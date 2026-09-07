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
  // Omitting these was not cosmetic: every tooltip, coach mark, signpost and
  // palette row on Windows read "Ctrl+Equal" and "Ctrl+Minus", because the
  // fallback below just title-cases whatever token it does not recognise.
  equal: '=',
  minus: '-',
  comma: ',',
  slash: '/',
  pageup: 'PgUp',
  pagedown: 'PgDn',
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
/**
 * Token names for `aria-keyshortcuts`, which is a defined grammar rather
 * than the glyphs above: screen readers parse it, so "ArrowRight" is right
 * here where "→" is right in a tooltip.
 */
const ARIA_KEY_NAMES: Record<string, string> = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  backslash: '\\\\',
  bracketleft: '[',
  bracketright: ']',
  backquote: '`',
  equal: '=',
  minus: '-',
  comma: ',',
  slash: '/',
};

/**
 * The same registry chord in `aria-keyshortcuts` syntax ('Control+Shift+P').
 *
 * Separate from formatKeybinding because the audiences differ — one is read
 * by a person looking at a keycap, the other by a screen reader — but both
 * read the registry, so neither can drift from the chord that actually
 * fires. The two call sites used to hardcode 'Meta+D' and 'Meta+M', which
 * announced a Cmd key to every Windows user.
 */
export function ariaKeyshortcuts(kb: string, isMac: boolean = platformIsMac()): string {
  return kb
    .split('+')
    .map((part) => {
      const p = part.toLowerCase().trim();
      if (p === 'mod') return isMac ? 'Meta' : 'Control';
      if (p === 'ctrl' || p === 'control') return 'Control';
      if (p === 'shift') return 'Shift';
      if (p === 'alt') return 'Alt';
      if (ARIA_KEY_NAMES[p]) return ARIA_KEY_NAMES[p];
      if (p.length === 1) return p.toUpperCase();
      if (/^f[0-9]{1,2}$/.test(p)) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join('+');
}

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
