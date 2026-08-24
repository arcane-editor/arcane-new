import { describe, it, expect } from 'bun:test';
import { convertToOpenAI } from './openai-format';

describe('convertToOpenAI', () => {
  it('emits system + user + assistant tool_calls + tool results', () => {
    const out = convertToOpenAI('SYS', [
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'assistant', timestamp: 2, stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.cs' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: '1  code', isError: false, timestamp: 3 },
    ] as never);
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out[2].tool_calls?.[0].function.name).toBe('read');
    expect(JSON.parse(out[2].tool_calls![0].function.arguments)).toEqual({ path: 'a.cs' });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '1  code' });
  });

  // A turn that errored, was aborted, or was restored from a persisted session
  // can carry null/absent content. The type says it can't, but the runtime
  // disagrees, and `convertToOpenAI` runs before the fetch — so one such
  // message threw "Cannot read properties of null (reading 'filter')" and
  // killed the send before it ever reached the network.
  it('survives null content on every role', () => {
    const out = convertToOpenAI('SYS', [
      { role: 'user', content: null, timestamp: 1 },
      { role: 'assistant', content: null, timestamp: 2, stopReason: 'stop' },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: null, isError: false, timestamp: 3 },
    ] as never);
    expect(out[1]).toEqual({ role: 'user', content: '' });
    expect(out[2]).toEqual({ role: 'assistant', content: null, tool_calls: undefined });
    // The null-content assistant carries no tool_calls, so the toolResult is a
    // stray — orphan repair DROPS it (a tool message with no preceding
    // tool_call 400s at the provider, same as the orphaned-call direction).
    expect(out).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Orphaned tool-call repair (agent-reliability fix): an abort or mid-stream
// error can leave an assistant message with tool_calls and no matching
// results. OpenAI-compatible providers 400 on that, permanently poisoning the
// conversation — every later send fails. convertToOpenAI must repair.
// ---------------------------------------------------------------------------
describe('convertToOpenAI orphan repair', () => {
  it('synthesizes a result for a tool_call with no matching toolResult', () => {
    const out = convertToOpenAI('SYS', [
      { role: 'user', content: 'go', timestamp: 1 },
      {
        role: 'assistant', timestamp: 2, stopReason: 'aborted',
        content: [
          { type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'a.cs' } },
          { type: 'toolCall', id: 'c2', name: 'write', arguments: { path: 'b.cs' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'write', content: 'ok', isError: false, timestamp: 3 },
      { role: 'user', content: 'restart', timestamp: 4 },
    ] as never);

    // system, user, assistant, tool(c1), synthesized tool(c2), user
    expect(out).toHaveLength(6);
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
    expect(out[4].role).toBe('tool');
    expect(out[4].tool_call_id).toBe('c2');
    expect(out[4].content).toContain('interrupted');
    expect(out[5]).toEqual({ role: 'user', content: 'restart' });
  });

  it('drops a stray toolResult whose id matches no preceding tool_call', () => {
    const out = convertToOpenAI('SYS', [
      { role: 'user', content: 'go', timestamp: 1 },
      { role: 'toolResult', toolCallId: 'ghost', toolName: 'write', content: 'zombie', isError: false, timestamp: 2 },
      { role: 'user', content: 'again', timestamp: 3 },
    ] as never);
    expect(out).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'go' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('repairs an assistant whose tool run was cut off by a later non-tool message', () => {
    const out = convertToOpenAI('SYS', [
      {
        role: 'assistant', timestamp: 1, stopReason: 'error',
        content: [{ type: 'toolCall', id: 'c9', name: 'read', arguments: {} }],
      },
      { role: 'user', content: 'hello?', timestamp: 2 },
    ] as never);
    expect(out[1].tool_calls?.[0].id).toBe('c9');
    expect(out[2].role).toBe('tool');
    expect(out[2].tool_call_id).toBe('c9');
    expect(out[3]).toEqual({ role: 'user', content: 'hello?' });
  });

  it('leaves well-formed conversations untouched', () => {
    const messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'assistant', timestamp: 2, stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
      },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: 'data', isError: false, timestamp: 3 },
      { role: 'assistant', timestamp: 4, stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
    ] as never;
    const out = convertToOpenAI('SYS', messages);
    expect(out).toHaveLength(5);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});

// `repairToolPairs` tracked outstanding calls in a `Set` of ids. Two calls
// sharing an id collapsed to ONE entry: the first result deleted it and the
// second was dropped as a stray — while the assistant message still carried two
// calls. The provider then 400s on the unanswered one, and because the broken
// history replays on every send, the conversation is poisoned permanently. That
// is the exact failure this repair exists to prevent.
//
// Not hypothetical: the server's `sanitizeToolCallId` normalises ids to
// `[A-Za-z0-9_-]`, so two distinct ids can be flattened into the same string.
describe('convertToOpenAI — duplicate tool-call ids', () => {
  const dupCallTurn = [
    {
      role: 'assistant',
      timestamp: 1,
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.cs' } },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'b.cs' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: 'A', isError: false, timestamp: 2 },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: 'B', isError: false, timestamp: 3 },
  ];

  it('answers every call when two share an id', () => {
    const out = convertToOpenAI('SYS', dupCallTurn as never);
    const assistant = out.find((m) => m.role === 'assistant');
    const toolMsgs = out.filter((m) => m.role === 'tool');

    expect(assistant?.tool_calls).toHaveLength(2);
    expect(toolMsgs).toHaveLength(2);
  });

  it('gives each call a distinct id, so no result is ambiguous', () => {
    const out = convertToOpenAI('SYS', dupCallTurn as never);
    const ids = out.find((m) => m.role === 'assistant')!.tool_calls!.map((c) => c.id);
    const resultIds = out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);

    expect(new Set(ids).size).toBe(2);
    expect(new Set(resultIds)).toEqual(new Set(ids));
  });

  it('keeps both results’ content — neither is silently discarded', () => {
    const out = convertToOpenAI('SYS', dupCallTurn as never);
    const contents = out.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(contents).toEqual(['A', 'B']);
  });

  it('still synthesises a result for a duplicated call that was never answered', () => {
    const out = convertToOpenAI('SYS', [
      dupCallTurn[0],
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: 'A', isError: false, timestamp: 2 },
    ] as never);
    const toolMsgs = out.filter((m) => m.role === 'tool');

    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[1].content).toContain('interrupted');
  });
});
