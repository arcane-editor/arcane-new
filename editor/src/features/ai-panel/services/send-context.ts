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
export function getSendPlanPhase(): 'preplanning' | 'planning' | 'executing' | undefined {
  if (currentPromptMode === 'preplanning') return 'preplanning';
  if (currentPromptMode === 'plan-planning') return 'planning';
  if (currentPromptMode === 'plan-execution') return 'executing';
  // Design work IS execution: it reads, writes and verifies in one turn. Calling
  // it 'planning' would route every send to the tier's planner model, which is
  // the expensive one, for no gain the loop actually uses.
  if (currentPromptMode === 'ui-design') return 'executing';
  return undefined;
}

/** The raw stored prompt mode of the in-flight send — `null` before any send. */
export function getSendPromptMode(): PromptMode | null {
  return currentPromptMode;
}

/** Test seam. */
export function resetSendContext(): void {
  currentPromptMode = null;
}
