import { expect, it } from 'bun:test';
import { profileDefaults, selectedPreferencePatch } from './profile-defaults';
import { mergeStoredSettings } from '../../../stores/settings';

it('chooses platform-specific VS Code typography and Rider defaults', () => {
  expect(profileDefaults('vscode', true).settings['editor.fontSize']).toBe(12);
  expect(profileDefaults('vscode', false).settings['editor.fontFamily']).toContain('Consolas');
  expect(profileDefaults('rider', true).themeId).toBe('rider-dark');
  expect(profileDefaults('rider', false).settings['editor.minimap']).toBe(false);
});

it('applies only selected preference categories and lets source preferences override presets', () => {
  const defaults = profileDefaults('rider', false).settings;
  const imported = { 'editor.fontSize': 19, 'editor.wordWrap': 'on', 'terminal.fontSize': 17 };
  const appearance = selectedPreferencePatch(defaults, imported, ['appearance']);
  expect(appearance['editor.fontSize']).toBe(19);
  expect(appearance['terminal.fontSize']).toBe(17);
  expect(appearance).not.toHaveProperty('editor.wordWrap');
  expect(selectedPreferencePatch(defaults, imported, [])).toEqual({});
});

it('preserves explicit imported system fonts across restarts with a monospace fallback', () => {
  expect(mergeStoredSettings({ 'terminal.fontFamily': 'JetBrains Mono' })['terminal.fontFamily']).toBe('JetBrains Mono, monospace');
  expect(mergeStoredSettings({ 'terminal.fontFamily': 'Cascadia Code, monospace' })['terminal.fontFamily']).toBe('Cascadia Code, monospace');
  expect(mergeStoredSettings({ 'terminal.fontFamily': 'Geist Mono Variable' })['terminal.fontFamily']).toBe('Geist Mono Variable, monospace');
});
