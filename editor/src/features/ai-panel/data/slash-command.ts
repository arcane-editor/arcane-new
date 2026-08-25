/**
 * Parsing the composer's leading `/command` query.
 *
 * Pulled out of `SlashTriggerPlugin` because the pattern it used was
 * `/^\/(\w*)$/`, and `\w` is `[A-Za-z0-9_]` — no `-`, no `:`. Every command an
 * agent actually advertises has at least one of them:
 * `superpowers:using-superpowers`, `frontend-design:frontend-design`,
 * `code-review:code-review`. So the popover opened on `/`, survived
 * `/using`, and then closed the moment the user typed the hyphen — after which
 * the text went out as an ordinary prompt the agent does not act on.
 *
 * The anchoring is the part that matters and is kept: the query is only a
 * command when it is the WHOLE composer content, so `/` mid-sentence (a path,
 * a date, a fraction) never opens the popover.
 */

/**
 * The command query when the composer holds exactly one leading `/token`, or
 * `null` when it does not. `/` alone yields `''`, which opens the full list.
 */
export function parseSlashQuery(fullText: string): string | null {
  const m = fullText.match(/^\/(\S*)$/);
  return m ? m[1] : null;
}
