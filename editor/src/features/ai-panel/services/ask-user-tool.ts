/**
 * `ask_user` — in-loop question tool: lets the model pause mid-turn to ask
 * the user a question (free-form or multiple-choice) and continue with their
 * answer, instead of guessing on a decision that's genuinely the user's to
 * make. Complements `todo_update`'s "keep the user informed" loop with "stop
 * and ask" for the cases where guessing risks wasted work.
 *
 * Bun-safe by construction: this module has NO store import at module scope,
 * so it (and its default `request`) can be constructed directly under Bun —
 * mirroring `todo-tool.ts`'s DI seam. The production default reaches
 * `question-gate.ts` (which owns the pending-question map and the store
 * wiring) via a dynamic import; every test in this file injects a fake
 * `request` instead.
 */

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from './vendor/types';

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserParams {
  question: string;
  options?: AskUserOption[];
  allowMultiple?: boolean;
}

export type QuestionAnswer = { kind: 'answered'; answer: string } | { kind: 'cancelled' };

export type RequestQuestionFn = (
  toolCallId: string,
  params: AskUserParams,
  signal?: AbortSignal,
) => Promise<QuestionAnswer>;

const askUserSchema = Type.Object({
  question: Type.String({ description: 'The question to ask the user. Be specific and concise.' }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String({ description: 'Short answer choice (1-5 words).' }),
        description: Type.Optional(Type.String({ description: 'One-line explanation of this choice.' })),
      }),
      { description: '2-4 suggested answers rendered as buttons. Omit for a free-form question.' },
    ),
  ),
  allowMultiple: Type.Optional(
    Type.Boolean({ description: 'Allow selecting several options (only with options).' }),
  ),
});

function txt(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * `AgentToolResult` shape for the "invalid params" branch — an extra
 * `isError` marker, since `vendor/types.ts` (READ-ONLY) doesn't carry one on
 * `AgentToolResult` itself. Mirrors `write-approval-gate.ts`'s
 * `WriteApprovalResult`/`rejected` extension for the same reason.
 */
interface AskUserErrorResult extends AgentToolResult {
  isError: true;
}

function errorResult(error: string): AskUserErrorResult {
  return { content: [{ type: 'text', text: `Error: ${error}` }], isError: true };
}

/**
 * Validate raw tool-call args before they ever reach the question gate.
 * Pulled into its own function (rather than inlined in `execute`, like
 * `todo-tool.ts` does) because the option-count/duplicate-label rules are
 * involved enough to want isolated test coverage.
 */
export function validateAskUserParams(
  raw: unknown,
): { ok: true; params: AskUserParams } | { ok: false; error: string } {
  const r = raw as Partial<AskUserParams> | null | undefined;

  if (!r || typeof r.question !== 'string' || r.question.trim() === '') {
    return { ok: false, error: 'Missing or empty "question" string.' };
  }

  const options = r.options;
  if (options !== undefined) {
    if (!Array.isArray(options)) {
      return { ok: false, error: '"options" must be an array of { label, description? }.' };
    }
    if (options.length === 1 || options.length > 4) {
      return { ok: false, error: 'Provide 2-4 options or none.' };
    }
    const seenLabels = new Set<string>();
    for (let i = 0; i < options.length; i++) {
      const opt = options[i] as Partial<AskUserOption> | null | undefined;
      if (!opt || typeof opt.label !== 'string' || opt.label.trim() === '') {
        return { ok: false, error: `Option ${i + 1} is missing a non-empty "label" string.` };
      }
      if (seenLabels.has(opt.label)) {
        return { ok: false, error: `Duplicate option label: ${JSON.stringify(opt.label)}.` };
      }
      seenLabels.add(opt.label);
    }
  }

  if (r.allowMultiple && options === undefined) {
    return { ok: false, error: '"allowMultiple" requires "options" to be set.' };
  }

  return {
    ok: true,
    params: {
      question: r.question,
      ...(options !== undefined ? { options: options as AskUserOption[] } : {}),
      ...(r.allowMultiple !== undefined ? { allowMultiple: r.allowMultiple } : {}),
    },
  };
}

/** Render the final tool-result text for a resolved question. */
export function formatAnswerResult(a: QuestionAnswer): string {
  return a.kind === 'answered'
    ? `User answered: ${a.answer}`
    : 'User cancelled the question (turn aborted).';
}

/**
 * Production default: hands off to `question-gate.ts`'s pending-question map
 * and store wiring. Loaded via dynamic import so this file stays statically
 * Bun-safe — see the module doc comment.
 */
async function defaultRequest(
  toolCallId: string,
  params: AskUserParams,
  signal?: AbortSignal,
): Promise<QuestionAnswer> {
  const { requestUserQuestion } = await import('./question-gate');
  return requestUserQuestion(toolCallId, params, signal);
}

/**
 * `request` is injectable (tests inject a fake instead of exercising the real
 * gate/store). Defaults to `defaultRequest` for production use.
 */
export function createAskUserTool(request: RequestQuestionFn = defaultRequest): AgentTool {
  return {
    name: 'ask_user',
    label: 'ask the user',
    description:
      'Ask the user a question when a decision is genuinely theirs to make, or requirements are ' +
      'ambiguous enough that guessing risks wasted work. This call BLOCKS until the user answers — ' +
      "the tool result is the user's answer (or a cancellation, if they abort the turn instead of " +
      'answering). Provide 2-4 short `options` for a multiple-choice question, or omit `options` for ' +
      'free-form input.',
    parameters: askUserSchema,
    async execute(toolCallId, raw, signal): Promise<AgentToolResult> {
      const validated = validateAskUserParams(raw);
      if (!validated.ok) {
        return errorResult(validated.error);
      }

      const answer = await request(toolCallId, validated.params, signal);
      return txt(formatAnswerResult(answer));
    },
  };
}
