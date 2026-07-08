import type { AgentTool } from '../vendor/types';
import { useProjectContextStore } from '../../../../stores/project-context';
import { createUnityBridgeReadTools } from './read-tools';
import { createGetUnityDocsTool } from './docs-tool';
import { createUnityApiSearchTool } from './api-search-tool';
import { unityApiSearch, unityApiLookup } from './api-client';
import { createUnityMigrationTool } from './migration-tool';
import { createUnityScriptMapTool } from './script-map-tool';

export { createUnityMutateTools } from './mutate-tools';
export { withUnityAnalyzerGate } from './analyzer-gate';
export { withUnityCompileGate, resetCompileGate } from './compile-gate';
export { unityApiSearch, unityApiLookup } from './api-client';

/**
 * Read-only Unity tools (auto-approved): bridge/index tools, deterministic
 * script-map classification, version-matched docs, version-accurate API
 * search/lookup (the hallucination-killer), and the migration planner
 * (Built-in→URP, Input System, version upgrades).
 *
 * This barrel is the only place in `unity-tools/` that wires store-backed
 * production implementations into the DI seams `api-search-tool.ts` and
 * `docs-tool.ts` expose (see those files) — production behavior here is
 * byte-identical to before the seam was added.
 */
export function createUnityReadTools(): AgentTool[] {
  return [
    ...createUnityBridgeReadTools(),
    createUnityScriptMapTool(),
    createGetUnityDocsTool(() => useProjectContextStore.getState().unityVersion),
    createUnityApiSearchTool({ search: unityApiSearch, lookup: unityApiLookup }),
    createUnityMigrationTool(),
  ];
}
