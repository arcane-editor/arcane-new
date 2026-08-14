/**
 * The effort scale's two chords, collapsed into the one cap shown beside the
 * bars: `⌘←→`.
 *
 * Two properties matter more than the formatting:
 *
 *  - It is DERIVED from the live registry bindings, never written out. A
 *    hardcoded chord goes stale the moment a binding moves, which is exactly
 *    how the mode pill ended up advertising mod+. after mode cycling had moved
 *    to mod+m. `format-keybinding.ts` and `tooltip-chord.ts` both exist for
 *    this reason; this is the same rule applied to a control that cannot use a
 *    tooltip.
 *  - It returns null rather than guessing. The compact `⌘←→` form is only
 *    honest while the two commands really are one modifier set plus Left and
 *    Right. Rebind either to something else and the cap disappears instead of
 *    describing a chord that no longer exists.
 */

import { formatKeybinding } from '../../../utils/format-keybinding';

interface ParsedChord {
  mods: string[];
  key: string;
}

function parse(kb: string): ParsedChord {
  const parts = kb
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] ?? '' };
}

export function effortChordLabel(
  down: string | undefined,
  up: string | undefined,
  mac: boolean,
): string | null {
  if (!down || !up) return null;

  const d = parse(down);
  const u = parse(up);
  if (d.key !== 'left' || u.key !== 'right') return null;
  if (d.mods.join('+') !== u.mods.join('+')) return null;

  // Built through the shared formatter so the modifier half — ⌘ vs Ctrl+, and
  // the separator that goes with it — can never drift from every other chord
  // in the app. Only the second arrow is appended.
  return formatKeybinding([...d.mods, 'left'].join('+'), mac) + formatKeybinding('right', mac);
}
