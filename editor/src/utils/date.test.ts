import { describe, expect, it } from 'bun:test';
import { formatRelativeDate } from './date';

// This module had no tests and now names the age of every thread in the design
// dock's history list, alongside the git log and the recent-projects list.
describe('formatRelativeDate', () => {
  const ago = (ms: number) => formatRelativeDate(new Date(Date.now() - ms).toISOString());

  it('climbs the units', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(4 * 60_000)).toBe('4m ago');
    expect(ago(3 * 3_600_000)).toBe('3h ago');
    expect(ago(2 * 86_400_000)).toBe('2d ago');
    expect(ago(60 * 86_400_000)).toBe('2mo ago');
    expect(ago(400 * 86_400_000)).toBe('1y ago');
  });

  it('reads a future timestamp as "just now" rather than a negative age', () => {
    // Clock skew, or a session file written by another machine.
    expect(formatRelativeDate(new Date(Date.now() + 60_000).toISOString())).toBe('just now');
  });

  it('hands back anything it cannot parse, rather than showing NaN', () => {
    expect(formatRelativeDate('not a date')).toBe('not a date');
  });
});
