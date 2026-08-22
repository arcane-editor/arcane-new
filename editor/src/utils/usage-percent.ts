/**
 * Percent of a plan's monthly credit grant that has been spent, as a clamped
 * integer 0-100 — the ONLY shape this codebase surfaces AI usage in
 * user-facing UI (owner directive: never a raw credit number). Editor-side
 * sibling of the landing site's `usagePercent` (`landing-page/src/lib/billing.ts`)
 * — same idea, deliberately DIFFERENT edge-case contract (see below), so the
 * two are independent rather than shared.
 *
 * `null` = cannot be computed — `grant` is 0 (or the account's plan wasn't
 * found in the tier ladder at all, which callers also pass in as 0; see
 * `features/auth/services/plan-grants.ts`) AND there's still a positive
 * balance left. There is nothing to divide by, and a balance above zero with
 * no grant to measure it against is not "0% used" — it's unknown — so hiding
 * the figure is less misleading than guessing. The ONE grant-0 case this
 * still resolves is "balance is also exhausted": whatever the grant was, 0
 * or 4235, a balance at or below zero really is 100% used.
 *
 * A `planBalance` above `grant` (a race that briefly overcredits) or below 0
 * (a race that overdrafts) both clamp into range rather than reporting a
 * nonsensical negative or >100% figure.
 */
export function usagePercent(grant: number, planBalance: number): number | null {
  if (grant <= 0) return planBalance <= 0 ? 100 : null;
  const pct = Math.round((100 * (grant - planBalance)) / grant);
  return Math.max(0, Math.min(100, pct));
}
