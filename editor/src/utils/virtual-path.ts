/**
 * Tab paths that name something other than a file on disk. Anything that
 * reads, writes, watches, re-opens or language-server-syncs a tab must skip
 * these — there is no file behind them.
 *
 * Note this is NOT the same predicate as `shouldPersistTab` in
 * `persistence.ts`, which deliberately persists `diff://unstaged/...` while
 * refusing `diff://commit/...`. Keep the two separate.
 */
export const VIRTUAL_SCHEMES = ['diff://', 'auth://', 'search://'] as const;

export function isVirtualPath(path: string): boolean {
  return VIRTUAL_SCHEMES.some((scheme) => path.startsWith(scheme));
}
