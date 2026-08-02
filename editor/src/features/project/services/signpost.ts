import { formatKeybinding } from '../../../utils/format-keybinding';

export interface SignpostShortcut {
  id: string;
  label: string;
  keys: string;
}

/**
 * The handful of commands a first-time user needs, with newcomer-facing
 * labels. Order is the display order.
 *
 * Keys are resolved from the live command registry rather than written here.
 * That is load-bearing: the tester who prompted this work was told "Ctrl+J
 * opens the terminal", but `mod+j` is `view.toggleBottomPanel` — the terminal
 * merely lives in that panel. The direct binding is `terminal.toggle`, and the
 * AI panel is `view.aiPanel` (not `view.toggleRightSidebar`). Hardcoding would
 * have shipped exactly that confusion.
 */
const SIGNPOSTED: Array<{ id: string; label: string }> = [
  { id: 'palette.quickOpen', label: 'Go to file' },
  { id: 'terminal.toggle', label: 'Terminal' },
  { id: 'view.aiPanel', label: 'Ask the AI' },
  { id: 'palette.commands', label: 'Commands' },
];

/**
 * Resolve the signposted commands against the registered keybindings,
 * dropping any that aren't bound so the UI never renders an empty chord.
 */
export function signpostShortcuts(
  bindings: Array<{ id: string; keybinding: string }>,
  isMac?: boolean,
): SignpostShortcut[] {
  const byId = new Map(bindings.map((b) => [b.id, b.keybinding]));
  const out: SignpostShortcut[] = [];
  for (const { id, label } of SIGNPOSTED) {
    const kb = byId.get(id);
    if (!kb) continue;
    // Undefined `isMac` falls through to formatKeybinding's own default,
    // which sniffs the platform — production callers pass nothing.
    out.push({ id, label, keys: isMac === undefined ? formatKeybinding(kb) : formatKeybinding(kb, isMac) });
  }
  return out;
}
