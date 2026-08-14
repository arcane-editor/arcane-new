import { isMac as platformIsMac } from './platform';

/**
 * Named physical-key tokens (react-hotkeys-hook v5 matches on `event.code`, so
 * bindings are registered with words like "backslash" instead of the literal
 * character — see the terminal.* commands in App.tsx). Render them as their
 * symbol, since the word is what the registry holds but the glyph is what is
 * printed on the user's key.
 */
const NAMED_KEY_LABELS: Record<string, string> = {
  backslash: '\\',
  bracketleft: '[',
  bracketright: ']',
  backquote: '`',
  // Arrow keys are the clearest case of the rule above: the glyph is literally
  // what is printed on the key, and "⌘⌥Right" reads as a word where "⌘⌥→"
  // reads as a key.
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
};

/**
 * Render a registered keybinding (`'mod+shift+a'`) as a display chord
 * (`'⌘⇧A'` on macOS, `'Ctrl+Shift+A'` elsewhere).
 *
 * Shared so every surface that advertises a shortcut reads the same registry
 * string through the same formatter — a hardcoded chord elsewhere would drift
 * from the real binding without anything failing.
 *
 * `isMac` is a parameter defaulting to the sniffed platform so tests can pin
 * it. Sniffing alone is not testable here: bun defines `navigator`, so
 * `isMac()` is true under `bun test` on macOS and false on a Windows CI host,
 * and the same assertion would pass on one and fail on the other.
 */
export function formatKeybinding(kb: string, isMac: boolean = platformIsMac()): string {
  return kb
    .split('+')
    .map((part) => {
      const p = part.toLowerCase().trim();
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return isMac ? '⇧' : 'Shift';
      if (p === 'alt') return isMac ? '⌥' : 'Alt';
      if (p === '`') return '`';
      if (NAMED_KEY_LABELS[p]) return NAMED_KEY_LABELS[p];
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(isMac ? '' : '+');
}
