import type { EditorProfile, ImportReportItem, KeyBinding, RiderKeymap } from '../../../types/editor-experience';
import { normalizeBinding } from '../../../utils/editor-keybindings';

export const RIDER_KEYMAP_OPTIONS: Array<{ value: RiderKeymap; label: string }> = [
  { value: 'intellij', label: 'IntelliJ / Rider' },
  { value: 'visual-studio', label: 'Visual Studio' },
  { value: 'visual-studio-2022', label: 'Visual Studio 2022' },
  { value: 'resharper', label: 'ReSharper' },
  { value: 'vscode', label: 'Visual Studio Code' },
];

export { MONACO_ACTION_LABELS } from '../../../utils/editor-action-labels';

type Mapping = Record<string, string | string[]>;
const EDITOR_ACTION = 'monaco:';

export function getDefaultEditorKeybindings(mac: boolean): KeyBinding[] {
  const editor: Mapping = {
    'editor.action.revealDefinition': 'f12',
    'editor.action.peekDefinition': 'alt+f12',
    'editor.action.rename': 'f2',
    'actions.find': 'mod+f',
    'editor.action.startFindReplaceAction': mac ? 'cmd+alt+f' : 'ctrl+h',
    'editor.action.commentLine': 'mod+slash',
    'editor.action.blockComment': 'shift+alt+a',
    'editor.action.copyLinesDownAction': 'shift+alt+down',
    'editor.action.copyLinesUpAction': 'shift+alt+up',
    'editor.action.deleteLines': 'mod+shift+k',
    'editor.action.moveLinesUpAction': 'alt+up',
    'editor.action.moveLinesDownAction': 'alt+down',
    'editor.action.indentLines': 'mod+bracketright',
    'editor.action.outdentLines': 'mod+bracketleft',
    'editor.action.smartSelect.expand': 'shift+alt+right',
    'editor.action.smartSelect.shrink': 'shift+alt+left',
    'editor.action.insertCursorAbove': mac ? 'cmd+alt+up' : 'ctrl+alt+up',
    'editor.action.insertCursorBelow': mac ? 'cmd+alt+down' : 'ctrl+alt+down',
    'editor.action.addSelectionToNextFindMatch': 'mod+d',
    'editor.action.selectHighlights': 'mod+shift+l',
    'expandLineSelection': 'mod+l',
    'editor.action.jumpToBracket': 'mod+shift+backslash',
    'editor.fold': mac ? 'cmd+alt+bracketleft' : 'ctrl+shift+bracketleft',
    'editor.unfold': mac ? 'cmd+alt+bracketright' : 'ctrl+shift+bracketright',
    'editor.foldAll': 'mod+k mod+0',
    'editor.unfoldAll': 'mod+k mod+j',
    'editor.action.triggerSuggest': 'ctrl+space',
    'editor.action.triggerParameterHints': 'mod+shift+space',
  };
  if (mac) editor['editor.action.joinLines'] = 'ctrl+j';
  return mappingBindings(editor, mac, true);
}

function mappingBindings(mapping: Mapping, mac: boolean, monaco = false): KeyBinding[] {
  return Object.entries(mapping).flatMap(([commandId, chords]) => (Array.isArray(chords) ? chords : [chords])
    .map((chord) => normalizeBinding({ commandId: monaco ? EDITOR_ACTION + commandId : commandId,
      strokes: chord.split(' '), context: monaco || commandId.startsWith('editor.') ? 'editor' : 'global' }, mac))
    .filter((binding): binding is KeyBinding => !!binding));
}

/** Presets translate supported actions; UnityIDE's additional commands keep their defaults. */
export function getPresetKeybindings(profile: EditorProfile, keymap: RiderKeymap, mac: boolean): KeyBinding[] {
  if (profile === 'unityide') return [];
  if (profile === 'vscode' || keymap === 'vscode') {
    return [
      ...getDefaultEditorKeybindings(mac),
      ...mappingBindings({
        'palette.commands': 'mod+shift+p', 'palette.quickOpen': 'mod+p', 'search.openTab': 'mod+shift+f',
        'file.openFolder': 'mod+k mod+o',
        'terminal.toggle': 'mod+backquote', 'view.toggleBottomPanel': 'mod+j',
        'editor.gotoLine': 'ctrl+g', 'editor.gotoSymbol': 'mod+shift+o',
        'editor.quickFix': 'mod+period', 'editor.formatDocument': 'shift+alt+f', 'editor.findUsages': 'shift+f12',
        'nav.back': mac ? 'ctrl+minus' : 'alt+left', 'nav.forward': mac ? 'ctrl+shift+minus' : 'alt+right',
        'debug.continue': 'f5', 'debug.stepOver': 'f10', 'debug.stepInto': 'f11',
        'debug.stepOut': 'shift+f11', 'debug.stop': 'shift+f5', 'debug.toggleBreakpoint': 'f9',
        'unity.play': 'ctrl+f5', 'unity.stop': 'ctrl+shift+f5',
      }, mac),
    ];
  }
  // JetBrains' OS-specific comparison tables and ReSharper reference cards:
  // https://www.jetbrains.com/help/rider/Keymaps_Comparison_Windows.html
  // https://www.jetbrains.com/help/rider/Keymaps_Comparison_Mac.html
  // https://resources.jetbrains.com/storage/products/rider/docs/Rider_ReSharper_mac_shortcuts.pdf
  const visualStudio = keymap === 'visual-studio' || keymap === 'visual-studio-2022';
  const resharper = keymap === 'resharper';
  const application: Mapping = visualStudio ? {
    'palette.quickOpen': 'mod+shift+t',
    'palette.commands': keymap === 'visual-studio-2022' && !mac ? 'ctrl+q' : 'mod+shift+a', 'search.openTab': 'mod+shift+f',
    'editor.gotoLine': 'mod+g', 'editor.gotoSymbol': 'alt+backslash',
    'editor.formatDocument': 'mod+alt+enter', 'editor.quickFix': 'alt+enter',
    'editor.findUsages': 'shift+f12', 'editor.refactor': 'mod+shift+r',
    'nav.back': 'mod+minus', 'nav.forward': 'mod+shift+minus',
    'terminal.toggle': mac ? 'ctrl+cmd+1' : 'ctrl+alt+1', 'debug.continue': ['f5', 'alt+f5'], 'debug.stepOver': 'f10',
    'debug.stepInto': mac ? 'cmd+f11' : 'f11', 'debug.stepOut': 'shift+f11', 'debug.stop': 'shift+f5', 'debug.toggleBreakpoint': 'f9',
    'debug.runToCursor': 'mod+f10', 'unity.play': 'ctrl+f5', 'unity.stop': 'ctrl+shift+f5',
  } : {
    'palette.quickOpen': mac && !resharper ? 'cmd+shift+o' : 'mod+shift+n', 'palette.commands': 'mod+shift+a',
    'search.openTab': 'mod+shift+f', 'editor.gotoLine': mac ? (resharper ? 'cmd+g' : 'cmd+l') : 'ctrl+g',
    'editor.gotoSymbol': 'mod+f12', 'editor.formatDocument': 'mod+alt+l',
    'editor.quickFix': 'alt+enter', 'editor.findUsages': 'alt+f7',
    'editor.refactor': resharper ? 'mod+shift+r' : mac ? 'ctrl+t' : 'ctrl+alt+shift+t',
    'nav.back': mac ? (resharper ? 'cmd+minus' : 'cmd+bracketleft') : resharper ? 'ctrl+minus' : 'ctrl+alt+left',
    'nav.forward': mac ? (resharper ? 'cmd+shift+minus' : 'cmd+bracketright') : resharper ? 'ctrl+shift+minus' : 'ctrl+alt+right',
    'terminal.toggle': 'alt+f12',
    'debug.continue': resharper ? ['f5', 'alt+f5'] : mac ? ['cmd+alt+r', 'ctrl+d'] : ['f9', 'shift+f9'],
    'debug.stepOver': resharper ? 'f10' : 'f8',
    'debug.stepInto': resharper ? (mac ? 'cmd+f11' : 'f11') : 'f7',
    'debug.stepOut': resharper ? 'shift+f11' : 'shift+f8', 'debug.stop': resharper ? 'shift+f5' : 'mod+f2',
    'debug.toggleBreakpoint': resharper ? 'f9' : 'mod+f8', 'debug.runToCursor': resharper ? 'mod+f10' : 'alt+f9',
    'unity.play': resharper ? 'ctrl+f5' : mac ? 'ctrl+r' : 'shift+f10',
    ...(resharper ? { 'unity.stop': 'ctrl+shift+f5' } : { 'unity.step': 'shift+f7' }),
  };
  application['settings.open'] = mac ? 'cmd+comma' : 'ctrl+alt+s';
  application['tab.next'] = mac ? 'cmd+shift+bracketright' : 'alt+right';
  application['tab.prev'] = mac ? 'cmd+shift+bracketleft' : 'alt+left';
  application['file.closeTab'] = 'mod+f4';
  const editing: Mapping = {
    'editor.action.revealDefinition': visualStudio ? 'f12' : 'mod+b',
    'editor.action.rename': visualStudio ? 'mod+r r' : resharper ? 'f2' : 'shift+f6',
    'actions.find': 'mod+f', 'editor.action.startFindReplaceAction': visualStudio || resharper ? 'ctrl+h' : 'mod+r',
    'editor.action.commentLine': visualStudio ? 'mod+alt+slash' : 'mod+slash',
    'editor.action.blockComment': mac ? (visualStudio || resharper ? 'ctrl+cmd+slash' : 'cmd+alt+slash') : 'ctrl+shift+slash',
    'editor.action.copyLinesDownAction': 'mod+d',
    'editor.action.deleteLines': visualStudio || resharper ? (mac ? 'cmd+shift+l' : 'ctrl+l') : mac ? 'cmd+backspace' : 'ctrl+y',
    'editor.action.smartSelect.expand': visualStudio ? (mac ? 'alt+up' : 'alt+shift+equal') : mac ? 'alt+up' : 'ctrl+w',
    'editor.action.smartSelect.shrink': visualStudio ? (mac ? 'alt+down' : 'alt+shift+minus') : mac ? 'alt+down' : 'ctrl+shift+w',
    'editor.action.joinLines': 'ctrl+shift+j',
    'editor.action.triggerSuggest': 'ctrl+space',
    'editor.action.triggerParameterHints': visualStudio && !mac ? 'ctrl+shift+space' : 'mod+p',
    'editor.action.addSelectionToNextFindMatch': visualStudio ? 'alt+shift+period' : mac ? 'ctrl+g' : 'alt+j',
    'editor.action.selectHighlights': visualStudio ? 'alt+shift+semicolon' : mac ? 'ctrl+cmd+g' : 'ctrl+alt+shift+j',
    'editor.action.moveLinesUpAction': visualStudio ? 'alt+up' : 'alt+shift+up',
    'editor.action.moveLinesDownAction': visualStudio ? 'alt+down' : 'alt+shift+down',
  };
  if (visualStudio || resharper) {
    editing['editor.fold'] = 'ctrl+m s';
    editing['editor.unfold'] = 'ctrl+m e';
    editing['editor.foldAll'] = 'ctrl+m a';
    editing['editor.unfoldAll'] = 'ctrl+m x';
  }
  // Native editing owns Ctrl+Y (redo on Windows); do not steal it for Delete Line.
  if (!mac && !visualStudio && !resharper) delete editing['editor.action.deleteLines'];
  return [...mappingBindings(application, mac), ...mappingBindings(editing, mac, true)];
}

export function getPresetKeybindingReport(profile: EditorProfile, keymap: RiderKeymap, mac: boolean): ImportReportItem[] {
  if (profile !== 'rider') return [];
  const report: ImportReportItem[] = [
    { category: 'shortcuts', label: 'Additional Rider gestures', status: 'unsupported',
      detail: 'Double Shift, double modifier taps, mouse shortcuts and NumPad-specific actions are not mapped. Supported actions remain available through the command palette and shortcut preferences.' },
    { category: 'shortcuts', label: 'Run and debug', status: 'approximated',
      detail: 'Rider run and debug shortcuts operate UnityIDE’s existing Unity play and debugger actions. JetBrains-only actions and integrations are not imported.' },
  ];
  if (!mac && keymap === 'intellij') report.push({ category: 'shortcuts', label: 'Delete Line: Ctrl+Y', status: 'conflicting',
    detail: 'Ctrl+Y keeps its standard Redo behavior. Delete Line keeps UnityIDE’s supported shortcut and can be customized.' });
  if (mac && keymap === 'visual-studio-2022') report.push({ category: 'shortcuts', label: 'Visual Studio 2022 on macOS', status: 'approximated',
    detail: 'The Visual Studio macOS mappings are used for this Windows keymap family.' });
  return report;
}
