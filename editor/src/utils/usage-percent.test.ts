import { describe, it, expect } from 'bun:test';
import { usagePercent } from './usage-percent';

describe('usagePercent', () => {
  it('computes the plain case: percent of grant already spent', () => {
    expect(usagePercent(100, 100)).toBe(0); // full balance — nothing used
    expect(usagePercent(100, 0)).toBe(100); // fully spent
    expect(usagePercent(100, 50)).toBe(50);
    expect(usagePercent(387, 193.5)).toBe(50); // rounds to the nearest integer
  });

  it('zero grant: hides the figure unless the balance is also exhausted', () => {
    expect(usagePercent(0, 0)).toBe(100);
    expect(usagePercent(0, -5)).toBe(100); // an overdrawn zero-grant balance still reads "fully used"
    expect(usagePercent(0, 1)).toBeNull();
    expect(usagePercent(0, 150)).toBeNull();
  });

  it('negative grant is treated the same as zero (the <= 0 guard)', () => {
    expect(usagePercent(-10, 0)).toBe(100);
    expect(usagePercent(-10, 5)).toBeNull();
  });

  it('a balance above the grant (overcredit race) clamps to 0% used, not negative', () => {
    expect(usagePercent(100, 150)).toBe(0);
  });

  it('a negative balance (overdraft race) clamps to 100% used, not above', () => {
    expect(usagePercent(100, -50)).toBe(100);
  });

  it('rounds to the nearest integer rather than truncating', () => {
    expect(usagePercent(3, 1)).toBe(67); // 66.66... rounds up
    expect(usagePercent(3, 2)).toBe(33); // 33.33... rounds down
  });
});
