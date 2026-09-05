// Verified-pass (P3.4) — the closing sweep that proves the agent's "done" is
// PROVEN, not asserted. The per-write gates (analyzer-gate.ts, compile-gate.ts,
// lsp-gate.ts) already repair in-loop as the agent writes; this pass re-checks
// everything a send touched ONE more time after the loop finishes, so the user
// sees a single "Verified" summary instead of trusting the agent's own claim.
// v1 renders results only — no loop re-entry (in-loop repair already exists
// via the gates above).
//
// Registry: `beginVerifiedPass()`/`recordTouchedFile()` track the absolute
// paths a send wrote/edited (wired into the write/edit tool's `onFileWritten`/
// `onFileEdited` hooks from agent-service.ts — see `createToolsForPromptMode`).
// `runVerifiedPass()` then sweeps the registry once, after `prompt()` resolves.
// Known v1 limitation: bash-tool file mutations are not registered — same scope
// as the per-write gates.
//
// DI note (mirrors lsp-gate.ts's `DiagnosticsFetcher` seam): `runAnalyzersOnText`,
// `bridgeConnected`, and `triggerRecompileAndWait` each sit behind an import
// chain that eventually reaches `stores/workspace.ts` → the `editor` feature
// barrel → `@monaco-editor/react` (and `stores/theme.ts`'s module-scope
// `document.documentElement` side effect) — none of which survive Bun's
// DOM-less test runtime. Every boundary here is injected via `VerifiedPassDeps`;
// the defaults defer those imports with a dynamic `import()` so the chain is
// only ever reached in the real app (tests always inject fakes).
//
// Budget: the whole pass is capped at ~10s total (not per-step) — each step is
// raced against whatever's left of the budget and degrades to 'skipped' on
// timeout, the same as it does on a thrown error, so a slow/dropped Unity
// bridge can't hang the "done" moment the user is waiting on. The compile step
// creates its own AbortController timed to the remaining budget, so the
// underlying triggerRecompileAndWait stops waiting when the budget expires.

import { invoke } from '@tauri-apps/api/core';
import { readScriptGuidFromMeta } from './unity-tools/script-guid';
import type { CompileWaitOutcome } from '../../unity-bridge';
import type { Finding } from '../../unity-analyzers';
import type { ConsoleCheckResult, TestsCheckResult, RepairInfo } from './console-check';

export interface VerifiedCardData {
  /** Total files touched by the send (any extension). */
  files: number;
  /** Workspace-relative paths, for the collapsed detail list. */
  touchedFiles: string[];
  analyzers: { errors: number } | 'skipped';
  compile: { errors: number } | 'clean' | 'skipped';
  guids: 'intact' | { missing: string[] } | 'skipped';
  /**
   * The three subsystems whose failures a compile can never catch.
   *
   * Each is `'skipped'` unless the send actually touched a file that could
   * affect it, so a pure C# change does not pay for three checks it cannot
   * have broken — and, more importantly, so the card never claims to have
   * verified something it did not look at.
   */
  uiToolkit: { queriesResolved: number; queriesTotal: number; problems: number } | 'clean' | 'skipped';
  /**
   * Did the documents this send wrote actually LAY OUT?
   *
   * Distinct from `uiToolkit`, which re-parses and re-resolves strings. A
   * `.uxml` that parses, references every stylesheet it names and satisfies
   * every `Q<T>()` in the project can still put every element at zero height,
   * push the primary button off the panel, or clip its own text — and no
   * string check ever written can see any of it. This renders the document
   * offscreen through the same pipeline the canvas uses and reports the boxes
   * elements really landed in, plus `lintLayout`'s geometry findings.
   *
   * `'skipped'` when the send touched no `.uxml`, or when the probe could not
   * run at all — never a stand-in for "nothing wrong".
   */
  layout:
    | {
        documents: number;
        elements: number;
        problems: number;
        /**
         * Elements no rule in the document's own stylesheets reaches.
         *
         * On the same row as the geometry rather than on one of its own,
         * because they are two readings of a single render and a screen is only
         * finished when both are good. It is here at all because a document can
         * lay out perfectly — every box the right size, `problems: 0` — and
         * render as flat default grey, which is the failure this card could not
         * previously see. See `style-coverage.ts`.
         *
         * Optional because cards are PERSISTED with the session: one saved
         * before this existed has no such field, and a restored card must
         * report geometry alone rather than claiming zero unstyled elements it
         * never counted. Same reasoning as `layout`'s own `= 'skipped'` default
         * in `VerifiedCard.tsx`.
         */
        unstyled?: number;
      }
    | 'skipped';
  scriptableObjects: { drift: number } | 'clean' | 'skipped';
  input: { problems: number } | 'clean' | 'skipped';
  /**
   * What Unity's console said after the turn (Task 13). Owned by
   * `console-check.ts` and filled in by `agent-service.ts`'s closing
   * sequence, NOT by `runVerifiedPass` — the check runs a second verified
   * pass of its own after its one repair attempt, and only the caller can see
   * both halves. `runVerifiedPass` therefore always returns `'skipped'` here,
   * and the merged card carries the real value.
   */
  console: ConsoleCheckResult;
  /** The latest Unity test run this send recorded (Task 13). Same ownership as `console`. */
  tests: TestsCheckResult;
  /** Present only when the console check actually made its one repair pass. */
  repair?: RepairInfo;
}

// ---- Injected boundaries ----

export interface VerifiedPassDeps {
  readFile: (absPath: string) => Promise<string>;
  runAnalyzers: (text: string, filePath: string) => Finding[] | Promise<Finding[]>;
  bridgeConnected: () => boolean | Promise<boolean>;
  triggerRecompile: (opts: { signal?: AbortSignal }) => Promise<CompileWaitOutcome>;
  /** Resolves the GUID from a `.cs` file's paired `.meta`, or `null` if missing/unreadable. */
  readGuid: (absPath: string) => Promise<string | null>;
  /**
   * The three subsystem checks.
   *
   * Injected as whole steps rather than as their pieces because each one has
   * to reach a feature barrel through a dynamic `import()` (see the DI note
   * above), and because that keeps the pure analysis where it already lives —
   * `asset-checks.ts` and `utils/uitoolkit-refs.ts` — rather than growing a
   * second copy here.
   */
  checkUiToolkit: (files: string[], workspacePath: string) => Promise<VerifiedCardData['uiToolkit']>;
  checkScriptableObjects: (
    files: string[],
    workspacePath: string,
  ) => Promise<VerifiedCardData['scriptableObjects']>;
  checkInput: (files: string[], workspacePath: string) => Promise<VerifiedCardData['input']>;
  /** See `VerifiedCardData.layout`. Injected as a whole step for the same reason the three above are. */
  checkLayout: (files: string[], workspacePath: string) => Promise<VerifiedCardData['layout']>;
}

async function defaultReadFile(absPath: string): Promise<string> {
  return invoke<string>('read_file', { path: absPath });
}

async function defaultRunAnalyzers(text: string, filePath: string): Promise<Finding[]> {
  const { runAnalyzersOnText } = await import('../../unity-analyzers');
  return runAnalyzersOnText(text, filePath);
}

async function defaultBridgeConnected(): Promise<boolean> {
  const { bridgeConnected } = await import('./unity-tools/shared');
  return bridgeConnected();
}

async function defaultTriggerRecompile(
  opts: { signal?: AbortSignal } = {},
): Promise<CompileWaitOutcome> {
  const { triggerRecompileAndWait } = await import('../../unity-bridge');
  return triggerRecompileAndWait(opts);
}

function hasExt(files: readonly string[], ...exts: string[]): boolean {
  return files.some((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
}

/**
 * UI Toolkit: do the documents still parse, and does every `Q<T>("name")` the
 * send wrote resolve?
 *
 * Only touched files are re-read; the element-name pool comes from the
 * analyzers' existing snapshot. A project-wide walk here would be the one
 * expensive step in a pass that has to finish while the user is watching.
 */
async function defaultCheckUiToolkit(
  files: string[],
  workspacePath: string,
): Promise<VerifiedCardData['uiToolkit']> {
  if (!hasExt(files, '.uxml', '.uss', '.cs')) return 'skipped';
  const mod = await import('../../unity-analyzers');
  const uxml = mod.getUxmlIndex();
  const uss = mod.getUssIndex();
  if (!uxml || uxml.docCount === 0) return 'skipped';

  const [{ checkUxml, checkUss }, { resolveQueryName, extractQuerySites }] = await Promise.all([
    import('./unity-tools/asset-checks'),
    import('../../../utils/uitoolkit-refs'),
  ]);
  const csRefs = mod.getCsUiRefIndex();
  const ladder = {
    associatedPath: null,
    associatedNames: null,
    projectNames: new Set(uxml.allNames),
    csAssignedNames: csRefs.loaded ? csRefs.assignedNames : null,
    allNames: uxml.allNames,
  };

  let problems = 0;
  let queriesTotal = 0;
  let queriesResolved = 0;

  for (const file of files) {
    const lower = file.toLowerCase();
    const text = await defaultReadFile(file).catch(() => null);
    if (text === null) continue;
    if (lower.endsWith('.uxml')) {
      problems += checkUxml(text, {
        declaredClasses: new Set(uss?.allClasses ?? []),
        csReferencedClasses: csRefs.loaded ? csRefs.referencedClasses : null,
        // Workspace-RELATIVE, because that is the form `parseStyleRef` returns
        // for a `project://` ref. Handing it absolute paths would report every
        // stylesheet in every document as missing.
        ussPaths: [...(uss?.docs.keys() ?? [])].map((p) => toRelative(p, workspacePath)),
        // Same form as `ussPaths`, so a relative `<Style src>` resolves against
        // a comparable path rather than an absolute one.
        documentPath: toRelative(file, workspacePath),
      }).length;
    } else if (lower.endsWith('.uss')) {
      problems += checkUss(text, file).length;
    } else if (lower.endsWith('.cs')) {
      for (const site of extractQuerySites(mod.blankStringsAndComments(text), text)) {
        if (!site.name) continue;
        queriesTotal++;
        // `unresolved` is the only verdict that is a failure. Every other one,
        // including `insufficient-data`, is a reason to stay quiet — the same
        // discipline the analyzer rule applies.
        if (resolveQueryName(site.name, ladder).kind !== 'unresolved') queriesResolved++;
      }
    }
  }

  if (queriesTotal === 0 && problems === 0) return 'clean';
  return { queriesResolved, queriesTotal, problems };
}

/**
 * ScriptableObjects: did a serialized-field change leave the assets behind?
 *
 * This is the check the whole subsystem exists for. A rename without
 * `[FormerlySerializedAs]` compiles, passes every test, and destroys tuned data
 * the next time Unity loads the asset — so "it compiles" is exactly the wrong
 * moment to stop looking.
 */
async function defaultCheckScriptableObjects(
  files: string[],
  workspacePath: string,
): Promise<VerifiedCardData['scriptableObjects']> {
  const scripts = files.filter((f) => f.toLowerCase().endsWith('.cs'));
  if (scripts.length === 0) return 'skipped';

  const { invoke } = await import('@tauri-apps/api/core');
  const analyzers = await import('../../unity-analyzers');
  const so = await import('../../unity-scriptable-objects');

  // Once, not once per touched script: this is a project-wide inventory and
  // building it inside the loop turned a forty-file send into forty index
  // queries.
  const groups = await invoke<
    Array<{ scriptPath: string | null; typeName: string; instances: Array<{ path: string }> }>
  >('unity_scriptable_object_types', { workspacePath }).catch(() => null);
  if (!groups) return 'skipped';

  let drift = 0;
  let looked = false;
  for (const script of scripts) {
    const source = await defaultReadFile(script).catch(() => null);
    if (source === null) continue;
    const schema = analyzers.buildSoSchema(analyzers.scanCSharp(source));
    if (!schema || schema.baseKind !== 'scriptableObject') continue;

    const group = groups.find((g) => g.scriptPath === script || g.typeName === schema.className);
    const paths = group?.instances ?? [];
    if (paths.length === 0) continue;

    const read = await invoke<Array<{ path: string; snapshot: Parameters<typeof so.computeDrift>[0]['instances'][number]['snapshot'] }>>(
      'unity_asset_read_many',
      { paths: paths.map((p) => p.path) },
    ).catch(() => []);
    if (read.length === 0) continue;

    looked = true;
    drift += so.computeDrift({
      schema,
      instances: read.map((r) => ({
        path: r.path,
        name: r.path.split('/').pop() ?? r.path,
        snapshot: r.snapshot,
      })),
    }).length;
  }

  if (!looked) return 'skipped';
  return drift === 0 ? 'clean' : { drift };
}

/** Input: does a touched `.inputactions` still parse, and does anything starve? */
async function defaultCheckInput(files: string[]): Promise<VerifiedCardData['input']> {
  const assets = files.filter((f) => f.toLowerCase().endsWith('.inputactions'));
  if (assets.length === 0) return 'skipped';

  const { checkInputActions } = await import('./unity-tools/asset-checks');
  let problems = 0;
  for (const asset of assets) {
    const text = await defaultReadFile(asset).catch(() => null);
    if (text === null) continue;
    problems += checkInputActions(text).length;
  }
  return problems === 0 ? 'clean' : { problems };
}

/**
 * Lay every `.uxml` this send wrote out offscreen, and measure it.
 *
 * The whole point of the row: this is the only check in the pass that renders
 * anything. It reaches `uitoolkit`'s barrel by dynamic `import()` for the
 * reason the DI note at the top of this file gives — `layout-probe.ts` touches
 * `document`, `attachShadow` and `getComputedStyle`, none of which exist under
 * Bun — and it is the same probe, at the same panel size, that
 * `unity_ui_layout` and the human preview both use, so the three can never
 * disagree about what the document looks like.
 *
 * A document whose probe throws is COUNTED but contributes no elements, rather
 * than dropping the whole row: one unmeasurable document must not make the
 * other three read as unmeasured.
 */
async function defaultCheckLayout(
  files: string[],
  workspacePath: string,
): Promise<VerifiedCardData['layout']> {
  const documents = files.filter((f) => f.toLowerCase().endsWith('.uxml'));
  if (documents.length === 0) return 'skipped';

  const [uitoolkit, { parseUxml }, { lintLayout }, { panelLayoutSize }] = await Promise.all([
    import('../../uitoolkit'),
    import('../../../utils/uxml-model'),
    import('../../../utils/layout-lint'),
    import('../../../utils/panel-settings'),
  ]);

  const guidMap = await invoke<Record<string, string>>('unity_index_guid_map', { workspacePath })
    .catch(() => ({}) as Record<string, string>);
  const resolveGuid = async (guid: string) => guidMap[guid] ?? null;

  let measured = 0;
  let elements = 0;
  let problems = 0;
  let unstyled = 0;

  for (const file of documents) {
    const text = await defaultReadFile(file).catch(() => null);
    if (text === null) continue;
    const relPath = toRelative(file, workspacePath);
    try {
      const doc = parseUxml(text);
      const { sheets } = await uitoolkit.loadStyleSheets(doc, relPath, workspacePath, resolveGuid);
      const panel = await uitoolkit.loadPanelSettings(relPath, workspacePath);
      // The panel decides the coordinate space every `px` in the document is
      // measured against; guessing it wrong is a 38%-off bug, not a rounding
      // one (see `utils/panel-settings.ts`).
      const size = panel.settings ? panelLayoutSize(panel.settings, LAYOUT_SCREEN) : LAYOUT_SCREEN;
      const probe = uitoolkit.probeLayout({ uxmlText: text, sheets, size });
      measured++;
      elements += probe.nodes.length;
      problems += lintLayout(probe, size).filter((f) => f.severity === 'error').length;
      // Free: the plan is already built and the sheets are already parsed.
      const coverage = uitoolkit.styleCoverage(uitoolkit.buildRenderPlan(doc, sheets).root, sheets);
      unstyled += coverage.unstyled.length;
    } catch {
      // Unmeasurable, not clean. It stays out of `measured`, so the row
      // reports what was actually laid out rather than implying all of it was.
    }
  }

  if (measured === 0) return 'skipped';
  return { documents: measured, elements, problems, unstyled };
}

/** The screen a `ScaleWithScreenSize` panel scales against — the same assumption `UxmlPreviewEditor` and `unity_ui_layout` make. */
const LAYOUT_SCREEN = { width: 1920, height: 1080 };

const DEFAULT_DEPS: VerifiedPassDeps = {
  readFile: defaultReadFile,
  runAnalyzers: defaultRunAnalyzers,
  bridgeConnected: defaultBridgeConnected,
  triggerRecompile: defaultTriggerRecompile,
  readGuid: readScriptGuidFromMeta,
  checkUiToolkit: defaultCheckUiToolkit,
  checkScriptableObjects: defaultCheckScriptableObjects,
  checkInput: defaultCheckInput,
  checkLayout: defaultCheckLayout,
};

// ---- Per-send registry ----

let touched = new Set<string>();

/** Reset the touched-file registry. Call once at the start of every user send. */
export function beginVerifiedPass(): void {
  touched = new Set<string>();
}

/** Record a file the send touched (absolute path). Wired from onFileWritten/onFileEdited. */
export function recordTouchedFile(absolutePath: string): void {
  touched.add(absolutePath);
}

/** Files touched so far this send — lets the caller decide whether to bother running the pass. */
export function touchedFileCount(): number {
  return touched.size;
}

/** Absolute paths touched this send (sorted copy) — memory distiller input. */
export function touchedFileList(): string[] {
  return [...touched].sort();
}

// ---- Helpers ----

function isCsFile(p: string): boolean {
  return p.toLowerCase().endsWith('.cs');
}

function isUnderAssets(p: string): boolean {
  return /(^|[\\/])Assets[\\/]/.test(p);
}

/** Best-effort path relative to the workspace root, for display (mirrors lsp-gate.ts). */
function toRelative(absPath: string, workspacePath: string): string {
  const normBase = (workspacePath.endsWith('/') || workspacePath.endsWith('\\')
    ? workspacePath
    : `${workspacePath}/`
  ).replace(/\\/g, '/');
  const normPath = absPath.replace(/\\/g, '/');
  return normPath.toLowerCase().startsWith(normBase.toLowerCase())
    ? normPath.slice(normBase.length)
    : normPath;
}

const PASS_BUDGET_MS = 10_000;

/**
 * Race a step against whatever budget remains; resolves `fallback` if the
 * step throws OR the budget runs out first — either way the pass degrades
 * gracefully instead of hanging or crashing.
 */
function withBudget<T>(fn: () => Promise<T>, budgetMs: number, fallback: T): Promise<T> {
  if (budgetMs <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, budgetMs);
    fn().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

// ---- Steps ----

async function computeAnalyzers(
  files: string[],
  deps: VerifiedPassDeps,
): Promise<VerifiedCardData['analyzers']> {
  let errors = 0;
  for (const f of files.filter(isCsFile)) {
    const content = await deps.readFile(f).catch(() => null);
    if (content == null) continue;
    const findings = await deps.runAnalyzers(content, f);
    errors += findings.filter((finding) => finding.severity === 'error').length;
  }
  return { errors };
}

async function computeCompile(
  deps: VerifiedPassDeps,
  budgetMs: number,
): Promise<VerifiedCardData['compile']> {
  const connected = await deps.bridgeConnected();
  if (!connected) return 'skipped';

  const controller = new AbortController();
  let abortTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    if (budgetMs > 0) {
      abortTimer = setTimeout(() => {
        controller.abort();
      }, budgetMs);
    }

    const outcome = await deps.triggerRecompile({ signal: controller.signal });
    // `no-compile` means the refresh ran but Unity had nothing to build — the
    // card can't claim a verified compile from that, so it stays 'skipped'
    // (same conservative treatment `unknown` gets).
    if (outcome.status !== 'report') return 'skipped';
    const errors = (outcome.report.messages ?? []).filter((m) => m.type === 'Error').length;
    return errors === 0 ? 'clean' : { errors };
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
}

async function computeGuids(
  files: string[],
  deps: VerifiedPassDeps,
): Promise<'intact' | { missing: string[] }> {
  const candidates = files.filter((f) => isCsFile(f) && isUnderAssets(f));
  if (candidates.length === 0) return 'intact';
  const missing: string[] = [];
  for (const f of candidates) {
    const guid = await deps.readGuid(f);
    if (!guid) missing.push(f);
  }
  return missing.length === 0 ? 'intact' : { missing };
}

/**
 * Sweep everything the send touched: analyzers (error-severity findings on
 * current disk content), a live compile if the Unity bridge is connected, and
 * GUID integrity (every touched `.cs` under `Assets/` has a readable `.meta`
 * GUID — the minimal standalone check `script-guid.ts` supports). Every step
 * is independently budgeted and defensive: a throw or a timeout degrades that
 * step to `'skipped'` without blocking the others.
 */
export interface RunVerifiedPassOptions {
  /**
   * Skip the compile step.
   *
   * Design mode sets it. A turn that wrote only `.uxml`/`.uss` cannot have
   * introduced a compile error, and `computeCompile` does not merely read a
   * cached verdict — it triggers a real Unity recompile and waits for it, which
   * on a backgrounded editor is the slowest thing in this pass by an order of
   * magnitude. Reporting `'skipped'` is the honest answer: nothing about C# was
   * checked, because nothing about C# changed.
   */
  skipCompile?: boolean;
}

export async function runVerifiedPass(
  workspacePath: string,
  deps: VerifiedPassDeps = DEFAULT_DEPS,
  options: RunVerifiedPassOptions = {},
): Promise<VerifiedCardData> {
  const files = Array.from(touched);
  const startedAt = Date.now();
  const remaining = () => PASS_BUDGET_MS - (Date.now() - startedAt);

  const analyzers = await withBudget<VerifiedCardData['analyzers']>(
    () => computeAnalyzers(files, deps),
    remaining(),
    'skipped',
  );
  // Before the compile step, not after: these are snapshot reads over the
  // touched files alone and cost single-digit milliseconds, whereas the compile
  // can legitimately consume the rest of the budget. Ordering them last would
  // mean the checks that catch the SILENT failures are the ones that get
  // dropped whenever the loud one takes a while.
  const uiToolkit = await withBudget<VerifiedCardData['uiToolkit']>(
    () => deps.checkUiToolkit(files, workspacePath),
    remaining(),
    'skipped',
  );
  const scriptableObjects = await withBudget<VerifiedCardData['scriptableObjects']>(
    () => deps.checkScriptableObjects(files, workspacePath),
    remaining(),
    'skipped',
  );
  const input = await withBudget<VerifiedCardData['input']>(
    () => deps.checkInput(files, workspacePath),
    remaining(),
    'skipped',
  );
  // With the other snapshot reads, before the compile: it is the check that
  // catches the failure nothing else in this pass can see, so it must not be
  // the one dropped when a recompile eats the budget.
  const layout = await withBudget<VerifiedCardData['layout']>(
    () => deps.checkLayout(files, workspacePath),
    remaining(),
    'skipped',
  );

  const compile = options.skipCompile
    ? ('skipped' as const)
    : await withBudget<VerifiedCardData['compile']>(
        () => computeCompile(deps, remaining()),
        remaining(),
        'skipped',
      );
  const guidsRaw = await withBudget<'intact' | { missing: string[] } | 'skipped'>(
    () => computeGuids(files, deps),
    remaining(),
    'skipped',
  );

  const guids: VerifiedCardData['guids'] =
    guidsRaw === 'intact' || guidsRaw === 'skipped'
      ? guidsRaw
      : { missing: guidsRaw.missing.map((f) => toRelative(f, workspacePath)) };

  return {
    files: files.length,
    touchedFiles: files.map((f) => toRelative(f, workspacePath)),
    analyzers,
    compile,
    guids,
    uiToolkit,
    scriptableObjects,
    input,
    layout,
    // Owned by the caller (see `VerifiedCardData.console`): this pass has no
    // way to tell a first sweep from a post-repair one, and guessing would
    // put a console verdict on a card that never read the console.
    console: 'skipped',
    tests: 'skipped',
  };
}
