import { describe, it, expect, beforeEach } from 'bun:test';
import { withTurnGovernor, resetTurnGovernor, DEFAULT_TURN_CAPS, WRAP_UP_TEXT } from './turn-governor';
import type { Context, StreamFn, StreamOptions } from './vendor/types';
import { AssistantMessageEventStream } from './vendor/event-stream';

const CTX: Context = { systemPrompt: 'SYS', messages: [{ role: 'user', content: 'hi', timestamp: 1 }], tools: [{ name: 't', description: 'd', parameters: {} as never }] };

function opts(reasoning?: string): StreamOptions {
  return { model: { id: 'm', name: 'm', provider: 'x' }, reasoning };
}

/** Records every Context it was called with and returns an immediately-done text response. */
function recordingStreamFn(): { streamFn: StreamFn; calls: () => Context[] } {
  const calls: Context[] = [];
  const streamFn: StreamFn = (context) => {
    calls.push(context);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'start' });
    stream.push({
      type: 'done',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: Date.now() },
    });
    return stream;
  };
  return { streamFn, calls: () => calls };
}

describe('withTurnGovernor', () => {
  beforeEach(() => resetTurnGovernor());

  it('passes calls below the cap through untouched', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 3 } }));

    governed(CTX, opts('mid'));
    governed(CTX, opts('mid'));

    expect(calls()[0]).toBe(CTX);
    expect(calls()[1]).toBe(CTX);
  });

  it('strips tools and appends the wrap-up message at the cap', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

    governed(CTX, opts('mid')); // call 1: below cap
    governed(CTX, opts('mid')); // call 2: AT cap

    const finalRequest = calls()[1];
    expect(finalRequest.tools).toEqual([]);
    expect(finalRequest.messages.length).toBe(CTX.messages.length + 1);
    const injected = finalRequest.messages[finalRequest.messages.length - 1];
    expect(injected.role).toBe('user');
    expect(injected.content).toBe(WRAP_UP_TEXT);
  });

  it('never mutates the original context (request-scoped only)', () => {
    const { streamFn } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 1 } }));
    const originalMessages = CTX.messages;
    const originalLength = originalMessages.length;

    governed(CTX, opts('mid'));

    expect(CTX.messages).toBe(originalMessages);
    expect(CTX.messages.length).toBe(originalLength);
    expect(CTX.tools.length).toBe(1);
  });

  it('applies the same treatment defensively to calls beyond the cap', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 1 } }));

    governed(CTX, opts('mid')); // AT cap
    governed(CTX, opts('mid')); // BEYOND cap

    expect(calls()[0].tools).toEqual([]);
    expect(calls()[1].tools).toEqual([]);
  });

  it('resets the call count per send', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

    governed(CTX, opts('mid'));
    governed(CTX, opts('mid')); // AT cap — stripped
    resetTurnGovernor();
    governed(CTX, opts('mid')); // fresh send, call 1 — untouched again

    expect(calls()[2].tools.length).toBe(1);
  });

  it('fires the cap-reached notice exactly once per send even across multiple over-cap calls', () => {
    const { streamFn } = recordingStreamFn();
    let notices: Array<{ effort: string; cap: number }> = [];
    const governed = withTurnGovernor(streamFn, () => ({
      caps: { mid: 1 },
      onCapReached: (effort, cap) => notices.push({ effort, cap }),
    }));

    governed(CTX, opts('mid'));
    governed(CTX, opts('mid'));
    governed(CTX, opts('mid'));

    expect(notices).toEqual([{ effort: 'mid', cap: 1 }]);
  });

  it('uses the default per-effort cap table when no override is given', () => {
    expect(DEFAULT_TURN_CAPS).toEqual({ low: 10, mid: 16, high: 20, super: 20 });

    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn);

    for (let i = 0; i < 9; i++) governed(CTX, opts('low'));
    expect(calls()[8].tools.length).toBe(1); // call 9 of 10 — still below cap

    governed(CTX, opts('low')); // call 10 — AT cap
    expect(calls()[9].tools).toEqual([]);
  });

  it('falls back to the mid cap for an unrecognized/absent reasoning value', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 1 } }));

    governed(CTX, opts(undefined));

    expect(calls()[0].tools).toEqual([]); // treated as 'mid', cap 1 reached immediately
  });
});
