import { describe, expect, it } from 'bun:test';
import type { KeyBinding } from '../types/editor-experience';
import { bindingBeatsShell, createShortcutDispatcher, eventStroke, isProtectedStroke, normalizeBinding, normalizeStroke,
  nativeMenuBindingsForContext, shouldSuppressTerminalKey, type ShortcutKeyEvent } from './editor-keybindings';

function event(stroke: string, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  const parts = stroke.split('+');
  const key = parts.at(-1)!;
  const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` :
    ({ esc: 'Escape', backquote: 'Backquote', bracketleft: 'BracketLeft', bracketright: 'BracketRight',
      backslash: 'Backslash', enter: 'Enter' } as Record<string, string>)[key] ?? key.toUpperCase();
  return { code, ctrlKey: parts.includes('ctrl'), metaKey: parts.includes('cmd'), altKey: parts.includes('alt'),
    shiftKey: parts.includes('shift'), ...extra };
}
function harness(bindings: KeyBinding[], timeoutMs = 1000) {
  const calls: string[] = [];
  const disabled = new Set<string>();
  const dispatcher = createShortcutDispatcher({ bindings: () => bindings, isMac: false, timeoutMs,
    enabled: (id) => !disabled.has(id), execute: (id) => { calls.push(id); } });
  return { ...dispatcher, calls, disabled };
}

describe('exact shortcut keys', () => {
  it('normalizes platform aliases without changing explicit Ctrl/Cmd', () => {
    expect(normalizeStroke('mod+shift+,', true)).toBe('cmd+shift+comma');
    expect(normalizeStroke('mod+shift+,', false)).toBe('ctrl+shift+comma');
    expect(normalizeStroke('ctrl+k', true)).toBe('ctrl+k');
    expect(normalizeStroke('cmd+k', false)).toBe('cmd+k');
    expect(normalizeStroke('Ctrl + Alt + KeyL', false)).toBe('ctrl+alt+l');
    expect(normalizeStroke('ctrl+notakey', false)).toBeNull();
    expect(normalizeBinding({ commandId: 'file.save', strokes: [], removed: true }, false)?.strokes).toEqual([]);
    expect(normalizeBinding({ commandId: 'file.save', strokes: [] }, false)).toBeNull();
  });
  it('uses physical key codes and yields to AltGr and IME', () => {
    expect(eventStroke(event('ctrl+alt+q', { key: '@' }))).toBe('ctrl+alt+q');
    expect(eventStroke(event('ctrl+alt+q', { getModifierState: (modifier) => modifier === 'AltGraph' }))).toBeNull();
    expect(eventStroke(event('ctrl+k', { isComposing: true }))).toBeNull();
    expect(eventStroke(event('cmd+backquote'))).toBe('cmd+backquote');
  });
  it('reserves native editing and OS keys while permitting explicit macOS shell Ctrl', () => {
    expect(isProtectedStroke('cmd+c', true)).toBe(true);
    expect(isProtectedStroke('ctrl+c', true)).toBe(false);
    expect(isProtectedStroke('ctrl+y', false)).toBe(true);
    expect(isProtectedStroke('alt+f4', false)).toBe(true);
    expect(isProtectedStroke('cmd+e', false)).toBe(true);
    expect(isProtectedStroke('ctrl+alt+l', false)).toBe(false);
  });
});

describe('focused shortcut dispatch', () => {
  it('executes a sequence once and does not run its single-stroke prefix', () => {
    const dispatcher = harness([{ commandId: 'view.toggleRightSidebar', strokes: ['ctrl+k'] },
      { commandId: 'editor.formatDocument', strokes: ['ctrl+k', 'ctrl+d'], context: 'editor' }]);
    expect(dispatcher.dispatch(event('ctrl+k'), 'editor')).toBe(true);
    expect(dispatcher.calls).toEqual([]);
    expect(dispatcher.dispatch(event('ctrl+d'), 'editor')).toBe(true);
    expect(dispatcher.calls).toEqual(['editor.formatDocument']);
    dispatcher.cancel();
  });
  it('cancels sequences on Escape, focus change, explicit cancellation and timeout', async () => {
    const dispatcher = harness([{ commandId: 'editor.formatDocument', strokes: ['ctrl+k', 'ctrl+d'], context: 'editor' }], 10);
    dispatcher.dispatch(event('ctrl+k'), 'editor');
    expect(dispatcher.dispatch(event('esc'), 'editor')).toBe(true);
    expect(dispatcher.dispatch(event('ctrl+d'), 'editor')).toBe(false);
    dispatcher.dispatch(event('ctrl+k'), 'editor');
    expect(dispatcher.dispatch(event('ctrl+d'), 'input')).toBe(false);
    dispatcher.dispatch(event('ctrl+k'), 'editor');
    dispatcher.cancel();
    expect(dispatcher.isPending()).toBe(false);
    dispatcher.dispatch(event('ctrl+k'), 'editor');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(dispatcher.isPending()).toBe(false);
    expect(dispatcher.dispatch(event('ctrl+d'), 'editor')).toBe(false);
    expect(dispatcher.calls).toEqual([]);
  });
  it('allows disabled editor actions to fall back to an enabled global command', () => {
    const dispatcher = harness([{ commandId: 'file.closeTab', strokes: ['ctrl+w'] },
      { commandId: 'monaco:editor.action.smartSelect.expand', strokes: ['ctrl+w'], context: 'editor' }]);
    dispatcher.dispatch(event('ctrl+w'), 'editor');
    expect(dispatcher.calls).toEqual(['monaco:editor.action.smartSelect.expand']);
    dispatcher.disabled.add('monaco:editor.action.smartSelect.expand');
    dispatcher.dispatch(event('ctrl+w'), 'editor');
    dispatcher.dispatch(event('ctrl+w'), 'input');
    expect(dispatcher.calls).toEqual(['monaco:editor.action.smartSelect.expand', 'file.closeTab', 'file.closeTab']);
  });
  it('does not start disabled or AltGr sequences', () => {
    const dispatcher = harness([{ commandId: 'editor.refactor', strokes: ['ctrl+alt+r', 'r'], context: 'editor' }]);
    dispatcher.disabled.add('editor.refactor');
    expect(dispatcher.dispatch(event('ctrl+alt+r'), 'editor')).toBe(false);
    dispatcher.disabled.clear();
    expect(dispatcher.dispatch(event('ctrl+alt+r', { getModifierState: () => true }), 'editor')).toBe(false);
    expect(dispatcher.isPending()).toBe(false);
  });
  it('cancels pending sequences on AltGr input and keeps repeated prefixes from restarting them', () => {
    const dispatcher = harness([{ commandId: 'editor.formatDocument', strokes: ['ctrl+k', 'ctrl+d'], context: 'editor' }]);
    dispatcher.dispatch(event('ctrl+k'), 'editor');
    dispatcher.dispatch(event('ctrl+k', { repeat: true }), 'editor');
    expect(dispatcher.dispatch(event('ctrl+d'), 'editor')).toBe(true);
    dispatcher.dispatch(event('ctrl+k'), 'editor');
    dispatcher.dispatch(event('ctrl+alt+q', { getModifierState: () => true }), 'editor');
    expect(dispatcher.dispatch(event('ctrl+d'), 'editor')).toBe(false);
    expect(dispatcher.calls).toEqual(['editor.formatDocument']);
  });
  it('gives a focused single stroke priority over a global sequence', () => {
    const dispatcher = harness([{ commandId: 'file.openFolder', strokes: ['ctrl+k', 'ctrl+o'] },
      { commandId: 'monaco:editor.fold', strokes: ['ctrl+k'], context: 'editor' }]);
    dispatcher.dispatch(event('ctrl+k'), 'editor');
    expect(dispatcher.calls).toEqual(['monaco:editor.fold']);
    expect(dispatcher.isPending()).toBe(false);
  });
});

describe('terminal app ownership and PTY suppression', () => {
  it('leaves shell control bytes alone on macOS and Windows', () => {
    for (const mac of [false, true]) expect(bindingBeatsShell({ commandId: 'file.closeTab', strokes: ['ctrl+w'] }, mac)).toBe(false);
    expect(bindingBeatsShell({ commandId: 'file.closeTab', strokes: ['cmd+w'] }, true)).toBe(true);
  });
  it('uses effective terminal chords for both dispatch and suppression', () => {
    const bindings: KeyBinding[] = [{ commandId: 'terminal.toggle', strokes: ['alt+f12'] }];
    const dispatcher = harness(bindings);
    expect(shouldSuppressTerminalKey(event('alt+f12'), bindings, false, () => true)).toBe(true);
    expect(dispatcher.dispatch(event('alt+f12'), 'terminal')).toBe(true);
    expect(dispatcher.calls).toEqual(['terminal.toggle']);
    expect(shouldSuppressTerminalKey(event('ctrl+j'), bindings, false, () => true)).toBe(false);
    expect(dispatcher.dispatch(event('ctrl+j'), 'terminal')).toBe(false);
    expect(shouldSuppressTerminalKey(event('alt+f12'), bindings, false, () => false)).toBe(false);
  });
  it('does not leak a disabled/input-only command into terminal dispatch', () => {
    const bindings: KeyBinding[] = [{ commandId: 'ai.effortCycle', strokes: ['ctrl+d'], context: 'input' }];
    const dispatcher = harness(bindings);
    expect(dispatcher.dispatch(event('ctrl+d'), 'terminal')).toBe(false);
    expect(shouldSuppressTerminalKey(event('ctrl+d'), bindings, false, () => true)).toBe(false);
    expect(dispatcher.dispatch(event('ctrl+d'), 'input')).toBe(true);
  });
});

describe('native menu focus ownership', () => {
  it('clears app accelerators during find/onboarding without changing effective bindings', () => {
    const bindings: KeyBinding[] = [{ commandId: 'editor.gotoLine', strokes: ['cmd+g'] },
      { commandId: 'monaco:actions.find', strokes: ['cmd+f'], context: 'editor' }];
    const native = nativeMenuBindingsForContext(bindings, { context: 'input', suppressAppShortcuts: true }, true);
    expect(native[0].removed).toBe(true);
    expect(native[1].removed).toBeUndefined();
    expect(bindings[0].removed).toBeUndefined();
    expect(nativeMenuBindingsForContext(bindings, { context: 'editor', suppressAppShortcuts: false }, true)[0].removed).toBeUndefined();
  });
  it('retains terminal management and Cmd while yielding explicit shell Ctrl on macOS', () => {
    const bindings: KeyBinding[] = [{ commandId: 'file.save', strokes: ['ctrl+s'] },
      { commandId: 'file.save', strokes: ['cmd+s'] }, { commandId: 'terminal.toggle', strokes: ['ctrl+j'] }];
    const native = nativeMenuBindingsForContext(bindings, { context: 'terminal', suppressAppShortcuts: false }, true);
    expect(native.map((binding) => binding.removed === true)).toEqual([true, false, false]);
  });
});
