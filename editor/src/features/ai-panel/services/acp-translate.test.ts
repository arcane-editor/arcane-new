import { describe, it, expect } from 'bun:test';
import {
  contentToText,
  dataUrlToBase64,
  extractDiffs,
  extractTerminalIds,
  planEntriesFor,
  stopReasonFor,
  toolDisplayName,
  toolStatusFor,
  reconcileToolCall,
  CLIENT_CAPABILITIES,
  configOptionPayload,
} from './acp-translate';

describe('contentToText', () => {
  it('joins text blocks in order', () => {
    expect(
      contentToText([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ]),
    ).toBe('Hello world');
  });

  it('accepts a bare block or a bare string', () => {
    expect(contentToText({ type: 'text', text: 'solo' })).toBe('solo');
    expect(contentToText('raw')).toBe('raw');
  });

  it('summarises non-text blocks instead of dropping them', () => {
    // A turn whose only output was an image must not render as an empty bubble.
    expect(contentToText([{ type: 'image', data: 'AAA', mimeType: 'image/png' }])).toBe('[image]');
    expect(
      contentToText([{ type: 'resource_link', uri: 'file:///a/b.cs', name: 'b.cs' }]),
    ).toBe('b.cs');
  });

  it('reads embedded resource text', () => {
    expect(
      contentToText([{ type: 'resource', resource: { uri: 'file:///a', text: 'contents' } }]),
    ).toBe('contents');
  });

  it('survives every shape a newer agent could send', () => {
    expect(contentToText(null)).toBe('');
    expect(contentToText(undefined)).toBe('');
    expect(contentToText([])).toBe('');
    expect(contentToText([null, 42, { nope: true }] as unknown)).toBe('');
    // Unknown type carrying text: keep the text rather than invent a label.
    expect(contentToText([{ type: 'future_thing', text: 'still readable' }])).toBe('still readable');
  });
});

describe('extractDiffs', () => {
  it('reads a diff block', () => {
    expect(
      extractDiffs([
        { type: 'content', content: { type: 'text', text: 'noise' } },
        { type: 'diff', path: '/p/a.cs', oldText: 'old', newText: 'new' },
      ]),
    ).toEqual([{ path: '/p/a.cs', oldText: 'old', newText: 'new' }]);
  });

  it('treats a null oldText as a file that did not exist', () => {
    expect(extractDiffs([{ type: 'diff', path: '/p/new.cs', oldText: null, newText: 'x' }])).toEqual([
      { path: '/p/new.cs', oldText: '', newText: 'x' },
    ]);
  });

  it('ignores malformed entries rather than throwing', () => {
    expect(extractDiffs(undefined)).toEqual([]);
    expect(extractDiffs([{ type: 'diff' } as never])).toEqual([]);
    expect(extractDiffs([null as never, 'x' as never])).toEqual([]);
  });
});

describe('extractTerminalIds', () => {
  it('finds embedded terminals and ignores everything else', () => {
    expect(
      extractTerminalIds([
        { type: 'terminal', terminalId: 'term_1' },
        { type: 'diff', path: '/a', oldText: '', newText: '' },
        { type: 'terminal' } as never,
      ]),
    ).toEqual(['term_1']);
  });
});

describe('toolStatusFor', () => {
  it('maps every status ACP defines', () => {
    expect(toolStatusFor('pending')).toBe('pending');
    expect(toolStatusFor('in_progress')).toBe('running');
    expect(toolStatusFor('completed')).toBe('complete');
    expect(toolStatusFor('failed')).toBe('error');
  });

  it('treats an unknown status as still running, never as complete', () => {
    // Guessing "complete" would mark work as finished that is still going.
    expect(toolStatusFor('paused')).toBe('running');
    expect(toolStatusFor(undefined)).toBe('running');
  });
});

describe('stopReasonFor', () => {
  it('maps the documented reasons', () => {
    expect(stopReasonFor('end_turn')).toBe('stop');
    expect(stopReasonFor('max_tokens')).toBe('length');
    expect(stopReasonFor('max_turn_requests')).toBe('toolUse');
    expect(stopReasonFor('cancelled')).toBe('aborted');
  });

  it('treats a refusal as a completed turn, not an error', () => {
    // The agent finished and declined. Rendering that as a failure would offer
    // a Retry that cannot succeed.
    expect(stopReasonFor('refusal')).toBe('stop');
  });

  it('falls back to stop for anything unrecognised', () => {
    expect(stopReasonFor('something_new')).toBe('stop');
    expect(stopReasonFor(undefined)).toBe('stop');
  });
});

describe('planEntriesFor', () => {
  it('maps ACP statuses onto the panel list', () => {
    expect(
      planEntriesFor([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
        { content: 'd' },
      ]),
    ).toEqual([
      { text: 'a', status: 'done' },
      { text: 'b', status: 'in_progress' },
      { text: 'c', status: 'pending' },
      { text: 'd', status: 'pending' },
    ]);
  });

  it('drops entries with no content and survives junk', () => {
    expect(planEntriesFor(undefined)).toEqual([]);
    expect(planEntriesFor([{ status: 'pending' } as never])).toEqual([]);
  });
});

describe('toolDisplayName', () => {
  it('prefers the agent-written title', () => {
    expect(toolDisplayName({ title: 'Read src/Player.cs', kind: 'read' })).toBe('Read src/Player.cs');
  });

  it('falls back through kind to a generic label', () => {
    expect(toolDisplayName({ kind: 'execute' })).toBe('execute');
    expect(toolDisplayName({ title: '   ' })).toBe('tool');
    expect(toolDisplayName({})).toBe('tool');
  });
});

describe('dataUrlToBase64', () => {
  it('strips the data URL prefix ACP does not accept', () => {
    expect(dataUrlToBase64('data:image/png;base64,AAAB')).toBe('AAAB');
  });

  it('passes through bare base64 unchanged', () => {
    expect(dataUrlToBase64('AAAB')).toBe('AAAB');
  });
});

describe('reconcileToolCall', () => {
  // Shapes taken verbatim from a live @agentclientprotocol/claude-agent-acp
  // 0.70.0 turn: the call opens generic and is filled in one update later.
  const opening = { title: 'Terminal', kind: 'execute' as const, rawInput: {} };
  const filledIn = {
    title: "printf 'ok' > probe.txt && od -c probe.txt",
    kind: 'execute' as const,
    rawInput: { command: "printf 'ok' > probe.txt && od -c probe.txt" },
  };

  it('adopts the real command once the agent streams it in', () => {
    const first = reconcileToolCall(opening, {});
    expect(first).toMatchObject({ name: 'Terminal', args: {}, changed: true });

    const second = reconcileToolCall(filledIn, { name: first.name, args: first.args });
    expect(second.name).toBe("printf 'ok' > probe.txt && od -c probe.txt");
    expect(second.args).toEqual({ command: "printf 'ok' > probe.txt && od -c probe.txt" });
    expect(second.changed).toBe(true);
  });

  it('does not blank out arguments an update simply did not repeat', () => {
    const args = { command: 'ls -la' };
    const next = reconcileToolCall(
      { title: 'ls -la', kind: 'execute', rawInput: undefined },
      { name: 'ls -la', args },
    );
    expect(next.args).toBe(args);
    expect(next.changed).toBe(false);
  });

  it('reports no change when an update repeats what is already rendered', () => {
    const known = { name: 'Read', args: { path: 'a.ts' } };
    const next = reconcileToolCall(
      { title: 'Read', kind: 'read', rawInput: known.args },
      known,
    );
    expect(next.changed).toBe(false);
  });

  it('names a call that arrives with no title at all', () => {
    expect(reconcileToolCall({ kind: 'edit', rawInput: {} }, {}).name).not.toBe('');
  });

  it('ignores a non-object rawInput rather than rendering junk', () => {
    const next = reconcileToolCall(
      { title: 'Bash', kind: 'execute', rawInput: 'not an object' as never },
      {},
    );
    expect(next.args).toEqual({});
  });
});

describe('CLIENT_CAPABILITIES', () => {
  // These are not descriptions of UnityIDE, they are switches on the agent. Each
  // assertion below names a feature that disappears — with no error anywhere —
  // if the capability stops being advertised.
  it('advertises form elicitation, or the agent stops asking questions entirely', () => {
    expect(CLIENT_CAPABILITIES.elicitation.form).toBeDefined();
  });

  it('advertises boolean config options, or Fast mode degrades to a select', () => {
    expect(CLIENT_CAPABILITIES.session.configOptions.boolean).toBeDefined();
  });

  it('advertises fs, or edits bypass checkpoints, review and the sandbox', () => {
    expect(CLIENT_CAPABILITIES.fs).toEqual({ readTextFile: true, writeTextFile: true });
  });

  it('advertises terminal auth in both spellings', () => {
    expect(CLIENT_CAPABILITIES.auth.terminal).toBe(true);
    expect(CLIENT_CAPABILITIES._meta['terminal-auth']).toBe(true);
  });
});

describe('configOptionPayload', () => {
  it('tags a boolean with its type, which the agent requires', () => {
    // Without `type` the agent answers -32602 "expected string, received
    // boolean" and the toggle silently never applies.
    expect(configOptionPayload('s1', 'fast', true)).toEqual({
      sessionId: 's1',
      configId: 'fast',
      type: 'boolean',
      value: true,
    });
  });

  it('sends a select value untagged, as the string variant expects', () => {
    expect(configOptionPayload('s1', 'mode', 'plan')).toEqual({
      sessionId: 's1',
      configId: 'mode',
      value: 'plan',
    });
  });
});
