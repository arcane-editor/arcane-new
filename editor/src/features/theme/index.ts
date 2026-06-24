// Order matters: re-export DEFAULT_THEME_ID and registry symbols first so
// that consumers reached through circular paths (ThemePicker → stores/theme
// → features/theme.DEFAULT_THEME_ID at module init) see initialized values.
export { getTheme, getAllThemes, DEFAULT_THEME_ID } from './registry';
export { applyTheme, applyCssVariables, ensureMonacoTheme, registerTerminal, unregisterTerminal } from './apply';
export { getThemeColor, onThemeChange } from './helpers';
export type { ThemeDefinition, UiColors, MonacoThemeData, TerminalColors } from './types';
export { default as ThemePicker } from './components/ThemePicker';
