/**
 * Pure resolver for the per-request `difficulty` FACT the stream layer sends
 * to the server (`arcane-stream.ts`'s metadata builder). Difficulty tags an
 * agent/plan-execution todo item as 'easy' | 'hard' (`todo-tool.ts`) so the
 * server's routing layer (high tier only) can route the executor model per
 * segment rather than per request — see the model-stickiness comment in
 * `arcane-stream.ts` for the billing rationale.
 *
 * Structural plan-entry type (`{ status, difficulty? }`) rather than importing
 * `ArcanePlanEntry` from the store keeps this module store-free/Bun-testable,
 * matching `send-context.ts`'s and `todo-tool.ts`'s module-scope discipline.
 */

import type { Effort } from './types';
import type { PromptMode } from './prompts';

export type Difficulty = 'easy' | 'hard';

/**
 * Resolves the difficulty tag to send with the in-flight request.
 *
 * Gated to the high tier's agentic modes only: `undefined` unless
 * `effort === 'high'` AND `promptMode` is `'agent'` or `'plan-execution'` —
 * ask/plan-planning/preplanning never carry a difficulty, and low/mid tiers
 * don't have the executor/executorHard split this exists to route between.
 *
 * When gated in: the first `in_progress` plan entry's difficulty; if there is
 * none, the first `pending` entry's difficulty; otherwise `undefined` (the
 * server's routing layer defaults to the plain executor).
 */
export function difficultyForRequest(
  effort: Effort | string | undefined,
  promptMode: PromptMode | null,
  plan: ReadonlyArray<{ status: string; difficulty?: Difficulty }> | null,
): Difficulty | undefined {
  if (effort !== 'high') return undefined;
  if (promptMode !== 'agent' && promptMode !== 'plan-execution') return undefined;
  if (!plan) return undefined;

  const inProgress = plan.find((entry) => entry.status === 'in_progress');
  if (inProgress) return inProgress.difficulty;

  const pending = plan.find((entry) => entry.status === 'pending');
  if (pending) return pending.difficulty;

  return undefined;
}
