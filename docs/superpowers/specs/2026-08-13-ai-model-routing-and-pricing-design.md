# AI Model Routing and Credit Pricing — Design

**Date:** 2026-08-13
**Status:** Approved for planning
**Supersedes:** the tier map and cost table from `2026-08-03-shadow-suggestions-and-ai-hardening-design.md`

## Problem

Three defects compound in the current AI routing and billing path.

**The cost table is wrong in the expensive direction.** `MODEL_CATALOG` in `arcane-server/src/lib/costs.ts` carries self-declared placeholder rates that were never reconciled against published prices. Verified against vendor documentation on 2026-08-13:

| Model | In `costs.ts` | Actual | Error |
|---|---|---|---|
| `@cf/zai-org/glm-5.2` (mid, default) | $0.60 / $2.20 | $1.40 / $4.40 | 2.3× / 2× under |
| `custom-moonshot/kimi-k3` (high, super) | $0.60 / $2.50 | $3.00 / $15.00 | 5× / 6× under |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | $0.30 / $1.20 | $0.66 / $1.00 | under on input |
| `custom-minimax/MiniMax-M3` | $0.40 / $2.20 | $0.30 / $1.20 | over (safe) |

Because `debitCredits` charges raw `estimateCost`, a high-effort turn currently debits roughly a fifth of what it costs. A Pro subscriber ($20, 1,400 credits = $14 of assumed cost) burning the high tier could incur $70 or more of real spend.

**The tier map picks the wrong models.** `high` and `super` both route to Kimi K3 at $3.00/$15.00 — a blended $6.00 per 1M tokens at a 3:1 input:output ratio, identical to Claude Sonnet 5, for a model that is not coding-specialized. Moonshot's coding-specialized model, `@cf/moonshotai/kimi-k2.7-code`, is available natively on Workers AI at $0.95/$4.00 — roughly a third the price.

**Margin has nowhere to live.** Margin exists only as the gap between plan price and granted credits, sized by a `SAFETY_BUFFER` constant applied at grant time. Any upstream price change silently moves margin with no signal, which is precisely the failure above.

Separately, inline (tab) completions consume real tokens but debit nothing and are bounded only by a request count, which does not bound cost.

## Platform changes that enable this design

Cloudflare shipped unified model access and billing on 2026-08-07. A single `AI` binding and `/ai/` REST surface now reach Workers AI models and supported third-party providers, with prepaid AI Gateway credits covering both. Cloudflare charges **5% on credits purchased** and applies **no per-token markup** — its GLM-5.2 rate is identical to Z.ai's direct rate. MiniMax M3 is in the catalog as `minimax/m3`.

Consequence: the AI Gateway `/compat` custom-provider path built on 2026-08-03 is obsolete. Every model in the new lineup is a first-party Cloudflare route.

## Decisions

1. **Open-weight models only.** No frontier closed models (Claude, GPT, Gemini) at any tier. The ceiling is GLM-5.2.
2. **Margin is an explicit per-request multiplier.** `MARGIN = 2.0`, applied at debit time, not at grant time.
3. **Inline completions stay free to the user**, bounded by a real monthly spend ceiling: $1.00 for Free, 10% of plan price for paid tiers.
4. **Credits granted = plan price × 100.** A $20 plan grants 2,000 credits.

## Model ladder

| Effort | Model ID | Route | In / Out / Cached ($/1M) | Context |
|---|---|---|---|---|
| `low` | `minimax/m3` | unified billing | 0.30 / 1.20 / 0.06 | 1,000,000 |
| `mid` | `@cf/moonshotai/kimi-k2.7-code` | Workers AI | 0.95 / 4.00 / 0.19 | 262,144 |
| `high` | `@cf/zai-org/glm-5.2` | Workers AI | 1.40 / 4.40 / 0.26 | 262,144 |
| inline | `@cf/qwen/qwen2.5-coder-32b-instruct` | Workers AI | 0.66 / 1.00 / — | 32,768 |

`super` is removed. It was an alias of `high` with no distinct model, and with an open-weight ceiling there is nothing above GLM-5.2 to promote it to. The wire value remains **accepted** and maps to `high`, so editor builds predating this change do not fail.

Every model is a first-party Cloudflare route, so **fallback routing is removed entirely**. There is no second provider to fall back to, and a Workers AI outage takes every tier down together — a fallback map would add code that cannot help.

Rationale for `mid` and `high` swapping relative to today: Kimi K2.7-Code is a 1-trillion-parameter coding-specialized model supporting function calling, reasoning, vision, and structured outputs, at $0.95/$4.00. GLM-5.2 is Z.ai's flagship agentic coding model at $1.40/$4.40 and reportedly outperforms GPT-5.5 on several long-horizon coding benchmarks. Making the cheaper coding-specialist the default and the flagship the ceiling matches capability to price.

## Cost and margin model

Three named constants, each independently auditable:

```
MODEL_CATALOG   — true vendor list prices, including cached-input rates
GATEWAY_FEE     — 1.05  (Cloudflare's 5% on prepaid gateway credits)
MARGIN          — 2.0   (platform markup)
```

Debit becomes:

```
debit_micro = round(estimateCost(model, inputTokens, outputTokens, cachedTokens)
                    × GATEWAY_FEE × MARGIN × 1_000_000)
```

`SAFETY_BUFFER` is removed; it is superseded by `MARGIN`.

The effective multiplier on list price is **2.10**. Real cost paid to Cloudflare is `list × GATEWAY_FEE`, so at full credit burn:

```
real_COGS = credits_face_value / MARGIN
```

### Fee stack

Both fees compound before any revenue is recognised:

- **Cloudflare:** 5% on prepaid AI Gateway credits.
- **Dodo Payments:** 4.5% + $0.40 (US subscription), 6% + $0.40 (international subscription), 5.5% + $0.40 (one-time). $1 refund, $30 dispute.

All figures below use the **international** rate as the conservative case. US cards run roughly 1.5 percentage points better.

### Plan economics at full burn

| Plan | Price | Dodo net | Credits | Chat COGS | Inline | Profit | Margin |
|---|---|---|---|---|---|---|---|
| Free | $0 | $0 | 150 | $0.75 | $1.00 | −$1.75 | — |
| Pro | $20 | $18.40 | 2,000 | $10.00 | $2.00 | $6.40 | 32.0% |
| Pro+ | $50 | $46.60 | 5,000 | $25.00 | $5.00 | $16.60 | 33.2% |
| Ultra | $200 | $187.60 | 20,000 | $100.00 | $20.00 | $67.60 | 33.8% |

This is the **floor**: it assumes both the credit balance and the inline budget are fully consumed on an international card. Realised margin will run above it because breakage is substantial.

Margin is uniform across the ladder and survives upstream price changes. If GLM-5.2 doubles in price, debits double, credits drain twice as fast, and margin holds — the property the current design lacks.

**Free-tier carrying cost is $1.75 per user per month** against zero revenue. This scales linearly with signups and should be tracked as a distinct line.

### Top-up packs

Same rule — credits = price × 100 — so a credit costs the same whether bought in a plan or a pack:

| Pack | Price | Credits | Dodo net | COGS | Profit | Margin |
|---|---|---|---|---|---|---|
| Small | $16 | 1,600 | $14.72 | $8.00 | $6.72 | 42.0% |
| Large | $75 | 7,500 | $70.48 | $37.50 | $32.98 | 44.0% |

Packs run higher margin than plans because they carry no inline allowance. Uniform per-credit pricing is deliberate: it is simpler to explain and consistent with the product's trust positioning.

### What a credit buys

Representative agentic turn: 30k input / 2k output. Chat turn: 8k input / 800 output.

| Tier | Uncached | Cached (20k of 30k input) |
|---|---|---|
| `low` | 0.7 credits | — |
| `mid` | 7.7 credits | 4.5 credits |
| `high` | 10.7 credits | 5.9 credits |

Monthly agentic turn allowances at `high` with caching: Free 25, Pro 339 (~11/day), Pro+ 847 (~28/day), Ultra 3,390 (~113/day).

### Prompt caching

Cached-input rates cut agentic-tier cost by roughly 45% (a cached `high` turn is $0.028 of list versus $0.0508). This is the highest-leverage margin lever in the design — worth more than any model substitution — and it is currently unused: `AI-SPEC.md` records that no prefix-caching provider is wired up, and `request_logs.cached_input_tokens` is plumbed but always zero.

`estimateCost` gains a `cachedTokens` parameter and a `cachedInputCostPer1M` field per model, so the saving is metered correctly the moment caching is enabled. Whether Workers AI actually reports cached token counts is an open item (below).

## Inline completions

Inline completions remain free to the user and never debit credits. They are bounded by a **monthly spend ceiling denominated in real cost** — `estimateCost × GATEWAY_FEE`, with no margin applied, since nothing is being sold.

The FIM context window is clamped to **600 tokens**. Input dominates inline cost almost entirely; clamping from the current ~1,500 to 600 tokens cuts per-suggestion cost from $0.00108 to **$0.000458**, nearly tripling the number of suggestions each budget buys.

| Plan | Monthly ceiling | Micro-USD | Suggestions/mo | Daily cap |
|---|---|---|---|---|
| Free | $1.00 | 1,000,000 | ~2,184 | 75 |
| Pro | $2.00 | 2,000,000 | ~4,369 | 150 |
| Pro+ | $5.00 | 5,000,000 | ~10,922 | 375 |
| Ultra | $20.00 | 20,000,000 | ~43,687 | 1,500 |

Daily caps are **derived from the monthly budget divided by 30**, then rounded up to a clean number (72.8 → 75, 145.6 → 150, 364 → 375, 1,456 → 1,500). They are not set independently. This rations the budget across the month; without it a user exhausts the allowance in the first few days and faces three dead weeks. Rounding up means 30 days at the daily cap slightly exceeds the monthly budget, which is intentional — the monthly micro-USD ceiling is the hard backstop, and a request-count cap alone does not bound cost, because cost scales with context size rather than request count.

Exceeding the monthly ceiling returns the existing `credits_exhausted`-style 402 with an inline-specific code, so the editor can distinguish "out of tab completions" from "out of chat credits".

## Implementation

### `arcane-server/src/config/plans.ts`

Rewrite `INTENSITY_CONFIG` to the three-tier ladder. Narrow `Intensity` to `'low' | 'mid' | 'high'`. `getIntensityConfig` maps the legacy `'super'` string to the `high` config so older clients keep working.

### `arcane-server/src/lib/costs.ts`

Replace `MODEL_CATALOG` with verified list prices. Add `cachedInputCostPer1M` to `ModelInfo`. Extend `estimateCost(model, inputTokens, outputTokens, cachedTokens = 0)` to bill cached tokens at the cached rate. Drop the `provider: 'minimax' | 'moonshot'` distinction — every entry is now reached through Cloudflare; retain a `route: 'workers-ai' | 'unified'` field for observability.

### `arcane-server/src/config/tiers.ts`

Remove `SAFETY_BUFFER`. Add `GATEWAY_FEE = 1.05` and `MARGIN = 2.0`. Set grants to `priceUsd × 100`. Replace `INLINE_DAILY_CAP` values and add `INLINE_MONTHLY_MICRO_CEILING`.

### `arcane-server/src/lib/usage.ts`

`recordUsage` computes `debit = estimateCost(...) × GATEWAY_FEE × MARGIN`, rounded to integer micro-USD. Existing plan-first-then-topup atomic debit is unchanged.

### `arcane-server/src/services/llm-router.ts`

Delete the external-routing path in full: `isExternalModel`, `externalApiKey`, `gatewayCompatUrl`, `ExternalRoutingEnv`, the `createOpenAICompatible` branch in `resolveModel`, `FALLBACK_MODEL`, `fallbackModelFor`, `shouldFallback`, `LlmConfigError`, the `fallback` stream event, and the `provider_rate_limit` / `provider_auth_failure` / `provider_unavailable` / `gateway_timeout` error codes. `streamCompletion` loses its config-failure pre-flight and its recursive `streamOnce` retry; it becomes a single pass over the AI binding. Retain `skipCache: true` on chat completions — cached replay of a temperature-sampled turn remains semantically wrong.

### `arcane-server/src/routes/inline.ts`

Add the monthly micro-USD ceiling check alongside the daily count check. Clamp FIM context to 600 tokens server-side. Record real inline spend into the new monthly accumulator.

### Migration 0016

Add a monthly micro-USD accumulator and period anchor to `inline_usage`. `request_logs.fallback_model` is retained for historical rows but no longer written.

### Editor

`TIER_CONTEXT_WINDOWS` becomes `{ low: 1_000_000, mid: 262_144, high: 262_144 }` — real model windows, since the min-with-fallback rule no longer applies. Remove `super` from `EffortSelector` and the `Effort` type. Remove `fallback` stream-event handling from `arcane-stream.ts` and turn-errors, and the `provider_*` error codes from the error surface. Clamp FIM context client-side to match the server. Surface the inline-exhausted 402 distinctly from the credits-exhausted 402.

### Landing

`/pricing` credit counts become 2,000 / 5,000 / 20,000; top-up packs become 1,600 / 7,500.

## Migration and compatibility

**Existing subscribers' grants change** (Pro 1,400 → 2,000). Apply new grants at next renewal rather than immediately; `refreshAndGetBalance` already never auto-regrants paid plans, so this requires no special handling beyond updating `tiers.ts` before the next renewal cycle. Free users pick up the new grant at their next lazy monthly reset.

**Older editor builds** send `reasoningLevel: 'super'` and expect `fallback` stream events. The former is mapped to `high`; the latter simply never arrives, which the client already tolerates as an optional event.

**Secrets to retire:** `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, `CF_ACCOUNT_ID` (if unused elsewhere). The leaked MiniMax key in `editor/.env` flagged in the 2026-08-03 runbook still needs rotation before the key is decommissioned — deleting the code path does not revoke the key.

## Risks and open items

**Blocking:** whether `workers-ai-provider` can route a non-`@cf/` model id such as `minimax/m3` through the `AI` binding, or whether unified-billing models require a different call path. Verify with a single throwaway request before committing the tier map. **Contingency:** route `low` to `@cf/openai/gpt-oss-120b` — native Workers AI, $0.35/$0.75, blended $0.45 versus M3's $0.53, function calling and reasoning supported. The cost is a 128k context instead of 1M and weaker agentic behaviour.

**Caching may not be observable.** The 45% saving assumes Workers AI reports cached input token counts. If it does not, the saving may still accrue on the invoice while being invisible to metering — which would mean debits overcharge users relative to true cost. Verify before enabling caching.

**Gateway fee scope is ambiguous.** Cloudflare's changelog states prepaid gateway credits cover Workers AI and third-party inference; the pricing page states unified billing applies only to third-party models. This design assumes the 5% applies to all AI spend. If it does not, every margin figure above improves by roughly 5%.

**Free-tier cost scales with signups** at $1.75/user/month with no offsetting revenue.

## Testing

- **`costs.test.ts`** — verbatim literal fixtures for every rate in `MODEL_CATALOG`, asserted against the values in this document. External vendor price tables get literal-value tests, not derived ones.
- **Catalog guard** — every model referenced by `INTENSITY_CONFIG` and `INLINE_MODEL` exists in `MODEL_CATALOG` (extends the existing A1 guard).
- **`tiers.test.ts`** — margin invariant: for each paid plan, assert net margin at full burn of both credits and inline budget is ≥ 30% under both the US and international Dodo rates.
- **`usage.test.ts`** — exact arithmetic on `debit = cost × 1.05 × 2.0`, including integer micro-USD rounding at boundary values, and cached-token billing at the cached rate.
- **Inline ceiling** — 402 when the monthly micro-USD ceiling is reached, distinct from the daily count cap; ceiling accumulates real cost without margin.
- **Legacy wire value** — `getIntensityConfig('super')` returns the `high` config.
- **Editor** — `TIER_CONTEXT_WINDOWS` updated; `super` absent from the effort selector.
- **End-to-end** — verify the real chat flow after the router deletion. That rewrite touches the only path users actually exercise, and this codebase has a documented history of a subsystem being "fixed" twice while the user-visible flow stayed broken.
