import { describe, it, expect, beforeEach } from 'bun:test';
import {
  withTurnGovernor,
  resetTurnGovernor,
  grantExtraCalls,
  beginSubmitBudget,
  endSubmitBudget,
  getSubmitCallCount,
  wasCapReachedThisSend,
  softLimitNotice,
  capReachedNotice,
  DEFAULT_TURN_CAPS,
  SOFT_LIMIT_RATIO,
  WRAP_UP_TEXT,
} from './turn-governor';
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
  // `endSubmitBudget()` first: module state persists across tests in this
  // file, so a test that opens a submit budget and forgets to close it must
  // not leak `submitOpen` into the next test — `resetTurnGovernor()` alone
  // wouldn't zero the count while a submit is (still) open.
  beforeEach(() => {
    endSubmitBudget();
    resetTurnGovernor();
  });

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
    expect(DEFAULT_TURN_CAPS).toEqual({ low: 1000, mid: 1600, high: 2000 });

    const { streamFn, calls } = recordingStreamFn();
    const governed = withTurnGovernor(streamFn);
    const cap = DEFAULT_TURN_CAPS.low;

    for (let i = 0; i < cap - 1; i++) governed(CTX, opts('low'));
    expect(isGoverned(calls()[cap - 2])).toBe(false); // call cap-1 of cap — still below cap

    governed(CTX, opts('low')); // call `cap` — AT cap
    expect(isGoverned(calls()[cap - 1])).toBe(true);
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

  describe('submit-scoped budget', () => {
    it('single-send submits (no beginSubmitBudget) keep per-send semantics: resetTurnGovernor still zeroes the count', () => {
      const { streamFn, calls } = recordingStreamFn();
      const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

      governed(CTX, opts('mid')); // call 1
      governed(CTX, opts('mid')); // call 2: AT cap
      resetTurnGovernor(); // no submit open — resets exactly like today
      governed(CTX, opts('mid')); // fresh call 1 — untouched again

      expect(isGoverned(calls()[1])).toBe(true);
      expect(isGoverned(calls()[2])).toBe(false);
    });

    it('accumulates the call count across chained sends inside an open submit — the 3rd call overall is governed, not the 3rd call of send 2', () => {
      const { streamFn, calls } = recordingStreamFn();
      const governed = withTurnGovernor(streamFn, () => ({ caps: { high: 3 } }));

      beginSubmitBudget();
      governed(CTX, opts('high')); // submit call 1 (send 1)
      governed(CTX, opts('high')); // submit call 2 (send 1)
      resetTurnGovernor(); // between sends — submit stays open, count NOT reset
      governed(CTX, opts('high')); // submit call 3 — the FIRST call of send 2, but AT cap overall

      expect(isGoverned(calls()[0])).toBe(false);
      expect(isGoverned(calls()[1])).toBe(false);
      expect(isGoverned(calls()[2])).toBe(true);
      expect(getSubmitCallCount()).toBe(3);
    });

    it('endSubmitBudget then resetTurnGovernor zeroes the count', () => {
      const { streamFn, calls } = recordingStreamFn();
      const governed = withTurnGovernor(streamFn, () => ({ caps: { high: 3 } }));

      beginSubmitBudget();
      governed(CTX, opts('high'));
      governed(CTX, opts('high'));
      endSubmitBudget();
      resetTurnGovernor();
      governed(CTX, opts('high')); // fresh count: call 1, not call 3

      expect(getSubmitCallCount()).toBe(1);
      expect(isGoverned(calls()[2])).toBe(false);
    });

    it('endSubmitBudget is idempotent', () => {
      const { streamFn, calls } = recordingStreamFn();
      const governed = withTurnGovernor(streamFn, () => ({ caps: { high: 3 } }));

      beginSubmitBudget();
      governed(CTX, opts('high'));
      endSubmitBudget();
      endSubmitBudget(); // no-op, does not throw
      resetTurnGovernor();
      governed(CTX, opts('high')); // fresh count: call 1

      expect(getSubmitCallCount()).toBe(1);
      expect(isGoverned(calls()[1])).toBe(false);
    });

    it('beginSubmitBudget called while a scope is already open restarts it (zeroes the count and flags)', () => {
      const { streamFn, calls } = recordingStreamFn();
      const governed = withTurnGovernor(streamFn, () => ({ caps: { high: 2 } }));

      beginSubmitBudget();
      governed(CTX, opts('high')); // submit call 1
      governed(CTX, opts('high')); // submit call 2 — AT cap
      beginSubmitBudget(); // restarts the budget
      governed(CTX, opts('high')); // fresh submit call 1 — untouched

      expect(isGoverned(calls()[1])).toBe(true);
      expect(isGoverned(calls()[2])).toBe(false);
      expect(getSubmitCallCount()).toBe(1);
    });
  });

  describe('onProgress', () => {
    it('reports the submit-scoped count on every call, including the governed one', () => {
      const { streamFn } = recordingStreamFn();
      const progress: Array<{ used: number; cap: number; effort: string }> = [];
      const governed = withTurnGovernor(streamFn, () => ({
        caps: { mid: 2 },
        onProgress: (used, cap, effort) => progress.push({ used, cap, effort }),
      }));

      governed(CTX, opts('mid')); // call 1 — below cap
      governed(CTX, opts('mid')); // call 2 — AT cap, governed, still reports

      expect(progress).toEqual([
        { used: 1, cap: 2, effort: 'mid' },
        { used: 2, cap: 2, effort: 'mid' },
      ]);
    });
  });

  describe('onSoftLimit', () => {
    it('fires exactly once per submit at ceil(cap * SOFT_LIMIT_RATIO)', () => {
      const { streamFn } = recordingStreamFn();
      const notices: Array<{ effort: string; used: number; cap: number }> = [];
      const governed = withTurnGovernor(streamFn, () => ({
        caps: { mid: 4 },
        onSoftLimit: (effort, used, cap) => notices.push({ effort, used, cap }),
      }));

      const threshold = Math.ceil(4 * SOFT_LIMIT_RATIO);
      governed(CTX, opts('mid')); // 1
      governed(CTX, opts('mid')); // 2 — crosses the threshold
      governed(CTX, opts('mid')); // 3
      governed(CTX, opts('mid')); // 4 — AT cap, not soft

      expect(threshold).toBe(2);
      expect(notices).toEqual([{ effort: 'mid', used: 2, cap: 4 }]);
    });

    it('does not fire again after a reset within an open submit', () => {
      const { streamFn } = recordingStreamFn();
      let fireCount = 0;
      const governed = withTurnGovernor(streamFn, () => ({
        caps: { mid: 4 },
        onSoftLimit: () => {
          fireCount++;
        },
      }));

      beginSubmitBudget();
      governed(CTX, opts('mid')); // 1
      governed(CTX, opts('mid')); // 2 — fires
      resetTurnGovernor(); // submit still open — notice flags NOT cleared
      governed(CTX, opts('mid')); // 3 — no second fire
      governed(CTX, opts('mid')); // 4 — AT cap

      expect(fireCount).toBe(1);
      endSubmitBudget();
    });

    it('fires again after a new beginSubmitBudget', () => {
      const { streamFn } = recordingStreamFn();
      let fireCount = 0;
      const governed = withTurnGovernor(streamFn, () => ({
        caps: { mid: 4 },
        onSoftLimit: () => {
          fireCount++;
        },
      }));

      beginSubmitBudget();
      governed(CTX, opts('mid'));
      governed(CTX, opts('mid')); // fires (1st)
      endSubmitBudget();

      beginSubmitBudget();
      governed(CTX, opts('mid'));
      governed(CTX, opts('mid')); // fires again (2nd) — new submit
      endSubmitBudget();

      expect(fireCount).toBe(2);
    });
  });

  describe('wasCapReachedThisSend', () => {
    it('is false below the cap, true after the governed call, false again after resetTurnGovernor', () => {
      const { streamFn } = recordingStreamFn();
      const governed = withTurnGovernor(streamFn, () => ({ caps: { mid: 2 } }));

      governed(CTX, opts('mid')); // below cap
      expect(wasCapReachedThisSend()).toBe(false);

      governed(CTX, opts('mid')); // AT cap
      expect(wasCapReachedThisSend()).toBe(true);

      resetTurnGovernor();
      expect(wasCapReachedThisSend()).toBe(false);
    });
  });
});

describe('notice copy', () => {
  it('pins softLimitNotice', () => {
    expect(softLimitNotice(5, 10)).toBe(
      'This task has used 5 of its 10 model calls. It will wrap up on its own at the limit.',
    );
  });

  it('pins capReachedNotice', () => {
    expect(capReachedNotice(10)).toBe(
      'Reached the 10 model-call limit for this task and asked the agent to wrap up. Reply "continue" to pick up where it left off.',
    );
  });
});

// Regression pin: at the cap the model's tools are disabled via
// tool_choice:'none'. The old wrap-up text ("Stop using tools; summarize…")
// never said WHY, so models confabulated "I'm hitting an intermittent tool
// limitation where write becomes unavailable" and pasted file contents for the
// user to apply by hand. The instruction must name the real cause and the real
// recovery path, and forbid the failure narrative.
describe('WRAP_UP_TEXT honesty', () => {
  it('names the turn limit, forbids claiming tool failure, and points at continue', () => {
    expect(WRAP_UP_TEXT).toContain('turn limit');
    expect(WRAP_UP_TEXT.toLowerCase()).toContain('not broken');
    expect(WRAP_UP_TEXT).toContain("'continue'");
    expect(WRAP_UP_TEXT.toLowerCase()).toContain('do not paste');
  });
});
