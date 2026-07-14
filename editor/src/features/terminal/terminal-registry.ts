// Module-level registry mapping a live terminal pane's id to a function that
// moves REAL keyboard focus into its xterm instance. Mirrors the shape of
// `features/theme/apply.ts`'s `registerTerminal`/`unregisterTerminal` (same
// module-level Map pattern), registered by TerminalInstance right next to
// its theme registration.
//
// Why this needs to exist at all: panes live inside `display:none`-toggled
// slots (tab switch, group switch) — `.focus()` on a detached/hidden DOM
// node is a no-op in most browsers, and even when it "works" React/DOM
// focus doesn't reliably land on xterm's internal hidden textarea unless
// xterm's own `Terminal.focus()` API is used. Command handlers (focus-next-
// pane, tab switch, split) call `focusTerminalById` so real focus follows
// the group model's `focusedId`, instead of just updating store state that
// nothing then acts on.

const focusFns = new Map<number, () => void>();

export function register(id: number, focusFn: () => void): void {
  focusFns.set(id, focusFn);
}

export function unregister(id: number): void {
  focusFns.delete(id);
}

export function focusTerminalById(id: number): void {
  focusFns.get(id)?.();
}
