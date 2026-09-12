import { formatRelativeDate } from '../../../utils/date';
import type { BlameLine } from '../../../types';

/**
 * What the inline blame hint says, and where it sits.
 *
 * Split from `inline-blame.ts` because that module reaches the git and
 * workspace stores, and a Zustand store here reaches `@tauri-apps/api`, which
 * does not load in a test — the same reason `rules/` takes its project
 * knowledge through a context object. Everything with a decision in it lives
 * on this side of the line; `inline-blame.ts` is the Monaco wiring around it.
 * The old blame hover provider had no tests at all for exactly this reason.
 */

/** The gap before the hint, in `ch` — this text sits in a monospaced grid. */
const PAD_CH = 6;
/** Zed's `min_column`: a one-word line should not park blame near the gutter. */
const MIN_COLUMN = 24;
/** A commit subject is one line; anything longer is a body that escaped. */
const MAX_SUMMARY = 60;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The hint itself: "Author, 3d ago · Subject".
 *
 * The comma joins the two halves of one fact — who, and when — the way prose
 * would. The single middle dot is the only structural mark in the line, and it
 * separates that fact from the commit's own words.
 */
export function formatInlineBlame(line: BlameLine): string {
  if (line.is_uncommitted) return 'Uncommitted';
  const who = line.author || 'Unknown';
  const when = line.date ? formatRelativeDate(line.date) : '';
  const head = when ? `${who}, ${when}` : who;
  const summary = line.summary ? truncate(line.summary.trim(), MAX_SUMMARY) : '';
  return summary ? `${head} · ${summary}` : head;
}

/** The full commit, shown only when the hint itself is hovered. */
export function formatBlameHover(line: BlameLine): string {
  if (line.is_uncommitted) {
    return '**Uncommitted changes**\n\nThis line is not committed yet, so there is nothing to attribute it to.';
  }
  const head = line.author_email
    ? `**${line.author || 'Unknown'}** ${line.author_email}`
    : `**${line.author || 'Unknown'}**`;
  const subject = line.summary ? `\n\n${line.summary.trim()}` : '';
  const when = line.date ? formatRelativeDate(line.date) : '';
  const meta = `\n\n\`${line.sha.slice(0, 7)}\`${when ? ` — ${when}` : ''}`;
  return `${head}${subject}${meta}`;
}

/**
 * Whether a line has anything worth blaming.
 *
 * A blank line gets nothing: the hint would be the only thing on the row, and
 * a lone run of text on an empty line reads as content rather than annotation.
 */
export function shouldShowBlame(lineContent: string): boolean {
  return lineContent.trim().length > 0;
}

/** Where the hint starts — never left of `MIN_COLUMN`, so short lines align. */
export function blamePadding(lineLength: number): number {
  return Math.max(PAD_CH, MIN_COLUMN - lineLength);
}
