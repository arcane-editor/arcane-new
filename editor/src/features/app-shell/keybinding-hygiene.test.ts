import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const APP = readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');

/**
 * Two rules about how a chord may be *written*, as opposed to which command
 * owns it (that is `keybinding-parity.test.ts`).
 *
 * Both encode a defect that shipped, survived review, and could not have been
 * caught by any existing test — including the parity test, which folds the two
 * spellings of a punctuation key together before comparing and so is blind to
 * the second rule by construction.
 */

/** Every `keybinding` / `extraKeybindings` chord in the registry, with its command id. */
function chords(source: string): Array<{ id: string; chord: string }> {
  const ids = [...source.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => ({
    id: m[1],
    index: m.index!,
  }));
  const ownerOf = (index: number): string | null => {
    let owner: string | null = null;
    for (const candidate of ids) {
      if (candidate.index < index) owner = candidate.id;
      else break;
    }
    return owner;
  };

  const out: Array<{ id: string; chord: string }> = [];
  for (const m of source.matchAll(/\bkeybinding:\s*'([^']+)'/g)) {
    const owner = ownerOf(m.index!);
    if (owner) out.push({ id: owner, chord: m[1] });
  }
  for (const m of source.matchAll(/\bextraKeybindings:\s*\[([^\]]*)\]/g)) {
    const owner = ownerOf(m.index!);
    if (!owner) continue;
    for (const inner of m[1].matchAll(/'([^']+)'/g)) {
      out.push({ id: owner, chord: inner[1] });
    }
  }
  return out;
}

describe('keybinding hygiene', () => {
  it('finds chords at all (guards the parser itself)', () => {
    const all = chords(APP);
    expect(all.length).toBeGreaterThan(40);
    expect(all.some((c) => c.id === 'view.aiPanel' && c.chord === 'mod+l')).toBe(true);
    // The alias arm of the parser, which the parity test does not exercise.
    expect(all.some((c) => c.id === 'view.zoomIn' && c.chord === 'mod+shift+equal')).toBe(true);
  });

  /**
   * On Windows `mod` is Ctrl, and Ctrl+Alt IS AltGr on every non-US layout —
   * UK-International, German, French, Polish, Portuguese, InScript and more.
   * So a `mod+alt+X` chord matches the keystrokes that type @ \ { } ~ | € and
   * KeyboardShortcutManager's `preventDefault` then eats the character, while
   * some unrelated command runs.
   *
   * Seven chords shipped this way — search.toggleCase/WholeWord/Regex,
   * ai.toggleInlineSuggestions, editor.refactor, tab.next and tab.prev — and
   * `mod+alt+left/right` additionally collided with Intel's screen-rotate
   * hotkey. None of it is visible on a US layout, which is why it lasted.
   */
  it('never combines a Ctrl-family modifier with Alt', () => {
    const offenders = chords(APP)
      .filter(({ chord }) => {
        const parts = chord.toLowerCase().split('+').map((p) => p.trim());
        const ctrlish = parts.includes('mod') || parts.includes('ctrl') || parts.includes('control');
        return ctrlish && parts.includes('alt');
      })
      .map(({ id, chord }) => `${id}: ${chord}`);
    expect(offenders).toEqual([]);
  });

  /**
   * react-hotkeys-hook v5 matches on `event.code`, so a punctuation key is
   * reported as 'Comma' / 'Backquote' / 'Backslash' and the registry must
   * spell it the same way. A literal ',' or '`' can never equal that, so the
   * chord simply never fires — silently, on every platform.
   *
   * `terminal.new` was bound to 'mod+shift+`' and `settings.open` to 'mod+,'
   * for their whole lives. `keybinding-parity.test.ts` normalises the literal
   * and the token to the same value before comparing, so it reported them as
   * being in perfect agreement with the native menu while neither worked.
   */
  it('spells punctuation keys as event.code tokens, never as the literal character', () => {
    const LITERALS: Record<string, string> = {
      ',': 'comma',
      '.': 'period',
      '/': 'slash',
      '\\': 'backslash',
      '[': 'bracketleft',
      ']': 'bracketright',
      '=': 'equal',
      '-': 'minus',
      ';': 'semicolon',
      "'": 'quote',
      '`': 'backquote',
    };
    const offenders: string[] = [];
    for (const { id, chord } of chords(APP)) {
      const key = chord.split('+').pop()?.trim() ?? '';
      const token = LITERALS[key];
      if (token) offenders.push(`${id}: '${chord}' should spell the key '${token}'`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The product is hotkey-first, so the chord for a frequent action is a
   * feature, not a detail. "Two keys" means one modifier plus one key.
   *
   * This is a floor, not a style rule: it names the handful of commands where
   * a third key was judged too expensive, so that a future edit that quietly
   * lengthens one of them has to argue with a test rather than slip through.
   */
  it('keeps the highest-frequency commands to two keys', () => {
    const TWO_KEY_REQUIRED = [
      'view.aiPanel',
      'ai.newChat',
      'terminal.toggle',
      'palette.quickOpen',
      'view.toggleSidebar',
      'view.toggleRightSidebar',
      'file.save',
      'file.closeTab',
      'settings.open',
      'tab.next',
      'tab.prev',
    ];
    const all = chords(APP);
    const tooLong: string[] = [];
    for (const id of TWO_KEY_REQUIRED) {
      // A command passes on its SHORTEST chord: aliases exist to add reach.
      const own = all.filter((c) => c.id === id);
      expect(own.length).toBeGreaterThan(0);
      const shortest = Math.min(...own.map((c) => c.chord.split('+').length));
      if (shortest > 2) tooLong.push(`${id}: ${own.map((c) => c.chord).join(', ')}`);
    }
    expect(tooLong).toEqual([]);
  });
});
