import { describe, it, expect } from 'bun:test';
import { restoreAgentMessages } from './restore-history';
import type { AiMessage } from '../../../stores/ai';

function user(id: string, text: string): AiMessage {
  return { id, role: 'user', text, timestamp: 1 };
}

function assistant(id: string, content: AiMessage['content'], text = ''): AiMessage {
  return { id, role: 'assistant', text, content, timestamp: 2 };
}

function call(id: string, name = 'read') {
  return { type: 'toolCall' as const, id, name, arguments: {} };
}

function say(text: string) {
  return { type: 'text' as const, text };
}

function result(id: string, toolCallId: string): AiMessage {
  return {
    id,
    role: 'toolResult',
    text: '',
    timestamp: 3,
    toolCallId,
    toolName: 'read',
    toolResult: { content: 'ok', isError: false },
  };
}

describe('restoreAgentMessages — pairing', () => {
  // The bug this exists for: a Stop mid-tool, a crash, or a blocked `ask_user`
  // that was never answered saves an assistant turn whose tool call has no
  // result. Providers reject that history deterministically, so the retry loop
  // cannot recover — the turn hangs on "Thinking…" and ends as a bare "Server
  // error". The design dock resumes its thread on every send, so one
  // interrupted turn poisoned that thread permanently.

  it('keeps a tool call that has its result', () => {
    const out = restoreAgentMessages([
      user('u1', 'go'),
      assistant('a1', [call('t1')]),
      result('r1', 't1'),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
  });

  it('drops a tool call that never got one', () => {
    const out = restoreAgentMessages([user('u1', 'go'), assistant('a1', [call('t1')])]);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });

  it('keeps the words of a turn that was cut off mid-tool, and drops only the call', () => {
    const out = restoreAgentMessages([
      user('u1', 'go'),
      assistant('a1', [say('Reading the stylesheet first.'), call('t1')]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: 'assistant', content: [say('Reading the stylesheet first.')] });
  });

  it('drops only the unanswered call when a turn made several', () => {
    const out = restoreAgentMessages([
      assistant('a1', [call('t1'), call('t2')]),
      result('r1', 't1'),
    ]);
    expect(out[0]).toMatchObject({ content: [call('t1')] });
  });

  it('drops a result whose call is not in the transcript', () => {
    // The other half of the same malformation, and just as rejectable.
    const out = restoreAgentMessages([user('u1', 'go'), result('r1', 'ghost')]);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });

  it('survives the exact shape a blocked ask_user leaves behind', () => {
    // The turn that started this: the model asked, the question was never
    // answered, and the transcript saved the call plus a UI-only question card.
    const out = restoreAgentMessages([
      user('u1', 'make it warmer'),
      assistant('a1', [call('t1', 'ask_user')]),
      {
        id: 'q1',
        role: 'questionRequest',
        text: '',
        timestamp: 4,
        questionRequest: { toolCallId: 't1', question: 'Which menu?', cancelled: true },
      },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'make it warmer', timestamp: 1 }]);
  });
});

describe('restoreAgentMessages — what is not history', () => {
  it('skips every UI-only role', () => {
    const out = restoreAgentMessages([
      user('u1', 'go'),
      { id: 's1', role: 'system', text: 'note', timestamp: 5 },
      { id: 'e1', role: 'error', text: '', timestamp: 5 },
      { id: 'x1', role: 'stopped', text: '', timestamp: 5 },
      { id: 'v1', role: 'verifiedPass', text: '', timestamp: 5 },
      { id: 'p1', role: 'permissionRequest', text: '', timestamp: 5 },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });

  it('leaves a clean transcript completely unchanged', () => {
    const messages = [user('u1', 'go'), assistant('a1', [call('t1')]), result('r1', 't1'), assistant('a2', [say('done')])];
    const out = restoreAgentMessages(messages);
    expect(out).toHaveLength(4);
    expect(out[3]).toMatchObject({ role: 'assistant', content: [say('done')] });
  });

  it('keeps an assistant turn that legitimately had no content', () => {
    // Pre-existing shape; filtering must not start dropping these.
    const out = restoreAgentMessages([assistant('a1', [])]);
    expect(out).toHaveLength(1);
  });
});
