import { describe, it, expect, beforeEach } from 'bun:test';
import {
  withTurnEscalation,
  resetTurnEscalation,
  getEffectiveReasoningLevel,
  isEscalated,
} from './turn-escalation';
import type { Context, StreamFn, StreamOptions } from './vendor/types';
import { AssistantMessageEventStream } from './vendor/event-stream';

const CTX: Context = { systemPrompt: 'SYS', messages: [{ role: 'user', content: 'hi', timestamp: 1 }], tools: [] };

function opts(reasoning?: string): StreamOptions {
  return { model: { id: 'm', name: 'm', provider: 'x' }, reasoning };
}

/** Records every StreamOptions it was called with and returns an immediately-done text response. */
function recordingStreamFn(): { streamFn: StreamFn; calls: () => StreamOptions[] } {
  const calls: StreamOptions[] = [];
  const streamFn: StreamFn = (_context, options) => {
    calls.push(options);
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

describe('getEffectiveReasoningLevel (pure escalation state)', () => {
  beforeEach(() => resetTurnEscalation());

  it('stays at the current tier below the repair threshold', () => {
    expect(getEffectiveReasoningLevel('low', 0, () => {})).toBe('low');
    expect(getEffectiveReasoningLevel('low', 1, () => {})).toBe('low');
  });

  it('escalates low -> mid at the threshold, firing the notice once', () => {
    const notices: string[] = [];
    expect(getEffectiveReasoningLevel('low', 2, (tier) => notices.push(tier))).toBe('mid');
    expect(notices).toEqual(['mid']);
  });

  it('escalates mid -> high at the threshold', () => {
    expect(getEffectiveReasoningLevel('mid', 2, () => {})).toBe('high');
  });

  it('is a no-op for high — nothing stronger to escalate to', () => {
    expect(getEffectiveReasoningLevel('high', 5, () => {})).toBe('high');
    expect(isEscalated()).toBe(false);
  });

  it('escalates once per send — latches even as the repair count keeps growing', () => {
    const notices: string[] = [];
    expect(getEffectiveReasoningLevel('low', 2, (tier) => notices.push(tier))).toBe('mid');
    expect(getEffectiveReasoningLevel('low', 5, (tier) => notices.push(tier))).toBe('mid'); // still mid, not high
    expect(notices).toEqual(['mid']); // notice fired exactly once
  });

  it('reset clears the latch for the next send', () => {
    expect(getEffectiveReasoningLevel('low', 2, () => {})).toBe('mid');
    expect(isEscalated()).toBe(true);

    resetTurnEscalation();

    expect(isEscalated()).toBe(false);
    expect(getEffectiveReasoningLevel('low', 0, () => {})).toBe('low');
  });
});

describe('withTurnEscalation', () => {
  beforeEach(() => resetTurnEscalation());

  it('passes the original reasoning through below the threshold', () => {
    const { streamFn, calls } = recordingStreamFn();
    const escalated = withTurnEscalation(streamFn, () => ({ getRepairCount: () => 1 }));

    escalated(CTX, opts('low'));

    expect(calls()[0].reasoning).toBe('low');
  });

  it('overrides reasoning for this and all subsequent requests once the threshold is crossed', () => {
    const { streamFn, calls } = recordingStreamFn();
    const escalated = withTurnEscalation(streamFn, () => ({ getRepairCount: () => 2 }));

    // agent-loop.ts always threads the ORIGINAL effort set via `agent.
    // setReasoning` into every call — the override must still apply.
    escalated(CTX, opts('low'));
    escalated(CTX, opts('low'));

    expect(calls()[0].reasoning).toBe('mid');
    expect(calls()[1].reasoning).toBe('mid');
  });

  it('fires the escalation notice exactly once per send', () => {
    const { streamFn } = recordingStreamFn();
    const notices: string[] = [];
    const escalated = withTurnEscalation(streamFn, () => ({
      getRepairCount: () => 2,
      onEscalate: (tier) => notices.push(tier),
    }));

    escalated(CTX, opts('low'));
    escalated(CTX, opts('low'));
    escalated(CTX, opts('low'));

    expect(notices).toEqual(['mid']);
  });

  it('is a no-op for high effort even over the repair threshold', () => {
    const { streamFn, calls } = recordingStreamFn();
    const escalated = withTurnEscalation(streamFn, () => ({ getRepairCount: () => 4 }));

    escalated(CTX, opts('high'));

    expect(calls()[0].reasoning).toBe('high');
    expect(isEscalated()).toBe(false);
  });

  it('does nothing when disabled via config, even over the threshold', () => {
    const { streamFn, calls } = recordingStreamFn();
    const escalated = withTurnEscalation(streamFn, () => ({ isEnabled: () => false, getRepairCount: () => 5 }));

    escalated(CTX, opts('low'));

    expect(calls()[0].reasoning).toBe('low');
    expect(isEscalated()).toBe(false);
  });

  it('resets the escalation latch per send', () => {
    const { streamFn, calls } = recordingStreamFn();
    const escalated = withTurnEscalation(streamFn, () => ({ getRepairCount: () => 2 }));

    escalated(CTX, opts('low'));
    resetTurnEscalation();
    escalated(CTX, opts('low')); // fresh send — escalates again from a clean latch

    expect(calls()[0].reasoning).toBe('mid');
    expect(calls()[1].reasoning).toBe('mid');
  });
});
