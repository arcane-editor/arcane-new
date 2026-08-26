/** Files rendered by the markdown preview. */
export function isMarkdownPath(name: string): boolean {
  return /\.mdx?$/i.test(name);
}

/**
 * Plan documents written by plan mode.
 *
 * `.aplan` is markdown inside — the executor reads it as text and the preview
 * renders it as markdown — but it carries its own extension so a plan can be
 * recognized as a plan by name alone. That is what earns it the step view
 * instead of a prose render, and it means a plan stays a plan wherever the
 * user moves it, rather than only inside the folder that produced it.
 *
 * Legacy `.md` plans under `.unityide/plans/` still open as plans: they were
 * written before the extension existed, they parse identically, and silently
 * demoting them to prose would take the Execute button away from work already
 * planned. That clause is matched on the DIRECTORY, so a user's own `plan.md`
 * elsewhere in the project stays an ordinary markdown file.
 *
 * Separator-insensitive: `plan-files.ts` builds these paths with `/`, but a
 * Windows path reaching here from elsewhere may carry `\`.
 */
export function isPlanPath(path: string): boolean {
  if (/\.aplan$/i.test(path)) return true;
  return /[/\\]\.unityide[/\\]plans[/\\][^/\\]+\.md$/i.test(path);
}
