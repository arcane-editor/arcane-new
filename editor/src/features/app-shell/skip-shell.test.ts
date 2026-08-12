import { describe, expect, it } from 'bun:test';
import { commandBeatsShell } from './skip-shell';

const inTerminalLinux = { isMac: false, inTerminal: true };
const inTerminalMac = { isMac: true, inTerminal: true };

describe('commandBeatsShell', () => {
  it('leaves every command alone when focus is outside a terminal', () => {
    expect(commandBeatsShell('view.toggleBottomPanel', 'mod+j', { isMac: false, inTerminal: false })).toBe(true);
    expect(commandBeatsShell('file.save', 'mod+s', { isMac: false, inTerminal: false })).toBe(true);
  });

  // On macOS `mod` is Cmd, which xterm never sends to the PTY. Yielding there
  // would make the key do nothing at all — worse than the status quo.
  it('never yields on macOS, where the shell has no claim on Cmd chords', () => {
    expect(commandBeatsShell('view.toggleBottomPanel', 'mod+j', inTerminalMac)).toBe(true);
    expect(commandBeatsShell('view.toggleRightSidebar', 'mod+k', inTerminalMac)).toBe(true);
    expect(commandBeatsShell('file.save', 'mod+s', inTerminalMac)).toBe(true);
  });

  // The actual bug: these are control characters the shell owns, and xterm has
  // already sent the byte by the time the command would run.
  it('yields bare Ctrl+letter chords to the shell on Linux/Windows', () => {
    const cases: Array<[string, string]> = [
      ['view.toggleBottomPanel', 'mod+j'], // Ctrl+J — Claude Code's newline
      ['view.toggleRightSidebar', 'mod+k'], // Ctrl+K — kill to end of line
      ['file.closeTab', 'mod+w'], // Ctrl+W — delete word backwards
      ['file.save', 'mod+s'], // Ctrl+S — XOFF, freezes output
      ['palette.quickOpen', 'mod+p'], // Ctrl+P — previous history
      ['view.toggleSidebar', 'mod+b'], // Ctrl+B — backward char
      ['file.new', 'mod+n'], // Ctrl+N — next history
      ['file.openFolder', 'mod+o'], // Ctrl+O
      ['editor.gotoLine', 'mod+g'], // Ctrl+G — abort
    ];
    for (const [id, kb] of cases) {
      expect(commandBeatsShell(id, kb, inTerminalLinux)).toBe(false);
    }
  });

  // Adding Shift/Alt leaves the control-character range, so no readline binding
  // claims these and the app can keep them.
  it('keeps chords the shell has no vocabulary for', () => {
    const cases: Array<[string, string]> = [
      ['view.toggleMaximizedPanel', 'mod+shift+j'],
      ['palette.commands', 'mod+shift+p'],
      ['search.openTab', 'mod+shift+f'],
      ['tab.next', 'mod+alt+right'],
      ['tab.prev', 'mod+alt+left'],
      ['editor.formatDocument', 'shift+alt+f'],
      ['unity.play', 'ctrl+shift+F5'],
      ['settings.open', 'mod+,'],
      ['tab.switch.1', 'mod+1'],
    ];
    for (const [id, kb] of cases) {
      expect(commandBeatsShell(id, kb, inTerminalLinux)).toBe(true);
    }
  });

  // These must survive from terminal focus or they'd be unusable — you split a
  // pane from inside a pane. xterm is already told to swallow their chords, so
  // yielding would make them dead keys.
  it('keeps terminal-management commands working from inside a terminal', () => {
    const cases: Array<[string, string]> = [
      ['terminal.toggle', 'mod+j'],
      ['terminal.new', 'mod+shift+`'],
      ['terminal.split', 'mod+backslash'],
      ['terminal.focusNextPane', 'mod+shift+bracketright'],
      ['terminal.focusPreviousPane', 'mod+shift+bracketleft'],
    ];
    for (const [id, kb] of cases) {
      expect(commandBeatsShell(id, kb, inTerminalLinux)).toBe(true);
    }
  });

  // Ctrl+J is LF (0x0A) — squarely in the shell's vocabulary, and the exact
  // shape isBareCtrlLetterChord yields on. terminal.toggle is exempt anyway:
  // you have to be able to close the panel from inside the pane filling it,
  // and xterm already swallows the chord, so yielding would make it dead.
  it('lets terminal.toggle win mod+j even though Ctrl+J is the shell\'s LF', () => {
    expect(commandBeatsShell('terminal.toggle', 'mod+j', inTerminalLinux)).toBe(true);
    // Same chord, a command that is not terminal management: still yields.
    expect(commandBeatsShell('view.toggleBottomPanel', 'mod+j', inTerminalLinux)).toBe(false);
  });

  it('is not confused by spacing or case in a binding', () => {
    expect(commandBeatsShell('x', 'MOD+J', inTerminalLinux)).toBe(false);
    expect(commandBeatsShell('x', 'mod + j', inTerminalLinux)).toBe(false);
    expect(commandBeatsShell('x', 'Ctrl+K', inTerminalLinux)).toBe(false);
  });
});
