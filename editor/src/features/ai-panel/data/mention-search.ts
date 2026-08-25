/**
 * Ranking for the `@` mention picker.
 *
 * Extracted from `MentionPopover` because the scoring it had inline was
 * quietly unusable. It read:
 *
 *   if (bn.startsWith(q)) score = 100 - bn.length;
 *   else if (bn.includes(q)) score = 50 - bn.length;
 *   else if (rp.includes(q)) score = 25 - rp.length;
 *   if (score >= 0) scored.push(...)
 *
 * The intent — "shorter is a better match" — is right, but subtracting a raw
 * length from a tier base of 25 collapses into the `>= 0` guard: any file whose
 * relative path is longer than 25 characters scores negative and is DROPPED.
 * A real path like
 * `student-ui/src/.../Counselling/SOP/index.tsx` is 85 characters, so typing
 * `@SOP/index.tsx` matched nothing at all. Path search only ever worked for
 * files sitting within 25 characters of the workspace root.
 *
 * Here the tiers are spaced far enough apart that the length tiebreak can order
 * matches WITHIN a tier without ever demoting one out of it, and "no match" is
 * `null` rather than a negative number that has to be filtered by arithmetic.
 */

/** Tier bases. The gap exceeds any filesystem path length, so tiers never cross. */
const TIER_NAME_PREFIX = 3_000_000;
const TIER_NAME_SUBSTR = 2_000_000;
const TIER_PATH_SUBSTR = 1_000_000;

/** Windows-style separators, so a pasted path still matches a POSIX relPath. */
function normalize(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/**
 * Score one candidate against the query, or `null` when it does not match.
 * Higher is better; callers sort descending.
 */
export function scoreMentionMatch(
  query: string,
  basename: string,
  relPath: string,
): number | null {
  const q = normalize(query.trim());
  if (!q) return null;

  const bn = normalize(basename);
  const rp = normalize(relPath);

  if (bn.startsWith(q)) return TIER_NAME_PREFIX - bn.length;
  if (bn.includes(q)) return TIER_NAME_SUBSTR - bn.length;
  if (rp.includes(q)) return TIER_PATH_SUBSTR - rp.length;
  return null;
}
