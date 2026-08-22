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

  it('falls back to the hardcoded offline window when config is null', () => {
    expect(effectiveContextWindow(null, 'low')).toBe(131_072);
    expect(effectiveContextWindow(null, 'mid')).toBe(131_072);
    expect(effectiveContextWindow(null, 'high')).toBe(131_072);
  });
});

describe('allowedEfforts', () => {
  it('uses the config tiers marked allowed when present', () => {
    // VALID_CONFIG: low+mid allowed, high not.
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
});

describe('maxAllowedEffort', () => {
  it('picks the highest allowed tier from config', () => {
    expect(maxAllowedEffort(VALID_CONFIG, 'pro')).toBe('mid');
  });

  it('falls back to the offline plan ceiling when config is null', () => {
    expect(maxAllowedEffort(null, 'free')).toBe('low');
    expect(maxAllowedEffort(null, 'pro')).toBe('mid');
    expect(maxAllowedEffort(null, 'max')).toBe('high');
    expect(maxAllowedEffort(null, 'proplus')).toBe('low');
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
  it('uses the config value when present', () => {
    expect(inlineAllowed(VALID_CONFIG)).toBe(true);
    expect(
      inlineAllowed({ ...VALID_CONFIG, features: { ...VALID_CONFIG.features, inline: false } }),
    ).toBe(false);
  });

  it('unknown (no config yet) fails OPEN — a startup race must not blank completions', () => {
    expect(inlineAllowed(null)).toBe(true);
  });
});

describe('acpAllowed', () => {
  it('uses the config value when present', () => {
    expect(acpAllowed(VALID_CONFIG)).toBe(true);
    expect(
      acpAllowed({ ...VALID_CONFIG, features: { ...VALID_CONFIG.features, acp: false } }),
    ).toBe(false);
  });

  it('unknown (no config yet) fails CLOSED — null, not true', () => {
    expect(acpAllowed(null)).toBeNull();
  });
});
