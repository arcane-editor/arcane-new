import type { BranchInfo } from '../../../stores/git';
import { fuzzyMatch } from '../../../utils/fuzzy-match';

/** A branch that matched the current query (or every branch, for an empty query). */
export interface BranchRow {
  kind: 'branch';
  /** Display name: `main`, or `origin/feature-x` for a remote branch. */
  name: string;
  matches: number[];
  score: number;
  /** True for a remote-tracking branch. Rendered in a group below the locals. */
  isRemote: boolean;
  /**
   * For a remote branch, the local branch to create or switch to on checkout
   * (`origin/release/1.x` -> `release/1.x`). Comes from git's own
   * `%(refname:lstrip=3)`, so nested names aren't split on the first slash.
   */
  localName?: string | null;
}

/** Synthetic trailing row offering to create a branch named after the typed query. */
export interface CreateBranchRow {
  kind: 'create';
  name: string;
}

export type BranchResultRow = BranchRow | CreateBranchRow;

/**
 * Empty-query ordering: the current branch is pinned first; the remainder
 * sorts by `last_checkout_ts` DESCENDING (most-recently-checked-out first,
 * per `git reflog`) — branches with no recorded checkout (`null`/`undefined`,
 * e.g. created but never checked out, or a fresh repo with no reflog at all)
 * sort AFTER every branch that has a timestamp, and any remaining tie
 * (equal timestamps, or both undefined) breaks alphabetically.
 *
 * This is a strict total ordering — for any two distinct branch names,
 * exactly one of "a before b"/"b before a" holds — so the result is stable
 * across repeated calls and independent of the input array's order (see the
 * "consistent total ordering" test).
 */
function compareBranchesByRecency(
  a: BranchInfo,
  b: BranchInfo,
  currentBranch: string | null,
): number {
  if (a.name === currentBranch) return -1;
  if (b.name === currentBranch) return 1;

  const aTs = a.last_checkout_ts ?? undefined;
  const bTs = b.last_checkout_ts ?? undefined;
  if (aTs !== undefined && bTs === undefined) return -1;
  if (aTs === undefined && bTs !== undefined) return 1;
  if (aTs !== undefined && bTs !== undefined && aTs !== bTs) return bTs - aTs;

  return a.name.localeCompare(b.name);
}

/**
 * Build the BranchPicker's result list: branches filtered/sorted by `query`,
 * with a synthetic "create branch" row appended when the (trimmed) query
 * doesn't exactly match any existing branch.
 *
 * - Empty query: all branches ordered by `compareBranchesByRecency` above. A
 *   `{ kind: 'create', name: '' }` row is prepended as the FIRST row — this
 *   is the always-visible "＋ Create new branch…" affordance that lets the
 *   BranchPicker enter create mode without requiring the user to type a
 *   non-matching name first.
 * - Non-empty query: fuzzy-filtered and sorted by match score, best first.
 *   Recency plays no role here — unchanged from before this feature.
 * - Create row: appended last when `query.trim()` is non-empty and no branch
 *   name equals the trimmed query exactly.
 *
 * Remote-tracking branches always sort AFTER every local branch, in both
 * modes — matching VS Code, which lists them as a separate group. Ordering
 * within each group is unchanged (recency, or fuzzy score).
 */
export function buildBranchResults(
  branches: BranchInfo[],
  query: string,
  currentBranch: string | null,
): BranchResultRow[] {
  const trimmed = query.trim();

  const toRow = (b: BranchInfo, matches: number[], score: number): BranchRow => ({
    kind: 'branch',
    name: b.name,
    matches,
    score,
    isRemote: b.is_remote === true,
    ...(b.is_remote ? { localName: b.local_name } : {}),
  });

  // Locals before remotes, applied after the mode-specific sort so it can't
  // disturb the ordering within either group.
  const byLocality = (a: BranchRow, b: BranchRow) =>
    Number(a.isRemote) - Number(b.isRemote);

  const rows: BranchRow[] = trimmed
    ? branches
        .map((b): BranchRow | null => {
          const result = fuzzyMatch(trimmed, b.name);
          if (!result) return null;
          return toRow(b, result.matches, result.score);
        })
        .filter((r): r is BranchRow => r !== null)
        .sort((a, b) => b.score - a.score)
        .sort(byLocality)
    : branches
        .slice()
        .sort((a, b) => compareBranchesByRecency(a, b, currentBranch))
        .map((b): BranchRow => toRow(b, [], 0))
        .sort(byLocality);

  if (trimmed === '') {
    return [{ kind: 'create', name: '' }, ...rows];
  }
  if (!branches.some((b) => b.name === trimmed)) {
    return [...rows, { kind: 'create', name: trimmed }];
  }
  return rows;
}
