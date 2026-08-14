# AI Model Routing and Credit Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AI tier map with a three-tier Standard/Deep Think/Max ladder on verified prices, move margin into an explicit per-request multiplier, gate paid tiers behind plans, and bound inline completions with a real spend ceiling.

**Architecture:** All models route through Cloudflare — Workers AI for `@cf/*` ids, unified billing for `openai/*` and `xai/*`. Every external-provider code path (custom `/compat` routing, per-provider secrets, fallback models) is deleted. Cost becomes `estimateCost × GATEWAY_FEE × MARGIN`, where `estimateCost` understands cached-input rates and long-context repricing cliffs.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1 (SQLite), Vitest (`@cloudflare/vitest-pool-workers`), React 19, Bun test, Astro.

**Spec:** `docs/superpowers/specs/2026-08-13-ai-model-routing-and-pricing-design.md`

## Global Constraints

- `GATEWAY_FEE = 1.05` — Cloudflare's 5% on prepaid AI Gateway credits.
- `MARGIN = 2.0` — platform markup. Effective multiplier on list price is **2.10**.
- Credits granted = `priceUsd × 100`. Free 150, Pro 2,000, Pro+ 5,000, Ultra 20,000.
- `MICRO_PER_CREDIT = 10_000` (unchanged). All money is integer micro-USD.
- Internal tier keys stay `low` / `mid` / `high`. Only display labels change.
- `super` is accepted on the wire and maps to `high`. Never 500 on it.
- Free plan may use `low` only.
- `noUncheckedIndexedAccess` is on — use `satisfies` plus explicit key types, never bare `Record<string, T>` lookups without a fallback.
- Third-party prices in this plan are **vendor list prices**. They are placeholders until confirmed against the Cloudflare dashboard (see Task 15).

---

## File Structure

**Server (`arcane-server/`)**
- `src/lib/costs.ts` — model catalog, cached + long-context aware `estimateCost`. Modify.
- `src/config/tiers.ts` — plans, grants, margin constants, inline ceilings, per-plan allowed tiers. Modify.
- `src/config/plans.ts` — tier→model map with display labels. Modify.
- `src/lib/usage.ts` — applies `GATEWAY_FEE × MARGIN` at debit time. Modify.
- `src/services/llm-router.ts` — external-routing deletion. Modify.
- `src/lib/inline-allowance.ts` — adds monthly micro-USD ceiling. Modify.
- `src/lib/fim.ts` — 600-token context clamp. Modify.
- `src/lib/db.ts` — new inline monthly-spend helpers. Modify.
- `migrations/0019_inline_spend.sql` — monthly micro-USD accumulator. Create.

**Editor (`editor/`)**
- `src/features/ai-panel/services/types.ts` — `Effort` type, `TIER_CONTEXT_WINDOWS`. Modify.
- `src/features/ai-panel/components/EffortSelector.tsx` — new labels. Modify.
- `src/features/ai-panel/services/arcane-stream.ts` — drop `fallback` event. Modify.

**Landing (`landing-page/`)**
- Pricing copy — credit counts and paid-tier badges. Modify.

---

## Phase 1 — Cost and margin foundation

### Task 1: Rewrite the model catalog with cached and long-context rates

**Files:**
- Modify: `arcane-server/src/lib/costs.ts`
- Test: `arcane-server/test/costs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MODEL_CATALOG`, `estimateCost(model: string, inputTokens: number, outputTokens: number, cachedTokens?: number): number`, `getMaxOutput(model: string): number`, `getContextWindow(model: string): number`.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `arcane-server/test/costs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG, estimateCost, getMaxOutput, getContextWindow } from '../src/lib/costs.ts';

describe('MODEL_CATALOG verified rates', () => {
    // Verbatim vendor rates. These are literal fixtures on purpose: an external
    // price table must fail loudly when someone "tidies" a number.
    it('gpt-5.6-luna', () => {
        const m = MODEL_CATALOG['openai/gpt-5.6-luna']!;
        expect(m.inputCostPer1M).toBe(0.20);
        expect(m.outputCostPer1M).toBe(1.20);
        expect(m.cachedInputCostPer1M).toBe(0.02);
        expect(m.contextWindow).toBe(1_050_000);
        expect(m.longContext!.thresholdTokens).toBe(272_000);
        expect(m.longContext!.inputCostPer1M).toBe(0.40);
        expect(m.longContext!.outputCostPer1M).toBe(1.80);
    });

    it('glm-5.2 has no long-context cliff', () => {
        const m = MODEL_CATALOG['@cf/zai-org/glm-5.2']!;
        expect(m.inputCostPer1M).toBe(1.40);
        expect(m.outputCostPer1M).toBe(4.40);
        expect(m.cachedInputCostPer1M).toBe(0.26);
        expect(m.contextWindow).toBe(262_144);
        expect(m.longContext).toBeUndefined();
    });

    it('grok-4.6', () => {
        const m = MODEL_CATALOG['xai/grok-4.6']!;
        expect(m.inputCostPer1M).toBe(2.00);
        expect(m.outputCostPer1M).toBe(6.00);
        expect(m.contextWindow).toBe(500_000);
        expect(m.longContext!.thresholdTokens).toBe(200_000);
        expect(m.longContext!.inputCostPer1M).toBe(4.00);
        expect(m.longContext!.outputCostPer1M).toBe(12.00);
        expect(m.longContext!.cachedInputCostPer1M).toBe(1.00);
    });

    it('glm-4.7-flash (inline)', () => {
        const m = MODEL_CATALOG['@cf/zai-org/glm-4.7-flash']!;
        expect(m.inputCostPer1M).toBe(0.06);
        expect(m.outputCostPer1M).toBe(0.40);
        expect(m.contextWindow).toBe(131_072);
    });
});

describe('estimateCost', () => {
    it('bills cached tokens at the cached rate', () => {
        // 10k fresh + 20k cached + 2k out on glm-5.2
        const cost = estimateCost('@cf/zai-org/glm-5.2', 30_000, 2_000, 20_000);
        // (10_000 * 1.40 + 20_000 * 0.26 + 2_000 * 4.40) / 1e6
        expect(cost).toBeCloseTo(0.028, 10);
    });

    it('treats inputTokens as inclusive of cachedTokens', () => {
        const all = estimateCost('@cf/zai-org/glm-5.2', 30_000, 0, 0);
        const some = estimateCost('@cf/zai-org/glm-5.2', 30_000, 0, 30_000);
        expect(all).toBeCloseTo(0.042, 10);
        expect(some).toBeCloseTo(0.0078, 10);
    });

    it('bills standard rates one token below the threshold', () => {
        const cost = estimateCost('xai/grok-4.6', 200_000, 1_000, 0);
        expect(cost).toBeCloseTo((200_000 * 2.00 + 1_000 * 6.00) / 1e6, 10);
    });

    it('rebills the ENTIRE request at long-context rates above the threshold', () => {
        const cost = estimateCost('xai/grok-4.6', 200_001, 1_000, 0);
        expect(cost).toBeCloseTo((200_001 * 4.00 + 1_000 * 12.00) / 1e6, 10);
    });

    it('applies long-context cached rate above the threshold', () => {
        const cost = estimateCost('xai/grok-4.6', 300_000, 1_000, 100_000);
        // 200k fresh @4.00 + 100k cached @1.00 + 1k out @12.00
        expect(cost).toBeCloseTo((200_000 * 4.00 + 100_000 * 1.00 + 1_000 * 12.00) / 1e6, 10);
    });

    it('returns 0 for an unknown model', () => {
        expect(estimateCost('nope/nope', 1000, 1000, 0)).toBe(0);
    });
});

describe('lookups', () => {
    it('getContextWindow falls back to 32768', () => {
        expect(getContextWindow('xai/grok-4.6')).toBe(500_000);
        expect(getContextWindow('nope/nope')).toBe(32_768);
    });

    it('getMaxOutput falls back to 8192', () => {
        expect(getMaxOutput('nope/nope')).toBe(8192);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd arcane-server && npx vitest run test/costs.test.ts`
Expected: FAIL — `cachedInputCostPer1M` undefined, `getContextWindow` not exported, `estimateCost` takes 3 args.

- [ ] **Step 3: Rewrite `src/lib/costs.ts`**

```typescript
// Model catalog for the AI tier ladder. Rates are VENDOR LIST PRICES verified
// 2026-08-13 (see the design doc). Two things make this non-trivial:
//
//  1. Cached input. Every frontier model prices a cache hit far below a fresh
//     token (glm-5.2: $0.26 vs $1.40). `estimateCost` bills them separately.
//  2. Long-context repricing. Some models reprice the ENTIRE request once the
//     input crosses a threshold — a cliff, not a gradient. A 200,001-token
//     Grok request costs double a 200,000-token one.
//
// `@cf/*` ids bill as Workers AI; everything else bills as a third-party model
// through AI Gateway unified billing. Third-party rates are set by the SERVING
// provider and are dashboard-only — confirm them before trusting these numbers.

export interface LongContextRates {
    /** Total input tokens above which the whole request reprices. */
    thresholdTokens: number;
    inputCostPer1M: number;
    outputCostPer1M: number;
    cachedInputCostPer1M: number;
}

export interface ModelInfo {
    route: 'workers-ai' | 'unified';
    inputCostPer1M: number;
    outputCostPer1M: number;
    cachedInputCostPer1M: number;
    contextWindow: number;
    maxOutput: number;
    longContext?: LongContextRates;
}

export const MODEL_CATALOG: Record<string, ModelInfo> = {
    // Standard — day-to-day coding. Coding Agent Index #6.
    'openai/gpt-5.6-luna': {
        route: 'unified',
        inputCostPer1M: 0.20, outputCostPer1M: 1.20, cachedInputCostPer1M: 0.02,
        contextWindow: 1_050_000, maxOutput: 128_000,
        // Above 272k input OpenAI reprices at $0.40/$1.80. The long-context
        // CACHED rate is not published; 0.04 mirrors the 2x input scaling and
        // is the conservative assumption. Verify before relying on it.
        longContext: {
            thresholdTokens: 272_000,
            inputCostPer1M: 0.40, outputCostPer1M: 1.80, cachedInputCostPer1M: 0.04,
        },
    },
    // Deep Think — extended reasoning. Terminal-Bench 2.1 leader (81.0%).
    // Flat pricing: the only tier with no long-context cliff, which makes it
    // the correct choice for genuinely large-context work.
    '@cf/zai-org/glm-5.2': {
        route: 'workers-ai',
        inputCostPer1M: 1.40, outputCostPer1M: 4.40, cachedInputCostPer1M: 0.26,
        contextWindow: 262_144, maxOutput: 32_000,
    },
    // Max — frontier intelligence. Above 200k the whole request reprices.
    'xai/grok-4.6': {
        route: 'unified',
        // No sub-threshold cached rate is published; charging cache hits at the
        // full input rate over-estimates, which is the safe direction.
        inputCostPer1M: 2.00, outputCostPer1M: 6.00, cachedInputCostPer1M: 2.00,
        contextWindow: 500_000, maxOutput: 64_000,
        longContext: {
            thresholdTokens: 200_000,
            inputCostPer1M: 4.00, outputCostPer1M: 12.00, cachedInputCostPer1M: 1.00,
        },
    },
    // Inline (tab) completions.
    '@cf/zai-org/glm-4.7-flash': {
        route: 'workers-ai',
        inputCostPer1M: 0.06, outputCostPer1M: 0.40, cachedInputCostPer1M: 0.06,
        contextWindow: 131_072, maxOutput: 8_192,
    },
    // Documented rollback for inline if glm-4.7-flash's reasoning tokens make
    // tab latency unusable. FIM-trained, 8.4x more expensive per suggestion.
    '@cf/qwen/qwen2.5-coder-32b-instruct': {
        route: 'workers-ai',
        inputCostPer1M: 0.66, outputCostPer1M: 1.00, cachedInputCostPer1M: 0.66,
        contextWindow: 32_768, maxOutput: 8_192,
    },
    // Embeddings. Input-only; embeddings never generate.
    '@cf/baai/bge-small-en-v1.5': {
        route: 'workers-ai',
        inputCostPer1M: 0.02, outputCostPer1M: 0.00, cachedInputCostPer1M: 0.02,
        contextWindow: 512, maxOutput: 0,
    },
};

const DEFAULT_MAX_OUTPUT = 8192;
const DEFAULT_CONTEXT_WINDOW = 32768;

export function getMaxOutput(model: string): number {
    return MODEL_CATALOG[model]?.maxOutput ?? DEFAULT_MAX_OUTPUT;
}

export function getContextWindow(model: string): number {
    return MODEL_CATALOG[model]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Estimated list cost in USD for one request.
 *
 * `inputTokens` is the TOTAL prompt size and is inclusive of `cachedTokens`;
 * the fresh portion is `inputTokens - cachedTokens`. When a model defines
 * `longContext` and `inputTokens` exceeds its threshold, the entire request —
 * fresh, cached and output alike — bills at the long-context rates.
 *
 * An unknown model costs 0 (and is therefore never debited).
 */
export function estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0,
): number {
    const info = MODEL_CATALOG[model];
    if (!info) return 0;

    const rates = info.longContext && inputTokens > info.longContext.thresholdTokens
        ? info.longContext
        : info;

    const cached = Math.min(Math.max(cachedTokens, 0), Math.max(inputTokens, 0));
    const fresh = Math.max(inputTokens, 0) - cached;

    return (fresh / 1_000_000) * rates.inputCostPer1M
         + (cached / 1_000_000) * rates.cachedInputCostPer1M
         + (Math.max(outputTokens, 0) / 1_000_000) * rates.outputCostPer1M;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd arcane-server && npx vitest run test/costs.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `cd arcane-server && npx tsc --noEmit`
Expected: errors only in files not yet updated (`usage.ts`, `llm-router.ts`, `plans.ts`). Those are fixed in Tasks 2–5.

- [ ] **Step 6: Commit**

```bash
git add arcane-server/src/lib/costs.ts arcane-server/test/costs.test.ts
git commit -m "feat(costs): verified rates with cached and long-context pricing"
```

---

### Task 2: Margin constants, grants, and per-plan tier access

**Files:**
- Modify: `arcane-server/src/config/tiers.ts`
- Test: `arcane-server/test/tiers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GATEWAY_FEE`, `MARGIN`, `TIERS`, `TierId`, `INLINE_DAILY_CAP`, `INLINE_MONTHLY_MICRO_CEILING`, `ALLOWED_TIERS`, `isTierAllowed(planId: string, tier: string): boolean`, plus the existing `creditsToMicro` / `microToCredits` / `usdToMicro` / `tierGrantMicro`.

- [ ] **Step 1: Write the failing tests**

Create `arcane-server/test/tiers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
    TIERS, MARGIN, GATEWAY_FEE, TOPUP_PACKS,
    INLINE_DAILY_CAP, INLINE_MONTHLY_MICRO_CEILING,
    isTierAllowed, tierGrantMicro,
} from '../src/config/tiers.ts';

describe('margin constants', () => {
    it('are the values the design underwrites', () => {
        expect(GATEWAY_FEE).toBe(1.05);
        expect(MARGIN).toBe(2.0);
    });
});

describe('grants', () => {
    it('are exactly plan price x 100', () => {
        for (const tier of Object.values(TIERS)) {
            if (tier.priceUsd > 0) expect(tier.monthlyCredits).toBe(tier.priceUsd * 100);
        }
        expect(TIERS.free.monthlyCredits).toBe(150);
    });

    it('tierGrantMicro converts credits to micro-USD', () => {
        expect(tierGrantMicro('pro')).toBe(2_000 * 10_000);
        expect(tierGrantMicro('unknown')).toBe(150 * 10_000);
    });
});

// The margin floor is the number the business is underwritten on. Both Dodo
// rate cases, both budgets fully burned.
describe('margin invariant at full burn', () => {
    const DODO = { us: { pct: 0.045, flat: 0.40 }, intl: { pct: 0.06, flat: 0.40 } };

    for (const [region, fee] of Object.entries(DODO)) {
        for (const tier of Object.values(TIERS)) {
            if (tier.priceUsd === 0) continue;
            it(`${tier.id} clears 30% net on ${region} cards`, () => {
                const net = tier.priceUsd - tier.priceUsd * fee.pct - fee.flat;
                const chatCogs = (tier.monthlyCredits / 100) / MARGIN;
                const inlineCogs = INLINE_MONTHLY_MICRO_CEILING[tier.id as keyof typeof INLINE_MONTHLY_MICRO_CEILING] / 1_000_000;
                const margin = (net - chatCogs - inlineCogs) / tier.priceUsd;
                expect(margin).toBeGreaterThanOrEqual(0.30);
            });
        }
    }
});

describe('inline budgets', () => {
    it('free gets $1, paid gets 10% of plan price', () => {
        expect(INLINE_MONTHLY_MICRO_CEILING.free).toBe(1_000_000);
        expect(INLINE_MONTHLY_MICRO_CEILING.pro).toBe(2_000_000);
        expect(INLINE_MONTHLY_MICRO_CEILING.proplus).toBe(5_000_000);
        expect(INLINE_MONTHLY_MICRO_CEILING.ultra).toBe(20_000_000);
    });

    it('daily caps ration the monthly budget across ~30 days', () => {
        for (const plan of ['free', 'pro', 'proplus', 'ultra'] as const) {
            const monthly = INLINE_MONTHLY_MICRO_CEILING[plan];
            const daily = INLINE_DAILY_CAP[plan];
            // 30 days at the cap must not undershoot the budget, nor exceed it
            // by more than 10% (caps are rounded up to clean numbers).
            const perSuggestionMicro = 54.6;
            const monthlyAtCap = daily * 30 * perSuggestionMicro;
            expect(monthlyAtCap).toBeGreaterThan(monthly * 0.9);
            expect(monthlyAtCap).toBeLessThan(monthly * 1.1);
        }
    });
});

describe('tier access', () => {
    it('free may only use low', () => {
        expect(isTierAllowed('free', 'low')).toBe(true);
        expect(isTierAllowed('free', 'mid')).toBe(false);
        expect(isTierAllowed('free', 'high')).toBe(false);
    });

    it('paid plans may use every tier', () => {
        for (const plan of ['pro', 'proplus', 'ultra']) {
            for (const tier of ['low', 'mid', 'high']) {
                expect(isTierAllowed(plan, tier)).toBe(true);
            }
        }
    });

    it('treats an unknown plan as free', () => {
        expect(isTierAllowed('nonsense', 'mid')).toBe(false);
        expect(isTierAllowed('nonsense', 'low')).toBe(true);
    });

    it('maps the legacy super value onto high', () => {
        expect(isTierAllowed('pro', 'super')).toBe(true);
        expect(isTierAllowed('free', 'super')).toBe(false);
    });
});

describe('top-up packs', () => {
    it('price a credit identically to plans', () => {
        for (const pack of TOPUP_PACKS) {
            expect(pack.credits).toBe(pack.priceUsd * 100);
        }
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd arcane-server && npx vitest run test/tiers.test.ts`
Expected: FAIL — `MARGIN`, `GATEWAY_FEE`, `INLINE_MONTHLY_MICRO_CEILING`, `isTierAllowed` are not exported.

- [ ] **Step 3: Update `src/config/tiers.ts`**

Replace `SAFETY_BUFFER` and the tier/pack/inline blocks. Keep `CREDIT_USD`, `MICRO_PER_USD`, `MICRO_PER_CREDIT`, `creditsToMicro`, `microToCredits`, `usdToMicro`, `isTierId` exactly as they are.

```typescript
/** Cloudflare's fee on prepaid AI Gateway credits (5%). Applied to every AI
 *  request because gateway credits fund both Workers AI and third-party spend. */
export const GATEWAY_FEE = 1.05;

/** Platform markup, applied per request at debit time. This is where margin
 *  lives — NOT in grant sizing. A model price change moves debits with it, so
 *  margin holds without anyone re-deriving a buffer. */
export const MARGIN = 2.0;

export interface Tier {
    id: string;
    name: string;
    priceUsd: number;
    monthlyCredits: number;
    dodoProductVar?: string;
    order: number;
}

// Grants are exactly priceUsd * 100 — "$20 buys $20 of credits". Margin comes
// entirely from MARGIN at debit time.
export const TIERS = {
    free:    { id: 'free',    name: 'Free',  priceUsd: 0,   monthlyCredits: 150,    order: 0 },
    pro:     { id: 'pro',     name: 'Pro',   priceUsd: 20,  monthlyCredits: 2000,   dodoProductVar: 'DODO_PRODUCT_PRO',     order: 1 },
    proplus: { id: 'proplus', name: 'Pro+',  priceUsd: 50,  monthlyCredits: 5000,   dodoProductVar: 'DODO_PRODUCT_PROPLUS', order: 2 },
    ultra:   { id: 'ultra',   name: 'Ultra', priceUsd: 200, monthlyCredits: 20000,  dodoProductVar: 'DODO_PRODUCT_ULTRA',   order: 3 },
} satisfies Record<string, Tier>;

export type TierId = keyof typeof TIERS;

/** Which effort tiers each plan may request. Deep Think and Max are paid. */
export const ALLOWED_TIERS: Record<TierId, readonly string[]> = {
    free:    ['low'],
    pro:     ['low', 'mid', 'high'],
    proplus: ['low', 'mid', 'high'],
    ultra:   ['low', 'mid', 'high'],
};

/** Legacy wire value `super` is an alias of `high`. */
export function isTierAllowed(planId: string, tier: string): boolean {
    const plan = (isTierId(planId) ? planId : 'free') as TierId;
    const normalized = tier === 'super' ? 'high' : tier;
    return ALLOWED_TIERS[plan].includes(normalized);
}

/** Monthly inline spend ceiling in micro-USD of REAL cost (no margin — inline
 *  is free to the user). Free $1; paid plans 10% of plan price. */
export const INLINE_MONTHLY_MICRO_CEILING: Record<TierId, number> = {
    free: 1_000_000, pro: 2_000_000, proplus: 5_000_000, ultra: 20_000_000,
};

/** Daily suggestion caps, derived from the monthly budget / 30 and rounded to
 *  a clean number. These ration the budget across the month; the micro-USD
 *  ceiling above is the hard backstop, because a request count does not bound
 *  cost — cost scales with context size. */
export const INLINE_DAILY_CAP: Record<TierId, number> = {
    free: 600, pro: 1200, proplus: 3000, ultra: 12000,
};

export const TOPUP_PACKS: TopupPack[] = [
    { id: 'topup_1600', credits: 1600, priceUsd: 16, dodoProductVar: 'DODO_PRODUCT_TOPUP_1600' },
    { id: 'topup_7500', credits: 7500, priceUsd: 75, dodoProductVar: 'DODO_PRODUCT_TOPUP_7500' },
];
```

Delete the `SAFETY_BUFFER` export and its comment block.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd arcane-server && npx vitest run test/tiers.test.ts`
Expected: PASS.

- [ ] **Step 5: Find and fix remaining SAFETY_BUFFER references**

Run: `cd arcane-server && grep -rn "SAFETY_BUFFER" src/ test/`
Expected: no matches. If any remain, delete them — the constant no longer exists.

- [ ] **Step 6: Commit**

```bash
git add arcane-server/src/config/tiers.ts arcane-server/test/tiers.test.ts
git commit -m "feat(tiers): explicit margin multiplier, price x100 grants, tier gating"
```

---

### Task 3: Apply margin at debit time

**Files:**
- Modify: `arcane-server/src/lib/usage.ts`
- Test: `arcane-server/test/usage.test.ts`

**Interfaces:**
- Consumes: `estimateCost` (Task 1), `GATEWAY_FEE` / `MARGIN` (Task 2).
- Produces: `recordUsage(db, userId, model, inputTokens, outputTokens, durationMs, extras)` — unchanged signature; `UsageExtras.cachedInputTokens` now feeds cost.

- [ ] **Step 1: Add the failing tests**

Append to `arcane-server/test/usage.test.ts`:

```typescript
import { billedMicro } from '../src/lib/usage.ts';

describe('billedMicro', () => {
    it('applies gateway fee and margin to the list cost', () => {
        // glm-5.2, 10k fresh + 20k cached + 2k out = $0.028 list
        // 0.028 * 1.05 * 2.0 = $0.0588 -> 58800 micro
        expect(billedMicro('@cf/zai-org/glm-5.2', 30_000, 2_000, 20_000)).toBe(58_800);
    });

    it('rounds to an integer micro-USD', () => {
        const micro = billedMicro('openai/gpt-5.6-luna', 8_000, 800, 0);
        expect(Number.isInteger(micro)).toBe(true);
        // 0.00256 * 2.10 = 0.005376 -> 5376
        expect(micro).toBe(5_376);
    });

    it('is 0 for an unknown model so it is never debited', () => {
        expect(billedMicro('nope/nope', 1_000, 1_000, 0)).toBe(0);
    });

    it('charges long-context rates above the cliff', () => {
        const below = billedMicro('xai/grok-4.6', 200_000, 1_000, 0);
        const above = billedMicro('xai/grok-4.6', 200_001, 1_000, 0);
        expect(above).toBeGreaterThan(below * 1.9);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd arcane-server && npx vitest run test/usage.test.ts`
Expected: FAIL — `billedMicro` is not exported.

- [ ] **Step 3: Update `src/lib/usage.ts`**

Change the import line and the body of `recordUsage`, and export the new helper:

```typescript
import { estimateCost } from './costs.ts';
import { upsertUsagePeriod, createRequestLog, getCurrentPeriodStart, getNextPeriodStart, debitCredits } from './db.ts';
import { usdToMicro, GATEWAY_FEE, MARGIN } from '../config/tiers.ts';

/**
 * What the user is charged, in integer micro-USD: the model's list cost,
 * uplifted by Cloudflare's gateway fee and the platform margin. Exported so
 * the arithmetic is testable independently of D1.
 */
export function billedMicro(
    model: string, inputTokens: number, outputTokens: number, cachedTokens = 0,
): number {
    const list = estimateCost(model, inputTokens, outputTokens, cachedTokens);
    return usdToMicro(list * GATEWAY_FEE * MARGIN);
}
```

Then in `recordUsage`, replace the first two lines of the body:

```typescript
    const cachedTokens = extras.cachedInputTokens ?? 0;
    const cost = estimateCost(model, inputTokens, outputTokens, cachedTokens);
    const micro = billedMicro(model, inputTokens, outputTokens, cachedTokens);
```

`cost` still feeds `upsertUsagePeriod` and `createRequestLog` (those record real cost); `micro` is what `debitCredits` receives. Update the docblock's last sentence to:

```
 * Debit is `estimateCost x GATEWAY_FEE x MARGIN` — margin lives here, per
 * request, so an upstream price change moves it automatically.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd arcane-server && npx vitest run test/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add arcane-server/src/lib/usage.ts arcane-server/test/usage.test.ts
git commit -m "feat(usage): debit at list cost x gateway fee x margin"
```

---

## Phase 2 — Model ladder

### Task 4: Three-tier config with display labels

**Files:**
- Modify: `arcane-server/src/config/plans.ts`
- Test: `arcane-server/test/model-catalog.test.ts`

**Interfaces:**
- Consumes: `MODEL_CATALOG` (Task 1).
- Produces: `Intensity = 'low' | 'mid' | 'high'`, `INTENSITY_CONFIG: Record<Intensity, {model, label, description}>`, `INLINE_MODEL`, `getIntensityConfig(level: string)`.

- [ ] **Step 1: Replace the tier assertions in `test/model-catalog.test.ts`**

```typescript
import { INTENSITY_CONFIG, INLINE_MODEL, getIntensityConfig } from '../src/config/plans.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';

describe('INTENSITY_CONFIG', () => {
    it('maps each tier to its model', () => {
        expect(INTENSITY_CONFIG.low.model).toBe('openai/gpt-5.6-luna');
        expect(INTENSITY_CONFIG.mid.model).toBe('@cf/zai-org/glm-5.2');
        expect(INTENSITY_CONFIG.high.model).toBe('xai/grok-4.6');
    });

    it('carries user-facing labels', () => {
        expect(INTENSITY_CONFIG.low.label).toBe('Standard');
        expect(INTENSITY_CONFIG.mid.label).toBe('Deep Think');
        expect(INTENSITY_CONFIG.high.label).toBe('Max');
    });

    it('uses glm-4.7-flash for inline', () => {
        expect(INLINE_MODEL).toBe('@cf/zai-org/glm-4.7-flash');
    });
});

describe('getIntensityConfig', () => {
    it('accepts the legacy super value and returns high', () => {
        expect(getIntensityConfig('super')).toBe(INTENSITY_CONFIG.high);
    });

    it('returns undefined for an unknown level', () => {
        expect(getIntensityConfig('turbo')).toBeUndefined();
    });
});

// Guard A1: a tier pointing at a model with no catalog entry silently bills $0.
describe('catalog guard', () => {
    it('every routed model exists in MODEL_CATALOG', () => {
        for (const cfg of Object.values(INTENSITY_CONFIG)) {
            expect(MODEL_CATALOG[cfg.model], `missing catalog entry: ${cfg.model}`).toBeDefined();
        }
        expect(MODEL_CATALOG[INLINE_MODEL]).toBeDefined();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd arcane-server && npx vitest run test/model-catalog.test.ts`
Expected: FAIL — models still point at MiniMax/Moonshot ids; `label` mismatch.

- [ ] **Step 3: Rewrite `src/config/plans.ts`**

```typescript
// ─── Effort tiers (model routing per reasoning level) ────
//
// THE single source of truth for which model each tier maps to. The editor
// sends an abstract `reasoningLevel` (low|mid|high); model choice happens here.
//
// Every model routes through Cloudflare: `@cf/*` ids bill as Workers AI,
// `openai/*` and `xai/*` bill as third-party via AI Gateway unified billing.
// There is no external-provider path and no fallback model — one provider
// means an outage takes every tier down together, so a fallback map could
// not help.
//
// Internal keys stay low/mid/high; only the labels are user-facing. The
// legacy `super` wire value maps to `high` (see getIntensityConfig).

export type Intensity = 'low' | 'mid' | 'high';

export interface IntensityConfig {
    model: string;
    label: string;
    description: string;
}

export const INTENSITY_CONFIG: Record<Intensity, IntensityConfig> = {
    low: {
        model: 'openai/gpt-5.6-luna',
        label: 'Standard',
        description: 'Day-to-day coding',
    },
    mid: {
        model: '@cf/zai-org/glm-5.2',
        label: 'Deep Think',
        description: 'Extended reasoning for tricky problems',
    },
    high: {
        model: 'xai/grok-4.6',
        label: 'Max',
        description: 'Maximum capability for complex work',
    },
};

/** Model for inline (tab) completions — cheap, large context, Workers AI. */
export const INLINE_MODEL = '@cf/zai-org/glm-4.7-flash';

/** Default tier when the client sends none. Standard is where most users stay. */
export const DEFAULT_INTENSITY: Intensity = 'low';

export function getIntensityConfig(level: string): IntensityConfig | undefined {
    // `super` predates the three-tier ladder; older editor builds still send it.
    const normalized = level === 'super' ? 'high' : level;
    return INTENSITY_CONFIG[normalized as Intensity];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd arcane-server && npx vitest run test/model-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add arcane-server/src/config/plans.ts arcane-server/test/model-catalog.test.ts
git commit -m "feat(plans): Standard/Deep Think/Max ladder on Cloudflare-only routes"
```

---

### Task 5: Delete external-provider routing

**Files:**
- Modify: `arcane-server/src/services/llm-router.ts`
- Modify: `arcane-server/src/types.ts` (drop the `fallback` StreamEvent variant)
- Test: `arcane-server/test/llm-router.test.ts`

**Interfaces:**
- Consumes: `getMaxOutput` (Task 1).
- Produces: `workersAiProvider(env, gatewayOverrides?)`, `resolveModel(modelId, env, gatewayOverrides?)`, `convertMessages`, `convertTools`, `classifyStreamError(error): StreamErrorCode`, `streamCompletion(req, env, streamTextImpl?)`. `LlmEnv` narrows to `WorkersAiEnv`.

- [ ] **Step 1: Rewrite `test/llm-router.test.ts`**

Delete every test referencing `isExternalModel`, `externalApiKey`, `gatewayCompatUrl`, `fallbackModelFor`, `shouldFallback`, or `LlmConfigError`. Replace with:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveModel, classifyStreamError } from '../src/services/llm-router.ts';

const ENV = { AI: {} as Ai, CF_AI_GATEWAY_ID: 'gw' };

describe('resolveModel', () => {
    it('resolves Workers AI ids through the binding', () => {
        expect(resolveModel('@cf/zai-org/glm-5.2', ENV).modelId).toBe('@cf/zai-org/glm-5.2');
    });

    it('resolves unified-billing ids through the same binding', () => {
        expect(resolveModel('openai/gpt-5.6-luna', ENV).modelId).toBe('openai/gpt-5.6-luna');
        expect(resolveModel('xai/grok-4.6', ENV).modelId).toBe('xai/grok-4.6');
    });
});

describe('classifyStreamError', () => {
    it('maps a 429 status to rate_limit', () => {
        expect(classifyStreamError({ statusCode: 429 })).toBe('rate_limit');
    });

    it('maps Workers AI internal capacity codes to rate_limit', () => {
        expect(classifyStreamError(new Error('error 3036: capacity'))).toBe('rate_limit');
    });

    it('falls back to model_error', () => {
        expect(classifyStreamError(new Error('boom'))).toBe('model_error');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd arcane-server && npx vitest run test/llm-router.test.ts`
Expected: FAIL — `classifyStreamError` still requires a second `externalModel` argument.

- [ ] **Step 3: Edit `src/services/llm-router.ts`**

Delete these exports entirely: `ExternalRoutingEnv`, `LlmConfigError`, `isExternalModel`, `externalApiKey`, `gatewayCompatUrl`, `FALLBACK_MODEL`, `fallbackModelFor`, `shouldFallback`. Remove the `createOpenAICompatible` import.

Replace `LlmEnv`, `resolveModel`, `classifyStreamError`, and the two stream functions:

```typescript
export type LlmEnv = WorkersAiEnv;

export function resolveModel(modelId: string, env: LlmEnv, gatewayOverrides?: GatewayOverrides) {
    // Workers AI and unified-billing third-party models both resolve through
    // the AI binding — the id prefix is the only difference and the binding
    // handles routing.
    return workersAiProvider(env, gatewayOverrides)(modelId);
}

export type StreamErrorCode = 'rate_limit' | 'model_error';

// Workers AI binding errors are normalized by workers-ai-provider into an
// APICallError whose `statusCode` carries the mapped HTTP status (internal
// codes 3036/3040 -> 429), so check that first — the stringified message
// never contains "429".
export function classifyStreamError(error: unknown): StreamErrorCode {
    const status = typeof error === 'object' && error !== null
        ? (error as { statusCode?: number }).statusCode
        : undefined;
    if (status === 429) return 'rate_limit';
    return /rate limit|\b3036\b|\b3040\b|capacity/i.test(String(error)) ? 'rate_limit' : 'model_error';
}

export async function* streamCompletion(
    req: ChatCompletionRequest, env: LlmEnv, streamTextImpl: StreamTextFn = streamText,
): AsyncGenerator<StreamEvent> {
    // A cached replay of a sampled completion is semantically wrong — chat is
    // temperature-sampled, so bypass the gateway cache on this path.
    const model = resolveModel(req.model, env, { skipCache: true });
    const messages = convertMessages(req.messages);
    const tools = convertTools(req.tools);
    const maxOutputTokens = Math.min(req.max_tokens ?? 8192, getMaxOutput(req.model));

    const result = streamTextImpl({
        model, messages, ...(tools ? { tools } : {}),
        maxOutputTokens, temperature: req.temperature,
    });

    for await (const part of result.fullStream) {
        switch (part.type) {
            case 'text-delta':
                yield { type: 'text', content: part.text };
                break;
            case 'tool-call':
                yield {
                    type: 'tool_call', id: part.toolCallId, name: part.toolName,
                    arguments: JSON.stringify(part.input), finished: true,
                };
                break;
            case 'finish':
                yield {
                    type: 'usage',
                    input_tokens: part.totalUsage.inputTokens ?? 0,
                    output_tokens: part.totalUsage.outputTokens ?? 0,
                    cached_input_tokens: part.totalUsage.inputTokenDetails.cacheReadTokens ?? 0,
                };
                break;
            case 'reasoning-delta':
                yield { type: 'thinking', thought: part.text, signature: '' };
                break;
            case 'error':
                yield { type: 'error', code: classifyStreamError(part.error), message: String(part.error) };
                break;
        }
    }
}
```

Delete the now-unused `streamOnce` function and the `yieldedContent` / `allowFallback` machinery.

In `src/types.ts`, delete the `{ type: 'fallback'; model: string }` variant from the `StreamEvent` union.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd arcane-server && npx vitest run test/llm-router.test.ts && npx tsc --noEmit`
Expected: PASS, and typecheck clean. If `chat.ts` referenced the `fallback` event or `fallbackModel` extra, remove those branches.

- [ ] **Step 5: Verify no dead references remain**

Run: `cd arcane-server && grep -rn "fallbackModel\|isExternalModel\|LlmConfigError\|provider_rate_limit\|MINIMAX_API_KEY\|MOONSHOT_API_KEY" src/ test/`
Expected: no matches outside `migrations/` (the `request_logs.fallback_model` column stays for historical rows).

- [ ] **Step 6: Commit**

```bash
git add arcane-server/src/services/llm-router.ts arcane-server/src/types.ts arcane-server/test/llm-router.test.ts
git commit -m "refactor(router): delete external-provider routing and fallbacks"
```

---

### Task 6: Gate Deep Think and Max behind paid plans

**Files:**
- Modify: `arcane-server/src/routes/chat.ts`
- Test: `arcane-server/test/tier-gate.test.ts`

**Interfaces:**
- Consumes: `isTierAllowed` (Task 2), `getIntensityConfig` (Task 4), `getUserBillingRow` (existing, `src/lib/db.ts`).
- Produces: HTTP 403 `{ error, code: 'tier_not_available', requiredPlan: 'pro' }` for a disallowed tier.

- [ ] **Step 1: Write the failing test**

Create `arcane-server/test/tier-gate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isTierAllowed } from '../src/config/tiers.ts';
import { getIntensityConfig } from '../src/config/plans.ts';

// The gate is pure policy — exercised here directly so it is covered even
// though the test env has no AI binding for a full chat round-trip.
describe('tier gate policy', () => {
    it('blocks free users from Deep Think and Max', () => {
        expect(isTierAllowed('free', 'mid')).toBe(false);
        expect(isTierAllowed('free', 'high')).toBe(false);
    });

    it('lets free users use Standard', () => {
        expect(isTierAllowed('free', 'low')).toBe(true);
    });

    it('resolves the tier before gating so super is gated as high', () => {
        const cfg = getIntensityConfig('super');
        expect(cfg?.label).toBe('Max');
        expect(isTierAllowed('free', 'super')).toBe(false);
        expect(isTierAllowed('pro', 'super')).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd arcane-server && npx vitest run test/tier-gate.test.ts`
Expected: PASS already if Task 2 landed — this test pins the policy. If it fails, Task 2 is incomplete.

- [ ] **Step 3: Wire the gate into `src/routes/chat.ts`**

Immediately after the user is resolved and before `checkAiBudget`, insert:

```typescript
import { isTierAllowed } from '../config/tiers.ts';
import { getUserBillingRow } from '../lib/db.ts';

// ...inside the handler, after `const userId = parseInt(user.sub)`:
const billing = await getUserBillingRow(c.env.arcane_db, userId);
const plan = billing?.plan ?? 'free';
const requestedTier = body.reasoningLevel ?? 'low';
if (!isTierAllowed(plan, requestedTier)) {
    return c.json({
        error: 'Deep Think and Max are available on paid plans.',
        code: 'tier_not_available',
        requiredPlan: 'pro',
    }, 403);
}
```

- [ ] **Step 4: Run the full server suite**

Run: `cd arcane-server && npx vitest run && npx tsc --noEmit`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add arcane-server/src/routes/chat.ts arcane-server/test/tier-gate.test.ts
git commit -m "feat(chat): gate Deep Think and Max behind paid plans"
```

---

## Phase 3 — Inline spend ceiling

### Task 7: Migration and DB helpers for monthly inline spend

**Files:**
- Create: `arcane-server/migrations/0019_inline_spend.sql`
- Modify: `arcane-server/src/lib/db.ts`
- Test: `arcane-server/test/inline-spend.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `addInlineSpend(db, userId, monthKey, micro): Promise<number>` returning the new cumulative total, and `getInlineSpend(db, userId, monthKey): Promise<number>`.

- [ ] **Step 1: Write the migration**

Create `arcane-server/migrations/0019_inline_spend.sql`:

```sql
-- Monthly inline (tab) completion spend, in integer micro-USD of REAL cost
-- (no margin — inline is free to the user). A daily request-count cap cannot
-- bound cost because cost scales with FIM context size, so this is the hard
-- backstop that does.
CREATE TABLE IF NOT EXISTS inline_spend (
    user_id     INTEGER NOT NULL,
    month_key   TEXT    NOT NULL,  -- 'YYYY-MM', UTC
    spend_micro INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month_key)
);

CREATE INDEX IF NOT EXISTS idx_inline_spend_month ON inline_spend(month_key);
```

- [ ] **Step 2: Write the failing test**

Create `arcane-server/test/inline-spend.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { addInlineSpend, getInlineSpend } from '../src/lib/db.ts';
import { utcMonthKey } from '../src/lib/inline-allowance.ts';

describe('inline spend accumulator', () => {
    it('starts at zero', async () => {
        expect(await getInlineSpend(env.arcane_db, 9001, '2026-08')).toBe(0);
    });

    it('accumulates and returns the running total', async () => {
        expect(await addInlineSpend(env.arcane_db, 9002, '2026-08', 100)).toBe(100);
        expect(await addInlineSpend(env.arcane_db, 9002, '2026-08', 55)).toBe(155);
        expect(await getInlineSpend(env.arcane_db, 9002, '2026-08')).toBe(155);
    });

    it('scopes by month', async () => {
        await addInlineSpend(env.arcane_db, 9003, '2026-08', 500);
        expect(await getInlineSpend(env.arcane_db, 9003, '2026-09')).toBe(0);
    });

    it('utcMonthKey formats as YYYY-MM', () => {
        expect(utcMonthKey(new Date('2026-08-14T23:59:59Z'))).toBe('2026-08');
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd arcane-server && npx vitest run test/inline-spend.test.ts`
Expected: FAIL — `addInlineSpend` is not exported.

- [ ] **Step 4: Add the helpers to `src/lib/db.ts`**

```typescript
/** Add to this month's inline spend and return the new cumulative total. */
export async function addInlineSpend(
    db: D1Database, userId: number, monthKey: string, micro: number,
): Promise<number> {
    const row = await db.prepare(
        `INSERT INTO inline_spend (user_id, month_key, spend_micro)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, month_key)
         DO UPDATE SET spend_micro = spend_micro + ?3
         RETURNING spend_micro`,
    ).bind(userId, monthKey, micro).first<{ spend_micro: number }>();
    return row?.spend_micro ?? 0;
}

export async function getInlineSpend(
    db: D1Database, userId: number, monthKey: string,
): Promise<number> {
    const row = await db.prepare(
        'SELECT spend_micro FROM inline_spend WHERE user_id = ?1 AND month_key = ?2',
    ).bind(userId, monthKey).first<{ spend_micro: number }>();
    return row?.spend_micro ?? 0;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd arcane-server && npx vitest run test/inline-spend.test.ts`
Expected: PASS. `apply-migrations.ts` auto-applies new migration files in the test harness.

- [ ] **Step 6: Commit**

```bash
git add arcane-server/migrations/0019_inline_spend.sql arcane-server/src/lib/db.ts arcane-server/test/inline-spend.test.ts
git commit -m "feat(db): monthly inline spend accumulator"
```

---

### Task 8: Enforce the monthly inline ceiling

**Files:**
- Modify: `arcane-server/src/lib/inline-allowance.ts`
- Test: `arcane-server/test/inline-allowance.test.ts`

**Interfaces:**
- Consumes: `INLINE_DAILY_CAP` / `INLINE_MONTHLY_MICRO_CEILING` (Task 2), `addInlineSpend` / `getInlineSpend` (Task 7).
- Produces: `utcMonthKey(now?)`, `nextUtcMonth(now?)`, and an extended `InlineAllowanceResult` with a `402 inline_budget_exhausted` variant.

- [ ] **Step 1: Write the failing test**

Create `arcane-server/test/inline-allowance.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { checkInlineAllowance, utcMonthKey, nextUtcMonth } from '../src/lib/inline-allowance.ts';
import { addInlineSpend } from '../src/lib/db.ts';
import { INLINE_MONTHLY_MICRO_CEILING } from '../src/config/tiers.ts';

const NOW = new Date('2026-08-14T12:00:00Z');

describe('monthly ceiling', () => {
    it('allows a user under budget', async () => {
        const r = await checkInlineAllowance(env.arcane_db, 8101, NOW);
        expect(r.ok).toBe(true);
    });

    it('blocks with 402 once the month budget is spent', async () => {
        await addInlineSpend(env.arcane_db, 8102, utcMonthKey(NOW), INLINE_MONTHLY_MICRO_CEILING.free);
        const r = await checkInlineAllowance(env.arcane_db, 8102, NOW);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.status).toBe(402);
            expect(r.code).toBe('inline_budget_exhausted');
            expect(r.resetAt).toBe(nextUtcMonth(NOW));
        }
    });

    it('the ceiling is checked before the daily counter is incremented', async () => {
        // A user at their monthly ceiling must not have a daily slot consumed.
        await addInlineSpend(env.arcane_db, 8103, utcMonthKey(NOW), INLINE_MONTHLY_MICRO_CEILING.free);
        const first = await checkInlineAllowance(env.arcane_db, 8103, NOW);
        const second = await checkInlineAllowance(env.arcane_db, 8103, NOW);
        expect(first.ok).toBe(false);
        expect(second.ok).toBe(false);
    });

    it('nextUtcMonth rolls the year over in December', () => {
        expect(nextUtcMonth(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01T00:00:00.000Z');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd arcane-server && npx vitest run test/inline-allowance.test.ts`
Expected: FAIL — `utcMonthKey` is not exported.

- [ ] **Step 3: Rewrite `src/lib/inline-allowance.ts`**

```typescript
// Allowance gate for POST /v1/completions/inline. Deliberately NOT
// checkAiBudget: inline completions are free (no credit debit) and exempt from
// the $1/hr cap. Two bounds apply, in this order:
//
//   1. A monthly micro-USD CEILING on real spend — the hard backstop, because
//      a request count does not bound cost (cost scales with FIM context).
//   2. A daily request cap that rations that budget across the month, so a
//      user cannot exhaust it in the first few days and face three dead weeks.
//
// The ceiling is checked first so a user already over budget never burns a
// daily slot.
import { getUserBillingRow, incrementInlineUsage, getInlineSpend } from './db.ts';
import { INLINE_DAILY_CAP, INLINE_MONTHLY_MICRO_CEILING, type TierId } from '../config/tiers.ts';

export type InlineAllowanceResult =
    | { ok: true; count: number }
    | { ok: false; status: 429; code: 'inline_quota'; error: string; resetAt: string }
    | { ok: false; status: 402; code: 'inline_budget_exhausted'; error: string; resetAt: string };

export function utcDateKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

export function utcMonthKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 7);
}

export function nextUtcMidnight(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export function nextUtcMonth(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export async function checkInlineAllowance(
    db: D1Database, userId: number, now: Date = new Date(),
): Promise<InlineAllowanceResult> {
    const row = await getUserBillingRow(db, userId);
    const plan = (row?.plan ?? 'free') as TierId;

    const ceiling = INLINE_MONTHLY_MICRO_CEILING[plan] ?? INLINE_MONTHLY_MICRO_CEILING.free;
    const spent = await getInlineSpend(db, userId, utcMonthKey(now));
    if (spent >= ceiling) {
        return {
            ok: false, status: 402, code: 'inline_budget_exhausted',
            error: 'Tab completions for this month are used up. They reset at the start of next month.',
            resetAt: nextUtcMonth(now),
        };
    }

    const cap = INLINE_DAILY_CAP[plan] ?? INLINE_DAILY_CAP.free;
    const count = await incrementInlineUsage(db, userId, utcDateKey(now));
    if (count > cap) {
        return {
            ok: false, status: 429, code: 'inline_quota',
            error: `Daily completion limit reached (${cap}/day on your plan). Suggestions resume at midnight UTC.`,
            resetAt: nextUtcMidnight(now),
        };
    }
    return { ok: true, count };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd arcane-server && npx vitest run test/inline-allowance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add arcane-server/src/lib/inline-allowance.ts arcane-server/test/inline-allowance.test.ts
git commit -m "feat(inline): monthly micro-USD spend ceiling"
```

---

### Task 9: Clamp FIM context and record inline spend

**Files:**
- Modify: `arcane-server/src/lib/fim.ts`
- Modify: `arcane-server/src/routes/inline.ts`
- Test: `arcane-server/test/fim.test.ts`

**Interfaces:**
- Consumes: `billedMicro` is NOT used here — inline records real cost via `estimateCost × GATEWAY_FEE`. Consumes `addInlineSpend` (Task 7), `utcMonthKey` (Task 8).
- Produces: `FIM_MAX_PREFIX_CHARS = 1600`, `FIM_MAX_SUFFIX_CHARS = 800`.

- [ ] **Step 1: Add the failing test**

Append to `arcane-server/test/fim.test.ts`:

```typescript
import { clampInlineRequest, FIM_MAX_PREFIX_CHARS, FIM_MAX_SUFFIX_CHARS } from '../src/lib/fim.ts';

describe('FIM context clamp', () => {
    it('clamps to ~600 tokens total', () => {
        // ~4 chars/token: 1600 + 800 = 2400 chars ~= 600 tokens.
        expect(FIM_MAX_PREFIX_CHARS).toBe(1600);
        expect(FIM_MAX_SUFFIX_CHARS).toBe(800);
        expect((FIM_MAX_PREFIX_CHARS + FIM_MAX_SUFFIX_CHARS) / 4).toBe(600);
    });

    it('keeps the prefix tail and the suffix head', () => {
        const r = clampInlineRequest({
            prefix: 'a'.repeat(5000) + 'TAIL',
            suffix: 'HEAD' + 'b'.repeat(5000),
            language: 'csharp',
        })!;
        expect(r.prefix.length).toBe(FIM_MAX_PREFIX_CHARS);
        expect(r.prefix.endsWith('TAIL')).toBe(true);
        expect(r.suffix.length).toBe(FIM_MAX_SUFFIX_CHARS);
        expect(r.suffix.startsWith('HEAD')).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd arcane-server && npx vitest run test/fim.test.ts`
Expected: FAIL — constants are still 4000 / 2000.

- [ ] **Step 3: Update the constants in `src/lib/fim.ts`**

```typescript
// Clamped to ~600 tokens total (~4 chars/token). Input dominates inline cost
// almost entirely, so this is the primary lever on tab-completion spend:
// dropping from 1500 to 600 tokens roughly triples the number of suggestions
// each plan's monthly budget buys.
export const FIM_MAX_PREFIX_CHARS = 1600;
export const FIM_MAX_SUFFIX_CHARS = 800;
```

- [ ] **Step 4: Record real inline spend in `src/routes/inline.ts`**

Add the imports:

```typescript
import { estimateCost } from '../lib/costs.ts';
import { GATEWAY_FEE, usdToMicro } from '../config/tiers.ts';
import { addInlineSpend, utcMonthKey } from '../lib/inline-allowance.ts';
```

`utcMonthKey` comes from `inline-allowance.ts`; `addInlineSpend` from `../lib/db.ts` — split the import accordingly.

Replace the `recordUsage` call block with:

```typescript
        const inputEstimate = Math.ceil((req.prefix.length + req.suffix.length) / 4);
        const outputEstimate = Math.ceil(text.length / 4);

        // Real cost only — no MARGIN. Inline is free to the user; this ceiling
        // exists to bound OUR spend, not to bill theirs.
        const realMicro = usdToMicro(
            estimateCost(INLINE_MODEL, inputEstimate, outputEstimate) * GATEWAY_FEE,
        );

        await Promise.all([
            recordUsage(c.env.arcane_db, userId, INLINE_MODEL, inputEstimate, outputEstimate,
                Date.now() - started, { taskType: 'inline', skipDebit: true }),
            addInlineSpend(c.env.arcane_db, userId, utcMonthKey(), realMicro)
                .catch(err => console.error('Failed to record inline spend:', err)),
        ]);
```

- [ ] **Step 5: Run the suite**

Run: `cd arcane-server && npx vitest run && npx tsc --noEmit`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add arcane-server/src/lib/fim.ts arcane-server/src/routes/inline.ts arcane-server/test/fim.test.ts
git commit -m "feat(inline): clamp FIM context to 600 tokens and meter real spend"
```

---

## Phase 4 — Editor

### Task 10: Effort type and context windows

**Files:**
- Modify: `editor/src/features/ai-panel/services/types.ts`
- Test: `editor/src/features/ai-panel/services/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Effort = 'low' | 'mid' | 'high'`, `TIER_CONTEXT_WINDOWS: Record<Effort, number>`.

- [ ] **Step 1: Rewrite the test**

Replace the `TIER_CONTEXT_WINDOWS` block in `editor/src/features/ai-panel/services/types.test.ts`:

```typescript
describe('TIER_CONTEXT_WINDOWS', () => {
  // These are PRICING cliffs, not model windows. Exceeding them reprices the
  // entire request, so compaction must treat them as hard limits.
  it('encodes each tier usable window', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(272_000);   // luna reprices above this
    expect(TIER_CONTEXT_WINDOWS.mid).toBe(262_144);   // glm-5.2, flat pricing
    expect(TIER_CONTEXT_WINDOWS.high).toBe(200_000);  // grok-4.6 reprices above this
  });

  it('has no super tier', () => {
    expect('super' in TIER_CONTEXT_WINDOWS).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd editor && bun test src/features/ai-panel/services/types.test.ts`
Expected: FAIL — values are 32768 / 200000 / 200000 / 200000.

- [ ] **Step 3: Update `types.ts`**

Change the `Effort` type to `'low' | 'mid' | 'high'` and replace the block:

```typescript
/**
 * Usable context per tier, in tokens.
 *
 * These are PRICING cliffs, not model windows. Two of the three models reprice
 * the ENTIRE request once input crosses a threshold — a 200,001-token Max
 * request costs double a 200,000-token one — so the economic limit is lower
 * than the model's advertised window and compaction must respect it:
 *   low  → openai/gpt-5.6-luna, window 1,050,000, reprices above 272,000
 *   mid  → @cf/zai-org/glm-5.2, window 262,144, FLAT pricing (no cliff)
 *   high → xai/grok-4.6,        window 500,000,   reprices above 200,000
 *
 * Note Max has the SMALLEST usable window. Deep Think is the correct tier for
 * genuinely large-context work despite sitting lower on the ladder.
 */
export const TIER_CONTEXT_WINDOWS: Record<Effort, number> = {
  low: 272_000,
  mid: 262_144,
  high: 200_000,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd editor && bun test src/features/ai-panel/services/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add editor/src/features/ai-panel/services/types.ts editor/src/features/ai-panel/services/types.test.ts
git commit -m "feat(editor): tier context windows track pricing cliffs"
```

---

### Task 11: Relabel the effort selector

**Files:**
- Modify: `editor/src/features/ai-panel/components/EffortSelector.tsx`

**Interfaces:**
- Consumes: `Effort` (Task 10).
- Produces: a selector rendering Standard / Deep Think / Max, defaulting to Standard.

- [ ] **Step 1: Read the current component**

Run: `cat editor/src/features/ai-panel/components/EffortSelector.tsx`
Note the existing option-array shape and styling so the edit matches local idiom.

- [ ] **Step 2: Replace the option list**

```typescript
const EFFORT_OPTIONS: ReadonlyArray<{ value: Effort; label: string; description: string }> = [
  { value: 'low',  label: 'Standard',    description: 'Day-to-day coding' },
  { value: 'mid',  label: 'Deep Think',  description: 'Extended reasoning for tricky problems' },
  { value: 'high', label: 'Max',         description: 'Maximum capability for complex work' },
];
```

Remove any `super` entry. Confirm the component's default value is `'low'`.

- [ ] **Step 3: Verify types and tests**

Run: `cd editor && npx tsc --noEmit && bun test`
Expected: PASS. Fix any `super` references the compiler surfaces.

- [ ] **Step 4: Commit**

```bash
git add editor/src/features/ai-panel/components/EffortSelector.tsx
git commit -m "feat(editor): Standard/Deep Think/Max effort labels"
```

---

### Task 12: Drop fallback and provider error handling

**Files:**
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts`
- Modify: the turn-errors module that maps `provider_*` codes

**Interfaces:**
- Consumes: nothing.
- Produces: stream handling with no `fallback` event and no `provider_*` codes; new handling for `tier_not_available` (403) and `inline_budget_exhausted` (402).

- [ ] **Step 1: Locate every reference**

Run: `cd editor && grep -rn "fallback\|provider_rate_limit\|provider_auth_failure\|provider_unavailable\|gateway_timeout" src/features/ai-panel/`

- [ ] **Step 2: Delete the `fallback` stream-event branch**

In `arcane-stream.ts`, remove the `case 'fallback':` branch and any state it set. Remove the `provider_*` entries from the error-code map, leaving `rate_limit` and `model_error`.

- [ ] **Step 3: Add the two new error codes**

In the same error mapping, add:

```typescript
  tier_not_available: 'Deep Think and Max are available on paid plans.',
  inline_budget_exhausted: 'Tab completions for this month are used up.',
```

Handle 403 `tier_not_available` like the existing 402 `credits_exhausted` path — surface it without retrying, and route it to the upgrade CTA rather than the out-of-credits CTA.

- [ ] **Step 4: Verify**

Run: `cd editor && npx tsc --noEmit && bun test && bun run check:modules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add editor/src/features/ai-panel/
git commit -m "refactor(editor): drop fallback events, add tier and inline-budget errors"
```

---

### Task 13: Match the client FIM clamp to the server

**Files:**
- Modify: the editor inline-suggest module that builds the FIM request (`editor/src/features/inline-suggest/`)

**Interfaces:**
- Consumes: nothing.
- Produces: client-side prefix/suffix clamps of 1600 / 800 chars.

- [ ] **Step 1: Locate the client clamp**

Run: `cd editor && grep -rn "prefix\|suffix" src/features/inline-suggest/ | grep -i "slice\|substring\|max"`

- [ ] **Step 2: Update the constants to 1600 / 800**

Match the server values from Task 9. Add a comment noting the server re-clamps defensively and that the two must stay in sync.

- [ ] **Step 3: Handle the 402 `inline_budget_exhausted` response**

Treat it like the existing `inline_quota` 429 — disable suggestions for the period and surface the status-bar state — but with the monthly reset copy rather than the daily one.

- [ ] **Step 4: Verify**

Run: `cd editor && npx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add editor/src/features/inline-suggest/
git commit -m "feat(editor): clamp FIM context to 600 tokens, handle monthly budget"
```

---

## Phase 5 — Landing and verification

### Task 14: Update pricing copy

**Files:**
- Modify: `landing-page/` pricing table and plan comparison

**Interfaces:**
- Consumes: `GET /v1/billing/plans` (already returns tier data from `tiers.ts`).
- Produces: correct credit counts and paid-tier badges.

- [ ] **Step 1: Locate hardcoded credit counts**

Run: `cd landing-page && grep -rn "1400\|3600\|16000\|1000 credits\|5000 credits" src/`

- [ ] **Step 2: Update to the new grants**

Free 150, Pro 2,000, Pro+ 5,000, Ultra 20,000. Top-up packs 1,600 ($16) and 7,500 ($75). Prefer reading from the API response over hardcoding; only hardcode where the page is static copy.

- [ ] **Step 3: Mark Deep Think and Max as paid-only**

Add to the plan comparison: Free includes Standard; paid plans add Deep Think and Max.

- [ ] **Step 4: Verify the build**

Run: `cd landing-page && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add landing-page/
git commit -m "docs(landing): update credit grants and paid-tier features"
```

---

### Task 15: Verification checklist (manual, owner-gated)

**Files:**
- Create: `docs/superpowers/plans/2026-08-14-ai-routing-verification.md`

These cannot be automated — they need the Cloudflare dashboard and a live account. Write them down so they are not lost.

- [ ] **Step 1: Create the checklist document**

```markdown
# AI Routing — Pre-Launch Verification

## Blocking

- [ ] **Dashboard rates.** Confirm `openai/gpt-5.6-luna` and `xai/grok-4.6`
      against the Cloudflare dashboard. The plan uses vendor list prices;
      Cloudflare serves some third-party models via resellers at a multiple
      (`deepseek-v4-pro` is ~4x DeepSeek's own rate). If they differ, update
      MODEL_CATALOG and re-run `test/costs.test.ts`.
- [ ] **Luna long-context cached rate.** MODEL_CATALOG assumes $0.04 above
      272k. Confirm or correct.
- [ ] **Grok sub-threshold cached rate.** MODEL_CATALOG charges cache hits at
      the full $2.00 input rate. Confirm whether a discount exists.
- [ ] **Inline reasoning tokens.** Send 20 FIM requests to
      `@cf/zai-org/glm-4.7-flash` and measure p50/p95 latency and output token
      counts. If it emits reasoning tokens, tab completion is unusable —
      roll back to `@cf/qwen/qwen2.5-coder-32b-instruct` (already in the
      catalog) and re-derive INLINE_DAILY_CAP from the higher per-suggestion
      cost.

## Before scaling

- [ ] **Workers AI rate limits.** Confirm the per-account request/minute limit
      for `@cf/zai-org/glm-5.2` and whether it is raisable.
- [ ] **Luna agentic quality.** Run `editor/tooling/unity-eval/presets.ts`
      against `openai/gpt-5.6-luna` and compare to the committed baselines.
      Luna ranks #36 on agentic benchmarks and it is the default tier.
- [ ] **Prompt caching observability.** Confirm `cacheReadTokens` is non-zero
      on a repeated-prefix request. If it stays 0, cached-rate savings are
      invisible to metering and debits over-charge relative to true cost.

## Secrets

- [ ] Rotate the leaked MiniMax key in `editor/.env` (outstanding from the
      2026-08-03 runbook — deleting the code path does not revoke the key).
- [ ] Delete Worker secrets `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, and
      `CF_ACCOUNT_ID` if unused elsewhere.

## Billing

- [ ] Create Dodo products for the renamed top-up packs (`topup_1600`,
      `topup_7500`) and set `DODO_PRODUCT_TOPUP_1600` / `_7500`.
- [ ] Confirm existing subscribers receive the new grant at renewal, not
      immediately.

## End-to-end

- [ ] Send a real chat turn at each tier and confirm the model in
      `request_logs` matches `INTENSITY_CONFIG`.
- [ ] Confirm a Free account gets 403 `tier_not_available` on Deep Think.
- [ ] Confirm an older editor build sending `super` still works.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-08-14-ai-routing-verification.md
git commit -m "docs: pre-launch verification checklist for AI routing"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: model ladder → Task 4; corrected catalog and long-context cliffs → Task 1; margin constants and grants → Task 2; debit arithmetic → Task 3; router deletion → Task 5; Free-tier gating → Tasks 2 and 6; inline ceiling → Tasks 7–9; editor context windows and labels → Tasks 10–11; editor error handling → Tasks 12–13; landing copy → Task 14; risks and open items → Task 15. The spec's testing section is distributed across the per-task tests.

**Placeholder scan.** No TBDs. Two intentional exceptions are flagged as verification tasks rather than silent gaps: Luna's long-context cached rate and Grok's sub-threshold cached rate, both given explicit conservative values in code with comments, and both listed in Task 15.

**Type consistency.** `estimateCost(model, inputTokens, outputTokens, cachedTokens?)` is used identically in Tasks 1, 3, and 9. `billedMicro` (Task 3) is used only in Task 3 — Task 9 deliberately uses `estimateCost × GATEWAY_FEE` without `MARGIN`, which is called out in that task's Interfaces block. `isTierAllowed(planId, tier)` matches between Tasks 2 and 6. `utcMonthKey` is defined in `inline-allowance.ts` (Task 8) and imported by `inline.ts` (Task 9) and the test in Task 7 — Task 7's test imports it before Task 8 creates it, so **Task 7 and Task 8 must be executed in order**, or Task 7's `utcMonthKey` assertion moved to Task 8.

**Correction against the spec:** the spec says "Migration 0017"; the repository is at `0018_otp_attempts.sql`, so the plan uses **0019**. Update the spec when convenient.
