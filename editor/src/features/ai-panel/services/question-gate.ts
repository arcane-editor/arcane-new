/**
 * Question gate — the pending-question map + resolution flow behind the
 * `ask_user` tool (mirrors `approval-gate.ts`'s pending-map/resolution shape
 * for permission requests). `requestUserQuestion` renders (via
 * `addQuestionRequest`) the questionRequest message the UI shows, then blocks
 * until either:
 *  - the UI calls `resolvePendingQuestion` (the user answered), or
 *  - the tool call's abort signal fires (the user cancelled the turn) — the
 *    T8 lock pattern from `approval-gate.ts`: an aborted run must both
 *    resolve the promise AND lock the questionRequest UI via
 *    `markQuestionCancelled`, so a cancelled turn never leaves a stale,
 *    still-clickable question behind.
 *
 * Bun-safety: `addQuestionRequest`/`markQuestionCancelled` reach the ai store
 * via a dynamic import, mirroring `todo-tool.ts`'s `pushToHostedStore` seam —
 * `stores/ai.ts` pulls in a chain (`stores/workspace.ts` → `features/editor`
 * → `@monaco-editor/react`, plus `stores/theme.ts`'s `document.documentElement`
 * side effect) that throws under Bun's DOM-less runtime. Since Task 2 landed
 * the real `addQuestionRequest`/`markQuestionCancelled` actions on `AiState`,
 * `useAiStore` is called directly with no cast: a dynamic `import()`
 * expression's type is resolved by TypeScript from the real module (same as
 * `import type` — this is purely a compile-time resolution, it does NOT
 * create a module-scope/eager runtime import), so `useAiStore.getState()`
 * already has full, non-optional typing for both actions. No `?.()` guard is
 * needed either — both actions always exist once this file is loaded.
 *
 * `requestUserQuestion`/`resolvePendingQuestion`/`hasPendingQuestion` are the
 * exact, frozen call surface `ask-user-tool.ts` (Task 1) and the Task-2 UI
 * rely on, so they take no `deps` parameter. `setQuestionGateDeps` /
 * `resetQuestionGateDeps` are the test-only override seam for the two
 * store-reaching calls above (module-scope swap, not Bun's `mock.module` —
 * `mock.module` registrations are process-global and this exact store
 * specifier is already mocked by other `*.test.ts` files elsewhere in this
 * directory, so a local swap avoids that cross-file collision hazard).
 */

import type { AskUserParams, QuestionAnswer } from './ask-user-tool';

export interface QuestionGateDeps {
  /** Pushes the questionRequest message the UI renders. */
  addQuestionRequest: (toolCallId: string, params: AskUserParams) => void | Promise<void>;
  /** Locks the questionRequest UI (buttons stop being interactive) on cancellation. */
  markQuestionCancelled: (toolCallId: string) => void | Promise<void>;
}

async function defaultAddQuestionRequest(toolCallId: string, params: AskUserParams): Promise<void> {
  const { useAiStore } = await import('../../../stores/ai');
  useAiStore.getState().addQuestionRequest(toolCallId, params);
}

async function defaultMarkQuestionCancelled(toolCallId: string): Promise<void> {
  const { useAiStore } = await import('../../../stores/ai');
  useAiStore.getState().markQuestionCancelled(toolCallId);
}

const DEFAULT_DEPS: QuestionGateDeps = {
  addQuestionRequest: defaultAddQuestionRequest,
  markQuestionCancelled: defaultMarkQuestionCancelled,
};

let deps: QuestionGateDeps = DEFAULT_DEPS;

/** Test-only seam: override the store-reaching deps (see this module's header). */
export function setQuestionGateDeps(overrides: QuestionGateDeps): void {
  deps = overrides;
}

/** Test-only seam: restore the production deps. */
export function resetQuestionGateDeps(): void {
  deps = DEFAULT_DEPS;
}

const pending = new Map<string, (a: QuestionAnswer) => void>();

/**
 * Render a pending question and resolve once the user answers
 * (`resolvePendingQuestion`) or the turn aborts (→ cancelled).
 */
export function requestUserQuestion(
  toolCallId: string,
  params: AskUserParams,
  signal?: AbortSignal,
): Promise<QuestionAnswer> {
  // Already-aborted check FIRST (mirrors `write-approval-gate.ts`'s explicit
  // `signal?.aborted` check ahead of `deps.requestApproval` — the same "real
  // hang risk" its comment describes): `addEventListener('abort', ...)` never
  // fires for a signal that was ALREADY aborted before registration, and the
  // production caller (`ask-user-tool.ts`'s `defaultRequest`) has a genuine
  // async gap (`await import('./question-gate')`) before reaching here — a
  // Stop click in that window would otherwise leave this promise pending
  // forever, hanging the vendor loop with no recovery. No question card is
  // pushed in this branch (nothing to render — the run is already dead) and
  // the pending map is never touched.
  if (signal?.aborted) {
    // No questionRequest message exists yet in this branch (never pushed —
    // see above), so this is a no-op lock in practice, but call it anyway for
    // T8 symmetry: every path that resolves `cancelled` also calls the
    // store-lock action, with no special-cased exception.
    void deps.markQuestionCancelled(toolCallId);
    return Promise.resolve({ kind: 'cancelled' });
  }

  void deps.addQuestionRequest(toolCallId, params);
  return new Promise<QuestionAnswer>((resolve) => {
    pending.set(toolCallId, resolve);
    signal?.addEventListener('abort', () => {
      // T8 lock pattern (mirrors `approval-gate.ts`): resolve the promise AND
      // lock the questionRequest UI, so an aborted turn never leaves a stale,
      // still-answerable question behind.
      if (pending.delete(toolCallId)) {
        void deps.markQuestionCancelled(toolCallId);
        resolve({ kind: 'cancelled' });
      }
    });
  });
}

/** Resolve a pending question with the user's answer (called from the questionRequest UI). No-op if `toolCallId` isn't pending (already resolved, cancelled, or unknown). */
export function resolvePendingQuestion(toolCallId: string, answer: string): void {
  const r = pending.get(toolCallId);
  if (!r) return;
  pending.delete(toolCallId);
  r({ kind: 'answered', answer });
}

/** True while `toolCallId` is awaiting an answer; false once resolved, cancelled, or if never requested. */
export function hasPendingQuestion(toolCallId: string): boolean {
  return pending.has(toolCallId);
}
