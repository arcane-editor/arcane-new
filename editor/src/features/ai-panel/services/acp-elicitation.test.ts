import { describe, it, expect } from 'bun:test';
import {
  choicesFor,
  customAnswerParent,
  encodeAnswer,
  parseElicitationForm,
  questionTextFor,
  type ElicitationField,
} from './acp-elicitation';
import type { CreateElicitationParams } from '../../acp';

/**
 * The fixtures below are the shapes `askUserQuestionsToCreateRequest` in
 * @agentclientprotocol/claude-agent-acp 0.70.0 actually emits — indexed
 * `question_<n>` fields, a titled `oneOf` enum whose `const` is the option
 * label, and a `question_<n>_custom` free-text sibling marked in `_meta`.
 */
function askRequest(
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string; preview?: string }>;
  }>,
): CreateElicitationParams {
  const single = questions.length === 1;
  const properties: Record<string, unknown> = {};
  questions.forEach((q, i) => {
    const options = q.options.map((o) => ({
      const: o.label,
      title: o.label,
      ...(o.description ? { description: o.description } : {}),
      ...(o.preview
        ? { _meta: { '_claude/askUserQuestionOption': { preview: o.preview } } }
        : {}),
    }));
    properties[`question_${i}`] = q.multiSelect
      ? {
          type: 'array',
          title: q.header,
          description: single ? undefined : q.question,
          items: { anyOf: options },
        }
      : {
          type: 'string',
          title: q.header,
          description: single ? undefined : q.question,
          oneOf: options,
        };
    properties[`question_${i}_custom`] = {
      type: 'string',
      title: 'Other',
      description: 'Type your own answer instead of choosing an option above (optional).',
      _meta: {
        _askUserQuestionCustomAnswer: { questionId: `question_${i}`, isCustomAnswer: true },
      },
    };
  });
  return {
    mode: 'form',
    sessionId: 's1',
    toolCallId: 'toolu_1',
    message: single ? questions[0].question : 'Please answer the following questions.',
    requestedSchema: { type: 'object', properties: properties as never },
  };
}

describe('parseElicitationForm', () => {
  it('folds the "Other" box into its question instead of asking it separately', () => {
    const form = parseElicitationForm(
      askRequest([{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]),
    );
    // Two schema properties, ONE question — asking "Other" as its own question
    // is the bug this guards against.
    expect(form?.fields).toHaveLength(1);
    expect(form?.fields[0].key).toBe('question_0');
    expect(form?.fields[0].customKey).toBe('question_0_custom');
  });

  it('keeps multiple questions in order, each with its own choices', () => {
    const form = parseElicitationForm(
      askRequest([
        { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }] },
        { question: 'Which host?', header: 'Host', options: [{ label: 'Fly' }, { label: 'Render' }] },
      ]),
    );
    expect(form?.fields.map((f) => f.key)).toEqual(['question_0', 'question_1']);
    expect(form?.fields[1].choices?.map((c) => c.label)).toEqual(['Fly', 'Render']);
  });

  it('reads multi-select from the array item enum', () => {
    const form = parseElicitationForm(
      askRequest([
        { question: 'Which features?', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Billing' }] },
      ]),
    );
    expect(form?.fields[0].kind).toBe('multiselect');
    expect(form?.fields[0].choices?.map((c) => c.label)).toEqual(['Auth', 'Billing']);
  });

  it('carries an option description and preview through', () => {
    const form = parseElicitationForm(
      askRequest([
        {
          question: 'Which layout?',
          options: [{ label: 'Split', description: 'Two panes', preview: '+---+---+' }],
        },
      ]),
    );
    expect(form?.fields[0].choices?.[0]).toMatchObject({
      label: 'Split',
      description: 'Two panes',
      preview: '+---+---+',
    });
  });

  it('handles the plain shapes an MCP server sends, not just Claude\'s', () => {
    const form = parseElicitationForm({
      mode: 'form',
      message: 'Connect to the server',
      requestedSchema: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', title: 'API token' },
          region: { type: 'string', enum: ['us', 'eu'] },
          retries: { type: 'integer', title: 'Retries' },
          verbose: { type: 'boolean', title: 'Verbose' },
        },
      },
    });
    expect(form?.fields.map((f) => [f.key, f.kind])).toEqual([
      ['token', 'text'],
      ['region', 'select'],
      ['retries', 'number'],
      ['verbose', 'boolean'],
    ]);
    expect(form?.fields[0].required).toBe(true);
    expect(form?.fields[1].choices?.map((c) => c.value)).toEqual(['us', 'eu']);
  });

  it('asks an unknown future field type as free text rather than dropping it', () => {
    const form = parseElicitationForm({
      mode: 'form',
      message: 'Pick a colour',
      requestedSchema: { type: 'object', properties: { shade: { type: 'colour' } as never } },
    });
    expect(form?.fields[0].kind).toBe('text');
  });

  it('returns null when there is nothing to ask', () => {
    expect(parseElicitationForm({ mode: 'form', message: 'hi' })).toBeNull();
    expect(
      parseElicitationForm({ mode: 'form', message: 'hi', requestedSchema: { properties: {} } }),
    ).toBeNull();
    // A schema of nothing BUT custom-answer fields has no question to anchor them.
    expect(
      parseElicitationForm({
        mode: 'form',
        message: 'hi',
        requestedSchema: {
          properties: {
            question_0_custom: {
              type: 'string',
              _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0' } },
            },
          },
        },
      }),
    ).toBeNull();
  });
});

describe('customAnswerParent', () => {
  it('recognises the adapter marker and ignores anything else', () => {
    expect(
      customAnswerParent({
        type: 'string',
        _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_2' } },
      }),
    ).toBe('question_2');
    expect(customAnswerParent({ type: 'string' })).toBeNull();
    expect(customAnswerParent({ type: 'string', _meta: { other: {} } })).toBeNull();
  });
});

describe('questionTextFor', () => {
  it('uses the elicitation message for a single question, not the field title', () => {
    const form = parseElicitationForm(
      askRequest([{ question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }] }]),
    )!;
    // Rendering "DB" under "Which database?" would say it twice.
    expect(questionTextFor(form, form.fields[0])).toBe('Which database?');
  });

  it('uses each field\'s own question when there are several', () => {
    const form = parseElicitationForm(
      askRequest([
        { question: 'Which database?', options: [{ label: 'Postgres' }] },
        { question: 'Which host?', options: [{ label: 'Fly' }] },
      ]),
    )!;
    expect(questionTextFor(form, form.fields[1])).toBe('Which host?');
  });
});

describe('encodeAnswer', () => {
  const select: ElicitationField = {
    key: 'question_0',
    kind: 'select',
    customKey: 'question_0_custom',
    required: false,
    choices: [
      { label: 'Postgres', value: 'Postgres' },
      { label: 'SQLite', value: 'SQLite' },
    ],
  };

  it('sends a picked option in the enum slot', () => {
    expect(encodeAnswer(select, 'SQLite')).toEqual({ question_0: 'SQLite' });
  });

  it('routes a typed answer to the "Other" slot, never the enum slot', () => {
    // The regression this locks in: free text in the enum slot reads back as an
    // invalid selection and the agent drops the answer entirely.
    expect(encodeAnswer(select, 'DuckDB, actually')).toEqual({
      question_0_custom: 'DuckDB, actually',
    });
  });

  it('treats an empty answer as nothing to send', () => {
    expect(encodeAnswer(select, '   ')).toEqual({});
  });

  it('sends a multi-select as an array of values', () => {
    const field: ElicitationField = {
      key: 'question_0',
      kind: 'multiselect',
      required: false,
      choices: [
        { label: 'Auth', value: 'Auth' },
        { label: 'Billing', value: 'Billing' },
      ],
    };
    expect(encodeAnswer(field, 'Auth, Billing')).toEqual({ question_0: ['Auth', 'Billing'] });
  });

  it('coerces a boolean field from a picked chip or a typed yes', () => {
    const field: ElicitationField = { key: 'verbose', kind: 'boolean', required: false };
    expect(choicesFor(field)?.map((c) => c.label)).toEqual(['Yes', 'No']);
    expect(encodeAnswer(field, 'Yes')).toEqual({ verbose: true });
    expect(encodeAnswer(field, 'No')).toEqual({ verbose: false });
    expect(encodeAnswer(field, 'y')).toEqual({ verbose: true });
  });

  it('sends a number as a number, and keeps unparseable text as text', () => {
    const field: ElicitationField = { key: 'retries', kind: 'number', required: false };
    expect(encodeAnswer(field, '3')).toEqual({ retries: 3 });
    expect(encodeAnswer(field, 'as many as it takes')).toEqual({
      retries: 'as many as it takes',
    });
  });

  it('sends free text for a plain string field with no "Other" sibling', () => {
    const field: ElicitationField = { key: 'token', kind: 'text', required: true };
    expect(encodeAnswer(field, 'sk-123')).toEqual({ token: 'sk-123' });
  });

  it('matches an option by its value when the label differs', () => {
    const field: ElicitationField = {
      key: 'region',
      kind: 'select',
      required: false,
      choices: [{ label: 'United States', value: 'us' }],
    };
    expect(encodeAnswer(field, 'United States')).toEqual({ region: 'us' });
    expect(encodeAnswer(field, 'us')).toEqual({ region: 'us' });
  });
});
