/**
 * Which chords a text input already owns, and how badly it would hurt to take
 * one for a composer-scoped command.
 *
 * A composer-scoped command is only live while the caret is in the AI chat box
 * (`isAiComposerFocused`), and `KeyboardShortcutManager` calls `preventDefault`
 * on every match. So a chord the platform uses for text navigation is at its
 * WORST when scoped this way: the one surface where the command fires is the
 * one surface that needs the key. `ai.effortUp` shipped as `mod+right` and ate
 * line-end on macOS and word-jump on Windows, in the composer only. The
 * scoping gate bounds the blast radius; it does not make the chord free.
 *
 * What text fields claim on the two platforms we ship:
 *
 * | Chord            | macOS                  | Windows              |
 * |------------------|------------------------|----------------------|
 * | `←/→/↑/↓`        | character / line       | character / line     |
 * | `shift+arrow`    | extend selection       | extend selection     |
 * | `mod+←/→`        | line start / end       | previous / next word |
 * | `mod+↑/↓`        | document start / end   | paragraph            |
 * | `alt+←/→`        | previous / next word   | (free)               |
 * | `alt+↑/↓`        | paragraph              | (free)               |
 * | `ctrl+arrow`     | Mission Control (OS)   | (varies)             |
 * | `home` / `end`   | line or document       | line                 |
 *
 * On macOS that is every single-modifier arrow combination — so a one-modifier
 * chord cannot be conflict-free there, only cheap. Hence two severities rather
 * than a boolean: `caret` is the movement people use constantly and must never
 * be taken; `paragraph` is `alt+↑/↓`, which is macOS-only and immaterial in a
 * chat composer that is usually one paragraph (`mod+↑/↓` still reaches both
 * ends of it). Spending that to give `mod+←/→` back is the trade the effort
 * ladder makes deliberately.
 */

const HORIZONTAL = new Set(['left', 'right']);
const VERTICAL = new Set(['up', 'down']);
const JUMP_KEYS = new Set(['home', 'end', 'pageup', 'pagedown']);

/** `null` when a text field does not want the chord at all. */
export type TextFieldClash = 'caret' | 'paragraph' | null;

function parts(keybinding: string): string[] {
  return keybinding
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** How badly this chord collides with text editing on macOS or Windows. */
export function textFieldClash(keybinding: string): TextFieldClash {
  const p = parts(keybinding);
  const key = p[p.length - 1] ?? '';
  const mods = new Set(p.slice(0, -1));

  if (JUMP_KEYS.has(key)) return 'caret';

  // `mod+alt` together is the one arrow combination neither platform's text
  // editing uses.
  const modAlt = mods.has('mod') && mods.has('alt');
  if (modAlt) return null;

  if (HORIZONTAL.has(key)) return 'caret';
  if (VERTICAL.has(key)) {
    // Only `alt` alone drops a vertical arrow to paragraph movement; bare,
    // shifted and `mod` verticals are all line/document caret movement.
    return mods.size === 1 && mods.has('alt') ? 'paragraph' : 'caret';
  }
  return null;
}

/**
 * True when a chord takes movement people rely on while typing. Composer-scoped
 * commands must never take one of these.
 */
export function ownsTextFieldChord(keybinding: string): boolean {
  return textFieldClash(keybinding) === 'caret';
}
