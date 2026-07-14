/**
 * question-routing — pure predicate deciding whether `ChatInput`'s submit
 * should route to answering a pending `ask_user` question
 * (`useAiStore.getState().resolveQuestionRequest`) instead of the normal
 * send-a-message flow. Extracted from `ChatInput.tsx` so the routing rule is
 * unit-testable without mounting React or touching the store (mirrors how
 * other pure predicates in this directory, e.g. `tool-guards.ts`, are split
 * out from their call sites).
 */

export interface QuestionRoutingState {
  /** Whether a question is currently awaiting an answer (`selectPendingQuestion(...) !== null`). */
  pendingQuestion: boolean;
  /** The composer's raw text at submit time (untrimmed). */
  text: string;
}

/**
 * True iff a question is pending AND the submitted text is non-empty after
 * trimming — i.e. the user typed a real answer while a question card is
 * showing. Whitespace-only text, or no pending question at all, falls
 * through to the normal send path.
 */
export function shouldRouteToQuestion(state: QuestionRoutingState): boolean {
  return state.pendingQuestion && state.text.trim().length > 0;
}
