import { describe, it, expect, beforeEach } from 'bun:test';
import { COACH_MARKS, hasSeen, markSeen, resetSeen, shouldShow } from './coach-marks';

// bun's test env has no localStorage; a minimal in-memory stand-in is enough
// to exercise the persistence rules, which are the part that can nag a user.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

beforeEach(() => store.clear());

const SETTLED = 10_000;

describe('shouldShow', () => {
  it('shows a hint that has not been seen', () => {
    expect(shouldShow('unityConnected', true, SETTLED)).toBe(true);
  });

  /** The entire point: a hint fires once, ever. */
  it('never shows the same hint twice', () => {
    markSeen('unityConnected');
    expect(shouldShow('unityConnected', true, SETTLED)).toBe(false);
  });

  it('respects the global off switch', () => {
    expect(shouldShow('unityConnected', false, SETTLED)).toBe(false);
  });

  /** Nothing competes with the app finishing its own startup. */
  it('stays quiet during the first seconds of a session', () => {
    expect(shouldShow('unityConnected', true, 500)).toBe(false);
  });

  it('ignores an unknown id rather than inventing a hint', () => {
    expect(shouldShow('no.such.hint', true, SETTLED)).toBe(false);
  });
});

describe('persistence', () => {
  it('remembers across reads', () => {
    expect(hasSeen('firstCsharpFile')).toBe(false);
    markSeen('firstCsharpFile');
    expect(hasSeen('firstCsharpFile')).toBe(true);
  });

  it('resetSeen brings every hint back', () => {
    for (const id of Object.keys(COACH_MARKS)) markSeen(id);
    resetSeen();
    for (const id of Object.keys(COACH_MARKS)) {
      expect(shouldShow(id, true, SETTLED)).toBe(true);
    }
  });

  /**
   * A corrupt value must not resurrect every hint at once — that would be the
   * single most annoying possible failure mode.
   */
  it('treats an unreadable record as everything-seen', () => {
    store.set('unityide.coachMarks.seen', '{not json');
    for (const id of Object.keys(COACH_MARKS)) {
      expect(shouldShow(id, true, SETTLED)).toBe(false);
    }
  });
});

describe('COACH_MARKS', () => {
  it('gives every hint an anchor and a message', () => {
    for (const [key, mark] of Object.entries(COACH_MARKS)) {
      expect({ key, id: mark.id }).toEqual({ key, id: key });
      expect(mark.anchor.length).toBeGreaterThan(0);
      expect(mark.message.length).toBeGreaterThan(0);
    }
  });
});
