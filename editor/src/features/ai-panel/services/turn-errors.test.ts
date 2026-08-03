import { describe, it, expect } from 'bun:test';
import {
  classifyTurnError,
  classifyServerCode,
  loopCrashError,
  detectTurnOutcome,
  findRetryTarget,
  hasRenderableContent,
} from './turn-errors';
import type { AgentMessage } from './vendor/types';
import type { AiMessage } from '../../../stores/ai';

// ---- classifyTurnError ----

describe('classifyTurnError', () => {
  it('classifies "authentication expired" as auth', () => {
    const err = classifyTurnError('Authentication expired. Please log in again.');
    expect(err.kind).toBe('auth');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Session expired');
    expect(err.detail).toBe('You were signed out. Sign back in, then press Retry.');
    expect(err.raw).toBe('Authentication expired. Please log in again.');
  });

  it('classifies "not logged in" as auth', () => {
    const err = classifyTurnError('Not logged in. Please sign in to use the AI assistant.');
    expect(err.kind).toBe('auth');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Session expired');
  });

  it('classifies "rate limit" as rate_limit', () => {
    const err = classifyTurnError('Rate limit exceeded. Please wait a moment and try again.');
    expect(err.kind).toBe('rate_limit');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Rate limited');
    expect(err.detail?.toLowerCase()).toContain('moment');
  });

  it('classifies "server error (NNN)" as server, embedding the status in the title', () => {
    const err = classifyTurnError('Server error (502): Bad Gateway');
    expect(err.kind).toBe('server');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Server error (502)');
  });

  it('classifies "stream stalled" as timeout', () => {
    const err = classifyTurnError('Stream stalled — no data for 90000ms');
    expect(err.kind).toBe('timeout');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Connection timed out');
  });

  it('classifies "Failed to fetch" as network', () => {
    const err = classifyTurnError('Failed to fetch');
    expect(err.kind).toBe('network');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Network error');
  });

  it('classifies "Load failed" as network (WKWebView spelling)', () => {
    const err = classifyTurnError('Load failed');
    expect(err.kind).toBe('network');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Network error');
  });

  it('classifies "error sending request" as network', () => {
    const err = classifyTurnError('error sending request for url (...)');
    expect(err.kind).toBe('network');
    expect(err.title).toBe('Network error');
  });

  it('classifies "fetch failed" as network', () => {
    const err = classifyTurnError('fetch failed');
    expect(err.kind).toBe('network');
    expect(err.title).toBe('Network error');
  });

  it('classifies a generic "network" mention as network', () => {
    const err = classifyTurnError('A network error occurred');
    expect(err.kind).toBe('network');
    expect(err.title).toBe('Network error');
  });

  it('classifies "no response body" as network', () => {
    const err = classifyTurnError('No response body');
    expect(err.kind).toBe('network');
    expect(err.title).toBe('Network error');
  });

  it('classifies "response corrupted" as corrupted', () => {
    const err = classifyTurnError('Response corrupted');
    expect(err.kind).toBe('corrupted');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Response corrupted');
  });

  it('classifies anything unrecognized as unknown, preserving raw', () => {
    const raw = 'Some completely unexpected failure blob';
    const err = classifyTurnError(raw);
    expect(err.kind).toBe('unknown');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Something went wrong');
    expect(err.raw).toBe(raw);
  });

  it('matches case-insensitively', () => {
    const err = classifyTurnError('RATE LIMIT hit, back off');
    expect(err.kind).toBe('rate_limit');
  });

  it('classifies "Empty response from the model" as kind empty', () => {
    const err = classifyTurnError('Empty response from the model');
    expect(err.kind).toBe('empty');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Empty response');
    expect(err.detail).toBe('The model returned no output. This is usually transient — try again.');
    expect(err.raw).toBe('Empty response from the model');
  });

  it('classifies the empty-response row case-insensitively', () => {
    const err = classifyTurnError('EMPTY RESPONSE from the model');
    expect(err.kind).toBe('empty');
    expect(err.title).toBe('Empty response');
  });

  it("classifies offline errors as network with a You're-offline title", () => {
    const e = classifyTurnError("You're offline — check your internet connection, then retry.");
    expect(e.kind).toBe('network');
    expect(e.title).toBe("You're offline");
    expect(e.retriable).toBe(true);
  });

  it('classifies the "you are offline" spelling case-insensitively', () => {
    const e = classifyTurnError('YOU ARE OFFLINE right now');
    expect(e.kind).toBe('network');
    expect(e.title).toBe("You're offline");
    expect(e.detail).toBe('Check your internet connection, then press Retry.');
  });
});

// ---- classifyTurnError — leading [code:<x>] marker ----

describe('classifyTurnError — [code:] marker', () => {
  it('maps a rate_limit marker to kind rate_limit, title "Rate limited", stripping the marker from raw', () => {
    const err = classifyTurnError('[code:rate_limit] slow down');
    expect(err.kind).toBe('rate_limit');
    expect(err.title).toBe('Rate limited');
    expect(err.retriable).toBe(true);
    expect(err.raw).toBe('slow down');
    // Part 4 (T4 review follow-up): the marker path carries the same
    // guidance `detail` the substring-table row for this kind carries.
    expect(err.detail).toBe('Too many requests — wait a moment and try again.');
  });

  it('maps a model_error marker to kind server, title "Server error"', () => {
    const err = classifyTurnError('[code:model_error] the model blew up');
    expect(err.kind).toBe('server');
    expect(err.title).toBe('Server error');
    expect(err.retriable).toBe(true);
    expect(err.raw).toBe('the model blew up');
    expect(err.detail).toBe('This is usually temporary — try again in a moment.');
  });

  it('maps a server_error marker to kind server, title "Server error"', () => {
    const err = classifyTurnError('[code:server_error] boom');
    expect(err.kind).toBe('server');
    expect(err.title).toBe('Server error');
    expect(err.retriable).toBe(true);
    expect(err.raw).toBe('boom');
    expect(err.detail).toBe('This is usually temporary — try again in a moment.');
  });

  it('falls through to the table on an unrecognized code, using the stripped remainder', () => {
    const err = classifyTurnError('[code:some_new_code] Failed to fetch');
    expect(err.kind).toBe('network');
    expect(err.title).toBe('Network error');
    expect(err.raw).toBe('Failed to fetch');
  });

  it('strips the marker from raw even when it falls through to the table', () => {
    const err = classifyTurnError('[code:unknown_thing] Some completely unexpected failure blob');
    expect(err.raw).toBe('Some completely unexpected failure blob');
  });

  it('maps a gateway_timeout marker to kind timeout, title "Connection timed out"', () => {
    expect(classifyTurnError('[code:gateway_timeout] upstream timed out').kind).toBe('timeout');
  });
});

// ---- classifyServerCode ----

describe('classifyServerCode', () => {
  it('maps rate_limit to rate_limit', () => {
    expect(classifyServerCode('rate_limit')).toBe('rate_limit');
  });

  it('maps model_error to server', () => {
    expect(classifyServerCode('model_error')).toBe('server');
  });

  it('maps server_error to server', () => {
    expect(classifyServerCode('server_error')).toBe('server');
  });

  it('maps undefined to null', () => {
    expect(classifyServerCode(undefined)).toBe(null);
  });
});

// ---- loopCrashError ----

describe('loopCrashError', () => {
  it('returns a crash TurnError pointing at the devtools console', () => {
    const err = loopCrashError();
    expect(err.kind).toBe('crash');
    expect(err.retriable).toBe(true);
    expect(err.title).toBe('Agent stopped unexpectedly');
    expect(err.detail?.toLowerCase()).toContain('console');
  });
});

// ---- detectTurnOutcome ----

function assistantMsg(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    stopReason: 'stop',
    timestamp: 1,
    ...overrides,
  } as AgentMessage;
}

function userMsg(): AgentMessage {
  return { role: 'user', content: 'hello', timestamp: 0 };
}

describe('detectTurnOutcome', () => {
  it('reports clean on a normal stop', () => {
    const result = detectTurnOutcome([userMsg(), assistantMsg({ stopReason: 'stop' })], false);
    expect(result).toEqual({ type: 'clean' });
  });

  it('reports error with the errorMessage when stopReason is error', () => {
    const result = detectTurnOutcome(
      [assistantMsg({ stopReason: 'error', errorMessage: 'Server error (500): boom' })],
      false,
    );
    expect(result).toEqual({ type: 'error', raw: 'Server error (500): boom' });
  });

  it('reports error with a fallback raw when errorMessage is missing', () => {
    const result = detectTurnOutcome([assistantMsg({ stopReason: 'error', errorMessage: undefined })], false);
    expect(result).toEqual({ type: 'error', raw: 'Unknown error' });
  });

  it('reports crash when there is no assistant message at all', () => {
    const result = detectTurnOutcome([userMsg()], false);
    expect(result).toEqual({ type: 'crash' });
  });

  it('reports crash on empty message list', () => {
    const result = detectTurnOutcome([], false);
    expect(result).toEqual({ type: 'crash' });
  });

  it('reports crash on a toolUse tail (loop died mid-turn)', () => {
    const result = detectTurnOutcome([assistantMsg({ stopReason: 'toolUse' })], false);
    expect(result).toEqual({ type: 'crash' });
  });

  it('reports aborted when abortRequested wins over a toolUse tail', () => {
    const result = detectTurnOutcome([assistantMsg({ stopReason: 'toolUse' })], true);
    expect(result).toEqual({ type: 'aborted' });
  });

  it('reports aborted on an aborted stop', () => {
    const result = detectTurnOutcome([assistantMsg({ stopReason: 'aborted' })], false);
    expect(result).toEqual({ type: 'aborted' });
  });

  it('uses the LAST assistant message when several are present', () => {
    const result = detectTurnOutcome(
      [assistantMsg({ stopReason: 'error', errorMessage: 'first' }), assistantMsg({ stopReason: 'stop' })],
      false,
    );
    expect(result).toEqual({ type: 'clean' });
  });

  // ---- empty-tail rule (R2-T3) ----

  it('reports error "Empty response from the model" on a stop tail with no renderable content and no tool calls this turn', () => {
    const result = detectTurnOutcome(
      [userMsg(), assistantMsg({ stopReason: 'stop', content: [] })],
      false,
    );
    expect(result).toEqual({ type: 'error', raw: 'Empty response from the model' });
  });

  it('reports error on a stop tail whose only content is whitespace-only text/thinking', () => {
    const result = detectTurnOutcome(
      [assistantMsg({ stopReason: 'stop', content: [{ type: 'text', text: '   ' }] })],
      false,
    );
    expect(result).toEqual({ type: 'error', raw: 'Empty response from the model' });
  });

  it('reports clean on a stop tail with renderable text (not empty)', () => {
    const result = detectTurnOutcome(
      [assistantMsg({ stopReason: 'stop', content: [{ type: 'text', text: 'hello' }] })],
      false,
    );
    expect(result).toEqual({ type: 'clean' });
  });

  it('reports clean when the stop tail is empty but the turn included a tool call earlier this turn (silence after acting)', () => {
    const result = detectTurnOutcome(
      [
        userMsg(),
        assistantMsg({
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }],
        }),
        { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: 'ok', timestamp: 2 } as AgentMessage,
        assistantMsg({ stopReason: 'stop', content: [] }),
      ],
      false,
    );
    expect(result).toEqual({ type: 'clean' });
  });

  it('reports the same empty-response error when stopReason is undefined (normal-end, never set)', () => {
    const result = detectTurnOutcome([assistantMsg({ stopReason: undefined, content: [] })], false);
    expect(result).toEqual({ type: 'error', raw: 'Empty response from the model' });
  });
});

// ---- findRetryTarget ----

function aiMsg(overrides: Partial<AiMessage>): AiMessage {
  return { id: 'x', role: 'user', timestamp: 0, ...overrides };
}

describe('findRetryTarget', () => {
  it('finds the nearest preceding user message when the error is at the end', () => {
    const messages: AiMessage[] = [
      aiMsg({ id: 'u1', role: 'user', text: 'hi' }),
      aiMsg({ id: 'a1', role: 'assistant' }),
      aiMsg({ id: 'err1', role: 'assistant' }),
    ];
    const result = findRetryTarget(messages, 'err1');
    expect(result).toEqual({ userMessage: messages[0], truncateAfterId: 'u1' });
  });

  it('walks backward over intervening toolResult/assistant messages', () => {
    const messages: AiMessage[] = [
      aiMsg({ id: 'u1', role: 'user', text: 'hi' }),
      aiMsg({ id: 'a1', role: 'assistant' }),
      aiMsg({ id: 't1', role: 'toolResult' }),
      aiMsg({ id: 'a2', role: 'assistant' }),
      aiMsg({ id: 's1', role: 'system' }),
      aiMsg({ id: 'err1', role: 'assistant' }),
    ];
    const result = findRetryTarget(messages, 'err1');
    expect(result).toEqual({ userMessage: messages[0], truncateAfterId: 'u1' });
  });

  it('returns null when no user message precedes the error', () => {
    const messages: AiMessage[] = [
      aiMsg({ id: 'a1', role: 'assistant' }),
      aiMsg({ id: 'err1', role: 'assistant' }),
    ];
    const result = findRetryTarget(messages, 'err1');
    expect(result).toBe(null);
  });

  it('returns null for an unknown errorMessageId', () => {
    const messages: AiMessage[] = [
      aiMsg({ id: 'u1', role: 'user', text: 'hi' }),
      aiMsg({ id: 'err1', role: 'assistant' }),
    ];
    const result = findRetryTarget(messages, 'does-not-exist');
    expect(result).toBe(null);
  });

  it('picks the closest user message when multiple precede the error', () => {
    const messages: AiMessage[] = [
      aiMsg({ id: 'u1', role: 'user', text: 'first' }),
      aiMsg({ id: 'a1', role: 'assistant' }),
      aiMsg({ id: 'u2', role: 'user', text: 'second' }),
      aiMsg({ id: 'err1', role: 'assistant' }),
    ];
    const result = findRetryTarget(messages, 'err1');
    expect(result).toEqual({ userMessage: messages[2], truncateAfterId: 'u2' });
  });
});

// ---- hasRenderableContent ----

describe('hasRenderableContent', () => {
  it('is false for an empty array', () => {
    expect(hasRenderableContent([])).toBe(false);
  });

  it('is false for whitespace-only text', () => {
    expect(hasRenderableContent([{ type: 'text', text: '   \n\t ' }])).toBe(false);
  });

  it('is true for real text', () => {
    expect(hasRenderableContent([{ type: 'text', text: 'hello' }])).toBe(true);
  });

  it('is true for a toolCall-only block', () => {
    expect(
      hasRenderableContent([{ type: 'toolCall', id: 't1', name: 'foo', arguments: {} }]),
    ).toBe(true);
  });

  it('is false for whitespace-only thinking', () => {
    expect(hasRenderableContent([{ type: 'thinking', thinking: '   ' }])).toBe(false);
  });

  it('is true for real thinking text', () => {
    expect(hasRenderableContent([{ type: 'thinking', thinking: 'pondering...' }])).toBe(true);
  });

  it('is false when undefined', () => {
    expect(hasRenderableContent(undefined)).toBe(false);
  });
});

// ---- new server codes + credits kind ----

describe('new server codes + credits kind', () => {
  it('maps provider/gateway codes', () => {
    expect(classifyServerCode('provider_rate_limit')).toBe('rate_limit');
    expect(classifyServerCode('provider_auth_failure')).toBe('server');
    expect(classifyServerCode('provider_unavailable')).toBe('server');
    expect(classifyServerCode('gateway_timeout')).toBe('timeout');
    expect(classifyServerCode('nonsense')).toBeNull();
  });

  it('classifies out-of-credits as a non-retriable credits error', () => {
    const e = classifyTurnError('You are out of credits. Upgrade your plan or add a top-up to keep using AI.');
    expect(e.kind).toBe('credits');
    expect(e.retriable).toBe(false);
    const e2 = classifyTurnError('You are out of AI credits. Open Account to upgrade or buy credits.');
    expect(e2.kind).toBe('credits');
  });
});
