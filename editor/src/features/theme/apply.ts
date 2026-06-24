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
