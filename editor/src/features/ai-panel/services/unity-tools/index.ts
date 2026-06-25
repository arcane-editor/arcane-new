import type { AgentTool } from '../vendor/types';
import { createUnityBridgeReadTools } from './read-tools';
import { createGetUnityDocsTool } from './docs-tool';
import { createUnityApiSearchTool } from './api-search-tool';
import { createUnityMigrationTool } from './migration-tool';

export { createUnityMutateTools } from './mutate-tools';
export { withUnityAnalyzerGate } from './analyzer-gate';
export { withUnityCompileGate, resetCompileGate } from './compile-gate';
export { unityApiSearch, unityApiLookup } from './api-client';

/**
 * Read-only Unity tools (auto-approved): bridge/index tools, version-matched
 * docs, version-accurate API search/lookup (the hallucination-killer), and the
 * migration planner (Built-in→URP, Input System, version upgrades).
 */
export function createUnityReadTools(): AgentTool[] {
  return [
    ...createUnityBridgeReadTools(),
    createGetUnityDocsTool(),
    createUnityApiSearchTool(),
    createUnityMigrationTool(),
  ];
}
