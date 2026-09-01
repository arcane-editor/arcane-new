import { describe, it, expect } from 'bun:test';
import { findPendingQuestion } from './pending-question';
import type { AiMessage } from '../../../stores/ai';

function question(
  toolCallId: string,
  extra: Partial<NonNullable<AiMessage['questionRequest']>> = {},
): AiMessage {
  return {
    id: `m-${toolCallId}`,
    role: 'questionRequest',
    questionRequest: { toolCallId, question: 'Which way?', ...extra },
    timestamp: 0,
  };
}

const assistant: AiMessage = { id: 'a1', role: 'assistant', content: [], timestamp: 0 };
const live = () => true;
const dead = () => false;

describe('findPendingQuestion', () => {
  it('returns the unresolved question the gate is still awaiting', () => {
    expect(findPendingQuestion([assistant, question('q1')], live)?.toolCallId).toBe('q1');
  });

  it('returns null when there are no questions at all', () => {
    expect(findPendingQuestion([assistant], live)).toBeNull();
  });

  it('skips an answered question', () => {
    expect(findPendingQuestion([question('q1', { resolvedAnswer: 'yes' })], live)).toBeNull();
  });

  it('skips a cancelled question', () => {
    expect(findPendingQuestion([question('q1', { cancelled: true })], live)).toBeNull();
  });

  it('picks the newest unresolved question when several are on screen', () => {
    const messages = [question('q1', { resolvedAnswer: 'a' }), question('q2'), question('q3')];
    expect(findPendingQuestion(messages, live)?.toolCallId).toBe('q3');
  });

  it('scans past answered questions to reach the unresolved one below them', () => {
    const messages = [question('q1'), question('q2', { resolvedAnswer: 'a' })];
    expect(findPendingQuestion(messages, live)?.toolCallId).toBe('q1');
  });

  // The regression this module exists for: a card left on screen after its
  // gate promise died is not answerable, and must not arm the composer.
  it('returns null for an unresolved card whose gate promise is gone', () => {
    expect(findPendingQuestion([question('q1')], dead)).toBeNull();
  });

  // A dead newest card ends the search — it must not fall through to a stale
  // card further up, which the gate resolved (or abandoned) even earlier.
  it('does not fall back to an older card when the newest one is dead', () => {
    const isLive = (id: string) => id === 'q1';
    expect(findPendingQuestion([question('q1'), question('q2')], isLive)).toBeNull();
  });

  // The whole point of the rewrite: a live gate promise is answerable whatever
  // `isAgentRunning` happens to say. The selector no longer reads that flag.
  it('does not depend on any agent-running flag', () => {
    const messages = [question('q1')];
    expect(findPendingQuestion(messages, live)?.toolCallId).toBe('q1');
  });
});
