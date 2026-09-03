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
  scriptableObjects: { drift: number } | 'clean' | 'skipped';
  input: { problems: number } | 'clean' | 'skipped';
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

const DEFAULT_DEPS: VerifiedPassDeps = {
  readFile: defaultReadFile,
  runAnalyzers: defaultRunAnalyzers,
  bridgeConnected: defaultBridgeConnected,
  triggerRecompile: defaultTriggerRecompile,
  readGuid: readScriptGuidFromMeta,
  checkUiToolkit: defaultCheckUiToolkit,
  checkScriptableObjects: defaultCheckScriptableObjects,
  checkInput: defaultCheckInput,
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
export async function runVerifiedPass(
  workspacePath: string,
  deps: VerifiedPassDeps = DEFAULT_DEPS,
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

  const compile = await withBudget<VerifiedCardData['compile']>(
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
  };
}
