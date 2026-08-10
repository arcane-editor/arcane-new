import { formatKeybinding } from '../utils/format-keybinding';
import { isMac as platformIsMac } from '../utils/platform';

export interface TooltipParts {
  label: string;
  /** Display chord, or null when the command has none. */
  chord: string | null;
}

/** Just enough of a command to read its chord. */
interface CommandLike {
  keybinding?: string;
}

/**
 * Split a tooltip into its label and the chord of the command it triggers.
 *
 * The chord is looked up rather than written at the call site. A hardcoded one
 * goes stale the moment the binding moves — which already happened here, and
 * five tooltips still spelled `⌘`/`⇧` so Windows and Linux users were shown
 * glyphs for keys they do not have.
 *
 * `lookup` and `isMac` are parameters so this is testable without a store or a
 * user agent: under `bun test` on macOS `navigator` exists and sniffing would
 * make the same assertion pass here and fail on a Windows CI host.
 */
export function tooltipParts(
  label: string,
  commandId: string | undefined,
  lookup: (id: string) => CommandLike | undefined,
  isMac: boolean = platformIsMac(),
): TooltipParts {
  if (!commandId) return { label, chord: null };
  const keybinding = lookup(commandId)?.keybinding;
  if (!keybinding) return { label, chord: null };
  return { label, chord: formatKeybinding(keybinding, isMac) };
}
