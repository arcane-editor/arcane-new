import type { AgentTool } from '../vendor/types';
import { useProjectContextStore } from '../../../../stores/project-context';
import { createUnityBridgeReadTools } from './read-tools';
import { createGetUnityDocsTool } from './docs-tool';
import { createUnityApiSearchTool } from './api-search-tool';
import { unityApiSearch, unityApiLookup } from './api-client';
import { createUnityMigrationTool } from './migration-tool';
import { createUnityInputActionsTool } from './input-actions-tool';
import { createUnityScriptableObjectsTool } from './scriptable-objects-tool';
import { createUnityUiToolkitTool } from './ui-toolkit-tool';
import { createUnityUiLayoutTool } from './ui-layout-tool';
import { createUnityUiScaffoldTool } from './ui-scaffold-tool';
import { createUnityAssetEditTool, defaultAssetEditDeps } from './asset-edit-tool';
import { createUnityFixSoDriftTool, defaultSoDriftDeps } from './so-drift-tool';
import { createUnityInputEditTool, defaultInputEditDeps } from './input-edit-tool';
import { createUnityUiWriteTool, defaultUiWriteDeps } from './ui-write-tool';
import { createUnityScriptMapTool } from './script-map-tool';
import { withUnityCompileGate as createCompileGate } from './compile-gate';

export { createUnityMutateTools } from './mutate-tools';
export { withUnityAnalyzerGate } from './analyzer-gate';
export { resetCompileGate } from './compile-gate';
export { withLspDiagnosticsGate } from './lsp-gate';
export { withUnityAssetGate } from './asset-gate';
export { unityApiSearch, unityApiLookup } from './api-client';
export { markConsoleTurnStart } from './read-tools';
export {
  recordTestRunForConsoleCheck,
  takeRecordedTestRuns,
  resetTestRunRegistry,
} from './test-run-registry';
export {
  registerPendingGuidCheck,
  takePendingGuidChecks,
  resetPendingGuidChecks,
} from './guid-verify';

/**
 * Compile-gate decorator, with the real (store-backed) grounding client wired
 * in here — the only place in `unity-tools/` that does — so callers keep the
 * existing 2-arg call (`withUnityCompileGate(tool, cwd)`; see agent-service.ts).
 * `compile-gate.ts` itself takes the client as an injected `HintLookup`
 * (mirrors the `createUnityApiSearchTool(client)` DI seam above), so its
 * `compile-hints.ts` de-hallucinator stays directly testable under Bun.
 */
export function withUnityCompileGate(tool: AgentTool, cwd: string): AgentTool {
  return createCompileGate(tool, cwd, { search: unityApiSearch, lookup: unityApiLookup });
}

/**
 * Read-only Unity tools (auto-approved): bridge/index tools, deterministic
 * script-map classification, the three first-class Unity subsystems
 * (ScriptableObjects, UI Toolkit, Input System), version-matched docs,
 * version-accurate API search/lookup (the hallucination-killer), and the
 * migration planner (Built-in→URP, Input System, version upgrades).
 *
 * The three subsystem tools exist for one shared reason: each couples an asset
 * to code through a STRING, and each fails silently when the string is wrong —
 * a renamed serialized field reverts every tuned value, a `Q<T>("name")` miss
 * throws only when the screen opens, a wrong action name simply never fires.
 * None of the three produces a compiler error, so the agent cannot discover any
 * of them by writing code and reading the result.
 *
 * `unity_ui_layout` (Task 15) is a fourth, geometry-shaped sibling of the UI
 * Toolkit tool: it does not join strings, it renders the SAME pipeline the
 * human preview does (offscreen) and reports the box every element actually
 * laid out to, plus a lint pass — the class of bug (off-panel, invisible,
 * clipped, low-contrast) that also compiles clean and is invisible to
 * `unity_ui_toolkit`'s string checks, because it was never a string problem.
 *
 * This barrel is the only place in `unity-tools/` that wires store-backed
 * production implementations into the DI seams `api-search-tool.ts` and
 * `docs-tool.ts` expose (see those files) — production behavior here is
 * byte-identical to before the seam was added.
 */
export function createUnityReadTools(workspacePath: string): AgentTool[] {
  return [
    ...createUnityBridgeReadTools({ search: unityApiSearch, lookup: unityApiLookup }),
    createUnityScriptMapTool(),
    createUnityInputActionsTool(workspacePath),
    createUnityScriptableObjectsTool(workspacePath),
    createUnityUiToolkitTool(workspacePath),
    createUnityUiLayoutTool(workspacePath),
    createUnityUiScaffoldTool(workspacePath),
    createGetUnityDocsTool(() => useProjectContextStore.getState().unityVersion),
    createUnityApiSearchTool({ search: unityApiSearch, lookup: unityApiLookup }),
    createUnityMigrationTool(),
  ];
}

/**
 * Unity asset-mutate tools, for the mutating modes only.
 *
 * These are file writes, not engine actions, so they do NOT take
 * `mutate-tools.ts`'s per-call human approval — they take the same treatment
 * every other file write takes. `agent-service.ts` wraps each one in
 * `withCheckpoint` and `withWriteApproval`, both of which key off a top-level
 * `path` parameter, which is why all three declare one.
 *
 * They exist because the generic `edit` tool is the wrong instrument for these
 * three formats. `.asset` is Unity YAML carrying fileIDs and GUIDs;
 * `.inputactions` is JSON carrying the ids Unity matches bindings by. In both,
 * an edit that looks correct can break references with no error at any point a
 * compiler or a test would see it.
 */
export function createUnityAssetMutateTools(
  workspacePath: string,
  opts: { onWrite?: (path: string) => void } = {},
): AgentTool[] {
  const { onWrite } = opts;
  return [
    createUnityAssetEditTool({ ...defaultAssetEditDeps, onWrite }),
    createUnityFixSoDriftTool(workspacePath, { ...defaultSoDriftDeps, onWrite }),
    createUnityInputEditTool({ ...defaultInputEditDeps, onWrite }),
    createUnityUiWriteTool(workspacePath, { ...defaultUiWriteDeps, onWrite }),
  ];
}
