/**
 * Retry (T5) — resend a failed turn from its inline `ErrorBlock`.
 *
 * LATEST TURN ONLY (v1, Cursor-like — T5 fix wave): retry is restricted to
 * the error block that is the LAST message in the store's timeline. Both
 * replay inputs are latest-turn-shaped — `getLastSend()` only remembers the
 * most recent send, and `rewindToLastUserPrompt()` only rewinds the agent's
 * LAST user prompt — so retrying an OLDER error block would truncate the
 * store at the right place but rewind/resend the WRONG prompt, silently
 * drifting the conversation. `retryFailedTurn` bails (with a banner) for a
 * non-latest error, and `ErrorBlock` disables its Retry button in that case.
 *
 * `sendMessage` never appends the ai store's UI "user" bubble itself — every
 * normal caller (`ChatInput`, `fixConsoleError`, `summarizeSceneDiff`) calls
 * `useAiStore.getState().addUserMessage(...)` immediately BEFORE calling
 * `sendMessage`/`planController.startPlanning`. A plain-chat retry therefore
 * has to replicate that whole two-step contract itself: drop the failed
 * turn's user bubble from the store (`truncateBeforeUserMessage` below) and
 * the matching entry from the agent's own LLM-facing history
 * (`rewindToLastUserPrompt`), then re-add both via `addUserMessage` +
 * `sendMessage` — otherwise the replay would either leave no bubble at all,
 * or the agent's history would carry the failed attempt AND the retry as two
 * separate user turns.
 *
 * Plan-planning and plan-execution retries are dispatched to
 * `plan-controller.ts`'s own `regenerate()`/`executePlan()` instead, WITHOUT
 * the store-truncate/agent-rewind dance above. Neither of those flows ever
 * adds a store user bubble in the first place (see `plan-controller.ts`) —
 * `regenerate()` replays `pendingPrompt`/`lastAttachments`, `executePlan()`
 * re-reads the plan file from disk — so there is no bubble to duplicate, and
 * truncating the store back to the ORIGINAL planning prompt (the "nearest
 * preceding user bubble" `findRetryTarget` would find for an execution
 * failure) would destructively erase the visible plan conversation and the
 * `activePlanPath`-gated Execute/Regenerate buttons for no benefit. This is
 * a deliberate narrowing of the brief's literal "truncate then branch"
 * ordering — see task-5-report.md for the full reasoning.
 *
 * `fix-console-error`'s synthetic prompt (the actual long text sent to the
 * LLM, assembled from the console error + stack-trace regions) is NOT
 * reconstructible from the store alone — only the short user-facing summary
 * bubble ("Fix this console error: ...") survives in `AiMessage.text`. When
 * `getLastSend()` is available (the normal, non-restart case), the retried
 * bubble still shows that short summary (`target.userMessage.text`) while
 * the actual resend uses `lastSend.text` (the real synthetic prompt) — so
 * this only degrades in the `lastSend === null` fallback below (a restored
 * session after an app restart), where the summary is genuinely all that's
 * left and gets used for both the bubble and the resend. Acceptable
 * degradation, restart-only.
 */

import { useAiStore, type AiMessage } from '../../../stores/ai';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { findRetryTarget } from './turn-errors';
import { getAgentService, getLastSend } from './agent-service';
import { planController } from './plan-controller';
import type { Attachment } from './types';

/**
 * Truncate the store's messages to just BEFORE `userMessageId` (dropping it
 * too), pruning `toolCalls` the same way `truncateAfterMessage` does.
 * Reuses that existing action by targeting the message immediately
 * preceding it; when `userMessageId` is the very first message, there's no
 * preceding id to target, so this clears the conversation directly.
 */
function truncateBeforeUserMessage(userMessageId: string): void {
  const { messages, truncateAfterMessage } = useAiStore.getState();
  const idx = messages.findIndex((m) => m.id === userMessageId);
  if (idx === -1) return;
  if (idx === 0) {
    useAiStore.setState({ messages: [], toolCalls: new Map() });
    return;
  }
  truncateAfterMessage(messages[idx - 1].id);
}

/**
 * Attachments minus any image whose `dataUrl` was stripped by session
 * persistence (`session-persistence.ts`'s `sanitizeMessagesForPersistence`
 * replaces it with `''` before writing to disk) — replaying a blank data URL
 * would send a broken image block to the model.
 */
function liveAttachments(userMessage: AiMessage): Attachment[] {
  const attachments = userMessage.attachments ?? [];
  return attachments.filter((a) => a.kind !== 'image' || a.dataUrl !== '');
}

/**
 * T10 fix wave: reanchor the failed turn's checkpoint entries onto the
 * replay's freshly minted user bubble id. `addUserMessage` doesn't return
 * the id it mints, so it's read back from the store immediately after —
 * safe because `addUserMessage`'s `set()` call is synchronous and nothing
 * else runs between the two calls, so the store's last user message is
 * always the bubble `addUserMessage` just appended. Without this, the
 * failed turn's own checkpoint entries (recorded under `oldUserMessageId`,
 * the now-truncated-away bubble) would never surface a `CheckpointRow`
 * again — see `stores/checkpoints.ts`'s `reanchorTurns` header for the full
 * reasoning.
 */
function reanchorRetryCheckpoints(oldUserMessageId: string): void {
  const messages = useAiStore.getState().messages;
  const newest = messages[messages.length - 1];
  if (newest && newest.role === 'user') {
    useCheckpointsStore.getState().reanchorTurns(oldUserMessageId, newest.id);
  }
}

export async function retryFailedTurn(errorMessageId: string): Promise<void> {
  if (useAiStore.getState().isAgentRunning) {
    useAiStore.getState().setError('Nothing to retry.');
    return;
  }

  // Latest turn only (see the file header): both getLastSend() and
  // rewindToLastUserPrompt() are latest-turn-shaped, so an older error block
  // cannot be replayed faithfully.
  const timeline = useAiStore.getState().messages;
  if (timeline.length === 0 || timeline[timeline.length - 1].id !== errorMessageId) {
    useAiStore.getState().setError('Only the most recent turn can be retried.');
    return;
  }

  const target = findRetryTarget(timeline, errorMessageId);
  if (!target) {
    useAiStore.getState().setError('Nothing to retry.');
    return;
  }

  const lastSend = getLastSend();
  const promptMode = lastSend?.opts.promptMode;

  if (promptMode === 'plan-planning') {
    await planController.regenerate();
    return;
  }

  if (promptMode === 'plan-execution') {
    const planPath = useAiStore.getState().activePlanPath;
    if (!planPath) {
      useAiStore.getState().setError('No active plan to re-execute.');
      return;
    }
    await planController.executePlan(planPath);
    return;
  }

  // Plain chat retry: drop the failed turn (store bubble + agent history),
  // then recreate both via the same addUserMessage-then-sendMessage contract
  // every normal send follows (see the file header).
  truncateBeforeUserMessage(target.truncateAfterId);
  getAgentService().rewindToLastUserPrompt();

  if (lastSend) {
    useAiStore.getState().addUserMessage(target.userMessage.text ?? lastSend.text, lastSend.opts.attachments);
    reanchorRetryCheckpoints(target.userMessage.id);
    await getAgentService().sendMessage(lastSend.text, lastSend.opts);
    return;
  }

  // Restored session after an app restart — lastSend is gone (it's an
  // in-memory-only module variable, never persisted). Replay using the
  // user bubble's own saved text/attachments and the CURRENT session
  // config, since that's all that survives a restart.
  const current = useAiStore.getState();
  const text = target.userMessage.text ?? '';
  const attachments = liveAttachments(target.userMessage);
  useAiStore.getState().addUserMessage(text, attachments);
  reanchorRetryCheckpoints(target.userMessage.id);
  // Plan mode routes by phase (persisted with the session): a bare
  // `sendMessage({ mode: 'plan' })` would default to plan-PLANNING, turning a
  // retry of an execution turn into a fresh plan.
  if (current.mode === 'plan') {
    await planController.sendPlanModeMessage(text, attachments);
    return;
  }
  await getAgentService().sendMessage(text, {
    mode: current.mode,
    effort: current.effort,
    attachments,
  });
}
