import { describe, it, expect } from 'bun:test';
import {
  buildDesignRows,
  describeAction,
  designStatusLine,
  type DesignRow,
} from './design-rows';
import type { AiMessage, ToolCallStatus } from '../../../stores/ai';

const NO_CALLS = new Map<string, ToolCallStatus>();

function user(id: string, text: string): AiMessage {
  return { id, role: 'user', text, timestamp: 0 };
}

function assistant(id: string, content: AiMessage['content']): AiMessage {
  return { id, role: 'assistant', text: '', content, timestamp: 0 };
}

function text(t: string) {
  return { type: 'text' as const, text: t };
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { type: 'toolCall' as const, id, name, arguments: args };
}

function kinds(rows: DesignRow[]): string[] {
  return rows.map((r) => r.kind);
}

describe('describeAction', () => {
  it('gives the design tools a verb, a subject and a measurement', () => {
    expect(describeAction({ name: 'unity_ui_write', args: { path: 'Assets/UI/Main.uss' } })).toEqual({
      verb: 'wrote',
      subject: 'Main.uss',
      detail: null,
    });
    expect(describeAction({ name: 'unity_ui_layout', args: { document: 'Assets/UI/Main.uxml' } })).toEqual({
      verb: 'laid out',
      subject: 'Main.uxml',
      detail: null,
    });
  });

  it('counts the lines a write changed, once the diffs land', () => {
    const status: ToolCallStatus = {
      id: 't1',
      name: 'unity_ui_write',
      args: {},
      status: 'complete',
      diffs: [{ path: 'a.uss', oldText: 'a\nb', newText: 'a\nb\nc\nd' }],
    };
    const row = describeAction({ name: 'unity_ui_write', args: { path: 'a.uss' } }, status);
    expect(row.detail).toBe('+2');
  });

  it('falls back to the injected label for a tool it has no column for', () => {
    const row = describeAction({ name: 'get_console_errors', args: {} }, undefined, () =>
      'Checked Unity console',
    );
    expect(row.verb).toBe('');
    expect(row.subject).toBe('Checked Unity console');
  });

  it('falls back to the raw tool name when no label function was injected', () => {
    // Never a blank row: an unlabelled action still has to say something
    // happened.
    expect(describeAction({ name: 'get_console_errors', args: {} }).subject).toBe(
      'get_console_errors',
    );
  });
});

describe('buildDesignRows', () => {
  it('promotes the opening line of a turn to the direction, and keeps the rest as prose', () => {
    const rows = buildDesignRows(
      [
        user('u1', 'make the buttons feel heavier'),
        assistant('a1', [text('Ash and ember: weight from density, not glow.\n\nHere is what changed.')]),
      ],
      NO_CALLS,
    );
    expect(kinds(rows)).toEqual(['request', 'direction', 'prose']);
    expect(rows[1]).toMatchObject({ text: 'Ash and ember: weight from density, not glow.' });
    expect(rows[2]).toMatchObject({ text: 'Here is what changed.' });
  });

  it('does not mistake a heading or a list item for a direction', () => {
    const rows = buildDesignRows([assistant('a1', [text('## Changes\n- one')])], NO_CALLS);
    expect(kinds(rows)).toEqual(['prose']);
  });

  it('does not mistake a long paragraph for a direction', () => {
    const long = 'x'.repeat(200);
    const rows = buildDesignRows([assistant('a1', [text(long)])], NO_CALLS);
    expect(kinds(rows)).toEqual(['prose']);
  });

  it('treats only the first text block of a turn as a possible direction', () => {
    const rows = buildDesignRows(
      [
        assistant('a1', [
          text('Warm ash, one rule.'),
          call('t1', 'unity_ui_write', { path: 'Assets/UI/Main.uss' }),
          text('Done.'),
        ]),
      ],
      NO_CALLS,
    );
    expect(kinds(rows)).toEqual(['direction', 'action', 'prose']);
  });

  it('carries a running call’s live status onto its row', () => {
    const calls = new Map<string, ToolCallStatus>([
      ['t1', { id: 't1', name: 'unity_ui_layout', args: {}, status: 'running' }],
    ]);
    const rows = buildDesignRows(
      [assistant('a1', [call('t1', 'unity_ui_layout', { document: 'A.uxml' })])],
      calls,
    );
    expect(rows[0]).toMatchObject({ kind: 'action', status: 'running' });
  });

  it('reports a failed turn rather than ending the log in silence', () => {
    const rows = buildDesignRows(
      [
        {
          id: 'e1',
          role: 'error',
          text: '',
          timestamp: 0,
          turnError: { kind: 'network', title: 'Network error', raw: '', retriable: true },
        },
      ],
      NO_CALLS,
    );
    expect(rows).toEqual([
      {
        kind: 'notice',
        id: 'e1',
        tone: 'error',
        text: 'Network error',
        detail: null,
        raw: null,
      },
    ]);
  });

  it('leaves the interactive cards to the AI panel, which can actually answer them', () => {
    const rows = buildDesignRows(
      [
        { id: 'p1', role: 'permissionRequest', text: '', timestamp: 0 },
        { id: 'q1', role: 'questionRequest', text: '', timestamp: 0 },
        { id: 'v1', role: 'verifiedPass', text: '', timestamp: 0 },
      ],
      NO_CALLS,
    );
    expect(rows).toEqual([]);
  });

  it('handles a plain-text assistant message that never streamed content blocks', () => {
    const rows = buildDesignRows(
      [{ id: 'a1', role: 'assistant', text: 'One line only.', timestamp: 0 }],
      NO_CALLS,
    );
    expect(kinds(rows)).toEqual(['direction']);
  });
});

describe('designStatusLine', () => {
  it('says nothing at all when no turn is running', () => {
    expect(designStatusLine([], false)).toBeNull();
  });

  it('adds nothing while a running action row is already saying it', () => {
    // The row has the spinner and the name; a second line underneath repeating
    // it reads as a duplicate rather than as a status.
    const rows = buildDesignRows(
      [assistant('a1', [call('t1', 'unity_ui_layout', { document: 'Assets/UI/Main.uxml' })])],
      new Map([['t1', { id: 't1', name: 'unity_ui_layout', args: {}, status: 'running' }]]),
    );
    expect(designStatusLine(rows, true)).toBeNull();
  });

  it('covers the state the rows cannot show — running, with nothing in flight', () => {
    const rows = buildDesignRows(
      [assistant('a1', [call('t1', 'unity_ui_write', { path: 'a.uss' }), text('Done writing.')])],
      new Map([['t1', { id: 't1', name: 'unity_ui_write', args: {}, status: 'complete' }]]),
    );
    expect(designStatusLine(rows, true)).toBe('Thinking…');
  });

  it('falls back to thinking before the first tool call, which is a real state', () => {
    expect(designStatusLine([{ kind: 'request', id: 'u1', text: 'hi' }], true)).toBe('Thinking…');
  });

  it('does not report a finished call as still in progress', () => {
    const rows = buildDesignRows(
      [assistant('a1', [call('t1', 'unity_ui_write', { path: 'a.uss' })])],
      new Map([['t1', { id: 't1', name: 'unity_ui_write', args: {}, status: 'complete' }]]),
    );
    expect(designStatusLine(rows, true)).toBe('Thinking…');
  });
});

describe('the verified row', () => {
  it('reports what the closing pass measured', () => {
    const rows = buildDesignRows(
      [
        {
          id: 'v1',
          role: 'verifiedPass',
          text: '',
          timestamp: 0,
          verifiedPass: {
            files: 2,
            touchedFiles: [],
            analyzers: 'skipped',
            compile: 'skipped',
            guids: 'skipped',
            uiToolkit: 'clean',
            scriptableObjects: 'skipped',
            input: 'skipped',
            layout: { documents: 1, elements: 14, problems: 2, unstyled: 0 },
            console: 'skipped',
            tests: 'skipped',
          },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toEqual({
      kind: 'verified',
      id: 'v1',
      elements: 14,
      problems: 2,
      unstyled: 0,
      files: 2,
    });
  });

  it('carries the unstyled count, the failure a clean geometry pass hides', () => {
    const rows = buildDesignRows(
      [
        {
          id: 'v1',
          role: 'verifiedPass',
          text: '',
          timestamp: 0,
          verifiedPass: {
            files: 2,
            touchedFiles: [],
            analyzers: 'skipped',
            compile: 'skipped',
            guids: 'skipped',
            uiToolkit: 'clean',
            scriptableObjects: 'skipped',
            input: 'skipped',
            layout: { documents: 1, elements: 14, problems: 0, unstyled: 9 },
            console: 'skipped',
            tests: 'skipped',
          },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toMatchObject({ kind: 'verified', unstyled: 9, problems: 0 });
  });

  it('reports a card saved before the count existed as unknown, not as zero', () => {
    // A restored session must not claim a measurement it never took.
    const rows = buildDesignRows(
      [
        {
          id: 'v1',
          role: 'verifiedPass',
          text: '',
          timestamp: 0,
          verifiedPass: {
            files: 1,
            touchedFiles: [],
            analyzers: 'skipped',
            compile: 'skipped',
            guids: 'skipped',
            uiToolkit: 'clean',
            scriptableObjects: 'skipped',
            input: 'skipped',
            layout: { documents: 1, elements: 14, problems: 0 },
            console: 'skipped',
            tests: 'skipped',
          },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toMatchObject({ kind: 'verified', unstyled: null });
  });

  it('reports an unmeasured layout as unmeasured, not as zero problems', () => {
    const rows = buildDesignRows(
      [
        {
          id: 'v1',
          role: 'verifiedPass',
          text: '',
          timestamp: 0,
          verifiedPass: {
            files: 1,
            touchedFiles: [],
            analyzers: 'skipped',
            compile: 'skipped',
            guids: 'skipped',
            uiToolkit: 'skipped',
            scriptableObjects: 'skipped',
            input: 'skipped',
            layout: 'skipped',
            console: 'skipped',
            tests: 'skipped',
          },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toMatchObject({ elements: null, problems: null });
  });
});

describe('the blocking gates — the rows the loop waits on', () => {
  // `ask_user` and every engine approval hold the turn open with
  // `timeoutMs: Infinity`. These rows were originally dropped here "because the
  // AI panel owns their interactive affordances", and the result was an agent
  // that hung: the person using the dock is looking at the canvas, and the
  // panel may not even be open.

  it('surfaces a pending question, so a blocked turn is visible where it blocked', () => {
    const rows = buildDesignRows(
      [
        {
          id: 'q1',
          role: 'questionRequest',
          text: '',
          timestamp: 0,
          questionRequest: {
            toolCallId: 'tc1',
            question: 'Which menu should this replace?',
            options: [{ label: 'Main menu' }, { label: 'Pause menu' }],
          },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toMatchObject({
      kind: 'question',
      toolCallId: 'tc1',
      question: 'Which menu should this replace?',
      answer: null,
      cancelled: false,
    });
  });

  it('carries the answer once given, so the row locks instead of asking twice', () => {
    const rows = buildDesignRows(
      [
        {
          id: 'q1',
          role: 'questionRequest',
          text: '',
          timestamp: 0,
          questionRequest: { toolCallId: 'tc1', question: 'Which?', resolvedAnswer: 'Main menu' },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toMatchObject({ answer: 'Main menu' });
  });

  it('says a question died with its turn rather than leaving it looking live', () => {
    const rows = buildDesignRows(
      [
        {
          id: 'q1',
          role: 'questionRequest',
          text: '',
          timestamp: 0,
          questionRequest: { toolCallId: 'tc1', question: 'Which?', cancelled: true },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toMatchObject({ cancelled: true });
  });

  it('surfaces an approval with its options, so scene wiring cannot hang either', () => {
    const rows = buildDesignRows(
      [
        {
          id: 'p1',
          role: 'permissionRequest',
          text: '',
          timestamp: 0,
          permissionRequest: {
            toolCallId: 'tc2',
            toolName: 'unity_attach_ui_document',
            detail: 'attach a UIDocument to Canvas',
            options: [
              { optionId: 'a', name: 'Allow', kind: 'allow_once' },
              { optionId: 'r', name: 'Reject', kind: 'reject_once' },
            ],
          },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toMatchObject({
      kind: 'permission',
      toolCallId: 'tc2',
      detail: 'attach a UIDocument to Canvas',
      resolvedOptionId: null,
    });
  });

  it('falls back to the tool name when an approval carries no verb summary', () => {
    // The file-write approval path sets no `detail`; "this action" would tell
    // the user nothing about what they are allowing.
    const rows = buildDesignRows(
      [
        {
          id: 'p1',
          role: 'permissionRequest',
          text: '',
          timestamp: 0,
          permissionRequest: { toolCallId: 'tc2', toolName: 'write', options: [] },
        },
      ],
      NO_CALLS,
    );
    expect(rows[0]).toMatchObject({ detail: 'write' });
  });
});

describe('a failed turn has to be readable where it failed', () => {
  // The dock originally rendered `turnError.title` alone, so a design turn that
  // died showed the word "Server error" and nothing else — the provider's own
  // message was in the store the whole time. A failure the user cannot read is
  // a failure nobody can fix.
  function errorRow(turnError: Record<string, unknown>) {
    return buildDesignRows(
      [{ id: 'e1', role: 'error', text: '', timestamp: 0, turnError } as never],
      NO_CALLS,
    )[0];
  }

  it('carries the guidance and the provider’s own wording', () => {
    expect(
      errorRow({
        kind: 'server',
        title: 'Server error',
        detail: 'This is usually temporary — try again in a moment.',
        raw: 'model_error: content parts must not be empty',
        retriable: true,
      }),
    ).toMatchObject({
      text: 'Server error',
      detail: 'This is usually temporary — try again in a moment.',
      raw: 'model_error: content parts must not be empty',
    });
  });

  it('offers no details toggle when the raw text only repeats the title', () => {
    expect(
      errorRow({ kind: 'server', title: 'Server error', raw: 'Server error', retriable: true }),
    ).toMatchObject({ raw: null });
  });

  it('falls back to the plain message when there is no classified error', () => {
    const row = buildDesignRows(
      [{ id: 'e1', role: 'error', text: '', timestamp: 0, errorMessage: 'Something broke' }],
      NO_CALLS,
    )[0];
    expect(row).toMatchObject({ text: 'Something broke', raw: null });
  });
});
