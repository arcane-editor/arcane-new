import { describe, expect, it } from 'bun:test';
import type { Command } from '../../../types';
import type { EditorExperienceState, KeyBinding, RiderKeymap } from '../../../types/editor-experience';
import { getPresetKeybindingReport, getPresetKeybindings } from './keymaps';
import { resolveKeybindings, validateKeybindings } from './keybindings';

function command(id: string, keybinding?: string, skipMonacoBridge = false): Command {
  return { id, label: id, category: 'Test', handler: () => {}, keybinding, skipMonacoBridge };
}
const commands = [
  command('file.save', 'mod+s'), command('file.closeTab', 'mod+w'), command('file.openFolder', 'mod+o'),
  command('palette.quickOpen', 'mod+p'), command('palette.commands', 'mod+shift+p'),
  command('view.aiPanel', 'mod+l'), command('view.toggleRightSidebar', 'mod+k'),
  command('terminal.toggle', 'mod+j'), command('view.toggleBottomPanel'), command('settings.open', 'mod+comma'),
  command('tab.next', 'ctrl+tab'), command('tab.prev', 'mod+pageup'), command('search.openTab', 'mod+shift+f'),
  command('editor.formatDocument', 'shift+alt+f'), command('editor.gotoLine', 'mod+g'), command('editor.gotoSymbol', 'mod+shift+o'),
  command('editor.quickFix', 'alt+enter'), command('editor.findUsages', 'alt+f7'), command('editor.refactor', 'mod+shift+r'),
  command('nav.back', 'mod+bracketleft'), command('nav.forward', 'mod+bracketright'),
  command('debug.continue', 'mod+f5'), command('debug.stop', 'mod+shift+f5'), command('debug.stepOver', 'f10'),
  command('debug.stepInto', 'f8'), command('debug.stepOut', 'shift+f8'), command('debug.toggleBreakpoint', 'f9'),
  command('debug.runToCursor', 'mod+f10'), command('unity.play', 'f5'), command('unity.stop', 'shift+f5'), command('unity.step', 'f7'),
  command('ai.effortCycle', 'mod+d', true), command('terminal.focusNextPane', 'mod+shift+bracketright', true),
];
function experience(profile: EditorExperienceState['profile'] = 'unityide', keymap: RiderKeymap = 'intellij'): EditorExperienceState {
  return { profile, keymap, setupStatus: 'complete', importedBindings: [], userBindings: [], lastReport: [] };
}
function active(bindings: KeyBinding[], id: string) { return bindings.filter((binding) => !binding.removed && binding.commandId === id); }
function chord(bindings: KeyBinding[], id: string) { return active(bindings, id).map((binding) => binding.strokes.join(' ')); }

describe('supported Rider and VS Code presets', () => {
  it('keeps the OS differences in IntelliJ navigation, refactoring and Unity run keys', () => {
    const windows = getPresetKeybindings('rider', 'intellij', false);
    const mac = getPresetKeybindings('rider', 'intellij', true);
    expect(chord(windows, 'palette.quickOpen')).toEqual(['ctrl+shift+n']);
    expect(chord(mac, 'palette.quickOpen')).toEqual(['cmd+shift+o']);
    expect(chord(windows, 'editor.formatDocument')).toEqual(['ctrl+alt+l']);
    expect(chord(mac, 'editor.refactor')).toEqual(['ctrl+t']);
    expect(chord(windows, 'monaco:editor.action.rename')).toEqual(['shift+f6']);
    expect(chord(mac, 'unity.play')).toEqual(['ctrl+r']);
    expect(chord(windows, 'unity.play')).toEqual(['shift+f10']);
  });
  it('distinguishes ReSharper from Visual Studio and IntelliJ on both platforms', () => {
    for (const mac of [false, true]) {
      const resharper = getPresetKeybindings('rider', 'resharper', mac);
      const visualStudio = getPresetKeybindings('rider', 'visual-studio', mac);
      expect(chord(resharper, 'editor.formatDocument')).toEqual([mac ? 'cmd+alt+l' : 'ctrl+alt+l']);
      expect(chord(visualStudio, 'editor.formatDocument')).toEqual([mac ? 'cmd+alt+enter' : 'ctrl+alt+enter']);
      expect(chord(resharper, 'monaco:editor.action.rename')).toEqual(['f2']);
      expect(chord(visualStudio, 'monaco:editor.action.rename')).toEqual([mac ? 'cmd+r r' : 'ctrl+r r']);
      expect(chord(visualStudio, 'monaco:editor.fold')).toEqual(['ctrl+m s']);
    }
    expect(chord(getPresetKeybindings('rider', 'visual-studio-2022', false), 'palette.commands')).toEqual(['ctrl+q']);
    expect(chord(getPresetKeybindings('rider', 'resharper', true), 'debug.stepInto')).toEqual(['cmd+f11']);
  });
  it('keeps Unity play and stop reachable beside VS Code debug shortcuts', () => {
    const bindings = resolveKeybindings(commands, experience('vscode'), false);
    expect(chord(bindings, 'debug.continue')).toEqual(['f5']);
    expect(chord(bindings, 'unity.play')).toEqual(['ctrl+f5']);
    expect(chord(bindings, 'debug.stop')).toEqual(['shift+f5']);
    expect(chord(bindings, 'unity.stop')).toEqual(['ctrl+shift+f5']);
    expect(chord(bindings, 'file.openFolder')).toEqual(['ctrl+k ctrl+o']);
  });
  it('discloses unsupported gestures and reserved native edit conflicts', () => {
    expect(getPresetKeybindingReport('rider', 'intellij', false).some((item) => item.label === 'Delete Line: Ctrl+Y' && item.status === 'conflicting')).toBe(true);
    expect(getPresetKeybindingReport('rider', 'visual-studio-2022', true).some((item) => item.status === 'approximated')).toBe(true);
    expect(getPresetKeybindingReport('vscode', 'intellij', false)).toEqual([]);
  });
});

describe('effective keymap resolution', () => {
  it('preserves UnityIDE app priority and opt-out editor defaults', () => {
    const bindings = resolveKeybindings(commands, experience(), false);
    expect(chord(bindings, 'view.aiPanel')).toEqual(['ctrl+l']);
    expect(active(bindings, 'monaco:expandLineSelection')).toEqual([]);
    expect(active(bindings, 'monaco:editor.action.addSelectionToNextFindMatch')).toHaveLength(1);
    expect(active(bindings, 'terminal.focusNextPane')[0].context).toBe('terminal');
    expect(active(bindings, 'ai.effortCycle')[0].context).toBe('input');
    expect(active(bindings, 'monaco:editor.foldAll')).toEqual([]); // Cmd/Ctrl+K remains the sidebar action.
  });
  it('restores profile editing priority and removes the old rename binding after switching', () => {
    const rider = resolveKeybindings(commands, experience('rider'), false);
    expect(chord(rider, 'monaco:editor.action.rename')).toEqual(['shift+f6']);
    expect(rider.some((binding) => binding.removed && binding.commandId === 'monaco:editor.action.rename' && binding.strokes[0] === 'f2')).toBe(true);
    const vscode = resolveKeybindings(commands, experience('vscode'), false);
    expect(chord(vscode, 'monaco:editor.action.rename')).toEqual(['f2']);
    expect(vscode.some((binding) => !binding.removed && binding.strokes[0] === 'shift+f6')).toBe(false);
    expect(chord(vscode, 'monaco:expandLineSelection')).toEqual(['ctrl+l']);
  });
  it('applies user overrides after imported bindings and supports removing all inherited action keys', () => {
    const state = experience('rider');
    state.importedBindings = [
      { commandId: 'editor.rename', strokes: [], removed: true },
      { commandId: 'editor.rename', strokes: ['alt+r'], context: 'editor' },
    ];
    expect(chord(resolveKeybindings(commands, state, false), 'monaco:editor.action.rename')).toEqual(['alt+r']);
    state.userBindings = [{ commandId: 'editor.rename', strokes: ['ctrl+shift+r'], context: 'editor' }];
    expect(chord(resolveKeybindings(commands, state, false), 'monaco:editor.action.rename')).toEqual(['ctrl+shift+r']);
    state.userBindings = [{ commandId: 'editor.rename', strokes: [], removed: true }];
    expect(active(resolveKeybindings(commands, state, false), 'monaco:editor.action.rename')).toEqual([]);
  });
  it('keeps shortcuts unchanged for an appearance-only profile switch', () => {
    const state = { ...experience('rider'), shortcutProfile: 'unityide' as const };
    expect(chord(resolveKeybindings(commands, state, true), 'terminal.toggle')).toEqual(['cmd+j']);
    expect(chord(resolveKeybindings(commands, { ...state, shortcutProfile: 'rider' }, true), 'terminal.toggle')).toEqual(['alt+f12']);
  });
  it('adds VS Code imported shortcuts until an explicit rule removes the inherited one', () => {
    const state = experience('vscode');
    state.importedBindings = [{ commandId: 'file.save', strokes: ['ctrl+alt+s'] }];
    expect(chord(resolveKeybindings(commands, state, false), 'file.save')).toEqual(['ctrl+s', 'ctrl+alt+s']);
    state.importedBindings.push({ commandId: 'file.save', strokes: ['ctrl+s'], removed: true });
    expect(chord(resolveKeybindings(commands, state, false), 'file.save')).toEqual(['ctrl+alt+s']);
  });
  it('uses shortcut source semantics after appearance-only changes and keeps manual overrides replacing', () => {
    const state = { ...experience('rider'), shortcutProfile: 'vscode' as const };
    state.importedBindings = [{ commandId: 'file.save', strokes: ['ctrl+alt+s'] }];
    expect(chord(resolveKeybindings(commands, state, false), 'file.save')).toEqual(['ctrl+s', 'ctrl+alt+s']);
    state.userBindings = [{ commandId: 'file.save', strokes: ['ctrl+shift+s'] }];
    expect(chord(resolveKeybindings(commands, state, false), 'file.save')).toEqual(['ctrl+shift+s']);
    const unityide = experience();
    unityide.userBindings = [{ commandId: 'file.save', strokes: ['ctrl+alt+s'] }];
    expect(chord(resolveKeybindings(commands, unityide, false), 'file.save')).toEqual(['ctrl+alt+s']);
  });
  it('gives a global user override priority over a preset editor shortcut', () => {
    const state = experience('vscode');
    state.userBindings = [{ commandId: 'file.save', strokes: ['ctrl+l'] }];
    const bindings = resolveKeybindings(commands, state, false);
    expect(chord(bindings, 'file.save')).toEqual(['ctrl+l']);
    expect(active(bindings, 'monaco:expandLineSelection')).toEqual([]);
  });
  it('reports and excludes unknown commands, malformed sequences and protected strokes', () => {
    const state = experience('rider');
    state.importedBindings = [
      { commandId: 'file.save', strokes: ['cmd+q'] },
      { commandId: 'extension.unavailable', strokes: ['ctrl+shift+a'] },
      { commandId: 'file.save', strokes: ['ctrl+k', 'ctrl+s', 's'] },
    ];
    const report = validateKeybindings(state.importedBindings, commands, true);
    expect(report.map((item) => item.status)).toEqual(['conflicting', 'unsupported', 'unsupported']);
    const bindings = resolveKeybindings(commands, state, true);
    expect(chord(bindings, 'file.save')).toEqual(['cmd+s']);
    expect(bindings.some((binding) => binding.commandId === 'extension.unavailable')).toBe(false);
  });
});
