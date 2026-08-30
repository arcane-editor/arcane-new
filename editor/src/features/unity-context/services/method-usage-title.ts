/**
 * Method-level usage summary for the asset-usage CodeLens.
 *
 * A LEAF module: `usage-codelens.ts` imports stores that touch `document` at
 * module-eval time and so cannot be pulled into a bun test. Same split as
 * `stores/debug-variables.ts`.
 */

/** One Inspector-wired UnityEvent call into a script. */
export interface MethodUsage {
  methodName: string;
  path: string;
  gameObject: string | null;
  targetType: string | null;
}

/**
 * Summarise the methods a script is wired to from prefabs and scenes.
 *
 * The file-level count alone ("Used in 3 prefabs") never says WHICH method is
 * wired, so renaming a handler looks safe right up until the button stops
 * working. Naming the methods is the whole point of the method-level index.
 */
export function formatMethodTitle(usages: MethodUsage[]): string {
  if (usages.length === 0) return '';
  const names = [...new Set(usages.map((u) => u.methodName))].sort();
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  const suffix = rest > 0 ? ` +${rest} more` : '';
  return `wired to ${shown}${suffix}`;
}
