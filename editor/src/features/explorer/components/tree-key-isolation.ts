/**
 * Whether a keystroke typed in the inline rename box must be withheld from the
 * `react-arborist` tree it renders inside.
 *
 * The rename input sits *inside* the tree, so every keystroke bubbles through
 * the tree's keyboard handler on its way up. Unmodified keys are exactly the
 * tree's vocabulary — arrows, Home/End, Enter, Escape, Space, and letters for
 * type-ahead — so those are stopped, or renaming a file would drive the
 * selection instead of editing text.
 *
 * Modifier chords are let through. React attaches its listeners to `#root`
 * (`src/main.tsx:76`), below `document` where react-hotkeys-hook listens, so a
 * blanket `stopPropagation` here kills every application shortcut while a
 * rename is open — which is the bug this replaces.
 *
 * Accepted cost: Cmd/Ctrl+A now also reaches react-arborist's select-all,
 * highlighting tree rows. It does not touch the rename in progress or the text
 * selection in the field, and it is cheaper than leaving every shortcut dead.
 *
 * Shift is deliberately not a modifier here: Shift+letter is a capital and
 * Shift+Home is a selection, both of which the field owns.
 *
 * Pure so the policy can be tested without a DOM — the same reason
 * `app-shell/skip-shell.ts:52` is pure.
 */
export function isolateFromTree(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return !(e.ctrlKey || e.metaKey || e.altKey);
}
