import type { EditorProfile, ImportCategory } from '../../../types/editor-experience';
import { DEFAULT_SETTINGS } from '../../../stores/settings';

export function preferenceCategory(key: string): ImportCategory {
  return /^(editor\.(font|lineHeight)|terminal\.font)/.test(key) ? 'appearance' : 'editor';
}

export function profileDefaults(profile: EditorProfile, mac: boolean): { themeId: string; settings: Record<string, unknown> } {
  if (profile === 'rider') {
    return { themeId: 'rider-dark', settings: {
      'editor.fontFamily': "'JetBrains Mono', Menlo, Consolas, monospace",
      'editor.fontSize': 13, 'editor.fontLigatures': false, 'editor.lineHeight': 16,
      'editor.tabSize': 4, 'editor.insertSpaces': true, 'editor.detectIndentation': true,
      'editor.minimap': false, 'editor.lineNumbers': 'on', 'editor.wordWrap': 'off',
    } };
  }
  if (profile === 'vscode') {
    return { themeId: 'dark-plus', settings: {
      'editor.fontFamily': mac ? 'Menlo, Monaco, monospace' : 'Consolas, Courier New, monospace',
      'editor.fontSize': mac ? 12 : 14, 'editor.fontLigatures': false, 'editor.lineHeight': 0,
      'editor.tabSize': 4, 'editor.insertSpaces': true, 'editor.detectIndentation': true,
      'editor.minimap': true, 'editor.lineNumbers': 'on', 'editor.wordWrap': 'off',
    } };
  }
  return { themeId: 'unityide-dark', settings: Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(([key]) => key.startsWith('editor.') || key.startsWith('terminal.')),
  ) };
}

/** Imported values are already validated by the native adapters. */
export function selectedPreferencePatch(defaults: Record<string, unknown>, imported: Record<string, unknown>, categories: ImportCategory[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries({ ...defaults, ...imported }).filter(([key]) => categories.includes(preferenceCategory(key))));
}
