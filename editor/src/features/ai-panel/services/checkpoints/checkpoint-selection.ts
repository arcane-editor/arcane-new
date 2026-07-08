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
