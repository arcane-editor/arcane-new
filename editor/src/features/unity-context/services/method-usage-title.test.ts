// The file-level lens ("Used in 3 prefabs") never says WHICH method is wired,
// so renaming a handler looks safe right up until the button stops working.
// These cover the summary that fixes that.

import { describe, it, expect } from 'bun:test';
import { formatMethodTitle, type MethodUsage } from './method-usage-title';

const u = (methodName: string, path = 'Assets/UI.prefab'): MethodUsage => ({
  methodName,
  path,
  gameObject: null,
  targetType: null,
});

describe('formatMethodTitle', () => {
  it('is empty when nothing is wired, so the lens stays quiet', () => {
    expect(formatMethodTitle([])).toBe('');
  });

  it('names the wired method', () => {
    expect(formatMethodTitle([u('OnStartPressed')])).toBe('wired to OnStartPressed');
  });

  // The same handler wired from several prefabs is ONE method, not three.
  it('dedupes a method wired from multiple assets', () => {
    expect(
      formatMethodTitle([
        u('OnStartPressed', 'Assets/A.prefab'),
        u('OnStartPressed', 'Assets/B.prefab'),
      ]),
    ).toBe('wired to OnStartPressed');
  });

  it('sorts names so the lens text is stable between runs', () => {
    expect(formatMethodTitle([u('Zeta'), u('Alpha')])).toBe('wired to Alpha, Zeta');
  });

  it('caps at three names and counts the remainder', () => {
    const t = formatMethodTitle([u('A'), u('B'), u('C'), u('D'), u('E')]);
    expect(t).toBe('wired to A, B, C +2 more');
  });
});
