import { describe, it, expect } from 'bun:test';
import { hotSet } from './hot-blocks';

const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

describe('hotSet', () => {
  it('hydrates the visible blocks', () => {
    expect(hotSet([0, 1], [], keys, 8).hot).toEqual(['a', 'b']);
  });

  it('keeps previously hot blocks that are still under the cap', () => {
    // Both previous entries ('a' and 'b') must survive, in their original
    // order — a `toContain('a')`-only assertion would still pass if the
    // implementation silently dropped 'b' (or reordered it ahead of 'a'),
    // because dropping/reordering one entry doesn't touch whether the OTHER
    // is present. Asserting the full array catches both.
    const { hot, evicted } = hotSet([2], ['a', 'b'], keys, 8);
    expect(hot).toEqual(['c', 'a', 'b']);
    expect(evicted).toEqual([]);
  });

  it('evicts the least recently visible once over the cap', () => {
    const previous = ['a', 'b', 'c'];
    const { hot, evicted } = hotSet([3], previous, keys, 3);
    expect(hot).toEqual(['d', 'a', 'b']);
    expect(evicted).toEqual(['c']);
  });

  it('never evicts a block that is currently visible', () => {
    const { hot, evicted } = hotSet([0, 1, 2], ['x', 'y', 'z'], keys, 3);
    expect(hot).toEqual(['a', 'b', 'c']);
    expect(evicted).toEqual(['x', 'y', 'z']);
  });

  it('drops keys that no longer exist — a new query replaced the results', () => {
    const { hot, evicted } = hotSet([0], ['gone'], keys, 8);
    expect(hot).toEqual(['a']);
    expect(evicted).toEqual(['gone']);
  });

  it('is stable when nothing changed', () => {
    const { hot, evicted } = hotSet([0], ['a'], keys, 8);
    expect(hot).toEqual(['a']);
    expect(evicted).toEqual([]);
  });
});
