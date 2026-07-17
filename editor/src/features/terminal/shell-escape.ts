/**
 * Quotes a filesystem path so a shell receives it as one literal argument.
 *
 * Used wherever the app types a path the user never typed — a dropped file, a
 * pasted image — which is exactly when the path is attacker-ish input: it can
 * contain spaces, quotes, `$(...)`, backticks, semicolons. Pasting those raw
 * into a live shell would execute them.
 *
 * Mirrors VS Code's `preparePathForShell` (`terminalEnvironment.ts`), minus its
 * per-shell branching: we always single-quote on POSIX, which suppresses every
 * form of expansion regardless of which shell is running, so no detection is
 * needed and nothing can be missed.
 */
export function escapePathForShell(path: string, platform: 'win32' | 'posix' = posixOrWin()): string {
  if (platform === 'win32') {
    // cmd and PowerShell share no quoting rules with POSIX and disagree with
    // each other; double-quoting is the common denominator, with embedded
    // quotes doubled.
    return `"${path.replace(/"/g, '""')}"`;
  }
  // A single-quoted POSIX string can contain anything except a single quote,
  // which has to be closed, backslash-escaped, and reopened.
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function posixOrWin(): 'win32' | 'posix' {
  return typeof navigator !== 'undefined' && navigator.platform.includes('Win')
    ? 'win32'
    : 'posix';
}
