/**
 * Unity project-facts header (F-5.1). A compact, always-included block that
 * grounds the agent in THIS project's reality: Unity version, render pipeline,
 * input system, key packages, the active file's owning assembly, and any
 * team-authored `.ai/unity-rules.md`.
 *
 * Facts that require file reads (manifest, ProjectSettings, unity-rules) are
 * primed asynchronously into a per-workspace cache; `getUnityFactsBlock()` is
 * synchronous so it can be called inside the synchronous prompt builder. If the
 * cache is cold it returns the version-only block and kicks off a prime so the
 * next turn is complete.
 */

import { invoke } from '@tauri-apps/api/core';
import { useProjectContextStore } from '../../../../stores/project-context';
import { useWorkspaceStore } from '../../../../stores/workspace';
import { useAsmdefStore } from '../../../../stores/asmdef';
import { useUnityIndexStore } from '../../../../stores/unity-index';
import { contrastFactLines } from './unity-contrast';
import { inputFactLines, type InputActionsFacts } from './input-facts';
import {
  selectSubsystems,
  presenceOf,
  subsystemInventoryLine,
  scriptableObjectFactLines,
  uiToolkitFactLines,
  type SubsystemInventory,
  type ScriptableObjectFacts,
  type UiToolkitFacts,
} from './subsystem-facts';
import {
  detectInputSystem,
  inputSystemLabel,
  type InputSystemMode,
} from '../../../../utils/input-system';
import { detectUiStack, type UiStack } from '../unity-tools/ui-stack';
import { readUiStackSignals } from '../unity-tools/ui-stack-scan';
import { parsePanelSettings } from '../../../../utils/panel-settings';
import {
  uiDesignFactLines,
  type UiDesignFacts,
  type UiDesignVariableFacts,
  type UiDesignPanelFacts,
} from './ui-design-facts';

type RenderPipeline = 'URP' | 'HDRP' | 'Built-in';

interface UnityFacts {
  workspacePath: string;
  renderPipeline: RenderPipeline;
  /** Tri-state, not prose — `inputSystemLabel()` renders it for the prompt. */
  inputSystem: InputSystemMode;
  keyPackages: Array<{ name: string; version: string }>;
  unityRules: string | null; // contents of .ai/unity-rules.md
  /** Null when the project has no `.inputactions` assets (or is on Legacy). */
  inputActions: InputActionsFacts | null;
  /** Counts for the always-on inventory line. */
  inventory: SubsystemInventory;
  /** Null when the project has no ScriptableObject types with assets. */
  scriptableObjects: ScriptableObjectFacts | null;
  /** Null when the project has no `.uxml` documents. */
  uiToolkit: UiToolkitFacts | null;
  /**
   * Which UI stack the project uses (`ui-stack.ts`). Gathered once alongside
   * everything else here — `unity_ui_write` reads it via `getUnityUiStack`
   * to refuse writing UI Toolkit markup into an established uGUI project.
   */
  uiStack: UiStack;
  /**
   * The project's real USS custom-property variables and `PanelSettings`
   * coordinate space, for `uiDesignFactLines`. Null under the same condition
   * `uiToolkit` is — no `.uxml` documents means nothing for either block to
   * say, and `getUnityFactsBlock`'s selection gate (below) never surfaces it
   * in that case anyway.
   */
  uiDesign: UiDesignFacts | null;
}

let cache: UnityFacts | null = null;
// The in-flight prime, shared by every caller for the same workspace — not
// just a "don't kick off twice" flag. `ensureUnityUiStack` (fix round 1, M2)
// needs a SECOND caller's `await primeUnityFacts(...)` to actually wait for
// a prime a FIRST caller's `void primeUnityFacts(...)` already started
// (e.g. `getUnityFactsBlock`'s own warm-for-next-turn call, moments before
// the model's first tool call of the turn) — a bare re-entrancy flag with no
// shared promise would let the second call return immediately, still cold.
let inFlight: { workspacePath: string; promise: Promise<void> } | null = null;

// Packages worth surfacing to the agent (drives API/idiom choices).
const KEY_PACKAGES = [
  'com.unity.netcode.gameobjects',
  'com.unity.netcode',
  'com.unity.addressables',
  'com.unity.entities',
  'com.unity.burst',
  'com.unity.cinemachine',
  'com.unity.timeline',
  'com.unity.inputsystem',
  'com.unity.render-pipelines.universal',
  'com.unity.render-pipelines.high-definition',
  'com.cysharp.unitask',
];

function detectRenderPipeline(deps: Record<string, string>): RenderPipeline {
  if (deps['com.unity.render-pipelines.universal']) return 'URP';
  if (deps['com.unity.render-pipelines.high-definition']) return 'HDRP';
  return 'Built-in';
}

/**
 * Populate the facts cache for a workspace (idempotent, best-effort).
 *
 * Concurrent calls for the SAME workspace share one in-flight promise rather
 * than racing: a caller that only fires this to warm the cache for later
 * (`void primeUnityFacts(...)`, throughout this file) and a caller that
 * needs the result NOW (`ensureUnityUiStack`) can both call this and both
 * get the one real prime's completion.
 */
export function primeUnityFacts(workspacePath: string): Promise<void> {
  if (!workspacePath) return Promise.resolve();
  if (cache?.workspacePath === workspacePath) return Promise.resolve();
  if (inFlight?.workspacePath === workspacePath) return inFlight.promise;

  const promise = runPrime(workspacePath).finally(() => {
    if (inFlight?.workspacePath === workspacePath) inFlight = null;
  });
  inFlight = { workspacePath, promise };
  return promise;
}

async function runPrime(workspacePath: string): Promise<void> {
  let deps: Record<string, string> = {};
  try {
    const manifest = await invoke<string>('read_file', {
      path: `${workspacePath}/Packages/manifest.json`,
    });
    deps = (JSON.parse(manifest).dependencies as Record<string, string>) ?? {};
  } catch {
    /* no manifest — leave deps empty */
  }

  let projectSettings: string | null = null;
  try {
    projectSettings = await invoke<string>('read_file', {
      path: `${workspacePath}/ProjectSettings/ProjectSettings.asset`,
    });
  } catch {
    /* ignore */
  }

  let unityRules: string | null = null;
  try {
    unityRules = await invoke<string>('read_file', {
      path: `${workspacePath}/.ai/unity-rules.md`,
    });
  } catch {
    /* none — that's fine */
  }

  const keyPackages = KEY_PACKAGES.filter((p) => deps[p]).map((name) => ({
    name,
    version: deps[name],
  }));

  const inputSystem = detectInputSystem(projectSettings, !!deps['com.unity.inputsystem']);

  // All five snapshots in parallel: each is a bounded read the app performs
  // anyway, and priming is off the critical path (the first turn falls back
  // to the version-only block if it is not warm yet).
  const [inputActions, so, ui, uiStackSignals, panels] = await Promise.all([
    readInputActionsFacts(workspacePath, inputSystem),
    readScriptableObjectFacts(workspacePath),
    readUiToolkitFacts(workspacePath),
    readUiStackSignals(workspacePath),
    readPanelSettingsFacts(workspacePath),
  ]);
  const scriptableObjects = so?.facts ?? null;
  const soAssetCount = so?.assetCount ?? 0;
  const uiToolkit = ui?.facts ?? null;
  const ussCount = ui?.stylesheetCount ?? 0;
  const uiStack = detectUiStack({
    uxmlCount: ui?.facts.documents.length ?? 0,
    panelSettingsCount: uiStackSignals.panelSettingsCount,
    canvasScenes: uiStackSignals.canvasScenes,
  });
  // Null under the same condition `uiToolkit` is (see `UnityFacts.uiDesign`'s
  // doc comment) — the selection gate in `getUnityFactsBlock` never surfaces
  // it otherwise, so there is nothing worth keeping a panel/variable scan
  // result for.
  const uiDesign: UiDesignFacts | null = ui
    ? { variables: ui.variables, panels, themeSheets: ui.themeSheets, stack: uiStack }
    : null;

  cache = {
    workspacePath,
    renderPipeline: detectRenderPipeline(deps),
    inputSystem,
    keyPackages,
    unityRules,
    inputActions,
    scriptableObjects,
    uiToolkit,
    uiStack,
    uiDesign,
    inventory: {
      scriptableObjects: scriptableObjects
        ? { types: scriptableObjects.typeNames.length, assets: soAssetCount }
        : null,
      uiToolkit: uiToolkit
        ? { documents: uiToolkit.documents.length, stylesheets: ussCount }
        : null,
      input: inputActions
        ? { assets: inputActions.assetPaths.length, maps: inputActions.maps.length }
        : null,
    },
  };
}

/**
 * The project's declared action maps, or null when there are none to name.
 *
 * Reached through a dynamic import for the reason `graphify-tools.ts`
 * documents: the `unity-analyzers` barrel pulls Monaco, and a static import
 * here would drag `stores/theme.ts` into Bun's DOM-less runtime, where its
 * module-scope `document` access kills the suite on import alone.
 *
 * Shares the analyzers' snapshot rather than scanning again, so the names in
 * the prompt are the same ones UNITY0401 validates written code against.
 */
async function readInputActionsFacts(
  workspacePath: string,
  inputSystem: InputSystemMode,
): Promise<InputActionsFacts | null> {
  if (inputSystem === 'Legacy') return null;
  try {
    const { loadInputActions, getInputActionsIndex } = await import('../../../unity-analyzers');
    await loadInputActions(workspacePath);
    const index = getInputActionsIndex();
    if (!index || index.assetCount === 0) return null;

    const maps = new Map<string, string[]>();
    for (const action of index.byQualifiedName.values()) {
      const list = maps.get(action.mapName);
      if (list) list.push(action.name);
      else maps.set(action.mapName, [action.name]);
    }
    return {
      assetPaths: index.assetPaths.map((p) =>
        p.startsWith(`${workspacePath}/`) ? p.slice(workspacePath.length + 1) : p,
      ),
      maps: [...maps].map(([name, actions]) => ({ name, actions })),
    };
  } catch {
    return null;
  }
}

/**
 * The active file's content, from the buffer the editor already holds.
 *
 * Synchronous on purpose: `getUnityFactsBlock` runs inside the synchronous
 * prompt builder, so there is no opportunity to read from disk. A file that is
 * open but not yet loaded simply yields null, and the selection falls back to
 * extension alone — which is the right degradation, since the alternative is
 * making the whole prompt build async.
 */
function activeFileTextSync(): string | null {
  const { openFiles, activeFilePath } = useWorkspaceStore.getState();
  if (!activeFilePath) return null;
  return openFiles.find((f) => f.path === activeFilePath)?.content ?? null;
}

/**
 * ScriptableObject types that have at least one asset, most-instanced first.
 *
 * Shares the same Rust inventory command the ScriptableObjects panel uses,
 * rather than scanning again — so the types named in the prompt are exactly the
 * ones `unity_scriptable_objects` can then describe.
 */
async function readScriptableObjectFacts(
  workspacePath: string,
): Promise<{ facts: ScriptableObjectFacts; assetCount: number } | null> {
  try {
    const groups = await invoke<Array<{ typeName: string; instances: unknown[] }>>(
      'unity_scriptable_object_types',
      { workspacePath },
    );
    if (groups.length === 0) return null;
    const sorted = [...groups].sort((a, b) => b.instances.length - a.instances.length);
    return {
      facts: { typeNames: sorted.map((g) => g.typeName) },
      assetCount: groups.reduce((n, g) => n + g.instances.length, 0),
    };
  } catch {
    return null;
  }
}

/**
 * The project's UXML documents and every element name they declare, plus the
 * theme's real USS custom-property variables (Task 16 — `uiDesignFactLines`).
 *
 * Reached through a dynamic import for the reason `readInputActionsFacts`
 * documents above, and shares the analyzers' snapshot for the same reason: the
 * names in the prompt are the ones UNITY0501 validates `Q<T>()` against, and
 * the variables are the ones a `var(--name)` in a written `.uss` resolves
 * against.
 */
async function readUiToolkitFacts(workspacePath: string): Promise<{
  facts: UiToolkitFacts;
  stylesheetCount: number;
  variables: UiDesignVariableFacts[];
  themeSheets: string[];
} | null> {
  try {
    const mod = await import('../../../unity-analyzers');
    await mod.loadUiToolkitIndex(workspacePath, mod.blankStringsAndComments);
    const uxml = mod.getUxmlIndex();
    if (!uxml || uxml.docCount === 0) return null;
    const relative = (p: string) =>
      p.startsWith(`${workspacePath}/`) ? p.slice(workspacePath.length + 1) : p;

    const ussIndex = mod.getUssIndex();
    // Declarations whose property starts with `--` (custom properties) —
    // first declaration wins, in path-sorted order, so the "first sheet that
    // declares it" is a deterministic, scan-order-independent choice rather
    // than whatever order `read_files_bulk` happened to return.
    const variables: UiDesignVariableFacts[] = [];
    if (ussIndex) {
      const sheetOfVar = new Set<string>();
      const sortedPaths = [...ussIndex.docs.keys()].sort((a, b) => a.localeCompare(b));
      for (const path of sortedPaths) {
        const sheet = ussIndex.docs.get(path);
        if (!sheet) continue;
        const base = path.split('/').pop() ?? path;
        for (const rule of sheet.rules) {
          for (const decl of rule.declarations) {
            if (!decl.property.startsWith('--') || sheetOfVar.has(decl.property)) continue;
            sheetOfVar.add(decl.property);
            variables.push({ name: decl.property, value: decl.value, sheet: base });
          }
        }
      }
    }
    const themeSheets = [...new Set(variables.map((v) => v.sheet))].sort((a, b) => a.localeCompare(b));

    return {
      facts: {
        documents: [...uxml.docs.keys()].map(relative),
        elementNames: uxml.allNames,
      },
      stylesheetCount: ussIndex?.docCount ?? 0,
      variables,
      themeSheets,
    };
  } catch {
    return null;
  }
}

const PANEL_ASSET_SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];
/** Mirrors `ui-stack-scan.ts`'s `MAX_SCENE_BYTES` — same technique, same cap. */
const MAX_PANEL_ASSET_BYTES = 2 * 1024 * 1024;
const PANEL_ASSET_READ_CHUNK = 200;

/** A chunk that fails narrows the answer; it does not break the whole prime. */
async function inChunks<T>(
  list: readonly string[],
  chunkSize: number,
  fn: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    try {
      out.push(...(await fn(list.slice(i, i + chunkSize))));
    } catch {
      /* see doc comment above */
    }
  }
  return out;
}

/**
 * Every `PanelSettings` asset in the project, for `uiDesign`'s panel facts.
 *
 * Same scan `panel-resolve.ts` runs to resolve ONE document's panel (`.asset`
 * files containing `UnityEngine.UIElements.PanelSettings`, parsed with the
 * same `parsePanelSettings`), but project-wide and size-gated the way
 * `ui-stack-scan.ts`'s Canvas scan is: every candidate is stat'd first via
 * `file_sizes_bulk`, and only the ones at or under the cap ever reach
 * `read_files_bulk` — an oversized `.asset` is skipped before a single byte
 * of it is read, not read in full and then discarded.
 */
async function readPanelSettingsFacts(workspacePath: string): Promise<UiDesignPanelFacts[]> {
  try {
    const paths = await invoke<string[]>('scan_all_files_v2', {
      workspacePath,
      extraExcludes: PANEL_ASSET_SCAN_EXCLUDES,
    });
    const assetPaths = paths.filter((p) => p.endsWith('.asset'));
    if (assetPaths.length === 0) return [];

    const sizes = await inChunks(assetPaths, PANEL_ASSET_READ_CHUNK, (chunk) =>
      invoke<Array<{ path: string; size: number }>>('file_sizes_bulk', { paths: chunk }),
    );
    const underCap = sizes.filter((s) => s.size <= MAX_PANEL_ASSET_BYTES).map((s) => s.path);
    if (underCap.length === 0) return [];

    const files = await inChunks(underCap, PANEL_ASSET_READ_CHUNK, (chunk) =>
      invoke<Array<{ path: string; content: string }>>('read_files_bulk', { paths: chunk }),
    );

    const relative = (p: string) =>
      p.startsWith(`${workspacePath}/`) ? p.slice(workspacePath.length + 1) : p;

    const panels: UiDesignPanelFacts[] = [];
    for (const file of files) {
      if (!file.content.includes('UnityEngine.UIElements.PanelSettings')) continue;
      const parsed = parsePanelSettings(file.content, file.path);
      if (!parsed) continue;
      panels.push({
        name: parsed.name,
        path: relative(file.path),
        scaleMode: parsed.scaleMode,
        // Only `scale-with-screen` derives its layout box FROM the reference
        // resolution (`panelLayoutSize`'s switch) — for the other two modes
        // the number is present in the asset but plays no part in sizing, so
        // stating it would claim a coordinate space that is not actually in
        // effect.
        referenceResolution:
          parsed.scaleMode === 'scale-with-screen'
            ? { w: parsed.referenceResolution.width, h: parsed.referenceResolution.height }
            : null,
        screenMatchMode: parsed.screenMatchMode,
        match: parsed.match,
      });
    }
    return panels;
  } catch {
    return [];
  }
}

// The `.uxml`-independent UI-stack signals (`PanelSettings`/Canvas counts) are
// gathered by `ui-stack-scan.ts` — moved there (fix round 1, F1) so the
// `.unity`/`.prefab` size cap can bound the WORK (stat first, read only what's
// under the cap) rather than being applied to `content.length` after every
// file was already read in full. That split also makes the scan directly
// Bun-testable, which this file (statically importing `stores/workspace.ts`)
// is not.

/**
 * Which UI stack the project uses, or `null` when the facts cache is cold for
 * this workspace. Synchronous (like `getUnityGroundingContext`) so the
 * synchronous prompt builder can call it — kicks off a background prime when
 * cold, for the NEXT call. A caller that can afford to wait for THIS call
 * (`unity_ui_write`'s default `stack` dep) should use `ensureUnityUiStack`
 * instead — treating a cold `null` here as `'none'` would silently let a
 * write through a uGUI-project refusal it only missed because it ran first.
 */
export function getUnityUiStack(workspacePath: string): UiStack | null {
  const facts = cache?.workspacePath === workspacePath ? cache : null;
  if (!facts && workspacePath) void primeUnityFacts(workspacePath);
  return facts?.uiStack ?? null;
}

/** `ensureUnityUiStack`'s wait budget — see its own doc comment. */
const ENSURE_UI_STACK_TIMEOUT_MS = 5000;

/**
 * Like `getUnityUiStack`, but for a caller that can afford to actually WAIT
 * for a cold cache to warm rather than treating "not primed yet" the same as
 * "primed and found nothing" (fix round 1, M2 — a `unity_ui_write` call is
 * often the very first thing to touch this workspace's facts, so `null` here
 * is common, not an edge case).
 *
 * Bounded: a prime this slow (or genuinely hung — a stalled Tauri IPC round
 * trip) must not hang the write tool call indefinitely. On timeout, the
 * prime is left running in the background (still useful for the NEXT call)
 * and this resolves `null`, same as a cold `getUnityUiStack` — the caller's
 * job, not this function's, to say honestly that the stack could not be
 * determined in time.
 */
export async function ensureUnityUiStack(workspacePath: string): Promise<UiStack | null> {
  if (cache?.workspacePath === workspacePath) return cache.uiStack;
  if (!workspacePath) return null;
  await Promise.race([
    primeUnityFacts(workspacePath),
    new Promise<void>((resolve) => setTimeout(resolve, ENSURE_UI_STACK_TIMEOUT_MS)),
  ]);
  return cache?.workspacePath === workspacePath ? cache.uiStack : null;
}

/**
 * Build the Unity facts markdown block synchronously. Returns null for
 * non-Unity projects. Triggers a background prime when the cache is cold.
 */
export function getUnityFactsBlock(): string | null {
  const ctx = useProjectContextStore.getState();
  if (!ctx.isUnityProject) return null;

  const workspacePath = useWorkspaceStore.getState().workspacePath;
  const facts = cache?.workspacePath === workspacePath ? cache : null;
  if (!facts && workspacePath) {
    void primeUnityFacts(workspacePath); // warm for next turn
  }

  const lines: string[] = ['## Unity project facts (authoritative — match these)'];
  lines.push(`- Unity version: ${ctx.unityVersion ?? 'unknown'}`);

  if (facts) {
    lines.push(`- Render pipeline: ${facts.renderPipeline}`);
    lines.push(`- Input system: ${inputSystemLabel(facts.inputSystem)}`);

    // Adaptive detail (subsystem-facts.ts): the inventory line is always sent,
    // the per-subsystem detail only for what this conversation opens on. The
    // choice is made HERE, once, because this whole block is then frozen for
    // the conversation — nothing may vary the system prompt mid-conversation
    // (frozen-context.ts), so "adaptive" has to mean "chosen at freeze time".
    const selected = selectSubsystems({
      activeFilePath: useWorkspaceStore.getState().activeFilePath,
      activeFileText: activeFileTextSync(),
      present: presenceOf(facts.inventory),
    });
    const inventory = subsystemInventoryLine(facts.inventory);
    if (inventory) lines.push(inventory);

    lines.push(
      ...inputFactLines(facts.inputSystem, facts.inputActions, {
        detail: selected.includes('input'),
      }),
    );
    if (selected.includes('scriptableObjects') && facts.scriptableObjects) {
      lines.push(...scriptableObjectFactLines(facts.scriptableObjects));
    }
    if (selected.includes('uiToolkit') && facts.uiToolkit) {
      lines.push(...uiToolkitFactLines(facts.uiToolkit));
    }
    if (selected.includes('uiToolkit') && facts.uiDesign) {
      lines.push(...uiDesignFactLines(facts.uiDesign));
    }
    if (facts.keyPackages.length > 0) {
      lines.push(
        `- Key packages: ${facts.keyPackages.map((p) => `${p.name}@${p.version}`).join(', ')}`,
      );
    }
  }

  // Owning assembly of the active C# file (from the asmdef store's cache).
  const activeFile = useWorkspaceStore.getState().activeFilePath;
  if (activeFile && activeFile.endsWith('.cs')) {
    const owner = useAsmdefStore.getState().byFile.get(activeFile);
    if (owner) {
      const node = useAsmdefStore.getState().graph.find((n) => n.name === owner);
      const refs = node?.references?.length ? ` (references: ${node.references.join(', ')})` : '';
      lines.push(`- Active file's assembly: ${owner}${refs} — only suggest APIs from referenced assemblies.`);
    }
  }

  lines.push(
    '- Generate Unity-version-correct, pipeline-correct code. Do not suggest Built-in shaders for a URP/HDRP project, legacy Input for a New-Input-System project, or version-wrong APIs.',
  );

  // Contrastive anti-default facts (P2.1, unity-contrast.ts): derived from
  // the SAME renderPipeline/inputSystem values just computed above, so this
  // stays in lockstep with the generic facts with no separate detection path.
  if (facts) {
    lines.push(
      ...contrastFactLines({
        renderPipeline: facts.renderPipeline,
        inputSystem: facts.inputSystem,
      }),
    );
  }

  if (facts?.unityRules) {
    // Cap the user-authored rules file (spec §5): it was the one unbounded
    // block in the system prompt. 6KB keeps ~1.5k tokens as the worst case.
    const rules = facts.unityRules.trim();
    const capped =
      rules.length > 6000
        ? `${rules.slice(0, 6000)}\n[…truncated — full rules in .ai/unity-rules.md; read it if needed]`
        : rules;
    lines.push('', '## Project conventions (.ai/unity-rules.md — follow these)', capped);
  }

  return lines.join('\n');
}

/**
 * Grounding context for the version-accurate API tools (unity_api_search /
 * lookup) and the compile-gate de-hallucinator: the detected Unity version plus
 * the render pipeline + input system used as Vectorize metadata filters. Reads
 * the warmed facts cache; kicks off a prime if cold (pipeline/input come back
 * undefined that turn, which is fine — the server treats them as optional).
 */
export function getUnityGroundingContext(): {
  unityVersion: string | null;
  renderPipeline?: RenderPipeline;
  inputSystem?: 'New' | 'Legacy' | 'Both';
} {
  const ctx = useProjectContextStore.getState();
  const workspacePath = useWorkspaceStore.getState().workspacePath;
  const facts = cache?.workspacePath === workspacePath ? cache : null;
  if (!facts && workspacePath) void primeUnityFacts(workspacePath);

  const inputSystem = facts?.inputSystem;
  return { unityVersion: ctx.unityVersion ?? null, renderPipeline: facts?.renderPipeline, inputSystem };
}

// Keep the cache warm: prime whenever a Unity project becomes active. Deferred
// by a microtask so the subscription is set up only AFTER all modules finish
// evaluating — this makes it safe even if this module is ever pulled into an
// early-eval import chain (the store bindings can't be in their TDZ by then).
queueMicrotask(() => {
  useProjectContextStore.subscribe((state) => {
    if (state.isUnityProject) {
      const wp = useWorkspaceStore.getState().workspacePath;
      if (wp) void primeUnityFacts(wp);
    } else {
      cache = null;
    }
  });

  // The facts cache is keyed on the workspace alone, so an action renamed or a
  // .uxml edited mid-session left it serving the names the project had at
  // workspace open — the same staleness `inputActionsRevision` was created to
  // fix for the analyzers, leaking through a second cache nobody wired up.
  //
  // Dropping the cache is the whole fix, and it is deliberately all this does:
  // the CURRENT conversation keeps the block it froze (frozen-context.ts —
  // changing the prompt mid-conversation would invalidate the provider's prefix
  // cache for the entire history), and the next one primes from the new truth.
  useUnityIndexStore.subscribe((state, prev) => {
    // The two asset-specific counters only, NOT `indexRevision` — for exactly
    // the reason `unity-analyzers/index.ts` states at its own subscription:
    // re-priming re-reads the `.inputactions` assets AND re-scans the project
    // for `.uxml`/`.uss`, and `indexRevision` bumps on every prefab and scene
    // save. Hanging this off it would run two project scans every time anyone
    // saves a scene.
    if (
      state.inputActionsRevision !== prev.inputActionsRevision ||
      state.uiToolkitRevision !== prev.uiToolkitRevision
    ) {
      cache = null;
      const wp = useWorkspaceStore.getState().workspacePath;
      if (wp && useProjectContextStore.getState().isUnityProject) void primeUnityFacts(wp);
    }
  });

  // Zustand subscribe only fires on CHANGES — if the workspace was already a
  // Unity project when this module loaded (app start with a restored
  // workspace), prime immediately. This makes the FIRST conversation's frozen
  // facts snapshot (frozen-context.ts) usually complete instead of
  // version-only, killing the turn-1/turn-2 prompt-prefix divergence.
  if (useProjectContextStore.getState().isUnityProject) {
    const wp = useWorkspaceStore.getState().workspacePath;
    if (wp) void primeUnityFacts(wp);
  }
});
