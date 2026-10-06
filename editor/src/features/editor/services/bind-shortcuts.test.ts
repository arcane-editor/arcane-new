import { afterEach, expect, it } from 'bun:test';
import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { useCommandsStore } from '../../../stores/commands';
import { bindGlobalShortcutsToMonaco } from './bind-shortcuts';

const initial = useCommandsStore.getState();
afterEach(() => useCommandsStore.setState(initial));

it('dispatches to the focused diff pane, respects readonly action support, and releases both registrations', () => {
  const calls: string[] = [];
  let focus: 'original' | 'modified' | null = 'original';
  const pane = (name: 'original' | 'modified') => ({
    hasTextFocus: () => focus === name,
    getAction: (id: string) => ({ isSupported: () => id === 'actions.find' }),
    trigger: (_source: string, action: string) => calls.push(`${name}:${action}`),
  } as unknown as MonacoEditorNs.IStandaloneCodeEditor);
  const monaco = { editor: { addKeybindingRules: () => ({ dispose() {} }) } } as unknown as Monaco;
  const releaseOriginal = bindGlobalShortcutsToMonaco(pane('original'), monaco);
  const releaseModified = bindGlobalShortcutsToMonaco(pane('modified'), monaco);
  try {
    const store = useCommandsStore.getState();
    expect(store.executeCommand('monaco:actions.find')).toBe(true);
    expect(store.canExecuteCommand('monaco:editor.action.deleteLines')).toBe(false);
    expect(store.executeCommand('monaco:editor.action.deleteLines')).toBe(false);
    focus = 'modified';
    expect(store.executeCommand('monaco:actions.find')).toBe(true);
    expect(calls).toEqual(['original:actions.find', 'modified:actions.find']);
    releaseOriginal();
    focus = 'original';
    expect(store.executeCommand('monaco:actions.find')).toBe(false);
    focus = 'modified';
    releaseModified();
    expect(store.executeCommand('monaco:actions.find')).toBe(false);
  } finally { releaseOriginal(); releaseModified(); }
});

it('refreshes profile removal rules in both diff panes and disposes subscriptions with them', () => {
  const rules: MonacoEditorNs.IKeybindingRule[][] = [];
  let disposals = 0;
  const monaco = {
    KeyCode: { F2: 60, F6: 64 }, KeyMod: { Shift: 1024 },
    editor: { addKeybindingRules: (next: MonacoEditorNs.IKeybindingRule[]) => {
      rules.push(next);
      return { dispose: () => { disposals++; } };
    } },
  } as unknown as Monaco;
  const pane = { hasTextFocus: () => false, getAction: () => undefined } as unknown as MonacoEditorNs.IStandaloneCodeEditor;
  useCommandsStore.getState().setResolvedKeybindings([
    { commandId: 'monaco:editor.action.rename', strokes: ['f2'], removed: true },
  ]);
  const releaseOriginal = bindGlobalShortcutsToMonaco(pane, monaco);
  const releaseModified = bindGlobalShortcutsToMonaco(pane, monaco);
  expect(rules).toEqual([
    [{ command: '-editor.action.rename', keybinding: 60 }],
    [{ command: '-editor.action.rename', keybinding: 60 }],
  ]);
  useCommandsStore.getState().setResolvedKeybindings([
    { commandId: 'monaco:editor.action.rename', strokes: ['shift+f6'], removed: true },
  ]);
  expect(disposals).toBe(2);
  expect(rules.slice(2)).toEqual([
    [{ command: '-editor.action.rename', keybinding: 1024 | 64 }],
    [{ command: '-editor.action.rename', keybinding: 1024 | 64 }],
  ]);
  releaseOriginal(); releaseModified();
  expect(disposals).toBe(4);
  useCommandsStore.getState().setResolvedKeybindings([]);
  expect(rules).toHaveLength(4);
});
