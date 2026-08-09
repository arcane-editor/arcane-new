import { describe, expect, it } from 'bun:test';
import { overrideKeySequence } from './key-sequences';

function key(k: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) {
  return {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  };
}

describe('overrideKeySequence', () => {
  // ESC+CR is Meta+Enter — exactly what /terminal-setup binds Shift+Enter to
  // for VS Code, and what Option+Enter produces on an Option-as-Meta terminal.
  // Claude Code already treats that as "insert newline".
  it('encodes Shift+Enter as Meta+Enter so a TUI can tell it from Enter', () => {
    expect(overrideKeySequence(key('Enter', { shiftKey: true }))).toBe('\x1b\r');
  });

  it('leaves plain Enter alone — it must still submit', () => {
    expect(overrideKeySequence(key('Enter'))).toBeNull();
  });

  // Ctrl+Enter/Alt+Enter/Meta+Enter (and Shift combined with Ctrl or Alt) all
  // have their own meanings and must keep xterm's default encoding — this
  // module only ever special-cases bare Shift+Enter. That holds regardless
  // of platform: it's a distinct question from Ctrl+J, Claude Code's actual
  // universal newline, which reaches the PTY as 0x0A via xterm's own
  // encoding on macOS but is now swallowed before xterm sees it on
  // Linux/Windows, where mod+j (= Ctrl+J) belongs to terminal.toggle instead
  // (TerminalInstance's attachCustomKeyEventHandler).
  it('leaves other Enter chords to xterm', () => {
    expect(overrideKeySequence(key('Enter', { ctrlKey: true }))).toBeNull();
    expect(overrideKeySequence(key('Enter', { altKey: true }))).toBeNull();
    expect(overrideKeySequence(key('Enter', { metaKey: true }))).toBeNull();
    // Shift+Ctrl+Enter is not bare Shift+Enter.
    expect(overrideKeySequence(key('Enter', { shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(overrideKeySequence(key('Enter', { shiftKey: true, altKey: true }))).toBeNull();
  });

  it('does not touch any other key', () => {
    for (const k of ['a', 'Tab', 'Escape', 'Backspace', 'ArrowUp', ' ']) {
      expect(overrideKeySequence(key(k))).toBeNull();
      expect(overrideKeySequence(key(k, { shiftKey: true }))).toBeNull();
    }
  });
});
