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
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '' });
  });
});
