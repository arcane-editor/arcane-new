// Turns a caret hit inside a rendered result line into an editor column.
//
// A line is not one text node: it renders as alternating plain spans and
// <mark> elements, and a colourized context line is a run of Monaco token
// spans. The browser reports a caret as (node, offset-within-node), so the
// offset within the LINE is that offset plus the length of every node before
// it.

/**
 * Character offset within the line's full text for a caret at `nodeOffset`
 * inside the node at `nodeIndex`. Out-of-range inputs clamp rather than
 * producing NaN — the caret APIs can report a node this code did not expect.
 */
export function offsetWithinLine(
  texts: string[],
  nodeIndex: number,
  nodeOffset: number,
): number {
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (nodeIndex >= texts.length) return total;

  const safeIndex = Math.max(0, nodeIndex);
  let offset = 0;
  for (let i = 0; i < safeIndex; i++) {
    offset += texts[i].length;
  }
  const within = Math.min(Math.max(0, nodeOffset), texts[safeIndex]?.length ?? 0);
  return offset + within;
}

/**
 * The 1-based editor column for an offset within a rendered line.
 * `lineStart` is the excerpt line's window origin — non-zero only when the
 * backend preview-trimmed a very long line, in which case the rendered text
 * begins that many characters into the real line.
 */
export function columnFor(lineStart: number, offset: number): number {
  return lineStart + offset + 1;
}
