import { expect, it } from 'bun:test';
import { DEFAULT_SETTINGS, mergeStoredSettings } from './settings';

it('enables the Unity specialist studio workflow for new installations', () => {
  expect(DEFAULT_SETTINGS['ai.specialists.enabled']).toBe(true);
});

it('migrates the old experimental default once and preserves later opt-outs', () => {
  expect(mergeStoredSettings({ 'ai.specialists.enabled': false })['ai.specialists.enabled']).toBe(true);
  expect(mergeStoredSettings({ 'ai.specialists.enabled': false, 'ai.specialists.editableScenesVersion': 1 })['ai.specialists.enabled']).toBe(false);
});
