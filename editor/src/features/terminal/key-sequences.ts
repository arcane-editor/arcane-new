/**
 * Key events this terminal encodes itself, rather than letting xterm's default
 * encoding through.
 */

/** ESC + CR — i.e. Meta+Enter. */
const META_ENTER = '\x1b\r';

/**
 * The bytes to send to the PTY for `e`, or null to let xterm encode it as usual.
 *
 * ## Why Shift+Enter needs us at all
 *
 * A terminal sends the same byte (`\r`) for Enter and Shift+Enter, so a TUI
 * cannot tell them apart. Terminals that *can* — Ghostty, Kitty, iTerm2,
 * WezTerm — do it by emitting an extended-key (CSI-u) sequence. xterm.js does
 * not, which is precisely why Claude Code lists VS Code, Cursor and Zed (all
 * xterm.js-based, like us) as terminals needing `/terminal-setup`, while those
 * others need nothing.
 *
 * That command can't help us: it writes into a *known* terminal's config file
 * and has no idea what Arcane is, so it refuses. But it isn't doing anything
 * privileged — for VS Code it just binds Shift+Enter to send `\r`. We own
 * this terminal, so we send that ourselves and the command becomes unnecessary.
 *
 * ESC+CR is Meta+Enter, which is the same thing Option+Enter produces on a
 * terminal with Option-as-Meta enabled — and Claude Code documents Option+Enter
 * as "insert a newline". So this is its existing newline input, not a special
 * case it has to know about.
 */
export function overrideKeySequence(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): string | null {
  // Shift+Enter only, and only bare: Ctrl/Alt/Cmd+Enter have their own
  // meanings and must keep xterm's encoding.
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return META_ENTER;
  }
  return null;
}
