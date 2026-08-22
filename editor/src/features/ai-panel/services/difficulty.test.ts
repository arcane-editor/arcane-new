import { describe, expect, it } from 'bun:test';
import { difficultyForRequest } from './difficulty';

const inProgressEasy = [
  { status: 'done', difficulty: 'hard' as const },
  { status: 'in_progress', difficulty: 'easy' as const },
  { status: 'pending', difficulty: 'hard' as const },
];

describe('difficultyForRequest', () => {
  it('returns undefined for any effort other than high', () => {
    expect(difficultyForRequest('low', 'agent', inProgressEasy)).toBeUndefined();
    expect(difficultyForRequest('mid', 'agent', inProgressEasy)).toBeUndefined();
    expect(difficultyForRequest(undefined, 'agent', inProgressEasy)).toBeUndefined();
    expect(difficultyForRequest('bogus', 'agent', inProgressEasy)).toBeUndefined();
  });

  it('returns undefined for high effort outside agent/plan-execution', () => {
    expect(difficultyForRequest('high', 'ask', inProgressEasy)).toBeUndefined();
    expect(difficultyForRequest('high', 'preplanning', inProgressEasy)).toBeUndefined();
    expect(difficultyForRequest('high', 'plan-planning', inProgressEasy)).toBeUndefined();
    expect(difficultyForRequest('high', null, inProgressEasy)).toBeUndefined();
  });

  it('returns undefined when there is no plan', () => {
    expect(difficultyForRequest('high', 'agent', null)).toBeUndefined();
    expect(difficultyForRequest('high', 'agent', [])).toBeUndefined();
  });

  it('prefers the first in_progress entry over pending, for both gated modes', () => {
    expect(difficultyForRequest('high', 'agent', inProgressEasy)).toBe('easy');
    expect(difficultyForRequest('high', 'plan-execution', inProgressEasy)).toBe('easy');
  });

  it('falls back to the first pending entry when there is no in_progress entry', () => {
    const plan = [
      { status: 'done', difficulty: 'easy' as const },
      { status: 'pending', difficulty: 'hard' as const },
      { status: 'pending', difficulty: 'easy' as const },
    ];
    expect(difficultyForRequest('high', 'agent', plan)).toBe('hard');
  });

  it('returns undefined when the winning entry is untagged, without falling through to a later entry', () => {
    const plan = [
      { status: 'in_progress' }, // untagged in_progress
      { status: 'pending', difficulty: 'hard' as const },
    ];
    expect(difficultyForRequest('high', 'agent', plan)).toBeUndefined();
  });

  it('returns undefined when neither in_progress nor pending entries exist', () => {
    const plan = [{ status: 'done', difficulty: 'hard' as const }];
    expect(difficultyForRequest('high', 'agent', plan)).toBeUndefined();
  });
});
