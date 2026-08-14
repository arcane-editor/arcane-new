import type { ThemeDefinition } from './types';
import { getMonacoInstance } from '../../utils/monaco-instance';
import type { Terminal } from '@xterm/xterm';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function applyTheme(theme: ThemeDefinition): void {
  applyCssVariables(theme);
  applyMonacoTheme(theme);
  applyTerminalTheme(theme);
  applyNativeWindowBackground(theme);
}

function applyNativeWindowBackground(theme: ThemeDefinition): void {
  try {
    void getCurrentWindow().setBackgroundColor(theme.ui['bg-primary']);
  } catch { /* not in Tauri / unsupported platform */ }
}

// ─── CSS Variables ───────────────────────────────────────────────

export function applyCssVariables(theme: ThemeDefinition): void {
  const root = document.documentElement;
  root.setAttribute('data-theme-type', theme.type);
  root.setAttribute('data-theme', theme.id);
  for (const [key, value] of Object.entries(theme.ui)) {
    root.style.setProperty(`--${key}`, value);
  }
  // Overwrite the anti-FOUC bootstrap's inline background (index.html). That
  // inline style outranks `html { background: var(--bg-primary) }` in App.css
  // forever, so leaving it would pin every theme to the bootstrap's guess —
  // which is only ever right for two of the six themes. Reassigning (rather
  // than clearing) keeps a painted background at all times, so no theme can
  // flash the UA white between the bootstrap and the stylesheet.
  root.style.backgroundColor = theme.ui['bg-primary'];
}

// ─── Monaco Editor ───────────────────────────────────────────────

/**
 * Monaco colour IDs whose *unset* default is a saturated red — #FF1212 for the
 * diagnostic and minimap entries, #FF1212CC for the unexpected bracket. That
 * hue appears in none of the six palettes, so whenever a theme omits one of
 * these the editor grows a red artefact nothing in the theme explains.
 *
 * This had already bitten once: `arcane-dark` and `arcane-light` state the
 * diagnostic trio precisely to kill that red. The other four themes never got
 * the same treatment, and *no* theme stated the minimap or unexpected-bracket
 * entries — so those stayed Monaco red in all six.
 *
 * Stating them per theme is what let them drift, so they are derived here from
 * tokens `types.ts` already requires every theme to define. Any theme added
 * later is covered for free. Enforced by `theme-contract.test.ts`.
 */
export const RED_DEFAULT_MONACO_COLOR_IDS = [
  'editorError.foreground',
  'editorWarning.foreground',
  'editorInfo.foreground',
  'editorOverviewRuler.errorForeground',
  'editorOverviewRuler.warningForeground',
  'editorOverviewRuler.infoForeground',
  'minimap.errorHighlight',
  'minimap.warningHighlight',
  'editorBracketHighlight.unexpectedBracket.foreground',
] as const;

function diagnosticColorDefaults(theme: ThemeDefinition): Record<string, string> {
  const error = theme.ui['error-text'];
  const warning = theme.ui['warning'];
  const info = theme.ui['info'];
  return {
    'editorError.foreground': error,
    'editorWarning.foreground': warning,
    'editorInfo.foreground': info,
    // Ruler and minimap marks sit under code, so they carry alpha rather than
    // the full-strength hue the squiggle uses.
    'editorOverviewRuler.errorForeground': `${error}99`,
    'editorOverviewRuler.warningForeground': `${warning}99`,
    'editorOverviewRuler.infoForeground': `${info}99`,
    'minimap.errorHighlight': `${error}B3`,
    'minimap.warningHighlight': `${warning}B3`,
    // An unmatched bracket is worth showing — in the palette's error hue.
    'editorBracketHighlight.unexpectedBracket.foreground': `${error}CC`,
  };
}

/**
 * The theme's own `colors` win: these are defaults for IDs a theme did not
 * state, never overrides of a deliberate choice.
 */
export function monacoThemeFor(theme: ThemeDefinition): ThemeDefinition['monaco'] {
  return {
    ...theme.monaco,
    colors: { ...diagnosticColorDefaults(theme), ...(theme.monaco.colors ?? {}) },
  };
}

const definedMonacoThemes = new Set<string>();

function applyMonacoTheme(theme: ThemeDefinition): void {
  const monaco = getMonacoInstance();
  if (!monaco) return;

  const monacoThemeId = `app-theme-${theme.id}`;
  if (!definedMonacoThemes.has(monacoThemeId)) {
    monaco.editor.defineTheme(monacoThemeId, monacoThemeFor(theme));
    definedMonacoThemes.add(monacoThemeId);
  }
  monaco.editor.setTheme(monacoThemeId);
}

export function ensureMonacoTheme(theme: ThemeDefinition): void {
  const monaco = getMonacoInstance();
  if (!monaco) return;

  const monacoThemeId = `app-theme-${theme.id}`;
  if (!definedMonacoThemes.has(monacoThemeId)) {
    monaco.editor.defineTheme(monacoThemeId, monacoThemeFor(theme));
    definedMonacoThemes.add(monacoThemeId);
  }
  monaco.editor.setTheme(monacoThemeId);
}

// ─── Terminal ────────────────────────────────────────────────────

const liveTerminals = new Map<number, Terminal>();

export function registerTerminal(id: number, term: Terminal): void {
  liveTerminals.set(id, term);
}

export function unregisterTerminal(id: number): void {
  liveTerminals.delete(id);
}

function applyTerminalTheme(theme: ThemeDefinition): void {
  for (const term of liveTerminals.values()) {
    term.options.theme = theme.terminal;
  }
}
