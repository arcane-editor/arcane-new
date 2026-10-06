import { expect, it } from 'bun:test';
import type { EditorPreferences, ImportPreview } from '../../../types/editor-experience';
import { buildApplyProfileRequest } from './apply-profile-request';
import { getPresetKeybindingReport } from './keymaps';

function preferences(): EditorPreferences {
  return {
    schemaVersion: 1, revision: 7, canRestore: true, themeId: 'rider-dark',
    settings: { 'editor.fontSize': 19, 'editor.wordWrap': 'off' },
    experience: {
      profile: 'rider', shortcutProfile: 'rider', keymap: 'resharper', setupStatus: 'complete',
      importedBindings: [{ commandId: 'file.save', strokes: ['ctrl+shift+s'] }],
      userBindings: [{ commandId: 'palette.commands', strokes: ['ctrl+shift+k'] }],
      lastReport: [], sourceLabel: 'Previous Rider import',
    },
  };
}

function preview(): ImportPreview {
  return {
    source: { id: 'fixture', editor: 'vscode', label: 'Fixture VS Code', path: '/fixture', recommended: true },
    settings: { 'editor.fontSize': 16, 'terminal.fontFamily': 'Studio Mono', 'editor.wordWrap': 'on', 'explorer.autoReveal': false },
    themeId: 'light-plus', keymap: 'vscode',
    keybindings: [{ commandId: 'file.save', strokes: ['ctrl+alt+s'] }],
    report: [
      { category: 'appearance', label: 'Font', status: 'imported', detail: 'Supported font' },
      { category: 'editor', label: 'Wrapping', status: 'imported', detail: 'Supported wrapping' },
      { category: 'shortcuts', label: 'Save', status: 'imported', detail: 'Supported shortcut' },
    ],
  };
}

it('appearance-only profile switches preserve the complete shortcut configuration', () => {
  const current = preferences();
  const before = structuredClone(current);
  const source = preview();
  const request = buildApplyProfileRequest(current, 'vscode', 'vscode', source, ['appearance'], false);
  expect(request.profile).toBe('vscode');
  expect(request.shortcutProfile).toBe('rider');
  expect(request.keymap).toBe('resharper');
  expect(request.importedBindings).toEqual(current.experience.importedBindings);
  expect(request.userBindings).toEqual(current.experience.userBindings);
  expect(request.themeId).toBe('light-plus');
  expect(request.settingsPatch['editor.fontSize']).toBe(16);
  expect(request.settingsPatch['terminal.fontFamily']).toBe('Studio Mono');
  expect(request.settingsPatch).not.toHaveProperty('editor.wordWrap');
  expect(request.report).toEqual([source.report[0]]);
  expect(request.expectedRevision).toBe(7);
  expect(current).toEqual(before);
});

it('editor-only imports leave appearance and every shortcut layer unchanged', () => {
  const current = preferences();
  const request = buildApplyProfileRequest(current, 'vscode', 'vscode', preview(), ['editor'], true);
  expect(request.themeId).toBeUndefined();
  expect(request.settingsPatch).not.toHaveProperty('editor.fontSize');
  expect(request.settingsPatch).not.toHaveProperty('terminal.fontFamily');
  expect(request.settingsPatch['editor.wordWrap']).toBe('on');
  expect(request.settingsPatch['explorer.autoReveal']).toBe(false);
  expect(request.shortcutProfile).toBe('rider');
  expect(request.keymap).toBe('resharper');
  expect(request.importedBindings).toEqual(current.experience.importedBindings);
  expect(request.userBindings).toEqual(current.experience.userBindings);
  expect(request.report?.every((item) => item.category === 'editor')).toBe(true);
});

it('shortcut-only imports choose the preset and include its report without changing typography', () => {
  const current = preferences();
  const source = preview();
  const request = buildApplyProfileRequest(current, 'vscode', 'vscode', source, ['shortcuts'], true);
  expect(request.shortcutProfile).toBe('vscode');
  expect(request.keymap).toBe('vscode');
  expect(request.importedBindings).toEqual(source.keybindings);
  expect(request.userBindings).toEqual(current.experience.userBindings);
  expect(request.themeId).toBeUndefined();
  expect(request.settingsPatch).toEqual({});
  expect(request.report).toEqual([source.report[2], ...getPresetKeybindingReport('vscode', 'vscode', true)]);
});

it('using defaults clears imported bindings while retaining manual overrides and platform fonts', () => {
  const current = preferences();
  const request = buildApplyProfileRequest(current, 'vscode', 'vscode', null, ['appearance', 'editor', 'shortcuts'], true);
  expect(request.importedBindings).toEqual([]);
  expect(request.userBindings).toEqual(current.experience.userBindings);
  expect(request.shortcutProfile).toBe('vscode');
  expect(request.themeId).toBe('dark-plus');
  expect(request.settingsPatch['editor.fontSize']).toBe(12);
  expect(request.settingsPatch['editor.fontFamily']).toContain('Menlo');
  expect(request.report).toEqual(getPresetKeybindingReport('vscode', 'vscode', true));
  expect(request.setupStatus).toBe('complete');
});

it('older preferences without shortcutProfile retain their prior profile when shortcuts are excluded', () => {
  const current = preferences();
  delete current.experience.shortcutProfile;
  const request = buildApplyProfileRequest(current, 'vscode', 'vscode', null, ['appearance'], false);
  expect(request.shortcutProfile).toBe('rider');
  expect(request.keymap).toBe('resharper');
  expect(request.importedBindings).toEqual(current.experience.importedBindings);
  expect(request.userBindings).toEqual(current.experience.userBindings);
});
