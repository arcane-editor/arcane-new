import { describe, it, expect } from 'bun:test';
import { buildBranchResults, type BranchRow } from './branch-results';

describe('buildBranchResults', () => {
  describe('empty query', () => {
    it('prepends a create row (name \'\') as the first row, before the pinned current branch', () => {
      const rows = buildBranchResults(['feature/b', 'main', 'develop'], '', 'develop');
      expect(rows[0]).toEqual({ kind: 'create', name: '' });
      expect(rows.map((r) => r.name)).toEqual(['', 'develop', 'feature/b', 'main']);
    });

    it('pins the current branch first among the branch rows, sorts the rest alphabetically', () => {
      const rows = buildBranchResults(['feature/b', 'main', 'develop'], '', 'develop');
      const branchRows = rows.filter((r): r is BranchRow => r.kind === 'branch');
      expect(branchRows.map((r) => r.name)).toEqual(['develop', 'feature/b', 'main']);
    });

    it('is a consistent total ordering (stable across repeated calls, no reshuffling)', () => {
      const branches = ['zeta', 'alpha', 'mid', 'omega'];
      const first = buildBranchResults(branches, '', 'mid').map((r) => r.name);
      const second = buildBranchResults([...branches], '', 'mid').map((r) => r.name);
      const third = buildBranchResults(branches.slice().reverse(), '', 'mid').map((r) => r.name);
      expect(first).toEqual(['', 'mid', 'alpha', 'omega', 'zeta']);
      expect(second).toEqual(first);
      // Regardless of the input array's order, the sorted output must be identical —
      // this is what a legal total-ordering comparator guarantees and the old
      // `a.name === currentBranch ? -1 : b.name === currentBranch ? 1 : 0`
      // comparator (returning 0 for any non-current pair) did not.
      expect(third).toEqual(first);
    });

    it('prepends the create row for a whitespace-only query (treated as empty)', () => {
      const rows = buildBranchResults(['main'], '   ', 'main');
      expect(rows[0]).toEqual({ kind: 'create', name: '' });
      expect(rows.map((r) => r.name)).toEqual(['', 'main']);
    });

    it('handles no current branch (null) without throwing: still prepends the create row and does not pin', () => {
      const rows = buildBranchResults(['b', 'a'], '', null);
      expect(rows[0]).toEqual({ kind: 'create', name: '' });
      const branchRows = rows.filter((r): r is BranchRow => r.kind === 'branch');
      expect(branchRows.map((r) => r.name)).toEqual(['a', 'b']);
    });
  });

  describe('non-empty query (fuzzy filtering)', () => {
    it('filters out branches that do not fuzzy-match and sorts by score', () => {
      const rows = buildBranchResults(['feature/login', 'feature/logout', 'main'], 'login', 'main');
      const names = rows.filter((r) => r.kind === 'branch').map((r) => r.name);
      expect(names).toContain('feature/login');
      expect(names).not.toContain('main');
    });

    it('is unaffected by the create-row logic when there is no exact match (still fuzzy-sorted)', () => {
      const rows = buildBranchResults(['feature/login', 'feature/logout'], 'logi', 'feature/login');
      const branchRows = rows.filter((r): r is BranchRow => r.kind === 'branch');
      // feature/login should score at least as well as feature/logout for query "logi"
      expect(branchRows[0].name).toBe('feature/login');
    });

    it('does not prepend a create row for a non-empty query (only the trailing create row applies)', () => {
      const rows = buildBranchResults(['feature/login'], 'feature/logi', 'main');
      expect(rows[0].kind).toBe('branch');
    });
  });

  describe('create row', () => {
    it('is absent when the trimmed query exactly matches an existing branch', () => {
      const rows = buildBranchResults(['main', 'develop'], 'main', 'main');
      expect(rows.some((r) => r.kind === 'create')).toBe(false);
    });

    it('is absent when the query exactly matches after trimming surrounding whitespace', () => {
      const rows = buildBranchResults(['main', 'develop'], '  main  ', 'main');
      expect(rows.some((r) => r.kind === 'create')).toBe(false);
      // Verify that the branch row IS present (not vacuously passing on empty array)
      expect(rows.map((r) => r.name)).toContain('main');
    });

    it('is present and appended last when the query matches no branch exactly', () => {
      const rows = buildBranchResults(['main', 'develop'], 'feature/new-thing', 'main');
      expect(rows.length).toBeGreaterThan(0);
      const last = rows[rows.length - 1];
      expect(last.kind).toBe('create');
      expect(last.name).toBe('feature/new-thing');
    });

    it('uses the trimmed query as the create-row name', () => {
      const rows = buildBranchResults(['main'], '  new-branch  ', 'main');
      const createRow = rows.find((r) => r.kind === 'create');
      expect(createRow?.name).toBe('new-branch');
    });

    it('is present even when a similarly-named branch fuzzy-matches (no exact match)', () => {
      const rows = buildBranchResults(['feature/login'], 'feature/logi', 'main');
      const kinds = rows.map((r) => r.kind);
      expect(kinds[kinds.length - 1]).toBe('create');
      // the fuzzy-matched branch row is still present ahead of the create row
      expect(rows.some((r) => r.kind === 'branch' && r.name === 'feature/login')).toBe(true);
    });

    it('is case-sensitive for the exact-match check (branch names are case-sensitive in git)', () => {
      const rows = buildBranchResults(['Main'], 'main', 'Main');
      // "main" !== "Main" exactly, so a create row for "main" is offered
      expect(rows.some((r) => r.kind === 'create' && r.name === 'main')).toBe(true);
    });

    it('appends the create row after all branch rows regardless of branch count', () => {
      const rows = buildBranchResults(['feature-one', 'feature-two', 'main'], 'feat', 'main');
      const branchRows = rows.filter((r) => r.kind === 'branch');
      const createRows = rows.filter((r) => r.kind === 'create');
      // Verify that several branches fuzzy-match the query
      expect(branchRows.length).toBeGreaterThan(1);
      expect(branchRows.map((r) => r.name)).toContain('feature-one');
      expect(branchRows.map((r) => r.name)).toContain('feature-two');
      // Verify that the create row is present and comes last
      expect(createRows).toHaveLength(1);
      expect(rows[rows.length - 1].kind).toBe('create');
    });
  });
});
