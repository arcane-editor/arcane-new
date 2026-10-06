import { expect, it } from 'bun:test';
import { DEFAULT_SETTINGS, mergeStoredSettings } from './settings';

it('enables the Unity specialist studio workflow for new installations', () => {
  expect(DEFAULT_SETTINGS['ai.specialists.enabled']).toBe(true);
});

it('migrates the old experimental default once and preserves later opt-outs', () => {
  expect(mergeStoredSettings({ 'ai.specialists.enabled': false })['ai.specialists.enabled']).toBe(true);
  expect(mergeStoredSettings({ 'ai.specialists.enabled': false, 'ai.specialists.editableScenesVersion': 1 })['ai.specialists.enabled']).toBe(false);
});

it('preserves imported font choices through repeated settings loads and adds a safe fallback', () => {
  for (const font of ['JetBrains Mono', 'Cascadia Code', 'Geist Mono', 'Missing Studio Font']) {
    const stored = { 'editor.fontFamily': font, 'terminal.fontFamily': font };
    const merged = mergeStoredSettings(stored);
    expect(merged['editor.fontFamily']).toBe(font);
    expect(merged['terminal.fontFamily']).toBe(`${font}, monospace`);
    expect(mergeStoredSettings({ ...merged })['terminal.fontFamily']).toBe(`${font}, monospace`);
  }
});
