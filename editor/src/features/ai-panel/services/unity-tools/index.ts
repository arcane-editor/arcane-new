import type { AgentTool } from '../vendor/types';
import { createUnityBridgeReadTools } from './read-tools';
import { createGetUnityDocsTool } from './docs-tool';

export { createUnityMutateTools } from './mutate-tools';
export { withUnityAnalyzerGate } from './analyzer-gate';

/** Read-only Unity tools (auto-approved): bridge/index tools + version-matched docs. */
export function createUnityReadTools(): AgentTool[] {
  return [...createUnityBridgeReadTools(), createGetUnityDocsTool()];
}
