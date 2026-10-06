import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { registerEditorCommandTarget, useCommandsStore } from './commands';

const initial = useCommandsStore.getState();
beforeEach(() => useCommandsStore.setState({ commands: new Map(), baseCommands: new Map(), resolvedBindings: [] }));
afterEach(() => useCommandsStore.setState(initial));

describe('command registry profile overlays', () => {
  it('keeps handlers/default chords immutable while showing effective shortcuts and editing actions', () => {
    let saved = 0;
    const store = useCommandsStore.getState();
    store.registerCommand({ id: 'file.save', label: 'Save', category: 'File', keybinding: 'mod+s', handler: () => { saved++; } });
    store.setResolvedKeybindings([{ commandId: 'file.save', strokes: ['ctrl+k', 's'] },
      { commandId: 'monaco:editor.action.rename', strokes: ['shift+f6'], context: 'editor' },
      { commandId: 'monaco:editor.action.rename', strokes: ['f2'], context: 'editor', removed: true }]);
    expect(store.getBaseCommands()[0].keybinding).toBe('mod+s');
    expect(useCommandsStore.getState().commands.get('file.save')?.keybinding).toBe('ctrl+k s');
    expect(store.getAllCommands().find((command) => command.id === 'monaco:editor.action.rename')?.label).toBe('Rename Symbol');
    expect(store.getAllCommands().find((command) => command.id === 'monaco:editor.action.rename')?.extraKeybindings).toEqual([]);
    expect(store.executeCommand('file.save')).toBe(true);
    expect(saved).toBe(1);
    expect(useCommandsStore.getState().baseCommands.has('monaco:editor.action.rename')).toBe(false);
  });
  it('checks focus and live action support before dispatching editor commands', () => {
    let focused = true;
    let supported = false;
    const calls: string[] = [];
    const unregister = registerEditorCommandTarget({ focused: () => focused, supports: () => supported,
      execute: (action) => { calls.push(action); } });
    try {
      const store = useCommandsStore.getState();
      expect(store.canExecuteCommand('monaco:editor.action.rename')).toBe(false);
      expect(store.executeCommand('monaco:editor.action.rename')).toBe(false);
      supported = true;
      expect(store.canExecuteCommand('monaco:editor.action.rename')).toBe(true);
      expect(store.executeCommand('monaco:editor.action.rename')).toBe(true);
      expect(calls).toEqual(['editor.action.rename']);
      focused = false;
      expect(store.canExecuteCommand('monaco:editor.action.rename')).toBe(false);
    } finally { unregister(); }
  });
  it('does not claim application editing shortcuts on a readonly or unsupported pane', () => {
    let supported = false;
    let calls = 0;
    const unregister = registerEditorCommandTarget({ focused: () => true, supports: (action) => supported && action === 'editor.action.formatDocument',
      execute: () => {} });
    try {
      const store = useCommandsStore.getState();
      store.registerCommand({ id: 'editor.formatDocument', label: 'Format Document', category: 'Editor', when: () => true, handler: () => { calls++; } });
      expect(store.canExecuteCommand('editor.formatDocument')).toBe(false);
      expect(calls).toBe(0);
      supported = true;
      expect(store.canExecuteCommand('editor.formatDocument')).toBe(true);
      expect(store.executeCommand('editor.formatDocument')).toBe(true);
      expect(calls).toBe(1);
    } finally { unregister(); }
  });
  it('preserves programmatic editor dispatch when native menus move focus away', () => {
    let allowed = true;
    let calls = 0;
    const unregister = registerEditorCommandTarget({ focused: () => false, supports: () => true, execute: () => {} });
    try {
      const store = useCommandsStore.getState();
      store.registerCommand({ id: 'editor.gotoLine', label: 'Go to Line', category: 'Editor', when: () => allowed, handler: () => { calls++; } });
      expect(store.canExecuteCommand('editor.gotoLine')).toBe(false);
      expect(store.executeCommand('editor.gotoLine')).toBe(true);
      expect(calls).toBe(1);
      allowed = false;
      expect(store.executeCommand('editor.gotoLine')).toBe(false);
    } finally { unregister(); }
  });
});
