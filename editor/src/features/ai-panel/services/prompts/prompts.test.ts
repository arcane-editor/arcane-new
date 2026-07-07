import { describe, it, expect } from 'bun:test';
import { buildAskPrompt } from './ask';
import { buildAgentPrompt } from './agent';

describe('prompt personas (anti-terseness regression)', () => {
  const ask = buildAskPrompt('/proj');
  const agent = buildAgentPrompt('/proj');

  it('ask prompt teaches root causes and adapts depth', () => {
    expect(ask).toContain('root cause');
    expect(ask).toContain('Match depth to the question');
    expect(ask).not.toContain('Keep examples small and self-contained');
  });

  it('agent prompt reports verification, not brevity', () => {
    expect(agent).toContain('what was verified');
    expect(agent).not.toContain('Keep prose tight');
    expect(agent).not.toContain('a brief summary');
  });

  it('both keep the grounding instructions and Unity context', () => {
    expect(ask).toContain('Investigate before answering');
    expect(agent).toContain('unity_api_search');
    expect(agent).toContain('Read before you edit');
  });
});
