import { useCommandsStore } from '../stores/commands';
import { ariaKeyshortcuts } from '../utils/format-keybinding';

/**
 * A command's chord in `aria-keyshortcuts` syntax, or `undefined` when it has
 * none (React then omits the attribute rather than rendering an empty one).
 *
 * The point is that the announced chord and the chord that fires come from the
 * same place. The two call sites used to hardcode `"Meta+D"` and `"Meta+M"`,
 * which told every Windows user to press a key their keyboard does not have.
 *
 * Selects the commands Map directly — it is a stable reference that changes
 * only when a command is registered or unregistered, so deriving in render is
 * safe where deriving in the selector would loop (see `selectCommands` in
 * components/Tooltip.tsx for the incident this refers to).
 */
export function useAriaKeyshortcuts(commandId: string): string | undefined {
  const commands = useCommandsStore((s) => s.commands);
  const keybinding = commands.get(commandId)?.keybinding;
  return keybinding ? ariaKeyshortcuts(keybinding) : undefined;
}
