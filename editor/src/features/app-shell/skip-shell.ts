import { bindingBeatsShell } from '../../utils/editor-keybindings';

/**
 * Decides who owns a keystroke when a terminal has focus: the app, or the shell
 * running inside it.
 *
 * This is VS Code's `terminal.integrated.commandsToSkipShell` idea. It matters
 * because xterm's own key handler sits on its element and fires *before* the
 * document-level hotkey listener — so the byte has already gone to the PTY by
 * the time an app command runs. Firing anyway means both happen: on Linux,
 * Ctrl+K kills to end of line *and* toggles the sidebar.
 */

/**
 * Commands that keep working even while the terminal has focus.
 *
 * All of them are terminal management — you must be able to split or cycle
 * panes from inside a pane, or the binding is useless. Their chords are also
 * ones xterm is already told to swallow (see TerminalInstance's
 * attachCustomKeyEventHandler), so yielding them to the shell would make the
 * keys do nothing at all rather than something useful.
 */

/**
 * True when `keybinding` is a bare Ctrl+<letter> — no Shift, no Alt.
 *
 * That set is not arbitrary: Ctrl+A..Ctrl+Z are precisely the control
 * characters 0x01..0x1A, which *is* the shell's vocabulary (Ctrl+W delete word,
 * Ctrl+K kill line, Ctrl+J newline, Ctrl+S XOFF). Adding Shift or Alt, or using
 * a digit or punctuation, produces something no readline binding claims — so
 * those stay the app's without conflict.
 */

/**
 * Whether an app command should fire, given where focus is.
 *
 * Pure so the policy can be tested without a DOM or a second platform — the
 * behaviour it governs only manifests on Linux/Windows.
 */
export function commandBeatsShell(
  commandId: string,
  keybinding: string,
  opts: { isMac: boolean; inTerminal: boolean }
): boolean {
  if (!opts.inTerminal) return true;

  return bindingBeatsShell({ commandId, strokes: [keybinding] }, opts.isMac);
}
