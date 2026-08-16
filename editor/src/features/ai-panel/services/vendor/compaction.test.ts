import { describe, it, expect } from 'bun:test';
import { estimateTokens, compactMessages } from './compaction';
import type { AgentMessage } from './types';

describe('image token estimate', () => {
  it('one pasted screenshot does not pin the conversation above the trigger', () => {
    const big = 'A'.repeat(683_000); // ~500KB image as base64
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', data: big, mimeType: 'image/png' },
        ],
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];
    expect(estimateTokens(messages)).toBeLessThan(10_000);
    // Below the trigger — returned unchanged (identity, not a copy).
    expect(compactMessages(messages, { contextWindow: 32768 })).toBe(messages);
  });

  it('null message content does not throw (aborted/restored turns)', () => {
    const messages = [{ role: 'user', content: null, timestamp: 1 }] as unknown as AgentMessage[];
    expect(estimateTokens(messages)).toBe(0);
  });

  it('old non-read tool results still get cleared above the trigger', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }], timestamp: 1 },
      { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: 'X'.repeat(200_000), isError: false, timestamp: 2 },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }], timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }], timestamp: 4 },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }], timestamp: 5 },
      { role: 'assistant', content: [{ type: 'text', text: 'd' }], timestamp: 6 },
    ] as unknown as AgentMessage[];
    const out = compactMessages(messages, { contextWindow: 32768 });
    expect(out[1].role).toBe('toolResult');
    expect((out[1] as { content: string }).content).toBe('[Tool result cleared to save context]');
  });
});
