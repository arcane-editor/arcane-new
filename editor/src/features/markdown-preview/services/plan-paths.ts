/** Files rendered by the markdown preview. */
export function isMarkdownPath(name: string): boolean {
  return /\.mdx?$/i.test(name);
}

/**
 * Plan documents written by plan mode, which live under
 * `<workspace>/.arcane/plans/`.
 *
 * Matched on the directory rather than the name so a user's own `plan.md`
 * elsewhere in the project opens as an ordinary markdown file — it has no
 * steps to execute and no session to attach suggestions to.
 *
 * Separator-insensitive: `plan-files.ts` builds these paths with `/`, but a
 * Windows path reaching here from elsewhere may carry `\`.
 */
export function isPlanPath(path: string): boolean {
  return /[/\\]\.arcane[/\\]plans[/\\][^/\\]+\.md$/i.test(path);
}
