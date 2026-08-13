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
  /** UTF-16 offset in the ORIGINAL (pre-trim) file line at which `text`
   *  begins — mirrors `SearchMatch.lineStart`. 0 unless the backend
   *  preview-trimmed this line around one of its matches; always 0 for a
   *  pure context line, which is never preview-trimmed. The real editor
   *  column for a match in `matches` is `lineStart + match.start + 1`
   *  (1-based) — `match.start` alone is an offset into the possibly-trimmed
   *  `text`, not into the real file line. */
  lineStart: number;
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
      // Provably unreachable, not just unlikely: `next.ranges`'s keys are
      // always a subset of `next.text`'s keys (every line `windowFor` gives
      // a range also gets an entry in `text`), and the text loop above —
      // which gives EVERY line in `next.text` an origin, whether or not it
      // was already in `target` — always runs before this one. So by the
      // time this line executes, `target.origin` must already hold an entry
      // for every key in `next.ranges`.
      //
      // This is also the exact site whose regression would silently
      // reintroduce the wrong-highlight bug that took three fix rounds
      // (`45ad0c1`, `a91f3fd`) to pin down: the old first-arrival branch
      // here attached a match's ranges to whatever text happened to be
      // stored for the line, with no check that the ranges were computed
      // against THAT text. Throwing turns a future regression of the
      // subset invariant into a loud failure instead of a silent
      // mis-highlight.
      throw new Error(
        `excerpt-model.absorb: no origin recorded for line ${lineNumber}, but it has ranges — ` +
          'the text loop above should have set one for every line in next.ranges',
      );
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
      lines.push({
        lineNumber,
        text,
        matches: w.ranges.get(lineNumber) ?? [],
        lineStart: w.origin.get(lineNumber) ?? 0,
      });
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
 * Whether `lineNumber` (a real Monaco cursor position, 1-based) falls inside
 * this excerpt's visible range. A hydrated editor's `getPosition()` is only
 * trustworthy as an "open at cursor" target when this holds — a fresh editor
 * that was never actually clicked into (e.g. re-hydrated after switching
 * tabs and back, which preserves `activeExcerptId`) defaults its cursor to
 * the MODEL's (1,1), which is usually outside the excerpt entirely.
 */
export function positionWithinExcerpt(excerpt: Excerpt, lineNumber: number): boolean {
  return lineNumber >= excerpt.startLine && lineNumber <= excerpt.endLine;
}

/**
 * The excerpt's first match, as a 1-based (line, column) position — the
 * fallback "open at" location whenever no live cursor is available or
 * trusted (see `positionWithinExcerpt`). Column mirrors the double-click
 * handler in `FileExcerptBlock`: `lineStart + match.start`, not
 * `match.start` alone — a long line is preview-trimmed around its match, so
 * `match.start` by itself is an offset into the TRIMMED text a row renders,
 * not the real file line. `null` only for a pathological excerpt with no
 * match line at all, which `buildExcerpts` never produces.
 */
export function matchStartPosition(
  excerpt: Excerpt,
): { lineNumber: number; column: number } | null {
  const line = excerpt.lines.find((l) => l.matches.length > 0);
  if (!line) return null;
  return { lineNumber: line.lineNumber, column: line.lineStart + (line.matches[0]?.start ?? 0) + 1 };
}
