import type { ThemeDefinition } from './types';
import arcaneDark from './definitions/arcane-dark';
import arcaneLight from './definitions/arcane-light';
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

export const DEFAULT_THEME_ID = 'arcane-dark';

registerTheme(arcaneDark);
registerTheme(arcaneLight);
registerTheme(darkPlus);
registerTheme(lightPlus);
registerTheme(monokai);
registerTheme(dracula);
