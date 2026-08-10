import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');
const TOKENS = readFileSync(path.join(ROOT, 'src/styles/tokens.css'), 'utf8');
const MAIN = readFileSync(path.join(ROOT, 'src/main.tsx'), 'utf8');

/**
 * Colors were already tokenised (theme/apply.ts writes each theme key to
 * :root). Nothing else was — no spacing, radius, type scale, elevation or
 * motion — so every panel re-derived its own row height and padding in one of
 * 362 inline style objects, and they disagreed. That drift is what reads as
 * "unfinished" next to VS Code.
 *
 * These live in a static sheet rather than the theme contract because they are
 * not themeable: a theme changes colour, not geometry.
 */
const SCALES = {
  space: ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8'],
  radius: ['--radius-sm', '--radius-md', '--radius-lg', '--radius-full'],
  text: ['--text-xs', '--text-sm', '--text-base', '--text-lg'],
  shadow: ['--shadow-1', '--shadow-2', '--shadow-3'],
  motion: ['--motion-fast', '--motion-base', '--motion-slow'],
  ease: ['--ease-out', '--ease-in-out'],
};

describe('design tokens', () => {
  for (const [group, names] of Object.entries(SCALES)) {
    it(`defines the ${group} scale`, () => {
      const missing = names.filter((n) => !new RegExp(`^\\s*${n}\\s*:`, 'm').test(TOKENS));
      expect(missing).toEqual([]);
    });
  }

  it('collapses every motion duration under prefers-reduced-motion', () => {
    const idx = TOKENS.indexOf('prefers-reduced-motion');
    expect(idx).toBeGreaterThan(-1);
    const block = TOKENS.slice(idx);
    // A duration left out of this block keeps animating for users who asked
    // the OS not to, which is an accessibility failure, not a nicety.
    for (const name of SCALES.motion) {
      expect(block).toContain(name);
    }
  });

  it('is imported before App.css so later rules can still override', () => {
    const tokens = MAIN.indexOf("styles/tokens.css");
    const app = MAIN.indexOf("./App.css");
    expect(tokens).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(-1);
    expect(tokens).toBeLessThan(app);
  });
});
