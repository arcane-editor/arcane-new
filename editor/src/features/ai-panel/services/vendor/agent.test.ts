import { describe, it, expect } from 'bun:test';
import { Agent } from './agent';
import { AssistantMessageEventStream } from './event-stream';
import type { StreamFn } from './types';

function stubStream(): StreamFn {
  return () => {
    const s = new AssistantMessageEventStream();
    s.push({ type: 'start' });
    s.push({
      type: 'done',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: 1 },
    });
    return s;
  };
}

describe('Agent.setContextWindow', () => {
  it('exists and is used on the next prompt without reconstructing the agent', async () => {
    const agent = new Agent({
      model: { id: 'x', name: 'x', provider: 'test' },
      streamFn: stubStream(),
      contextWindow: 32768,
    });
    agent.setContextWindow(200000);
    const messages = await agent.prompt('hi');
    expect(messages.at(-1)?.role).toBe('assistant');
  });
});
