import { describe, it, expect } from 'bun:test';
import {
  isAwaitingUser,
  showsInlineIndicator,
  showsTailIndicator,
} from './working-indicator';
import type { AiMessage } from '../../../stores/ai';

const streamingAssistant: AiMessage = {
  id: 'a1',
  role: 'assistant',
  content: [],
  isStreaming: true,
  timestamp: 0,
};
const finishedAssistant: AiMessage = { ...streamingAssistant, isStreaming: false };
const toolResult: AiMessage = { id: 't1', role: 'toolResult', timestamp: 0 };

function questionMessage(extra: Partial<NonNullable<AiMessage['questionRequest']>> = {}): AiMessage {
  return {
    id: 'q1',
    role: 'questionRequest',
    questionRequest: { toolCallId: 'tc1', question: 'Which way?', ...extra },
    timestamp: 0,
  };
}

function permissionMessage(resolvedOptionId?: string): AiMessage {
  return {
    id: 'p1',
    role: 'permissionRequest',
    permissionRequest: { toolCallId: 'tc2', options: [], resolvedOptionId },
    timestamp: 0,
  };
}

describe('isAwaitingUser', () => {
  it('is true for an unanswered question at the tail', () => {
    expect(isAwaitingUser(questionMessage())).toBe(true);
  });

  it('is false once the question is answered', () => {
    expect(isAwaitingUser(questionMessage({ resolvedAnswer: 'yes' }))).toBe(false);
  });

  it('is false for a cancelled question', () => {
    expect(isAwaitingUser(questionMessage({ cancelled: true }))).toBe(false);
  });

  it('is true for an unresolved permission request', () => {
    expect(isAwaitingUser(permissionMessage())).toBe(true);
  });

  it('is false once the permission request is resolved', () => {
    expect(isAwaitingUser(permissionMessage('allow'))).toBe(false);
  });

  it('is false for ordinary messages and for an empty transcript', () => {
    expect(isAwaitingUser(streamingAssistant)).toBe(false);
    expect(isAwaitingUser(null)).toBe(false);
  });
});

describe('showsInlineIndicator', () => {
  it('shows dots inside a streaming bubble that is the tail', () => {
    expect(showsInlineIndicator(streamingAssistant, true)).toBe(true);
  });

  // The reported bug: a question card appended after a streaming message left
  // the dots stranded above it.
  it('hides them once something has been appended after that bubble', () => {
    expect(showsInlineIndicator(streamingAssistant, false)).toBe(false);
  });

  it('never shows them for a finished bubble', () => {
    expect(showsInlineIndicator(finishedAssistant, true)).toBe(false);
  });
});

describe('showsTailIndicator', () => {
  it('is false when no agent is running', () => {
    expect(showsTailIndicator({ isAgentRunning: false, last: toolResult })).toBe(false);
  });

  it('defers to the inline dots while a streaming bubble is the tail', () => {
    expect(showsTailIndicator({ isAgentRunning: true, last: streamingAssistant })).toBe(false);
  });

  it('shows below a finished bubble whose tool calls are still running', () => {
    expect(showsTailIndicator({ isAgentRunning: true, last: finishedAssistant })).toBe(true);
  });

  it('shows below a tool result', () => {
    expect(showsTailIndicator({ isAgentRunning: true, last: toolResult })).toBe(true);
  });

  // The screenshot: the question is answered, the agent went back to work, and
  // the dots must be UNDER the card rather than above it.
  it('shows below an answered question card', () => {
    expect(
      showsTailIndicator({ isAgentRunning: true, last: questionMessage({ resolvedAnswer: 'yes' }) }),
    ).toBe(true);
  });

  it('shows nothing while the question is still unanswered', () => {
    expect(showsTailIndicator({ isAgentRunning: true, last: questionMessage() })).toBe(false);
  });

  it('shows nothing while a permission request is unresolved', () => {
    expect(showsTailIndicator({ isAgentRunning: true, last: permissionMessage() })).toBe(false);
  });

  it('shows on a turn that has started before its first message exists', () => {
    expect(showsTailIndicator({ isAgentRunning: true, last: null })).toBe(true);
  });
});
