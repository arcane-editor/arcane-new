import { fuzzyMatch } from '../../../utils/fuzzy-match';

/** A branch that matched the current query (or every branch, for an empty query). */
export interface BranchRow {
  kind: 'branch';
  name: string;
  matches: number[];
  score: number;
}

/** Synthetic trailing row offering to create a branch named after the typed query. */
export interface CreateBranchRow {
  kind: 'create';
  name: string;
}

export type BranchResultRow = BranchRow | CreateBranchRow;

/**
 * Build the BranchPicker's result list: branches filtered/sorted by `query`,
 * with a synthetic "create branch" row appended when the (trimmed) query
 * doesn't exactly match any existing branch.
 *
 * - Empty query: all branches, current branch pinned first, remainder sorted
 *   alphabetically (a total ordering — no two distinct branches compare equal,
 *   so the list doesn't reshuffle across re-renders).
 * - Non-empty query: fuzzy-filtered and sorted by match score, best first.
 * - Create row: appended last when `query.trim()` is non-empty and no branch
 *   name equals the trimmed query exactly.
 */
export function buildBranchResults(
  branches: string[],
  query: string,
  currentBranch: string | null,
): BranchResultRow[] {
  const trimmed = query.trim();

  const rows: BranchRow[] = trimmed
    ? branches
        .map((name): BranchRow | null => {
          const result = fuzzyMatch(trimmed, name);
          if (!result) return null;
          return { kind: 'branch', name, matches: result.matches, score: result.score };
        })
        .filter((r): r is BranchRow => r !== null)
        .sort((a, b) => b.score - a.score)
    : branches
        .map((name): BranchRow => ({ kind: 'branch', name, matches: [], score: 0 }))
        .sort((a, b) =>
          a.name === currentBranch ? -1 : b.name === currentBranch ? 1 : a.name.localeCompare(b.name),
        );

  if (trimmed !== '' && !branches.some((name) => name === trimmed)) {
    return [...rows, { kind: 'create', name: trimmed }];
  }
  return rows;
}
