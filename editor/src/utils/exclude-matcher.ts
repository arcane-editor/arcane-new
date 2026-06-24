/**
 * Lightweight glob matcher for file exclusion patterns.
 * Supports the subset of glob patterns used by VS Code's files.exclude:
 *   - `Library/**`      — matches directory named Library and all its contents
 *   - `**\/*.meta`      — matches any file ending in .meta at any depth
 *   - `*.sln`           — matches files matching the pattern
 *   - `.vs/**`          — matches hidden directory and its contents
 *
 * Matching is done against the entry's basename (name) — this matches
 * VS Code's behavior where `Library/**` hides any folder named "Library".
 */

function globToRegex(pattern: string): RegExp {
  // Escape regex special chars except * and ?
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** = match anything including slashes
        re += '.*';
        i += 2;
        // Skip following slash if present
        if (pattern[i] === '/') i++;
      } else {
        // * = match anything except slash
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$()|[]{}\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

export class ExcludeMatcher {
  private nameMatchers: RegExp[] = [];
  private extensionMatchers: RegExp[] = [];

  constructor(patterns: string[]) {
    for (const pattern of patterns) {
      // Normalize: strip trailing /** since we match against entry name
      const stripped = pattern.replace(/\/\*\*$/, '').replace(/^\*\*\//, '');

      if (stripped.startsWith('*.') || stripped.includes('*.')) {
        // Extension-style pattern
        this.extensionMatchers.push(globToRegex(stripped));
      } else {
        // Plain name pattern (possibly with wildcards)
        this.nameMatchers.push(globToRegex(stripped));
      }
    }
  }

  /** Returns true if the entry should be excluded. */
  matches(name: string): boolean {
    for (const re of this.nameMatchers) {
      if (re.test(name)) return true;
    }
    for (const re of this.extensionMatchers) {
      if (re.test(name)) return true;
    }
    return false;
  }
}
