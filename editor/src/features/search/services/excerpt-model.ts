// Folds a file's flat match list into the excerpt ranges the results tab
// renders. Pure — no Monaco, no store, no Tauri — so it is bun-testable.
import type { FileSearchResult, SearchMatch } from '../../../types';

export interface MatchRange {
  /** UTF-16 offset within the line's rendered `text`. */
  start: number;
  end: number;
}

export interface ExcerptLine {
  /** 1-based line number in the real file. */
  lineNumber: number;
  text: string;
  /** Empty for pure context lines. */
  matches: MatchRange[];
}

export interface Excerpt {
  /** `${filePath}:${startLine}` — stable across re-renders of one result set. */
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  lines: ExcerptLine[];
  /** Matches inside this excerpt, including any whose highlight could not be
   *  rendered (see the trimming note in `buildExcerpts`). */
  matchCount: number;
}

export interface Expansion {
  up: number;
  down: number;
}

export function excerptId(filePath: string, startLine: number): string {
  return `${filePath}:${startLine}`;
}

interface Window {
  start: number;
  end: number;
  /** lineNumber -> text, from context lines and match lines alike. */
  text: Map<number, string>;
  /** lineNumber -> highlight ranges. */
  ranges: Map<number, MatchRange[]>;
  /** lineNumber -> the lineStart the rendered text belongs to. */
  origin: Map<number, number>;
  matchCount: number;
}

function windowFor(match: SearchMatch): Window {
  const before = match.before ?? [];
  const after = match.after ?? [];
  const start = match.lineNumber - before.length;
  const end = match.lineNumber + after.length;

  const text = new Map<number, string>();
  const origin = new Map<number, number>();
  // Context lines are never preview-trimmed by the backend, so their origin
  // is always 0 (the whole, untrimmed line). Recording that here — not just
  // for the match line — is what lets `absorb` notice when a later match's
  // trimmed window lands on a line this window already saw as context.
  before.forEach((line, i) => {
    text.set(start + i, line);
    origin.set(start + i, 0);
  });
  text.set(match.lineNumber, match.lineContent);
  origin.set(match.lineNumber, match.lineStart ?? 0);
  after.forEach((line, i) => {
    text.set(match.lineNumber + 1 + i, line);
    origin.set(match.lineNumber + 1 + i, 0);
  });

  return {
    start,
    end,
    text,
    ranges: new Map([[match.lineNumber, [{ start: match.matchStart, end: match.matchEnd }]]]),
    origin,
    matchCount: 1,
  };
}

function absorb(target: Window, next: Window): void {
  target.start = Math.min(target.start, next.start);
  target.end = Math.max(target.end, next.end);
  target.matchCount += next.matchCount;

  for (const [lineNumber, text] of next.text) {
    if (!target.text.has(lineNumber)) {
      target.text.set(lineNumber, text);
      // Every line that gets text must get an origin alongside it — not just
      // a window's own match line — otherwise a line adopted here as context
      // (from THIS window's before/after) has no recorded origin, and a
      // later window's match landing on that same line falls through to the
      // "first arrival" branch below and wrongly attaches its (possibly
      // trimmed) ranges to this (possibly untrimmed) text. Context lines are
      // never preview-trimmed, so their origin is always 0.
      target.origin.set(lineNumber, next.origin.get(lineNumber) ?? 0);
    }
  }
  for (const [lineNumber, ranges] of next.ranges) {
    const incomingOrigin = next.origin.get(lineNumber) ?? 0;
    const existingOrigin = target.origin.get(lineNumber);
    if (existingOrigin === undefined) {
      target.origin.set(lineNumber, incomingOrigin);
      target.ranges.set(lineNumber, [...ranges]);
      continue;
    }
    // A long line is preview-trimmed around each match independently, so two
    // matches on one line can describe DIFFERENT windows of that line. Only
    // ranges from the window whose text we are actually rendering can be
    // highlighted; the rest stay in matchCount so the tally is still honest.
    //
    // Equal origins mean these ranges were computed against the very text
    // now stored for this line, so they are valid to attach whether or not
    // any ranges were attached to it yet — a line can have text and an
    // origin (set above, or by windowFor) without ever having had a range,
    // if it has so far only been seen as context. Get-or-set instead of an
    // asserted `.push`, since `target.ranges` is not guaranteed to already
    // hold an entry here.
    if (existingOrigin === incomingOrigin) {
      const existingRanges = target.ranges.get(lineNumber);
      if (existingRanges) {
        existingRanges.push(...ranges);
      } else {
        target.ranges.set(lineNumber, [...ranges]);
      }
    }
  }
}

/**
 * Builds this file's excerpts, merging matches whose context windows touch or
 * overlap so adjacent hits render as one continuous run of code rather than
 * two boxes repeating the same lines. Input order is assumed ascending by
 * line, which is the order the backend's sink emits.
 */
export function buildExcerpts(file: FileSearchResult): Excerpt[] {
  const windows: Window[] = [];
  for (const match of file.matches) {
    const next = windowFor(match);
    const current = windows[windows.length - 1];
    // `next.start <= current.end + 1` merges windows that overlap or sit
    // exactly adjacent (their ranges touch with no line between them). A
    // genuine one-line gap (next.start === current.end + 2) does NOT merge —
    // it stays two excerpts.
    if (current && next.start <= current.end + 1) {
      absorb(current, next);
    } else {
      windows.push(next);
    }
  }

  return windows.map((w) => {
    const lines: ExcerptLine[] = [];
    for (let lineNumber = w.start; lineNumber <= w.end; lineNumber++) {
      const text = w.text.get(lineNumber);
      if (text === undefined) continue;
      lines.push({ lineNumber, text, matches: w.ranges.get(lineNumber) ?? [] });
    }
    return {
      id: excerptId(file.path, w.start),
      filePath: file.path,
      startLine: w.start,
      endLine: w.end,
      lines,
      matchCount: w.matchCount,
    };
  });
}

/**
 * Re-renders an excerpt with `up`/`down` extra lines taken from the real file
 * contents, clamped at both boundaries. Highlight ranges on existing lines are
 * preserved; revealed lines are pure context.
 */
export function applyExpansion(
  excerpt: Excerpt,
  fileLines: string[],
  expansion: Expansion,
): Excerpt {
  const startLine = Math.max(1, excerpt.startLine - expansion.up);
  const endLine = Math.min(fileLines.length, excerpt.endLine + expansion.down);

  const existing = new Map(excerpt.lines.map((l) => [l.lineNumber, l]));
  const lines: ExcerptLine[] = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const known = existing.get(lineNumber);
    lines.push(
      known ?? { lineNumber, text: fileLines[lineNumber - 1] ?? '', matches: [] },
    );
  }

  return { ...excerpt, startLine, endLine, lines };
}
