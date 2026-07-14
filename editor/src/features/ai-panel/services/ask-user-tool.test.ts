import { describe, it, expect } from 'bun:test';
import {
  createAskUserTool,
  validateAskUserParams,
  formatAnswerResult,
  type AskUserParams,
  type QuestionAnswer,
  type RequestQuestionFn,
} from './ask-user-tool';

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('validateAskUserParams', () => {
  it('rejects a missing question', () => {
    const result = validateAskUserParams({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('question');
  });

  it('rejects an empty question', () => {
    const result = validateAskUserParams({ question: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('question');
  });

  it('rejects a whitespace-only question', () => {
    const result = validateAskUserParams({ question: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('question');
  });

  it('rejects exactly 1 option ("provide 2-4 options or none")', () => {
    const result = validateAskUserParams({ question: 'Pick one', options: [{ label: 'A' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain('provide 2-4 options or none');
  });

  it('rejects 5 options', () => {
    const result = validateAskUserParams({
      question: 'Pick one',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain('provide 2-4 options or none');
  });

  it('rejects duplicate labels (case-sensitive compare — exact duplicates only)', () => {
    const result = validateAskUserParams({
      question: 'Pick one',
      options: [{ label: 'Yes' }, { label: 'Yes' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Duplicate');
  });

  it('allows same-text labels differing only in case (case-sensitive compare)', () => {
    const result = validateAskUserParams({
      question: 'Pick one',
      options: [{ label: 'Yes' }, { label: 'yes' }],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an option with an empty label', () => {
    const result = validateAskUserParams({
      question: 'Pick one',
      options: [{ label: '' }, { label: 'B' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('label');
  });

  it('rejects an option with a whitespace-only label', () => {
    const result = validateAskUserParams({
      question: 'Pick one',
      options: [{ label: '  ' }, { label: 'B' }],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts 0 options (omitted entirely) — free-form question', () => {
    const result = validateAskUserParams({ question: 'What should I call this?' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.options).toBeUndefined();
  });

  it('accepts 2 options', () => {
    const result = validateAskUserParams({
      question: 'Pick one',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts 4 options', () => {
    const result = validateAskUserParams({
      question: 'Pick one',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an option with a description', () => {
    const result = validateAskUserParams({
      question: 'Pick one',
      options: [{ label: 'A', description: 'The first choice' }, { label: 'B' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.options?.[0].description).toBe('The first choice');
  });

  it('rejects allowMultiple without options', () => {
    const result = validateAskUserParams({ question: 'Pick some', allowMultiple: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('allowMultiple');
  });

  it('accepts allowMultiple with options', () => {
    const result = validateAskUserParams({
      question: 'Pick some',
      options: [{ label: 'A' }, { label: 'B' }],
      allowMultiple: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.allowMultiple).toBe(true);
  });
});

describe('formatAnswerResult', () => {
  it('formats an answered result', () => {
    const answer: QuestionAnswer = { kind: 'answered', answer: 'pick B' };
    expect(formatAnswerResult(answer)).toBe('User answered: pick B');
  });

  it('formats a cancelled result with the exact cancellation string', () => {
    const answer: QuestionAnswer = { kind: 'cancelled' };
    expect(formatAnswerResult(answer)).toBe('User cancelled the question (turn aborted).');
  });
});

describe('ask_user tool', () => {
  it('has the expected name, label, and a description explaining the blocking behavior', () => {
    const tool = createAskUserTool(async () => ({ kind: 'cancelled' }));
    expect(tool.name).toBe('ask_user');
    expect(tool.label).toContain('ask');
    expect(tool.description).toContain('BLOCKS');
  });

  it('answered: calls the injected request fn and returns its answer as normal (non-error) text', async () => {
    let calledWith: { toolCallId: string; params: AskUserParams; signal?: AbortSignal } | undefined;
    const request: RequestQuestionFn = async (toolCallId, params, signal) => {
      calledWith = { toolCallId, params, signal };
      return { kind: 'answered', answer: 'Use option B' };
    };
    const tool = createAskUserTool(request);
    const controller = new AbortController();

    const result = await tool.execute(
      'call-1',
      { question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] },
      controller.signal,
    );

    expect(calledWith?.toolCallId).toBe('call-1');
    expect(calledWith?.params).toEqual({
      question: 'Which approach?',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(calledWith?.signal).toBe(controller.signal);
    expect(textOf(result)).toBe('User answered: Use option B');
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('cancelled: the injected request resolving cancelled produces normal (non-error) result text — the model reads it, it is NOT isError', async () => {
    const request: RequestQuestionFn = async () => ({ kind: 'cancelled' });
    const tool = createAskUserTool(request);

    const result = await tool.execute('call-1', { question: 'Which approach?' });

    expect(textOf(result)).toBe('User cancelled the question (turn aborted).');
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('invalid params: returns isError:true and never calls the injected request', async () => {
    let called = false;
    const request: RequestQuestionFn = async () => {
      called = true;
      return { kind: 'cancelled' };
    };
    const tool = createAskUserTool(request);

    const result = await tool.execute('call-1', { question: '' });

    expect(called).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('Error');
  });

  it('invalid params (bad option count): returns isError:true and never calls the injected request', async () => {
    let called = false;
    const request: RequestQuestionFn = async () => {
      called = true;
      return { kind: 'cancelled' };
    };
    const tool = createAskUserTool(request);

    const result = await tool.execute('call-1', {
      question: 'Pick one',
      options: [{ label: 'A' }],
    });

    expect(called).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  // NOTE: the default `request` (no argument) reaches `question-gate.ts`,
  // which reaches the ai store via a dynamic import — deliberately NOT
  // exercised here, matching `todo-tool.test.ts`'s convention for this class
  // of tool (see its NOTE): `stores/ai.ts` pulls in a chain that throws
  // under Bun's DOM-less runtime. Every test above injects a fake `request`.
});
