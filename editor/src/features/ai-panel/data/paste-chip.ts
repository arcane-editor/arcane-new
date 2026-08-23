/**
 * When a pasted slab should become a context chip instead of composer text.
 *
 * Pasting fifty lines of a stack trace into the composer buries the sentence
 * you were writing and leaves you scrolling a text box to find it. Collapsing
 * it to a chip keeps the composer about your words and puts the pasted content
 * where the rest of your context already lives — removable, and not something
 * you have to select-all to delete.
 *
 * The threshold is the whole design. Chip too eagerly and pasting a filename
 * or a one-line error stops working the way typing does; chip too late and the
 * composer still gets buried. These numbers are set so that anything you would
 * plausibly keep editing by hand stays inline.
 */

/** More than this many non-empty lines becomes a chip. */
export const PASTE_CHIP_MIN_LINES = 8;

/** …or more than this many characters, for one very long line. */
export const PASTE_CHIP_MIN_CHARS = 800;

/**
 * Lines in the paste, ignoring trailing blank ones.
 *
 * A copy out of an editor almost always carries a trailing newline, and
 * counting it would make the threshold fire one line earlier than it claims.
 */
export function pasteLineCount(text: string): number {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return 0;
  return trimmed.split('\n').length;
}

export function shouldChipPaste(text: string): boolean {
  if (!text) return false;
  return pasteLineCount(text) >= PASTE_CHIP_MIN_LINES || text.length >= PASTE_CHIP_MIN_CHARS;
}

/** What the chip says. Names what it is and how much of it there is. */
export function pasteChipLabel(text: string): string {
  const lines = pasteLineCount(text);
  return `Pasted ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}
