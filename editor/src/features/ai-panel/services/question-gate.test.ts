import { describe, it, expect, afterEach } from 'bun:test';
import {
  requestUserQuestion,
  resolvePendingQuestion,
  hasPendingQuestion,
  setQuestionGateDeps,
  resetQuestionGateDeps,
  type QuestionGateDeps,
} from './question-gate';
import type { AskUserParams } from './ask-user-tool';

interface FakeAddCall {
  toolCallId: string;
  params: AskUserParams;
}

/** Records every `addQuestionRequest`/`markQuestionCancelled` call — the store-observing seam these tests assert against. */
function fakeDeps(): {
  deps: QuestionGateDeps;
  addCalls: FakeAddCall[];
  cancelCalls: string[];
} {
  const addCalls: FakeAddCall[] = [];
  const cancelCalls: string[] = [];
  const deps: QuestionGateDeps = {
    addQuestionRequest: (toolCallId, params) => {
      addCalls.push({ toolCallId, params });
    },
    markQuestionCancelled: (toolCallId) => {
      cancelCalls.push(toolCallId);
    },
  };
  return { deps, addCalls, cancelCalls };
}

const QUESTION: AskUserParams = { question: 'Which approach?' };

describe('question-gate', () => {
  afterEach(() => {
    resetQuestionGateDeps();
  });

  it('resolve path: addQuestionRequest fires immediately, resolvePendingQuestion resolves the promise with the answer', async () => {
    const { deps, addCalls } = fakeDeps();
    setQuestionGateDeps(deps);

    const promise = requestUserQuestion('call-1', QUESTION);

    expect(addCalls).toEqual([{ toolCallId: 'call-1', params: QUESTION }]);
    expect(hasPendingQuestion('call-1')).toBe(true);

    resolvePendingQuestion('call-1', 'my answer');
    const result = await promise;

    expect(result).toEqual({ kind: 'answered', answer: 'my answer' });
    expect(hasPendingQuestion('call-1')).toBe(false);
  });

  it('abort: resolves the promise as cancelled AND fires the store-lock (markQuestionCancelled) callback', async () => {
    const { deps, cancelCalls } = fakeDeps();
    setQuestionGateDeps(deps);
    const controller = new AbortController();

    const promise = requestUserQuestion('call-2', QUESTION, controller.signal);
    expect(hasPendingQuestion('call-2')).toBe(true);

    controller.abort();
    const result = await promise;

    expect(result).toEqual({ kind: 'cancelled' });
    expect(cancelCalls).toEqual(['call-2']);
    expect(hasPendingQuestion('call-2')).toBe(false);
  });

  it('abort (already aborted BEFORE requestUserQuestion) → resolves cancelled immediately, never renders the question', async () => {
    // The 'abort' event never fires for a signal aborted before the listener
    // is registered, and the production caller (`ask-user-tool.ts`'s
    // `defaultRequest`) has a genuine async gap (`await import(...)`) before
    // reaching the gate — this must resolve WITHOUT depending on that
    // listener (a real hang risk: see `write-approval-gate.test.ts`'s
    // "already aborted by the time the diff is ready" sibling test).
    const { deps, addCalls, cancelCalls } = fakeDeps();
    setQuestionGateDeps(deps);
    const controller = new AbortController();
    controller.abort();

    const result = await requestUserQuestion('call-pre-aborted', QUESTION, controller.signal);

    expect(result).toEqual({ kind: 'cancelled' });
    expect(addCalls).toEqual([]); // no question card for a dead run
    expect(cancelCalls).toEqual(['call-pre-aborted']); // store-lock still fired once (T8 symmetry)
    expect(hasPendingQuestion('call-pre-aborted')).toBe(false); // pending map never touched
  });

  it('resolve-after-abort is a no-op: calling resolvePendingQuestion after the signal already aborted it does nothing', async () => {
    const { deps, cancelCalls } = fakeDeps();
    setQuestionGateDeps(deps);
    const controller = new AbortController();

    const promise = requestUserQuestion('call-3', QUESTION, controller.signal);
    controller.abort();
    const result = await promise;
    expect(result).toEqual({ kind: 'cancelled' });

    // Late resolution attempt — must not throw, and must not change anything
    // observable (the promise already settled; the pending entry is gone).
    expect(() => resolvePendingQuestion('call-3', 'too late')).not.toThrow();
    expect(cancelCalls).toEqual(['call-3']); // unchanged from the abort above — resolvePendingQuestion never touches it
    expect(hasPendingQuestion('call-3')).toBe(false);
  });

  it('double-resolve is a no-op: a second resolvePendingQuestion call for the same id does nothing', async () => {
    const { deps } = fakeDeps();
    setQuestionGateDeps(deps);

    const promise = requestUserQuestion('call-4', QUESTION);
    resolvePendingQuestion('call-4', 'first answer');
    const result = await promise;
    expect(result).toEqual({ kind: 'answered', answer: 'first answer' });

    // Second call — must not throw, and the (already-settled) promise's value
    // cannot change; hasPendingQuestion must stay false.
    expect(() => resolvePendingQuestion('call-4', 'second answer')).not.toThrow();
    expect(hasPendingQuestion('call-4')).toBe(false);
  });

  it('resolvePendingQuestion for a never-requested/unknown id is a no-op', () => {
    const { deps } = fakeDeps();
    setQuestionGateDeps(deps);

    expect(() => resolvePendingQuestion('never-requested', 'x')).not.toThrow();
  });

  it('hasPendingQuestion is false for an id that was never requested', () => {
    expect(hasPendingQuestion('nonexistent-id')).toBe(false);
  });
});
