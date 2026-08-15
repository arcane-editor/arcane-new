/**
 * Per-send FACT channel for the stream layer (same module-level pattern as
 * turn-telemetry). The editor never chooses models — it reports facts like
 * the plan-mode phase, and the server's routing layer (arcane-server
 * config/routing.ts) makes every model decision.
 */

import type { PromptMode } from './prompts';

let currentPromptMode: PromptMode | null = null;

/** Called at the top of every send (agent-service.sendMessage). */
export function setSendPromptMode(mode: PromptMode): void {
  currentPromptMode = mode;
}

/**
 * The plan-mode phase of the in-flight send, in the server's metadata
 * vocabulary — undefined outside plan mode.
 */
export function getSendPlanPhase(): 'planning' | 'executing' | undefined {
  if (currentPromptMode === 'plan-planning') return 'planning';
  if (currentPromptMode === 'plan-execution') return 'executing';
  return undefined;
}

/** Test seam. */
export function resetSendContext(): void {
  currentPromptMode = null;
}
