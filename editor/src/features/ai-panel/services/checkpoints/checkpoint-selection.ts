// Checkpoint turn selection (P5.2 review fix) — pure, Bun-testable helper
// that picks which checkpoint turn(s) `CheckpointRow` renders for a given
// user message.
//
// Finding: `plan-controller.ts`'s `executePlan()` sends the execution turn
// via `agentService.sendMessage()` WITHOUT calling `addUserMessage` first
// (only the initial planning prompt does). `agent-service.ts`'s
// `currentUserMessageId()` therefore tags the execution turn with the SAME
// userMessageId as the earlier plan-PLANNING turn (which is always empty —
// planning mode only has read-only tools, so it never records a
// `recordPreWrite`). `CheckpointRow` used to do `turns.find(t =>
// t.userMessageId === id)`, which — in array (chronological) order — hits
// the empty planning turn first and renders nothing, even though the later
// execution turn recorded real entries.
//
// Fix: don't stop at the first match — collect every turn for this message
// that actually has entries, in original chronological order, and let the
// caller render one row per turn. Do NOT touch plan-controller.ts (out of
// scope for this fix — see the finding).
import type { CheckpointTurn } from './restore-plan';

export function selectCheckpointTurnsForMessage(
  turns: CheckpointTurn[],
  userMessageId: string,
): CheckpointTurn[] {
  return turns.filter((t) => t.userMessageId === userMessageId && t.entries.length > 0);
}

/**
 * P5.1 per-file Revert (on a diff rendered in `ToolCallBlock`): find the
 * checkpoint turn to restore against for a given path.
 *
 * `CheckpointEntry.toolCallId` (restore-plan.ts) documents itself as "the
 * tool call that triggered this snapshot, if known (future per-file revert
 * UI)" — but it's never actually populated: `checkpoint-gate.ts`'s
 * `recordPreWrite` call, and `stores/checkpoints.ts`'s `recordPreWrite`
 * action signature, don't thread a toolCallId through at all. Rather than
 * wire that up (out of scope here — see the P5.1 brief), this matches by
 * (user-message turn, path) instead: scope to the turns already selected by
 * `selectCheckpointTurnsForMessage` for this message, then find the one that
 * recorded an entry for `path`. Picks the LAST (most recent) matching turn —
 * the plan-execution edge case that function's header documents can yield
 * more than one non-empty turn per message, and a later turn's entry is the
 * one a still-visible diff on screen actually corresponds to.
 */
export function findCheckpointTurnForPath(
  turns: CheckpointTurn[],
  userMessageId: string,
  path: string,
): CheckpointTurn | undefined {
  const candidates = selectCheckpointTurnsForMessage(turns, userMessageId);
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i].entries.some((e) => e.path === path)) return candidates[i];
  }
  return undefined;
}
