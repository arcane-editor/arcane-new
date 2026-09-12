/**
 * The theme stylesheet `unity_ui_scaffold` emits when there is nothing to
 * reuse: a `:root { --token: value; }` block declaring exactly the palette
 * tokens `resolvePalette` could not match against the project's own USS
 * variables (`shared.ts`'s `ThemeDeclaration[]`) — background, surface, text,
 * muted text, accent, danger, the 4/8/12/16/24/32 spacing scale, one radius,
 * and the 12/14/16/20/24/32 type scale.
 *
 * `ui-scaffold-tool.ts` decides WHETHER to call this at all (skipped when
 * `reuseTheme` applies — see that file); this module only renders the text.
 */

import type { ThemeDeclaration } from './shared';

/** `<Name>Theme.uss` content. */
export function buildThemeUss(screenName: string, declarations: readonly ThemeDeclaration[]): string {
  const body =
    declarations.length > 0
      ? declarations.map((d) => `    ${d.name}: ${d.value};`).join('\n')
      : '    /* Every token this screen uses already matched an existing project variable. */';
  return [
    `/* ${screenName}'s theme — a small coherent palette every screen scaffold references with var(). */`,
    ':root {',
    body,
    '}',
    '',
  ].join('\n');
}
