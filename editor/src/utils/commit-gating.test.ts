import { describe, expect, test } from 'bun:test';
import { canCommit, needsAutoStage } from './commit-gating';

describe('canCommit', () => {
  test('empty or whitespace message never commits', () => {
    expect(canCommit('', 1, 0, false)).toBe(false);
    expect(canCommit('   ', 0, 3, false)).toBe(false);
    expect(canCommit('', 0, 0, true)).toBe(false);
  });

  test('unstaged-only changes enable commit (smart commit)', () => {
    expect(canCommit('fix', 0, 2, false)).toBe(true);
  });

  test('staged-only changes enable commit', () => {
    expect(canCommit('fix', 2, 0, false)).toBe(true);
  });

  test('no changes at all disables commit unless amending', () => {
    expect(canCommit('fix', 0, 0, false)).toBe(false);
    expect(canCommit('reword', 0, 0, true)).toBe(true);
  });
});

describe('needsAutoStage', () => {
  test('nothing staged but changes exist: stage all first', () => {
    expect(needsAutoStage(0, 2, false)).toBe(true);
  });

  test('something already staged: commit staged-only (VS Code semantics)', () => {
    expect(needsAutoStage(1, 3, false)).toBe(false);
  });

  test('amend never auto-stages', () => {
    expect(needsAutoStage(0, 2, true)).toBe(false);
  });

  test('nothing to stage: no-op', () => {
    expect(needsAutoStage(0, 0, false)).toBe(false);
  });
});
