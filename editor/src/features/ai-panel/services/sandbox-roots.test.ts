import { describe, it, expect } from 'bun:test';
import { computeAllowedRoots } from './sandbox-roots';

describe('computeAllowedRoots', () => {
  it('Unity: Assets first (bash cwd), then .arcane, then Packages', () => {
    expect(computeAllowedRoots('/p', true, '/p/Assets')).toEqual([
      '/p/Assets',
      '/p/.arcane',
      '/p/Packages',
    ]);
  });

  it('non-Unity: the workspace itself (was: NO sandbox at all)', () => {
    expect(computeAllowedRoots('/p', false, null)).toEqual(['/p']);
  });

  it('Unity without a resolved Assets root falls back to the workspace', () => {
    expect(computeAllowedRoots('/p', true, null)).toEqual(['/p']);
  });

  it('no workspace open denies all file tools', () => {
    expect(computeAllowedRoots('/', false, null)).toEqual([]);
    expect(computeAllowedRoots('', false, null)).toEqual([]);
  });
});
