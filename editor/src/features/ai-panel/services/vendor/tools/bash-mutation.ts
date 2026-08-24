/**
 * Does this shell command look like it changes files?
 *
 * Every write-side guarantee in this app is wired to the `write`/`edit` tools:
 * checkpoints (`checkpoint-gate.ts`), the compile and analyzer gates, and the
 * closing verified pass all wrap those two and nothing else. `bash` bypasses all
 * of them, so a `sed -i` or a `> File.cs` lands with:
 *
 *   - no checkpoint pre-image, so "Restore this turn" silently misses it;
 *   - no compile/analyzer round, so a broken script is not caught;
 *   - no entry in the verified pass's touched-file list.
 *
 * Containing that properly needs a backend guard; this makes it HONEST, which
 * is the same rule the compile gate follows — never let a degraded path look
 * like a clean one.
 *
 * Deliberately over-eager: a false positive costs one advisory line, a false
 * negative costs the user a restore they thought they had.
 */

/** Commands that modify the filesystem when run at all. */
const MUTATING_COMMANDS = [
  'rm',
  'rmdir',
  'mv',
  'cp',
  'mkdir',
  'touch',
  'ln',
  'chmod',
  'chown',
  'truncate',
  'dd',
  'tee',
  'install',
  'patch',
  'unzip',
  'tar',
];

/** Sub-commands of `git` that rewrite the working tree. */
const MUTATING_GIT = ['checkout', 'reset', 'clean', 'apply', 'restore', 'stash', 'revert', 'merge'];

/** Strip quoted spans so a `>` or an `rm` inside a string literal is not counted. */
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * Returns a short human-readable reason when the command looks mutating, or
 * `null` when it looks read-only.
 */
export function detectBashMutation(command: string): string | null {
  const bare = stripQuoted(command);

  // Output redirection to a file. `2>&1`, `>&2` and process substitution are fd
  // plumbing, not file writes, so they are excluded.
  const redirect = /(^|[^0-9&>])>>?\s*(?![&(])/.test(bare);
  if (redirect) return 'redirects output into a file';

  // Tokenize on shell separators so `foo && rm -rf x` is caught, and a flag
  // like `--remove` is not mistaken for `rm`.
  const segments = bare.split(/(?:\|\||&&|[|;&\n])+/);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    // Skip a leading env assignment or `sudo`.
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]) || words[i] === 'sudo')) i++;
    const head = (words[i] ?? '').split('/').pop() ?? '';

    if (MUTATING_COMMANDS.includes(head)) return `runs \`${head}\``;

    if (head === 'git' && words.slice(i + 1).some((w) => MUTATING_GIT.includes(w))) {
      return 'runs a `git` command that rewrites the working tree';
    }

    // In-place editors: the `-i` flag is what makes them write.
    if ((head === 'sed' || head === 'perl' || head === 'ruby') &&
        words.slice(i + 1).some((w) => w === '-i' || w.startsWith('-i.'))) {
      return `runs \`${head} -i\` (edits files in place)`;
    }
  }

  return null;
}

/** The advisory appended to a mutating command's result. */
export function bashMutationNote(reason: string): string {
  return (
    `[Note] This command ${reason}, so any file it changed is NOT covered by this turn's ` +
    `checkpoint and was NOT compile-checked or analyzer-checked — those apply to the write ` +
    `and edit tools only. Use write/edit for source changes you want checkpointed and verified.`
  );
}
