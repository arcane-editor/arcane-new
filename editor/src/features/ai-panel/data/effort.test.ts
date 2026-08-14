import { describe, it, expect } from 'bun:test';
import { EFFORT_ORDER, nextEffort } from './effort';
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
