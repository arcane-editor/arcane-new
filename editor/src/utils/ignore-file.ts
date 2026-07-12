/**
 * Whether a path is a git ignore-rules file (`.gitignore`/`.ignore`) — an
 * edit to one changes which tree entries should render dimmed.
 */
export function isIgnoreFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base === '.gitignore' || base === '.ignore';
}
