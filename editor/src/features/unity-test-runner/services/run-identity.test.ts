import { expect, it } from 'bun:test';
import { sameTestRun } from './run-identity';
it('does not let delayed, foreign, or uncorrelated events finish an identified run', () => {
  expect(sameTestRun('current', 'current')).toBe(true);
  for (const value of ['previous', '', null, undefined, 42]) expect(sameTestRun('current', value)).toBe(false);
  expect(sameTestRun(undefined, null)).toBe(true);
  expect(sameTestRun(undefined, 'identified')).toBe(false);
});
