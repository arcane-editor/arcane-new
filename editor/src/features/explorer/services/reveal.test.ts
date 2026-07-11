import { describe, it, expect, beforeEach } from 'bun:test';
import { ancestorDirs, setPendingReveal, consumePendingReveal } from './reveal';

describe('ancestorDirs', () => {
  it('returns each ancestor directory, top-down, excluding root and the file itself', () => {
    expect(ancestorDirs('/proj/Assets', '/proj/Assets/Scripts/Foo/Bar.cs')).toEqual([
      '/proj/Assets/Scripts',
      '/proj/Assets/Scripts/Foo',
    ]);
  });

  it('returns an empty array when the file sits directly under root', () => {
    expect(ancestorDirs('/proj/Assets', '/proj/Assets/Bar.cs')).toEqual([]);
  });

  it('returns an empty array when the file sits directly under a root with a trailing slash', () => {
    expect(ancestorDirs('/proj/Assets/', '/proj/Assets/Bar.cs')).toEqual([]);
  });

  it('returns null when the path is not under root at all', () => {
    expect(ancestorDirs('/proj/Assets', '/other/Bar.cs')).toBeNull();
  });

  it('returns null for a sibling directory that merely shares a prefix', () => {
    // "/proj/Assets-extra" starts with "/proj/Assets" but is not nested
    // inside it — the trailing "/" in the prefix check must reject this.
    expect(ancestorDirs('/proj/Assets', '/proj/Assets-extra/Bar.cs')).toBeNull();
  });

  it('returns an empty array when filePath equals root itself', () => {
    expect(ancestorDirs('/proj/Assets', '/proj/Assets')).toEqual([]);
  });

  it('handles a deeply nested file with many ancestor levels', () => {
    expect(ancestorDirs('/root', '/root/a/b/c/d/File.txt')).toEqual([
      '/root/a',
      '/root/a/b',
      '/root/a/b/c',
      '/root/a/b/c/d',
    ]);
  });
});

describe('pending reveal slot', () => {
  beforeEach(() => {
    consumePendingReveal(); // reset any leftover state between tests
  });

  it('returns null when nothing is pending', () => {
    expect(consumePendingReveal()).toBeNull();
  });

  it('returns the stashed path once, then clears it', () => {
    setPendingReveal('/proj/Assets/Foo.cs');
    expect(consumePendingReveal()).toBe('/proj/Assets/Foo.cs');
    expect(consumePendingReveal()).toBeNull();
  });

  it('a later setPendingReveal(null) clears a previously stashed path', () => {
    setPendingReveal('/proj/Assets/Foo.cs');
    setPendingReveal(null);
    expect(consumePendingReveal()).toBeNull();
  });
});
