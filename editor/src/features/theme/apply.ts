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

const definedMonacoThemes = new Set<string>();

function applyMonacoTheme(theme: ThemeDefinition): void {
  const monaco = getMonacoInstance();
  if (!monaco) return;

  const monacoThemeId = `app-theme-${theme.id}`;
  if (!definedMonacoThemes.has(monacoThemeId)) {
    monaco.editor.defineTheme(monacoThemeId, theme.monaco);
    definedMonacoThemes.add(monacoThemeId);
  }
  monaco.editor.setTheme(monacoThemeId);
}

export function ensureMonacoTheme(theme: ThemeDefinition): void {
  const monaco = getMonacoInstance();
  if (!monaco) return;

  const monacoThemeId = `app-theme-${theme.id}`;
  if (!definedMonacoThemes.has(monacoThemeId)) {
    monaco.editor.defineTheme(monacoThemeId, theme.monaco);
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
