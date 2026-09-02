import type { AgentTool } from '../vendor/types';
import { useProjectContextStore } from '../../../../stores/project-context';
import { createUnityBridgeReadTools } from './read-tools';
import { createGetUnityDocsTool } from './docs-tool';
import { createUnityApiSearchTool } from './api-search-tool';
import { unityApiSearch, unityApiLookup } from './api-client';
import { createUnityMigrationTool } from './migration-tool';
import { createUnityInputActionsTool } from './input-actions-tool';
import { createUnityScriptMapTool } from './script-map-tool';
import { withUnityCompileGate as createCompileGate } from './compile-gate';

export { createUnityMutateTools } from './mutate-tools';
export { withUnityAnalyzerGate } from './analyzer-gate';
export { resetCompileGate } from './compile-gate';
export { withLspDiagnosticsGate } from './lsp-gate';
export { unityApiSearch, unityApiLookup } from './api-client';

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
 * script-map classification, the project's Input System actions, version-matched
 * docs, version-accurate API search/lookup (the hallucination-killer), and the
 * migration planner (Built-in→URP, Input System, version upgrades).
 *
 * This barrel is the only place in `unity-tools/` that wires store-backed
 * production implementations into the DI seams `api-search-tool.ts` and
 * `docs-tool.ts` expose (see those files) — production behavior here is
 * byte-identical to before the seam was added.
 */
export function createUnityReadTools(workspacePath: string): AgentTool[] {
  return [
    ...createUnityBridgeReadTools(),
    createUnityScriptMapTool(),
    createUnityInputActionsTool(workspacePath),
    createGetUnityDocsTool(() => useProjectContextStore.getState().unityVersion),
    createUnityApiSearchTool({ search: unityApiSearch, lookup: unityApiLookup }),
    createUnityMigrationTool(),
  ];
}
