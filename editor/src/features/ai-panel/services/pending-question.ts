/**
 * pending-question — which question, if any, the user can still answer right
 * now. Backs `stores/ai.ts`'s `selectPendingQuestion`, extracted here for the
 * reason `question-routing.ts` gives: the rule is worth testing, and
 * `stores/ai.ts` cannot be imported under Bun (it pulls `stores/workspace.ts`
 * → `@monaco-editor/react`, which throws in a DOM-less runtime).
 *
 * WHY THIS IS NOT `isAgentRunning` ANY MORE
 * -----------------------------------------
 * This used to short-circuit on `state.isAgentRunning`, using "a turn is in
 * flight" as a stand-in for "the `ask_user` gate promise is still live". The
 * two can disagree, and when they did the failure was silent and total: the
 * card sat on screen unanswered while `ChatInput` saw no pending question, so
 * its answer-mode routing never armed AND its Send button never rendered
 * (`!isAgentRunning || pendingQuestion` was false on both halves). The user was
 * left with a question they could only answer by clicking a chip — typing an
 * answer, which the card's own hint invites, did nothing.
 *
 * `question-gate.ts`'s pending map IS the authority: an entry exists exactly
 * while some caller is awaiting `requestUserQuestion`'s promise. So ask it
 * directly. The ordering works out on every path — `requestUserQuestion`
 * populates the map SYNCHRONOUSLY and pushes the card through an async dynamic
 * import, so the map is always ready before the store update that renders the
 * card; and both teardown paths (`resolvePendingQuestion`, the abort branch)
 * delete from the map in the same tick they lock the card.
 */

import type { AiMessage, QuestionRequestData } from '../../../stores/ai';
import { hasPendingQuestion } from './question-gate';

/**
 * The newest question the user can still answer: unresolved, not cancelled,
 * and still awaited by a live gate promise. `null` when there is none.
 *
 * Only the NEWEST unresolved card is considered. An older one behind it is
 * necessarily deader still — the gate resolves questions in the order it
 * raises them — so a dead newest card ends the search rather than falling
 * through to a stale card further up the transcript.
 *
 * `isLive` is injectable for tests; production passes the real gate.
 */
export function findPendingQuestion(
  messages: readonly AiMessage[],
  isLive: (toolCallId: string) => boolean = hasPendingQuestion,
): QuestionRequestData | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'questionRequest' || !m.questionRequest) continue;
    const q = m.questionRequest;
    if (q.resolvedAnswer !== undefined || q.cancelled) continue;
    return isLive(q.toolCallId) ? q : null;
  }
  return null;
}
