import { describe, it, expect } from 'bun:test';
import {
  createServerConfigStore,
  effectiveContextWindow,
  allowedEfforts,
  maxAllowedEffort,
  shouldPreplanTier,
  inlineAllowed,
  acpAllowed,
  type ServerConfig,
} from './server-config';

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The exact /v1/config shape from the task brief.
const VALID_CONFIG: ServerConfig = {
  plan: 'pro',
  planLabel: 'Pro',
  features: { inline: true, acp: true, topups: true },
  tiers: [
    { id: 'low', label: 'Standard', description: '…', allowed: true, hasPreplanning: false, contextWindow: 131_072, pricingCliffTokens: null },
    { id: 'mid', label: 'Deep Think', description: '…', allowed: true, hasPreplanning: true, contextWindow: 131_072, pricingCliffTokens: 200_000 },
    { id: 'high', label: 'Max', description: '…', allowed: false, hasPreplanning: true, contextWindow: 131_072, pricingCliffTokens: 200_000 },
  ],
};

function storeWith(
  fetchImpl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
  getToken: () => string | null = () => 'tok',
) {
  return createServerConfigStore({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    getToken,
    baseUrl: 'https://x.test',
  });
}

describe('useServerConfigStore.refresh', () => {
  it('populates config on a successful 2xx response', async () => {
    const store = storeWith(async () => ok(VALID_CONFIG));
    await store.getState().refresh();
    expect(store.getState().config).toEqual(VALID_CONFIG);
  });

  it('is a no-op (never calls fetch) without a token', async () => {
    let called = false;
    const store = storeWith(async () => {
      called = true;
      return ok(VALID_CONFIG);
    }, () => null);
    await store.getState().refresh();
    expect(called).toBe(false);
    expect(store.getState().config).toBeNull();
  });

  it('keeps the previous config on a non-2xx response (never clears on transient failure)', async () => {
    let fail = false;
    const store = storeWith(async () => (fail ? ok({ error: 'server error' }, 500) : ok(VALID_CONFIG)));
    await store.getState().refresh();
    expect(store.getState().config).toEqual(VALID_CONFIG);

    fail = true;
    await store.getState().refresh();
    expect(store.getState().config).toEqual(VALID_CONFIG);
  });

  it('keeps the previous config on a network error', async () => {
    let throwNext = false;
    const store = storeWith(async () => {
      if (throwNext) throw new TypeError('network fail');
      return ok(VALID_CONFIG);
    });
    await store.getState().refresh();
    expect(store.getState().config).toEqual(VALID_CONFIG);

    throwNext = true;
    await store.getState().refresh();
    expect(store.getState().config).toEqual(VALID_CONFIG);
  });

  it('keeps the previous config on a malformed body (missing fields)', async () => {
    let malformed = false;
    const store = storeWith(async () => (malformed ? ok({ plan: 'pro' }) : ok(VALID_CONFIG)));
    await store.getState().refresh();
    expect(store.getState().config).toEqual(VALID_CONFIG);

    malformed = true;
    await store.getState().refresh();
    expect(store.getState().config).toEqual(VALID_CONFIG);
  });

  it('rejects a tiers array that is not exactly the 3 expected ids', async () => {
    const store = storeWith(async () => ok({ ...VALID_CONFIG, tiers: VALID_CONFIG.tiers.slice(0, 2) }));
    await store.getState().refresh();
    expect(store.getState().config).toBeNull();
  });

  it('rejects a non-JSON body', async () => {
    const store = storeWith(
      async () => new Response('not json', { status: 200 }),
    );
    await store.getState().refresh();
    expect(store.getState().config).toBeNull();
  });
});

describe('useServerConfigStore.clear', () => {
  it('empties the config', async () => {
    const store = storeWith(async () => ok(VALID_CONFIG));
    await store.getState().refresh();
    expect(store.getState().config).not.toBeNull();

    store.getState().clear();
    expect(store.getState().config).toBeNull();
  });
});

describe('effectiveContextWindow', () => {
  it('uses the per-tier config value when present', () => {
    expect(effectiveContextWindow(VALID_CONFIG, 'mid')).toBe(131_072);
  });

  // Mirrors TIER_CONTEXT_WINDOWS in features/ai-panel/services/types.ts —
  // the duplicate these two files deliberately keep in step (see that file's
  // header). Both moved off spark's flat 131k on 2026-08-27, and off grok's
  // 500k mid planner on 2026-08-30.
  it('falls back to the hardcoded offline window when config is null', () => {
    expect(effectiveContextWindow(null, 'low')).toBe(1_048_576);
    expect(effectiveContextWindow(null, 'mid')).toBe(1_048_576);
    expect(effectiveContextWindow(null, 'high')).toBe(400_000);
  });
});

describe('allowedEfforts', () => {
  it('uses the config tiers marked allowed when present and the plan matches', () => {
    // VALID_CONFIG: plan 'pro', low+mid allowed, high not.
    expect(allowedEfforts(VALID_CONFIG, 'pro')).toEqual(['low', 'mid']);
  });

  it('falls back to the offline plan ladder (all efforts up to the ceiling) when config is null', () => {
    expect(allowedEfforts(null, 'free')).toEqual(['low']);
    expect(allowedEfforts(null, 'starter')).toEqual(['low']);
    expect(allowedEfforts(null, 'pro')).toEqual(['low', 'mid']);
    expect(allowedEfforts(null, 'max')).toEqual(['low', 'mid', 'high']);
    expect(allowedEfforts(null, null)).toEqual(['low']);
    expect(allowedEfforts(null, 'garbage')).toEqual(['low']);
  });

  it('trusts a present config when plan is null (no independent signal to contradict it)', () => {
    expect(allowedEfforts(VALID_CONFIG, null)).toEqual(['low', 'mid']);
  });

  it('treats a stale config (fetched under a since-downgraded plan) as unknown and falls back', () => {
    // config.plan is still 'max' (allows all 3), but the caller's independently
    // -sourced plan (e.g. from a fresh /v1/usage) says 'free' — the downgrade
    // this store's fire-and-forget refresh() hasn't caught up with yet.
    const staleMaxConfig: ServerConfig = { ...VALID_CONFIG, plan: 'max' };
    expect(allowedEfforts(staleMaxConfig, 'free')).toEqual(['low']);
  });
});

describe('maxAllowedEffort', () => {
  it('picks the highest allowed tier from config when the plan matches', () => {
    expect(maxAllowedEffort(VALID_CONFIG, 'pro')).toBe('mid');
  });

  it('falls back to the offline plan ceiling when config is null', () => {
    expect(maxAllowedEffort(null, 'free')).toBe('low');
    expect(maxAllowedEffort(null, 'pro')).toBe('mid');
    expect(maxAllowedEffort(null, 'max')).toBe('high');
    expect(maxAllowedEffort(null, 'proplus')).toBe('low');
  });

  it('trusts a present config when plan is null', () => {
    expect(maxAllowedEffort(VALID_CONFIG, null)).toBe('mid');
  });

  it('a stale max-plan config does not outlive a downgrade to free (the bricked-escalation case)', () => {
    const staleMaxConfig: ServerConfig = { ...VALID_CONFIG, plan: 'max' };
    expect(maxAllowedEffort(staleMaxConfig, 'free')).toBe('low');
  });
});

describe('shouldPreplanTier', () => {
  it('uses the config value when present', () => {
    expect(shouldPreplanTier(VALID_CONFIG, 'low')).toBe(false);
    expect(shouldPreplanTier(VALID_CONFIG, 'mid')).toBe(true);
    expect(shouldPreplanTier(VALID_CONFIG, 'high')).toBe(true);
  });

  it('falls back to effort !== "low" when config is null', () => {
    expect(shouldPreplanTier(null, 'low')).toBe(false);
    expect(shouldPreplanTier(null, 'mid')).toBe(true);
    expect(shouldPreplanTier(null, 'high')).toBe(true);
  });
});

describe('inlineAllowed', () => {
  it('uses the config value when present and the plan matches', () => {
    expect(inlineAllowed(VALID_CONFIG, 'pro')).toBe(true);
    expect(
      inlineAllowed({ ...VALID_CONFIG, features: { ...VALID_CONFIG.features, inline: false } }, 'pro'),
    ).toBe(false);
  });

  it('unknown (no config yet) fails OPEN — a startup race must not blank completions', () => {
    expect(inlineAllowed(null, 'pro')).toBe(true);
  });

  it('trusts a present config when plan is null', () => {
    expect(inlineAllowed(VALID_CONFIG, null)).toBe(true);
  });

  it('a stale config from a since-downgraded plan is treated as unknown (fails OPEN, not the stale value)', () => {
    const staleMaxConfig: ServerConfig = { ...VALID_CONFIG, plan: 'max', features: { ...VALID_CONFIG.features, inline: false } };
    // Stale config says inline:false for 'max', but the account is really
    // 'free' now — the mismatch discards it rather than trusting either the
    // stale true or the stale false.
    expect(inlineAllowed(staleMaxConfig, 'free')).toBe(true);
  });
});

describe('acpAllowed', () => {
  it('uses the config value when present and the plan matches', () => {
    expect(acpAllowed(VALID_CONFIG, 'pro')).toBe(true);
    expect(
      acpAllowed({ ...VALID_CONFIG, features: { ...VALID_CONFIG.features, acp: false } }, 'pro'),
    ).toBe(false);
  });

  it('unknown (no config yet) fails CLOSED — null, not true', () => {
    expect(acpAllowed(null, 'pro')).toBeNull();
  });

  it('trusts a present config when plan is null', () => {
    expect(acpAllowed(VALID_CONFIG, null)).toBe(true);
  });

  it('a stale config from a since-downgraded plan is treated as unknown (fails CLOSED)', () => {
    const staleMaxConfig: ServerConfig = { ...VALID_CONFIG, plan: 'max' };
    expect(acpAllowed(staleMaxConfig, 'free')).toBeNull();
  });
});
