/**
 * Whether the Source Control surfaces belong in this workspace at all: the
 * activity-bar icon, and the `view.sourceControl` command that owns its chord.
 *
 * A workspace that is not a git repository — plain folder or Unity project,
 * the distinction does not matter — has nothing for the panel to show but the
 * "not a git repository" placeholder, so the icon is absent rather than
 * present-and-empty. Same shape as `isNewInputSystemActive` for the Input Hub.
 *
 * Optimistic while detection is in flight. `isGitRepo` is `false` both before
 * the first `git status` resolves and after one says "not a repository", so
 * gating on it alone would move the whole activity bar on every launch of a
 * git project — the common case. `repoChecked` separates the two: the icon
 * stays until a status verdict actually lands, which costs a non-git project
 * one shift, once.
 */
export function showSourceControl(git: { isGitRepo: boolean; repoChecked: boolean }): boolean {
  return git.isGitRepo || !git.repoChecked;
}
