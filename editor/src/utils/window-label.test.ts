import { describe, it, expect } from 'bun:test';
import { hashLabel } from './window-label';

describe('hashLabel', () => {
  it('produces a stable, prefixed, fixed-width label', () => {
    const label = hashLabel('/Users/me/Unity/Proj');
    expect(label).toBe(hashLabel('/Users/me/Unity/Proj'));
    expect(label).toMatch(/^editor-[0-9a-f]{8}$/);
  });

  it('separates different projects', () => {
    expect(hashLabel('/Users/me/A')).not.toBe(hashLabel('/Users/me/B'));
  });

  // The regression this whole module exists for: `canonicalize_path` used to
  // return `\\?\D:\Unity\Proj` and now returns `D:/Unity/Proj`, so the same
  // project hashes to a different label across the upgrade. Persisted window
  // state has to be re-keyed for it (see `migrateWindowEntry`).
  it('gives a legacy verbatim path a different label than its normalized form', () => {
    expect(hashLabel('\\\\?\\D:\\Unity\\Proj')).not.toBe(hashLabel('D:/Unity/Proj'));
  });

  it('is case- and separator-sensitive (it hashes the exact spelling)', () => {
    expect(hashLabel('D:/Unity/Proj')).not.toBe(hashLabel('D:\\Unity\\Proj'));
  });
});
