/**
 * Auth-ish substrings from git's stderr when a fetch/pull/push failed because
 * of missing or invalid credentials, as opposed to a network, ref, or merge
 * error. `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND=... -oBatchMode=yes`
 * (set in `run_git_remote` on the Rust side) make git fail fast with one of
 * these instead of hanging on an interactive prompt.
 */
const AUTH_ERROR_SUBSTRINGS = [
  'Authentication failed',
  'could not read Username',
  'terminal prompts disabled',
  'Permission denied (publickey)',
] as const;

/** True when `stderr` (from a failed fetch/pull/push) indicates missing or invalid git credentials. */
export function isAuthError(stderr: string): boolean {
  return AUTH_ERROR_SUBSTRINGS.some((needle) => stderr.includes(needle));
}

/** Actionable hint shown in place of raw git stderr for auth failures. */
export const AUTH_ERROR_HINT =
  'authentication required — set up a credential helper or SSH key';

/**
 * Build the user-facing message for a failed remote git operation
 * (fetch/pull/push). Auth-ish stderr is replaced with an actionable hint so
 * the user knows what to do next; every other error is passed through
 * verbatim (unchanged behavior) so genuine failures (rejected non-fast-
 * forward, network unreachable, merge conflicts, …) still surface git's own
 * message.
 */
export function remoteErrorMessage(opLabel: string, stderr: string): string {
  return isAuthError(stderr)
    ? `${opLabel} failed: ${AUTH_ERROR_HINT}`
    : `${opLabel} failed: ${stderr}`;
}
