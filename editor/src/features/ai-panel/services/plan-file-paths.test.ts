import { describe, it, expect } from 'bun:test';
import { slugify, buildPlanPath, planPathVariant, reservePlanPath } from './plan-file-paths';

const WS = '/proj';

describe('slugify', () => {
  it('kebab-cases and caps the length', () => {
    expect(slugify('Add a Player Controller!')).toBe('add-a-player-controller');
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it('falls back to "plan" for an unusable prompt', () => {
    expect(slugify('!!!')).toBe('plan');
  });
});

describe('planPathVariant', () => {
  it('returns the base name for n <= 1', () => {
    expect(planPathVariant('/p/.unityide/plans/20260824-1200-x.aplan', 1)).toBe(
      '/p/.unityide/plans/20260824-1200-x.aplan',
    );
  });

  it('inserts the counter before the extension, not after it', () => {
    expect(planPathVariant('/p/.unityide/plans/20260824-1200-x.aplan', 2)).toBe(
      '/p/.unityide/plans/20260824-1200-x-2.aplan',
    );
  });

  it('is not confused by the dot in the .unityide directory', () => {
    const v = planPathVariant('/p/.unityide/plans/20260824-1200-x.aplan', 3);
    expect(v.endsWith('.aplan')).toBe(true);
    expect(v).toContain('/.unityide/');
  });
});

describe('reservePlanPath', () => {
  // The timestamp is minute-precision, so pressing Regenerate twice inside one
  // minute produced the SAME path for the same prompt: the new plan silently
  // overwrote the old one, taking its checked-off execution progress with it.
  it('returns the base path when nothing is there', async () => {
    const p = await reservePlanPath(WS, 'add a controller', async () => false);
    expect(p).toBe(buildPlanPath(WS, 'add a controller'));
  });

  it('steps past an existing same-minute plan instead of overwriting it', async () => {
    const base = buildPlanPath(WS, 'add a controller');
    const p = await reservePlanPath(WS, 'add a controller', async (c) => c === base);
    expect(p).toBe(planPathVariant(base, 2));
  });

  it('keeps stepping while variants are taken', async () => {
    const base = buildPlanPath(WS, 'add a controller');
    const taken = new Set([base, planPathVariant(base, 2), planPathVariant(base, 3)]);
    const p = await reservePlanPath(WS, 'add a controller', async (c) => taken.has(c));
    expect(p).toBe(planPathVariant(base, 4));
  });

  it('still returns an unused path when every variant is taken', async () => {
    const p = await reservePlanPath(WS, 'add a controller', async () => true);
    expect(p.endsWith('.aplan')).toBe(true);
    expect(p).not.toBe(buildPlanPath(WS, 'add a controller'));
  });
});
