import { describe, it, expect, beforeEach } from 'bun:test';
import {
  noteSelfWrittenAsset,
  shouldInvalidate,
  SELF_WRITE_SUPPRESSION_MS,
  __resetSelfWritesForTest,
} from './usage-invalidation';

beforeEach(() => {
  __resetSelfWritesForTest();
});

const T = 1_000_000;

describe('shouldInvalidate — relevance', () => {
  it('ignores files that do not feed the usage caches', () => {
    expect(shouldInvalidate(['/p/Assets/Weapon.cs'], T)).toBe(false);
    expect(shouldInvalidate(['/p/Assets/icon.png'], T)).toBe(false);
    expect(shouldInvalidate(['/p/Assets/Weapon.asset.meta'], T)).toBe(false);
  });

  it('fires for a scene, prefab or asset', () => {
    expect(shouldInvalidate(['/p/Assets/Combat.unity'], T)).toBe(true);
    expect(shouldInvalidate(['/p/Assets/Player.prefab'], T)).toBe(true);
    expect(shouldInvalidate(['/p/Assets/Sword.asset'], T)).toBe(true);
  });

  it('is case-insensitive about the extension', () => {
    expect(shouldInvalidate(['/p/Assets/Sword.ASSET'], T)).toBe(true);
  });

  it('does nothing for an empty batch', () => {
    expect(shouldInvalidate([], T)).toBe(false);
  });
});

describe('shouldInvalidate — self-write suppression', () => {
  it('ignores the watcher event caused by our own write', () => {
    noteSelfWrittenAsset('/p/Assets/Sword.asset', T);
    expect(shouldInvalidate(['/p/Assets/Sword.asset'], T + 10)).toBe(false);
  });

  it('stops suppressing once the window has passed', () => {
    noteSelfWrittenAsset('/p/Assets/Sword.asset', T);
    expect(
      shouldInvalidate(['/p/Assets/Sword.asset'], T + SELF_WRITE_SUPPRESSION_MS + 1),
    ).toBe(true);
  });

  it('suppresses only the exact path it was told about', () => {
    noteSelfWrittenAsset('/p/Assets/Sword.asset', T);
    expect(shouldInvalidate(['/p/Assets/Shield.asset'], T + 10)).toBe(true);
  });

  it('still fires when an unrelated asset changes in the same batch', () => {
    noteSelfWrittenAsset('/p/Assets/Sword.asset', T);
    expect(
      shouldInvalidate(['/p/Assets/Sword.asset', '/p/Assets/Combat.unity'], T + 10),
    ).toBe(true);
  });

  it('does not leak suppression entries once they expire', () => {
    noteSelfWrittenAsset('/p/Assets/Sword.asset', T);
    // A later call prunes the expired entry; the same path then invalidates.
    expect(shouldInvalidate([], T + SELF_WRITE_SUPPRESSION_MS + 1)).toBe(false);
    expect(shouldInvalidate(['/p/Assets/Sword.asset'], T + SELF_WRITE_SUPPRESSION_MS + 2)).toBe(true);
  });
});
