import { describe, it, expect, beforeEach } from 'bun:test';
import {
  getFrozenDecoration,
  graphChangedSinceFreeze,
  resetFrozenDecoration,
  type FrozenBlocks,
} from './frozen-context';

function blocks(facts: string | null, snapshot: string | null): FrozenBlocks {
  return { factsBlock: facts, contextPack: null, graphSnapshot: snapshot };
}

describe('frozen-context (per-conversation prompt stability)', () => {
  beforeEach(() => resetFrozenDecoration());

  it('captures once per sessionId and returns byte-identical blocks afterwards', () => {
    let liveFacts = 'facts v1';
    const capture = () => blocks(liveFacts, 'snap v1');

    const first = getFrozenDecoration('s1', capture);
    expect(first.factsBlock).toBe('facts v1');

    // Underlying "live" content changes mid-conversation…
    liveFacts = 'facts v2';

    // …but the frozen conversation keeps seeing the original capture.
    const second = getFrozenDecoration('s1', capture);
    expect(second.factsBlock).toBe('facts v1');
    expect(second).toBe(first); // same object, not a re-capture
  });

  it('a new sessionId re-captures from live sources', () => {
    let liveFacts = 'facts v1';
    const capture = () => blocks(liveFacts, null);

    getFrozenDecoration('s1', capture);
    liveFacts = 'facts v2';

    const other = getFrozenDecoration('s2', capture);
    expect(other.factsBlock).toBe('facts v2');
  });

  it('null sessionId is a passthrough (no freezing)', () => {
    let liveFacts = 'a';
    const capture = () => blocks(liveFacts, null);

    expect(getFrozenDecoration(null, capture).factsBlock).toBe('a');
    liveFacts = 'b';
    expect(getFrozenDecoration(null, capture).factsBlock).toBe('b');
  });

  it('resetFrozenDecoration clears all frozen sessions', () => {
    let liveFacts = 'v1';
    const capture = () => blocks(liveFacts, null);
    getFrozenDecoration('s1', capture);

    resetFrozenDecoration();
    liveFacts = 'v2';
    expect(getFrozenDecoration('s1', capture).factsBlock).toBe('v2');
  });

  it('evicts the oldest frozen session beyond the cap (no unbounded growth)', () => {
    const capture = (v: string) => () => blocks(v, null);
    getFrozenDecoration('s1', capture('one'));
    getFrozenDecoration('s2', capture('two'));
    getFrozenDecoration('s3', capture('three'));
    getFrozenDecoration('s4', capture('four'));
    getFrozenDecoration('s5', capture('five')); // evicts s1

    // s1 was evicted → re-captures fresh
    expect(getFrozenDecoration('s1', capture('one-again')).factsBlock).toBe('one-again');
    // s5 still frozen
    expect(getFrozenDecoration('s5', capture('stale')).factsBlock).toBe('five');
  });

  describe('graphChangedSinceFreeze', () => {
    it('false when nothing frozen or snapshot unchanged, true when it drifted', () => {
      expect(graphChangedSinceFreeze('s1', 'snap A')).toBe(false); // nothing frozen yet

      getFrozenDecoration('s1', () => blocks('f', 'snap A'));
      expect(graphChangedSinceFreeze('s1', 'snap A')).toBe(false);
      expect(graphChangedSinceFreeze('s1', 'snap B')).toBe(true);
      // a graph that disappeared (null) is not "changed" for notice purposes
      expect(graphChangedSinceFreeze('s1', null)).toBe(false);
      expect(graphChangedSinceFreeze(null, 'snap B')).toBe(false);
    });
  });
});
