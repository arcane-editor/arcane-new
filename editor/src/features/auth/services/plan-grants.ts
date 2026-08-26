/**
 * Public-endpoint client for the subscription tier ladder (`GET
 * /v1/billing/plans`) — the ONE place a plan's monthly credit *grant* lives.
 * `/v1/usage` (the auth store's own `authClient.fetchUsage`) carries the
 * current BALANCE, never what it's measured against, so turning a balance
 * into a usage PERCENTAGE (`utils/usage-percent.ts`) needs this too.
 *
 * Factory (follows `createInlineClient`/`createServerConfigStore`'s pattern)
 * so tests can inject a fake fetch without touching the real network or the
 * auth store. The tier ladder is small, public, effectively-static config, so
 * it's fetched AT MOST ONCE per process and cached forever on success; a
 * failure clears the in-flight promise so the next call retries instead of
 * staying poisoned for the rest of the session.
 */
import { API_URL } from '../../../config/api';

interface PlanGrantsClientConfig {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function createPlanGrantsClient(cfg: PlanGrantsClientConfig = {}) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const baseUrl = cfg.baseUrl ?? API_URL;

  let grants: Record<string, number> | null = null;
  let inflight: Promise<Record<string, number>> | null = null;

  function load(): Promise<Record<string, number>> {
    if (grants) return Promise.resolve(grants);
    if (!inflight) {
      inflight = (async () => {
        const res = await fetchImpl(`${baseUrl}/v1/billing/plans`);
        if (!res.ok) throw new Error(`Billing plans fetch failed (${res.status})`);
        const body = (await res.json()) as { tiers?: Array<Record<string, unknown>> };
        const map: Record<string, number> = {};
        for (const t of body.tiers ?? []) {
          if (typeof t.id === 'string' && typeof t.monthlyCredits === 'number') map[t.id] = t.monthlyCredits;
        }
        grants = map;
        return map;
      })().catch((err: unknown) => {
        inflight = null; // let the NEXT call retry rather than staying poisoned
        throw err;
      });
    }
    return inflight;
  }

  return {
    /**
     * This plan's monthly credit grant.
     *
     * `null` = could not be determined yet — the fetch is still in flight or
     * it failed — callers must hide the usage figure rather than guess.
     *
     * `0` = fetched successfully but this plan id isn't in the ladder
     * (unknown/legacy plan). `usagePercent`'s own `grant <= 0` handling folds
     * that into the same "nothing to measure against" case a genuine
     * zero-grant tier would hit, so callers can treat the two identically.
     */
    async getGrant(plan: string): Promise<number | null> {
      try {
        const map = await load();
        return map[plan] ?? 0;
      } catch {
        return null;
      }
    },
  };
}

export const planGrantsClient = createPlanGrantsClient();
