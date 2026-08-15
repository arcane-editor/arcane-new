import { describe, it, expect, beforeEach } from 'bun:test';
import {
  resolveSendEffort,
  resetSendEscalation,
  SEND_ESCALATION_THRESHOLD,
} from './send-escalation';

const on = () => true;
const off = () => false;

describe('send-boundary escalation (cache-aware turn-escalation replacement)', () => {
  beforeEach(() => resetSendEscalation());

  it('no escalation below the repair threshold', () => {
    expect(resolveSendEffort('s1', 'low', SEND_ESCALATION_THRESHOLD - 1, on)).toEqual({
      effort: 'low',
      escalatedNow: false,
    });
  });

  it('escalates one tier at the threshold and reports escalatedNow once', () => {
    expect(resolveSendEffort('s1', 'low', 2, on)).toEqual({ effort: 'mid', escalatedNow: true });
    // Later sends in the same conversation stay latched, no repeated notice.
    expect(resolveSendEffort('s1', 'low', 0, on)).toEqual({ effort: 'mid', escalatedNow: false });
  });

  it('mid escalates to high; high has nowhere to go', () => {
    expect(resolveSendEffort('s1', 'mid', 3, on).effort).toBe('high');
    resetSendEscalation();
    expect(resolveSendEffort('s1', 'high', 5, on)).toEqual({ effort: 'high', escalatedNow: false });
  });

  it('latch is per conversation', () => {
    resolveSendEffort('s1', 'low', 2, on);
    expect(resolveSendEffort('s2', 'low', 0, on).effort).toBe('low');
  });

  it('a user manually raising effort to/above the latch clears it', () => {
    resolveSendEffort('s1', 'low', 2, on); // latched at mid
    // User flips the effort selector to mid themselves → latch dissolves.
    expect(resolveSendEffort('s1', 'mid', 0, on)).toEqual({ effort: 'mid', escalatedNow: false });
    // …and with the latch gone, low is low again.
    expect(resolveSendEffort('s1', 'low', 0, on).effort).toBe('low');
  });

  it('disabled setting and missing sessionId are passthroughs', () => {
    expect(resolveSendEffort('s1', 'low', 5, off).effort).toBe('low');
    expect(resolveSendEffort(null, 'low', 5, on).effort).toBe('low');
  });

  it('resetSendEscalation clears latches', () => {
    resolveSendEffort('s1', 'low', 2, on);
    resetSendEscalation();
    expect(resolveSendEffort('s1', 'low', 0, on).effort).toBe('low');
  });
});
