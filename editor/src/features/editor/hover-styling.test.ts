import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');
const CSS = readFileSync(path.join(ROOT, 'features/editor/styles/hover.css'), 'utf8');
const PANEL = readFileSync(
  path.join(ROOT, 'features/editor/components/EditorPanel.tsx'),
  'utf8',
);
const BARREL = readFileSync(path.join(ROOT, 'features/editor/index.ts'), 'utf8');

/**
 * Every rule in `hover.css` is scoped `.monaco-editor .monaco-hover …`, for
 * two reasons that both have to keep holding:
 *
 *  1. Specificity. Monaco's own rules are already two and three classes deep
 *     (`.monaco-hover .hover-contents:not(.html-hover-contents)`), so a bare
 *     `.monaco-hover` selector loses to them and the restyle silently does
 *     nothing at all — no error, no warning, just the stock widget.
 *  2. Containment. That scoping is only true while the hover renders INSIDE
 *     the editor's DOM node, which is the default (`fixedOverflowWidgets`
 *     is `false`). Switching it on reparents every overflow widget to a
 *     container outside `.monaco-editor`, and the entire stylesheet stops
 *     matching — again with nothing to notice.
 */
describe('hover widget styling', () => {
  it('is loaded — a stylesheet nothing imports styles nothing', () => {
    expect(BARREL).toMatch(/import '\.\/styles\/hover\.css'/);
  });

  it('scopes every rule under .monaco-editor, to outrank Monaco and to match', () => {
    const selectors = CSS
      // Strip comments before reading selectors out of the file.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((block) => block.split('{')[0]?.trim())
      .filter((s): s is string => !!s)
      .flatMap((s) => s.split(',').map((one) => one.trim()))
      .filter(Boolean);

    expect(selectors.length).toBeGreaterThan(8);
    const unscoped = selectors.filter((s) => !s.startsWith('.monaco-editor '));
    expect(unscoped).toEqual([]);
  });

  it('never turns on fixedOverflowWidgets, which reparents the hover out of scope', () => {
    expect(PANEL).not.toMatch(/fixedOverflowWidgets/);
  });
});
