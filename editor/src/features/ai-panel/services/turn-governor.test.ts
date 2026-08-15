import { describe, it, expect, beforeEach } from 'bun:test';
import { withTurnGovernor, resetTurnGovernor, grantExtraCalls, DEFAULT_TURN_CAPS, WRAP_UP_TEXT } from './turn-governor';
import { getStreamExtras } from './stream-extras';
import type { Context, StreamFn, StreamOptions } from './vendor/types';
import { AssistantMessageEventStream } from './vendor/event-stream';

/** A governed request keeps its tools but carries tool_choice: 'none'. */
function isGoverned(c: Context): boolean {
  return getStreamExtras(c)?.toolChoice === 'none';
}

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

  it('keeps tools, sets tool_choice none, and appends the wrap-up message at the cap', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

    governed(CTX, opts('mid')); // call 1: below cap
    governed(CTX, opts('mid')); // call 2: AT cap

    const finalRequest = calls()[1];
    // Tools stay byte-identical — they head the provider's cached prompt
    // prefix. The governed request signals tool_choice 'none' instead.
    expect(finalRequest.tools).toBe(CTX.tools);
    expect(isGoverned(finalRequest)).toBe(true);
    expect(isGoverned(calls()[0])).toBe(false);
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

    expect(isGoverned(calls()[0])).toBe(true);
    expect(isGoverned(calls()[1])).toBe(true);
  });

  it('resets the call count per send', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

    governed(CTX, opts('mid'));
    governed(CTX, opts('mid')); // AT cap — governed
    resetTurnGovernor();
    governed(CTX, opts('mid')); // fresh send, call 1 — untouched again

    expect(isGoverned(calls()[2])).toBe(false);
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
    expect(DEFAULT_TURN_CAPS).toEqual({ low: 10, mid: 16, high: 20 });

    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn);

    for (let i = 0; i < 9; i++) governed(CTX, opts('low'));
    expect(isGoverned(calls()[8])).toBe(false); // call 9 of 10 — still below cap

    governed(CTX, opts('low')); // call 10 — AT cap
    expect(isGoverned(calls()[9])).toBe(true);
  });

  it('falls back to the mid cap for an unrecognized/absent reasoning value', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 1 } }));

    governed(CTX, opts(undefined));

    expect(isGoverned(calls()[0])).toBe(true); // treated as 'mid', cap 1 reached immediately
  });

  it('grantExtraCalls(1) at cap allows one more call through untouched', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

    governed(CTX, opts('mid')); // call 1: below cap
    governed(CTX, opts('mid')); // call 2: AT cap, governed
    grantExtraCalls(1);
    governed(CTX, opts('mid')); // call 3: extra grant used, untouched

    expect(isGoverned(calls()[1])).toBe(true); // capped
    expect(isGoverned(calls()[2])).toBe(false); // grant allowed through
  });

  it('call after grantExtraCalls grant is consumed stays capped', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

    governed(CTX, opts('mid')); // call 1
    governed(CTX, opts('mid')); // call 2: AT cap
    grantExtraCalls(1);
    governed(CTX, opts('mid')); // call 3: grant used, untouched
    governed(CTX, opts('mid')); // call 4: grant consumed, now capped

    expect(isGoverned(calls()[2])).toBe(false); // grant allowed
    expect(isGoverned(calls()[3])).toBe(true); // back to capped
  });

  it('reset clears the extra-calls grant', () => {
    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

    governed(CTX, opts('mid')); // call 1: below cap
    governed(CTX, opts('mid')); // call 2: AT cap, governed
    grantExtraCalls(1);
    resetTurnGovernor();
    governed(CTX, opts('mid')); // fresh send, call 1 — untouched again

    expect(isGoverned(calls()[1])).toBe(true); // second call was capped
    expect(isGoverned(calls()[2])).toBe(false); // reset cleared the grant + reset count, fresh send
  });
});
