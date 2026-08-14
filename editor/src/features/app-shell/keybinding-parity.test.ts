import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const MENU = readFileSync(path.join(ROOT, 'src-tauri/src/menu.rs'), 'utf8');
const APP = readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');

/**
 * A chord is owned in two independent places, and changing one does not change
 * the other:
 *
 *   1. the JS command registry in App.tsx, bound at the document level, and
 *   2. the native macOS menu in menu.rs, whose accelerators are registered
 *      with the OS.
 *
 * On macOS the native menu wins, and `handle_menu_event` executes the menu
 * item's *id* directly — bypassing the keybinding lookup entirely. So a chord
 * that names two different command ids silently does two different things
 * depending on the platform.
 *
 * editor/CLAUDE.md documents this trap from a real incident: mod+j was moved to
 * terminal.toggle while menu.rs still bound CmdOrCtrl+J to
 * view.toggleBottomPanel, and it survived a full green suite and eleven review
 * passes because every one of them was scoped to the JS diff. This test is that
 * review step, automated.
 */

/**
 * Punctuation keys have two spellings, one per side: menu.rs must use muda's
 * accelerator tokens (`=`, `-`, `[`), while App.tsx uses react-hotkeys-hook's
 * `code`-derived names (`equal`, `minus`, `bracketleft`). Folding them together
 * is what makes the comparison below actually happen — an unmatched spelling
 * is not reported as a mismatch, it is simply never compared, so without this
 * the zoom chords would pass the guard while diverging freely.
 */
const KEY_ALIASES: Record<string, string> = {
  '=': 'equal',
  '-': 'minus',
  '[': 'bracketleft',
  ']': 'bracketright',
  '`': 'backquote',
  '\\': 'backslash',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  ';': 'semicolon',
  "'": 'quote',
};

/** `CmdOrCtrl+Shift+T` -> `mod+shift+t`, `CmdOrCtrl+=` -> `mod+equal` */
function normalizeChord(chord: string): string {
  return chord
    .replace(/CmdOrCtrl/gi, 'mod')
    .toLowerCase()
    .split('+')
    .map((token) => token.trim())
    .map((token) => KEY_ALIASES[token] ?? token)
    .join('+');
}

/** Every `id: '...'` / `keybinding: '...'` pair, matched by proximity. */
function registryBindings(source: string): Map<string, string> {
  const ids = [...source.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => ({
    id: m[1],
    index: m.index!,
  }));
  const out = new Map<string, string>();
  for (const m of source.matchAll(/\bkeybinding:\s*'([^']+)'/g)) {
    // Associate with the NEAREST PRECEDING id, so a command without a
    // keybinding cannot have its neighbour's chord attributed to it.
    let owner: string | null = null;
    for (const candidate of ids) {
      if (candidate.index < m.index!) owner = candidate.id;
      else break;
    }
    if (owner) out.set(normalizeChord(m[1]), owner);
  }
  return out;
}

/**
 * Every menu item that declares an accelerator, as chord -> command id.
 *
 * Nearest-preceding rather than a bounded gap: `file.openRecent` declares no
 * accelerator, so a windowed match walks straight into the *next* item's
 * `.accelerator(...)` and attributes Cmd+S to Open Recent.
 */
function menuBindings(source: string): Map<string, string> {
  const ids = [...source.matchAll(/with_id\(\s*"([^"]+)"/g)].map((m) => ({
    id: m[1],
    index: m.index!,
  }));
  const out = new Map<string, string>();
  for (const m of source.matchAll(/\.accelerator\("([^"]+)"\)/g)) {
    let owner: string | null = null;
    for (const candidate of ids) {
      if (candidate.index < m.index!) owner = candidate.id;
      else break;
    }
    if (owner) out.set(normalizeChord(m[1]), owner);
  }
  return out;
}

describe('native menu vs command registry', () => {
  it('finds accelerators in menu.rs at all (guards the parser itself)', () => {
    const menu = menuBindings(MENU);
    expect(menu.size).toBeGreaterThan(8);
    expect(menu.get('mod+s')).toBe('file.save');
  });

  it('finds keybindings in App.tsx at all (guards the parser itself)', () => {
    const registry = registryBindings(APP);
    expect(registry.size).toBeGreaterThan(20);
    expect(registry.get('mod+shift+t')).toBe('tab.reopenClosed');
  });

  /**
   * Guards the alias folding itself. If `=` stopped normalising to `equal`,
   * the mismatch test below would keep passing — it only compares chords
   * present on BOTH sides — while Cmd+= silently drifted apart across
   * platforms. Naming the zoom chords explicitly makes that failure loud.
   */
  it('compares the zoom chords across both spellings rather than skipping them', () => {
    const menu = menuBindings(MENU);
    const registry = registryBindings(APP);
    for (const [chord, id] of [
      ['mod+equal', 'view.zoomIn'],
      ['mod+minus', 'view.zoomOut'],
      ['mod+0', 'view.zoomReset'],
    ] as const) {
      expect({ chord, menu: menu.get(chord), registry: registry.get(chord) }).toEqual({
        chord,
        menu: id,
        registry: id,
      });
    }
  });

  /**
   * Two commands on one chord is the bug `view.toggleBottomPanel` was left
   * unbound to avoid. It matters more now that chords are focus-routed:
   * `window.minimize` answers mod+m and decides between minimizing and cycling
   * the AI mode by where the caret is, so a second mod+m command would not
   * merely double-fire, it would make the routing unreachable.
   */
  it('gives every chord exactly one owning command', () => {
    const ids = [...APP.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => ({
      id: m[1],
      index: m.index!,
    }));
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const m of APP.matchAll(/\bkeybinding:\s*'([^']+)'/g)) {
      let owner: string | null = null;
      for (const candidate of ids) {
        if (candidate.index < m.index!) owner = candidate.id;
        else break;
      }
      if (!owner) continue;
      const chord = normalizeChord(m[1]);
      const prior = seen.get(chord);
      if (prior && prior !== owner) collisions.push(`${chord}: ${prior} and ${owner}`);
      else seen.set(chord, owner);
    }
    expect(collisions).toEqual([]);
  });

  it('binds every shared chord to the same command id on both sides', () => {
    const registry = registryBindings(APP);
    const mismatches: string[] = [];
    for (const [chord, menuId] of menuBindings(MENU)) {
      const registryId = registry.get(chord);
      if (registryId && registryId !== menuId) {
        mismatches.push(`${chord}: menu.rs=${menuId} but App.tsx=${registryId}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
