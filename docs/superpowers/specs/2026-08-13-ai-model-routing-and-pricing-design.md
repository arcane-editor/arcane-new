# AI Model Routing and Credit Pricing — Design

**Date:** 2026-08-13 (revised 2026-08-14)
**Status:** Approved for planning
**Supersedes:** the tier map and cost table from `2026-08-03-shadow-suggestions-and-ai-hardening-design.md`

## Problem

Three defects compound in the current AI routing and billing path.

**The cost table is wrong in the expensive direction.** `MODEL_CATALOG` in `arcane-server/src/lib/costs.ts` carries self-declared placeholder rates that were never reconciled against published prices:

| Model | In `costs.ts` | Actual | Error |
|---|---|---|---|
| `@cf/zai-org/glm-5.2` (mid, default) | $0.60 / $2.20 | $1.40 / $4.40 | 2.3× / 2× under |
| `custom-moonshot/kimi-k3` (high, super) | $0.60 / $2.50 | $3.00 / $15.00 | 5× / 6× under |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | $0.30 / $1.20 | $0.66 / $1.00 | under on input |
| `custom-minimax/MiniMax-M3` | $0.40 / $2.20 | $0.30 / $1.20 | over (safe) |

Because `debitCredits` charges raw `estimateCost`, a high-effort turn debits roughly a fifth of what it costs. A Pro subscriber ($20, 1,400 credits = $14 of assumed cost) burning the high tier could incur $70 or more of real spend.

**The tier map picks the wrong models.** `high` and `super` both route to Kimi K3 at $3.00/$15.00 — a blended $6.00 per 1M tokens, identical to Claude Sonnet 5, for a model that is not coding-specialized.

**Margin has nowhere to live.** Margin exists only as the gap between plan price and granted credits, sized by a `SAFETY_BUFFER` applied at grant time. Any upstream price change silently moves margin with no signal.

Separately, inline (tab) completions consume real tokens but debit nothing and are bounded only by a request count, which does not bound cost.

## Platform context

Cloudflare shipped unified model access and billing on 2026-08-07. A single `AI` binding and `/ai/` REST surface reach Workers AI models and third-party providers, with prepaid AI Gateway credits covering both. Cloudflare charges **5% on credits purchased** and applies no per-token markup of its own.

Consequence: the AI Gateway `/compat` custom-provider path built on 2026-08-03 is obsolete. All three tiers plus the inline model route through Cloudflare — **one billing surface.**

## Decisions

1. **Three tiers**, labelled **Standard / Deep Think / Max**. Standard is auto-selected and is where most users are expected to stay.
2. **No incognito mode.** It was introduced to avoid a provider training on user code; with that provider removed, the rationale is gone.
3. **Margin is an explicit per-request multiplier.** `MARGIN = 2.0`, applied at debit time, not at grant time.
4. **Credits granted = plan price × 100.** A $20 plan grants 2,000 credits.
5. **Inline completions stay free to the user**, bounded by a real monthly spend ceiling: $1.00 for Free, 10% of plan price for paid tiers.
6. **Free tier gets Standard only** — Deep Think and Max are paid-plan features.

## Model ladder

| Tier | Label | UI description | Model ID | In / Out / Cached | Route |
|---|---|---|---|---|---|
| `low` | **Standard** | Day-to-day coding | `openai/gpt-5.6-luna` | 0.20 / 1.20 / 0.02 | unified billing |
| `mid` | **Deep Think** | Extended reasoning for tricky problems | `@cf/zai-org/glm-5.2` | 1.40 / 4.40 / 0.26 | Workers AI |
| `high` | **Max** | Maximum capability for complex work | `xai/grok-4.6` | 2.00 / 6.00 | unified billing |
| — | inline | tab completions | `@cf/zai-org/glm-4.7-flash` | 0.06 / 0.40 | Workers AI |

Internal tier keys stay `low` / `mid` / `high` — only the display labels change. This keeps the wire protocol stable and limits churn to the presentation layer.

`super` is removed. The wire value remains **accepted** and maps to `high`, so editor builds predating this change do not fail.

All models are reached through Cloudflare, so **fallback routing is removed entirely**. There is no second provider to fall back to, and a Cloudflare outage takes every tier down together.

**Model selection rationale.** GPT-5.6 Luna ranks #6 on the Coding Agent Index (its strongest category) at 80% lower per-task cost than Sol, and is OpenAI's default for ChatGPT Free/Go. GLM-5.2 leads Terminal-Bench 2.1 at 81.0% — agentic tool-loop execution, which is what the Unity agent does. Grok 4.6 scores 61 on the Artificial Analysis Intelligence Index, matching GPT-5.6 Sol and one point behind Claude Fable 5, making it the cheapest model at the intelligence frontier.

**Known weakness:** Luna's lowest benchmark position is agentic, at #36. It is the tier most users never leave, and the product is a tool-loop agent. This should be evaluated against the committed baselines in `editor/tooling/unity-eval/presets.ts` before launch — public benchmarks do not test C# or Unity APIs.

## Long-context repricing cliffs

Both third-party models reprice above a token threshold, and they are **cliffs, not gradients** — crossing the threshold rebills the entire request.

| Model | Threshold | Rates above it | Effect |
|---|---|---|---|
| `openai/gpt-5.6-luna` | 272,000 input | $0.40 / $1.80 | 2× input, 1.5× output |
| `xai/grok-4.6` | 200,000 total | $4.00 / $1.00 cached / $12.00 | 2× the whole request |
| `@cf/zai-org/glm-5.2` | — | flat | none |

A 201k-token Grok request costs double a 199k one. Two consequences:

**`estimateCost` needs tiered rates.** `ModelInfo` gains an optional `longContext: { thresholdTokens, inputCostPer1M, outputCostPer1M, cachedInputCostPer1M }`. When total input exceeds the threshold, the whole request bills at the long-context rates.

**Usable context per tier is the cliff, not the model window.** `TIER_CONTEXT_WINDOWS` becomes the economic limit:

| Tier | Model window | Usable |
|---|---|---|
| Standard | 1,050,000 | **272,000** |
| Deep Think | 262,144 | **262,144** |
| Max | 500,000 | **200,000** |

Max therefore has the smallest usable window. GLM-5.2's flat pricing makes **Deep Think the correct tier for large-context work**, even though it sits below Max on the ladder. This should be surfaced as a routing hint when a request approaches Max's threshold rather than left for users to discover through billing.

## Cost and margin model

Three named constants, each independently auditable:

```
MODEL_CATALOG   — true vendor list prices, including cached and long-context rates
GATEWAY_FEE     — 1.05  (Cloudflare's 5% on prepaid gateway credits)
MARGIN          — 2.0   (platform markup)
```

Debit becomes:

```
debit_micro = round(estimateCost(model, inputTokens, outputTokens, cachedTokens)
                    × GATEWAY_FEE × MARGIN × 1_000_000)
```

`SAFETY_BUFFER` is removed; it is superseded by `MARGIN`. The effective multiplier on list price is **2.10**, and real cost paid to Cloudflare is `list × GATEWAY_FEE`, so at full credit burn `real_COGS = credits_face_value / MARGIN`.

### Fee stack

- **Cloudflare:** 5% on prepaid AI Gateway credits.
- **Dodo Payments:** 4.5% + $0.40 (US subscription), 6% + $0.40 (international subscription), 5.5% + $0.40 (one-time). $1 refund, $30 dispute.

All figures below use the **international** rate as the conservative case; US cards run roughly 1.5 percentage points better.

### Plan economics at full burn

| Plan | Price | Dodo net | Credits | Chat COGS | Inline | Profit | Margin |
|---|---|---|---|---|---|---|---|
| Free | $0 | $0 | 150 | $0.75 | $1.00 | −$1.75 | — |
| Pro | $20 | $18.40 | 2,000 | $10.00 | $2.00 | $6.40 | 32.0% |
| Pro+ | $50 | $46.60 | 5,000 | $25.00 | $5.00 | $16.60 | 33.2% |
| Ultra | $200 | $187.60 | 20,000 | $100.00 | $20.00 | $67.60 | 33.8% |

This is the **floor** — it assumes both the credit balance and the inline budget are fully consumed on an international card. Realised margin will run above it.

Margin is uniform across the ladder and **model-independent by construction**. If any model's price changes, debits change with it, credits drain faster or slower, and margin holds. That is the property the current design lacks.

**Free-tier carrying cost is $1.75 per user per month** against zero revenue, scaling linearly with signups.

### Top-up packs

Same rule — credits = price × 100 — so a credit costs the same whether bought in a plan or a pack:

| Pack | Price | Credits | Dodo net | COGS | Profit | Margin |
|---|---|---|---|---|---|---|
| Small | $16 | 1,600 | $14.72 | $8.00 | $6.72 | 42.0% |
| Large | $75 | 7,500 | $70.48 | $37.50 | $32.98 | 44.0% |

Packs run higher margin than plans because they carry no inline allowance.

### What a credit buys

Cached agentic turn = 10k fresh input + 20k cached + 2k output.

| Tier | Cached agentic turn | Credits | Pro's 2,000 credits |
|---|---|---|---|
| Standard | $0.0048 | **1.0** | ~2,000 turns (66/day) |
| Deep Think | $0.028 | **5.9** | ~339 turns (11/day) |
| Max | $0.072 | **15.1** | ~132 turns |

Free's 150 credits buy ~150 Standard turns per month.

### Prompt caching

Cached-input rates cut cost substantially — Luna's cached rate is $0.02 against $0.20 input (10×), GLM-5.2's is $0.26 against $1.40 (5.4×). This is the highest-leverage margin lever in the design and it is currently unused: `AI-SPEC.md` records that no prefix-caching provider is wired up, and `request_logs.cached_input_tokens` is plumbed but always zero.

`estimateCost` gains a `cachedTokens` parameter and a `cachedInputCostPer1M` field per model so the saving is metered correctly once caching is enabled.

## Inline completions

Inline completions remain free to the user and never debit credits. They are bounded by a **monthly spend ceiling denominated in real cost** — `estimateCost × GATEWAY_FEE`, no margin, since nothing is being sold.

The FIM context window is clamped to **600 tokens**. Input dominates inline cost almost entirely.

At 600 in / 40 out on `@cf/zai-org/glm-4.7-flash`, each suggestion costs **$0.0000546**:

| Plan | Monthly ceiling | Micro-USD | Suggestions/mo | Daily cap |
|---|---|---|---|---|
| Free | $1.00 | 1,000,000 | ~18,300 | 600 |
| Pro | $2.00 | 2,000,000 | ~36,600 | 1,200 |
| Pro+ | $5.00 | 5,000,000 | ~91,600 | 3,000 |
| Ultra | $20.00 | 20,000,000 | ~366,300 | 12,000 |

Daily caps are derived from the monthly budget divided by 30, rounded to a clean number. They ration the budget across the month; the monthly micro-USD ceiling is the hard backstop, because a request-count cap alone does not bound cost.

Exceeding the monthly ceiling returns a 402 with an inline-specific code, so the editor can distinguish "out of tab completions" from "out of chat credits".

**Risk:** GLM-4.7-Flash is a reasoning model and is not FIM-trained. If it emits thinking tokens on every completion, latency will regress badly — fatal for tab completion — and output cost will exceed the 40-token estimate substantially. This must be verified before shipping, with `@cf/qwen/qwen2.5-coder-32b-instruct` ($0.66 / $1.00, 8.4× more expensive per suggestion) as the documented rollback.

## Implementation

### `arcane-server/src/config/plans.ts`

Rewrite `INTENSITY_CONFIG` to the three-tier ladder with display labels. Narrow `Intensity` to `'low' | 'mid' | 'high'`. `getIntensityConfig` maps the legacy `'super'` string to the `high` config.

### `arcane-server/src/lib/costs.ts`

Replace `MODEL_CATALOG` with verified list prices. Add `cachedInputCostPer1M` and optional `longContext` to `ModelInfo`. Extend `estimateCost(model, inputTokens, outputTokens, cachedTokens = 0)` to bill cached tokens at the cached rate and to switch the entire request to long-context rates above the threshold. Replace the `provider` field with `route: 'workers-ai' | 'unified'` for observability.

### `arcane-server/src/config/tiers.ts`

Remove `SAFETY_BUFFER`. Add `GATEWAY_FEE = 1.05` and `MARGIN = 2.0`. Set grants to `priceUsd × 100`. Replace `INLINE_DAILY_CAP` values and add `INLINE_MONTHLY_MICRO_CEILING`. Add a per-plan allowed-tier list so Free is restricted to `low`.

### `arcane-server/src/lib/usage.ts`

`recordUsage` computes `debit = estimateCost(...) × GATEWAY_FEE × MARGIN`, rounded to integer micro-USD. Existing plan-first-then-topup atomic debit is unchanged.

### `arcane-server/src/services/llm-router.ts`

Delete the external-routing path in full: `isExternalModel`, `externalApiKey`, `gatewayCompatUrl`, `ExternalRoutingEnv`, the `createOpenAICompatible` branch in `resolveModel`, `FALLBACK_MODEL`, `fallbackModelFor`, `shouldFallback`, `LlmConfigError`, the `fallback` stream event, and the `provider_*` error codes. `streamCompletion` loses its config-failure pre-flight and its recursive `streamOnce` retry. Retain `skipCache: true` on chat completions.

Add a tier gate: reject `mid` / `high` for Free-plan users with a distinct error code the editor can surface as an upgrade prompt.

### `arcane-server/src/routes/inline.ts`

Add the monthly micro-USD ceiling check alongside the daily count check. Clamp FIM context to 600 tokens server-side. Record real inline spend into the new monthly accumulator.

### Migration 0017

Add a monthly micro-USD accumulator and period anchor to `inline_usage`. `request_logs.fallback_model` is retained for historical rows but no longer written.

### Editor

`TIER_CONTEXT_WINDOWS` becomes `{ low: 272_000, mid: 262_144, high: 200_000 }` — the pricing cliffs, not the model windows. Rename the effort selector labels to Standard / Deep Think / Max with the descriptions above, defaulting to Standard. Remove `super` from the `Effort` type. Remove `fallback` stream-event handling from `arcane-stream.ts` and turn-errors, and the `provider_*` error codes. Clamp FIM context client-side. Surface the inline-exhausted 402 and the Free-tier tier-gate error distinctly. Add a hint when a request approaches Max's 200k threshold suggesting Deep Think for large-context work.

### Landing

`/pricing` credit counts become 2,000 / 5,000 / 20,000; top-up packs 1,600 / 7,500. Plan comparison shows Deep Think and Max as paid-only.

## Migration and compatibility

**Existing subscribers' grants change** (Pro 1,400 → 2,000). Apply at next renewal; `refreshAndGetBalance` never auto-regrants paid plans, so this needs no special handling beyond updating `tiers.ts` before the next renewal cycle. Free users pick up the new grant at their next lazy monthly reset.

**Older editor builds** send `reasoningLevel: 'super'` (mapped to `high`) and expect `fallback` stream events (which simply never arrive, already tolerated as optional).

**Secrets to retire:** `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, and `CF_ACCOUNT_ID` if unused elsewhere. The leaked MiniMax key in `editor/.env` flagged in the 2026-08-03 runbook still requires rotation — deleting the code path does not revoke the key.

## Risks and open items

**Third-party rates are dashboard-only and set by the serving provider, not the model vendor.** Cloudflare serves `deepseek-v4-pro` via Fireworks at roughly 4× DeepSeek's first-party rate. The Luna and Grok figures in this document are vendor list prices and **must be confirmed against the Cloudflare dashboard** before the credit weightings are trusted. Only the `@cf/*` rates are published and reliable.

**Luna's agentic benchmark position (#36)** is the weakest point of the design, on the tier most users will never leave. Evaluate on `editor/tooling/unity-eval/presets.ts` before launch.

**Inline on a reasoning model** may regress tab-completion latency badly. Verify reasoning can be suppressed; rollback is `@cf/qwen/qwen2.5-coder-32b-instruct`.

**Prompt caching may not be observable.** The cached-rate savings assume Workers AI and the unified-billing providers report cached input token counts. If they do not, the saving may accrue on the invoice while being invisible to metering, meaning debits overcharge users relative to true cost.

**Workers AI account-level rate limits.** Frontier Workers AI models are documented at 50 requests/minute per account when billed via AI Gateway credits, up from 20. GLM-5.2 is in that bucket. This may throttle concurrency well before revenue justifies it, and needs verifying for this account along with whether the limit is raisable.

**Grok 4.6 is two days old** (released 2026-08-12). Expect price and availability volatility.

**Free-tier cost scales with signups** at $1.75/user/month with no offsetting revenue.

## Testing

- **`costs.test.ts`** — verbatim literal fixtures for every rate in `MODEL_CATALOG`, asserted against the values in this document, including long-context thresholds and rates. External vendor price tables get literal-value tests, not derived ones.
- **Long-context repricing** — a request one token below each threshold bills at standard rates; one token above bills the entire request at long-context rates.
- **Catalog guard** — every model referenced by `INTENSITY_CONFIG` and `INLINE_MODEL` exists in `MODEL_CATALOG`.
- **`tiers.test.ts`** — margin invariant: for each paid plan, net margin at full burn of both credits and inline budget is ≥ 30% under both US and international Dodo rates.
- **`usage.test.ts`** — exact arithmetic on `debit = cost × 1.05 × 2.0`, including integer micro-USD rounding at boundary values, and cached-token billing at the cached rate.
- **Tier gate** — Free-plan requests for `mid` / `high` are rejected with the upgrade error code; paid plans are not.
- **Inline ceiling** — 402 when the monthly micro-USD ceiling is reached, distinct from the daily count cap; the ceiling accumulates real cost without margin.
- **Legacy wire value** — `getIntensityConfig('super')` returns the `high` config.
- **Editor** — `TIER_CONTEXT_WINDOWS` matches the pricing cliffs; `super` absent from the effort selector; labels render as Standard / Deep Think / Max with Standard default.
- **End-to-end** — verify the real chat flow after the router deletion. That rewrite touches the only path users exercise, and this codebase has a documented history of a subsystem being "fixed" twice while the user-visible flow stayed broken.
