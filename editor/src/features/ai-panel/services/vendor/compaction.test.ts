import { describe, it, expect } from 'bun:test';
import { estimateTokens, compactMessages, estimateReservedTokens } from './compaction';
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

// ---------------------------------------------------------------------------
// The compaction FLOOR.
//
// Compaction only ever shrank `toolResult` content. When the bulk of a
// conversation is user text, attachments or assistant prose there is nothing
// for it to elide, so it returned a context that was STILL over the window —
// and nothing checked. The send then died at the provider with a context-length
// rejection that the UI (until this run) offered to retry forever.
// ---------------------------------------------------------------------------

/** A conversation whose weight is user/assistant prose, not tool output. */
function proseHeavy(turns: number, charsPerTurn: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `U${i} ${'u'.repeat(charsPerTurn)}`, timestamp: i * 2 });
    out.push({
      role: 'assistant',
      content: [{ type: 'text', text: `A${i} ${'a'.repeat(charsPerTurn)}` }],
      stopReason: 'stop',
      timestamp: i * 2 + 1,
    });
  }
  return out as unknown as AgentMessage[];
}

describe('compaction floor', () => {
  const WINDOW = 32_768;

  it('gets a prose-heavy conversation under the window when tool elision cannot help', () => {
    const messages = proseHeavy(40, 8_000);
    expect(estimateTokens(messages)).toBeGreaterThan(WINDOW);

    const out = compactMessages(messages, { contextWindow: WINDOW });
    expect(estimateTokens(out)).toBeLessThanOrEqual(WINDOW);
  });

  it('never deletes a message while shrinking — tool pairing depends on it', () => {
    const messages = proseHeavy(40, 8_000);
    const out = compactMessages(messages, { contextWindow: WINDOW });
    expect(out).toHaveLength(messages.length);
  });

  it('keeps every assistant toolCall paired with its toolResult', () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: 'u'.repeat(6_000), timestamp: i * 3 } as never);
      messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: `c${i}`, name: 'read', arguments: { path: `${i}.cs` } }],
        stopReason: 'toolUse',
        timestamp: i * 3 + 1,
      } as never);
      messages.push({
        role: 'toolResult',
        toolCallId: `c${i}`,
        toolName: 'read',
        content: 'r'.repeat(6_000),
        isError: false,
        timestamp: i * 3 + 2,
      } as never);
    }

    const out = compactMessages(messages, { contextWindow: WINDOW });

    const callIds = out
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (m as { content: Array<{ type: string; id?: string }> }).content)
      .filter((b) => b.type === 'toolCall')
      .map((b) => b.id!);
    const resultIds = out
      .filter((m) => m.role === 'toolResult')
      .map((m) => (m as { toolCallId: string }).toolCallId);

    expect(callIds).toHaveLength(30);
    expect(new Set(resultIds)).toEqual(new Set(callIds));
    expect(estimateTokens(out)).toBeLessThanOrEqual(WINDOW);
  });

  it('preserves the newest user message — that is the turn being answered', () => {
    const messages = proseHeavy(40, 8_000);
    messages.push({ role: 'user', content: 'THE ACTUAL QUESTION', timestamp: 999 } as never);

    const out = compactMessages(messages, { contextWindow: WINDOW });
    const last = out[out.length - 1] as { content: string };
    expect(last.content).toContain('THE ACTUAL QUESTION');
  });

  it('sheds image payloads when prose alone will not fit', () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', data: 'A'.repeat(1000), mimeType: 'image/png' },
        ],
        timestamp: i,
      } as never);
    }
    const out = compactMessages(messages, { contextWindow: 8_000 });
    expect(estimateTokens(out)).toBeLessThanOrEqual(8_000);
    expect(out).toHaveLength(messages.length);
  });
});

describe('reserved tokens (system prompt + tool schemas)', () => {
  // `estimateTokens` counted MESSAGES only, while the result was compared with
  // 80% of the full window — but the system prompt (Unity facts + context pack
  // + graph snapshot) and ~26 tool JSON schemas ride along on every request and
  // are easily 5–15k tokens. Real usage could pass 100% of the window while
  // compaction believed it was at 79%.
  it('counts the system prompt and the tool schemas', () => {
    const reserved = estimateReservedTokens('S'.repeat(40_000), [
      { name: 'write', description: 'd', parameters: { type: 'object' } },
    ]);
    expect(reserved).toBeGreaterThan(10_000);
  });

  it('is zero-ish for an empty prompt and no tools', () => {
    expect(estimateReservedTokens('', [])).toBeLessThan(10);
  });

  it('compacts a conversation that only overflows once the prompt is counted', () => {
    const messages = proseHeavy(5, 8_000); // ~22.8k tokens: fits 32k on its own
    expect(compactMessages(messages, { contextWindow: 32_768 })).toBe(messages);

    const out = compactMessages(messages, { contextWindow: 32_768, reservedTokens: 20_000 });
    expect(out).not.toBe(messages);
    expect(estimateTokens(out)).toBeLessThanOrEqual(32_768 - 20_000);
  });

  it('still produces a usable budget when the prompt alone would exhaust the window', () => {
    const messages = proseHeavy(10, 4_000);
    const out = compactMessages(messages, { contextWindow: 32_768, reservedTokens: 40_000 });
    expect(out).toHaveLength(messages.length);
    expect(estimateTokens(out)).toBeGreaterThan(0);
  });
});
