/**
 * VS Code-style smart-commit decisions, extracted pure so the SCM panel's
 * button gate and the git store's auto-stage step share one definition.
 */

/** Whether the Commit button should be enabled. */
export function canCommit(
  message: string,
  stagedCount: number,
  unstagedCount: number,
  amend: boolean,
): boolean {
  if (!message.trim()) return false;
  if (amend) return true;
  return stagedCount + unstagedCount > 0;
}

/**
 * Whether commit must stage everything first (VS Code smart commit: nothing
 * staged → stage all changes, including untracked, then commit). When the
 * user has staged a subset, only that subset commits — never auto-widen.
 */
export function needsAutoStage(
  stagedCount: number,
  unstagedCount: number,
  amend: boolean,
): boolean {
  if (amend) return false;
  return stagedCount === 0 && unstagedCount > 0;
}
