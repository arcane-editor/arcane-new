import { describe, it, expect } from 'bun:test';
import { EFFORT_ORDER, nextEffort, clampEffort, effortLockMessage, restoreEffort } from './effort';
import type { Effort } from '../services/types';

describe('nextEffort', () => {
  it('steps one level in either direction', () => {
    expect(nextEffort('low', 1)).toBe('mid');
    expect(nextEffort('mid', 1)).toBe('high');
    expect(nextEffort('high', -1)).toBe('mid');
  });

  /**
   * Wrapping would turn a held-down arrow at the top of the scale into a
   * silent drop to the cheapest model, and vice versa. Both ends saturate.
   */
  it('saturates at both ends instead of wrapping', () => {
    expect(nextEffort('high', 1)).toBe('high');
    expect(nextEffort('low', -1)).toBe('low');
  });

  it('does not bank up steps taken past an end', () => {
    let level: Effort = 'mid';
    for (let i = 0; i < 5; i++) level = nextEffort(level, 1);
    expect(level).toBe('high');
    expect(nextEffort(level, -1)).toBe('mid');
  });

  it('reaches every level walking the scale end to end', () => {
    const seen: Effort[] = ['low'];
    let level: Effort = 'low';
    for (let i = 0; i < EFFORT_ORDER.length - 1; i++) {
      level = nextEffort(level, 1);
      seen.push(level);
    }
    expect(seen).toEqual(EFFORT_ORDER);
  });

  it('resolves an unrecognised level to the bottom of the scale', () => {
    expect(nextEffort('nonsense' as Effort, 1)).toBe('mid');
    expect(nextEffort('nonsense' as Effort, -1)).toBe('low');
  });

  it('is a no-op for a zero step', () => {
    for (const level of EFFORT_ORDER) expect(nextEffort(level, 0)).toBe(level);
  });
});

describe('clampEffort', () => {
  it('passes an effort through unchanged when it is within the ceiling', () => {
    expect(clampEffort('low', 'high')).toBe('low');
    expect(clampEffort('mid', 'mid')).toBe('mid');
    expect(clampEffort('high', 'high')).toBe('high');
  });

  it('clamps down to the ceiling when the effort exceeds it', () => {
    expect(clampEffort('high', 'low')).toBe('low');
    expect(clampEffort('high', 'mid')).toBe('mid');
    expect(clampEffort('mid', 'low')).toBe('low');
  });

  it('never clamps UP — a ceiling above the requested effort is a no-op', () => {
    expect(clampEffort('low', 'high')).toBe('low');
    expect(clampEffort('low', 'mid')).toBe('low');
  });

  it('an unrecognised effort ranks at the bottom of the scale, so it is never clamped further (coerceEffort sanitizes it separately)', () => {
    expect(clampEffort('nonsense' as Effort, 'high')).toBe('nonsense' as Effort);
    expect(clampEffort('nonsense' as Effort, 'low')).toBe('nonsense' as Effort);
  });

  it('an unrecognised ceiling also ranks at the bottom, so anything above \'low\' clamps down to it verbatim', () => {
    expect(clampEffort('high', 'nonsense' as Effort)).toBe('nonsense' as Effort);
    expect(clampEffort('low', 'nonsense' as Effort)).toBe('low');
  });
});

describe('effortLockMessage', () => {
  it('names the Pro plan for mid', () => {
    expect(effortLockMessage('mid')).toBe(
      'Deep Think — available on the Pro plan. Upgrade in Settings → Account.',
    );
  });

  it('names the Max plan for high', () => {
    expect(effortLockMessage('high')).toBe(
      'Max — available on the Max plan. Upgrade in Settings → Account.',
    );
  });

  it('is empty for low — every plan, including unknown, may request it', () => {
    expect(effortLockMessage('low')).toBe('');
  });
});

describe('restoreEffort', () => {
  it('leaves the persisted effort unclamped when the ceiling is unknown (cold start)', () => {
    expect(restoreEffort('high', null)).toBe('high');
    expect(restoreEffort('mid', null)).toBe('mid');
  });

  it('clamps the persisted effort to a known ceiling', () => {
    expect(restoreEffort('high', 'low')).toBe('low');
    expect(restoreEffort('high', 'mid')).toBe('mid');
  });

  it('is a no-op when the persisted effort is already within a known ceiling', () => {
    expect(restoreEffort('low', 'high')).toBe('low');
    expect(restoreEffort('mid', 'mid')).toBe('mid');
  });
});
