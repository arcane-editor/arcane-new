// Match-range splitting is pure and tested here. Token colouring itself is a
// Monaco call — bun cannot import Monaco (it wants a DOM and workers), so it
// stays out of this module entirely: it lives as the `useColorizedLine` hook
// in `FileExcerptBlock.tsx`, which is not unit-tested for the same reason.
import type { MatchRange } from './excerpt-model';

export interface LineSegment {
  text: string;
  isMatch: boolean;
}

export function excerptRowKey(filePath: string, lineNumber: number): string {
  return `${filePath}#${lineNumber}`;
}

/**
 * Splits a line into alternating plain and matched segments. Ranges are
 * UTF-16 offsets into `text`; out-of-range ends are clamped and zero-width
 * ranges dropped, so a malformed range can never produce an empty span or a
 * negative slice.
 */
export function splitByMatches(text: string, ranges: MatchRange[]): LineSegment[] {
  const sorted = [...ranges]
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(text.length, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) return [{ text, isMatch: false }];

  const segments: LineSegment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue; // overlapping range: keep the first
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), isMatch: false });
    }
    segments.push({ text: text.slice(range.start, range.end), isMatch: true });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), isMatch: false });
  }
  return segments;
}
