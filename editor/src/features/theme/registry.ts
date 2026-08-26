import type { ThemeDefinition } from './types';
import unityideDark from './definitions/unityide-dark';
import unityideLight from './definitions/unityide-light';
import darkPlus from './definitions/dark-plus';
import lightPlus from './definitions/light-plus';
import monokai from './definitions/monokai';
import dracula from './definitions/dracula';

const themeRegistry = new Map<string, ThemeDefinition>();

export function registerTheme(theme: ThemeDefinition): void {
  themeRegistry.set(theme.id, theme);
}

export function getTheme(id: string): ThemeDefinition | undefined {
  return themeRegistry.get(id);
}

export function getAllThemes(): ThemeDefinition[] {
  return Array.from(themeRegistry.values());
}

export const DEFAULT_THEME_ID = 'unityide-dark';

/**
 * Pre-rename theme ids -> their current ids.
 *
 * The id is a persisted value: it is written to localStorage and set as the
 * `data-theme` attribute the stylesheet keys off. An unrecognised stored id
 * falls through to DEFAULT_THEME_ID, so without this map anyone on the old
 * light theme would be silently switched to dark on upgrade — wrong in the
 * most noticeable direction.
 *
 * In practice this should rarely fire, because the bundle identifier changed in
 * the same release and the webview's storage is keyed off it, so most upgrades
 * start from empty localStorage anyway. It is kept because the cost is two
 * entries and the alternative is relying on that platform detail holding on
 * every OS.
 */
const THEME_ID_ALIASES: Readonly<Record<string, string>> = {
  'arcane-dark': 'unityide-dark',
  'arcane-light': 'unityide-light',
};

/** Current id for a possibly-legacy one; returns the input when unmapped. */
export function resolveThemeId(id: string): string {
  return THEME_ID_ALIASES[id] ?? id;
}

registerTheme(unityideDark);
registerTheme(unityideLight);
registerTheme(darkPlus);
registerTheme(lightPlus);
registerTheme(monokai);
registerTheme(dracula);
