// Pure source-surgery for in-place preview editing. The preview maps a
// rendered block back to its markdown source through the remark AST's
// `position.start.offset` / `position.end.offset` (UTF-16 code units on the
// exact string react-markdown parsed), so edits are offset splices — no text
// matching, no heuristics. Keep this file dependency-free; it is the tested
// core the components lean on.

/**
 * Replace `[start, end)` of `source` with `newText`.
 * Returns `source` unchanged on an invalid range — a stale offset (the file
 * changed under the editor) must never mangle the document.
 */
export function replaceBlock(source: string, start: number, end: number, newText: string): string {
  if (start < 0 || end < start || end > source.length) return source;
  return source.slice(0, start) + newText + source.slice(end);
}

/**
 * Toggle the `- [ ]` / `- [x]` task marker on the line containing `offset`.
 * Handles `-` and `*` bullets at any indent, case-insensitive `[X]`.
 * Returns `null` when the line carries no task marker (caller no-ops).
 */
export function toggleTaskAt(source: string, offset: number): string | null {
  if (offset < 0 || offset > source.length) return null;
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEndIdx = source.indexOf('\n', lineStart);
  const lineEnd = lineEndIdx === -1 ? source.length : lineEndIdx;
  const line = source.slice(lineStart, lineEnd);

  const m = line.match(/^(\s*[-*]\s+\[)( |x|X)(\])/);
  if (!m) return null;

  const toggled = m[2] === ' ' ? 'x' : ' ';
  const newLine = line.slice(0, m[1].length) + toggled + line.slice(m[1].length + 1);
  return source.slice(0, lineStart) + newLine + source.slice(lineEnd);
}
