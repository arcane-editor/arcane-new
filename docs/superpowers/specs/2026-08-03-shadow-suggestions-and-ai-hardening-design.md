# Shadow AI Suggestions, External Model Routing & AI Edge-Case Hardening — Design

**Date:** 2026-08-03
**Status:** Approved (brainstormed and section-approved with owner)
**Build order:** Routing → Tab completions → Hardening sweep (single plan, three phases)

## Context

Arcane Editor's AI subsystem today routes every call through the Workers AI binding
(`arcane-server/src/services/llm-router.ts`) with server-side model selection per intensity
tier (`src/config/plans.ts`), credit gating (`src/lib/credits.ts` → 402/429), and metering
(`src/lib/usage.ts`). The editor has a hardened SSE chat client
(`editor/src/features/ai-panel/services/arcane-stream.ts`) with retries, watchdogs, and an
error taxonomy. There is **no inline-completion feature** and **no external-provider
routing**. The documented "model lineup FROZEN — CF Workers AI only" decision
(`docs/superpowers/plans/2026-07-08-unity-finetune-HANDOFF.md:40`) is explicitly lifted by
this design (owner decision, 2026-08-03).

## Goals

1. **Shadow/tab suggestions** (Cursor-Tab-style ghost text) powered by a cheap, fast
   CF-catalog model, accepted with Tab.
2. **External models through Cloudflare AI Gateway**: MiniMax 3 and Kimi 3 (Moonshot),
   which are not in the Workers AI catalog, routed via the gateway so logs/analytics/
   caching/rate-limits stay unified.
3. **Edge-case hardening** across the AI subsystem: offline, plan/credit exhaustion,
   provider outage, server errors, quota exhaustion, auth expiry — nothing surfaces as a
   raw failure.

## Non-goals

- No BYOK / Secrets Store / authenticated-gateway setup (owner declined — provider keys
  are Worker secrets sent per-request).
- No streaming for inline completions.
- No multi-suggestion cycling UI (Monaco supports it later; v1 returns one suggestion).
- No change to chat UX, checkpoints, or the apply-review flow.
- No dedicated "super" model (stays aliased to high).

---

## Part 1 — External model routing via AI Gateway

### Tier map (`src/config/plans.ts` `INTENSITY_CONFIG`)

| Tier | New model | Runs via |
|---|---|---|
| low | `custom-minimax/MiniMax-M3` | Gateway `/compat` → MiniMax API |
| mid | `@cf/zai-org/glm-5.2` | Workers AI binding (demoted from high) |
| high | `custom-moonshot/kimi-k3` | Gateway `/compat` → Moonshot API |
| super | `custom-moonshot/kimi-k3` | alias of high |
| inline (new config key) | `@cf/qwen/qwen2.5-coder-32b-instruct` | Workers AI binding |

The upstream model-id strings (`MiniMax-M3`, `kimi-k3`) are constants in `plans.ts`. At
implementation time they are verified against the providers' model catalogs when the
custom providers are registered; if a provider names its model differently, the fix is a
one-line constant change plus the matching `MODEL_CATALOG` key.

### Mechanism: Gateway Custom Providers + `/compat`

MiniMax and Moonshot are not natively supported AI Gateway providers. AI Gateway's
**Custom Providers** feature covers this: register each provider's OpenAI-compatible base
URL under a slug (`minimax`, `moonshot`) on both gateways (`arcane-ai-gateway`,
`arcane-ai-gateway-dev`), then call the gateway's unified endpoint:

```
POST https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{CF_AI_GATEWAY_ID}/compat/chat/completions
Authorization: Bearer <provider API key>          ← per-request, from Worker secret
body.model = "custom-minimax/MiniMax-M3" | "custom-moonshot/kimi-k3"
```

The gateway remains **unauthenticated** (as today), so no `cf-aig-authorization` header
and no gateway token. All gateway features (logs, analytics, caching config, rate limits)
apply to custom providers.

### Router changes (`src/services/llm-router.ts`)

- `resolveModel(modelId, env, overrides)` branches:
  - `@cf/*` → existing `createWorkersAI` binding path, unchanged.
  - anything else → OpenAI-compatible AI SDK provider (`@ai-sdk/openai-compatible`)
    with `baseURL = https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/compat`
    and `Authorization` chosen by a provider→secret map:
    `custom-minimax/*` → `env.MINIMAX_API_KEY`, `custom-moonshot/*` → `env.MOONSHOT_API_KEY`.
- All call sites (`streamCompletion`, `routes/graph.ts`, etc.) are untouched — they
  consume the AI SDK `LanguageModel` abstraction.
- If the needed secret or `CF_ACCOUNT_ID` is missing, `resolveModel` throws a typed
  configuration error → 500 with structured log; tests run with external routing
  unconfigured and assert this failure is fast and clear.

### Fallback on provider failure

If an external-model call fails with a transient class of error (HTTP 5xx, gateway/network
timeout, provider 429), the router retries **once** against a CF-catalog fallback:

| Failed tier | Fallback model |
|---|---|
| low | `@cf/qwen/qwen2.5-coder-32b-instruct` |
| high / super | `@cf/zai-org/glm-5.2` |

Request-shaped errors (HTTP 400-class validation failures) do **not** fall back — the
same request would fail again anywhere. Provider 401/403 (expired/revoked key) **does**
fall back so users keep working, and additionally emits a loud structured server log
(`provider_auth_failure`) because it is an ops incident. The request log records `fallbackModel` (new
`UsageExtras` field) so fallback rate is observable. Streaming: fallback applies only if
the primary fails **before the first token**; a mid-stream failure surfaces through the
existing stream-error path (the editor's error block + retry already handle it).

### Costs (`src/lib/costs.ts`)

- Add `MODEL_CATALOG` entries for `custom-minimax/MiniMax-M3` and
  `custom-moonshot/kimi-k3` with real per-token prices, `contextWindow`, `maxOutput`
  (taken from provider pricing pages at implementation time; the entry structure is
  already defined).
- Keep existing entries (fallbacks still bill correctly).
- **Guard test**: every model referenced by `INTENSITY_CONFIG` (including the inline
  model) must have a `MODEL_CATALOG` entry — closes the standing footgun where
  `estimateCost` returns 0 for unknown ids and silently skips the credit debit.

### Error mapping (`classifyStreamError` + editor taxonomy)

New classifications flowing into the existing structured-code channel (SSE `error` event
with `code`): `provider_rate_limit`, `provider_auth_failure`, `provider_unavailable`,
`gateway_timeout`. The editor's `turn-errors.ts` maps them to human copy; when the
fallback succeeded the user sees nothing.

### Config & ops (one-time)

- `wrangler.toml`: add `CF_ACCOUNT_ID` to `[vars]` for prod, `[env.dev]`, and
  `wrangler.test.toml` (test value fake). Bindings are not inherited across envs — set all.
- Secrets (prod + dev): `wrangler secret put MINIMAX_API_KEY`, `MOONSHOT_API_KEY`.
- Dashboard/API: register custom providers `minimax` and `moonshot` (OpenAI-compatible
  base URLs from provider docs) on both gateways.
- **Rotate the MiniMax key currently sitting in `editor/.env` (`MINMAX=...`) and delete
  that line** — it is a plaintext live-looking secret in the working tree.

---

## Part 2 — Shadow/tab completions

### Server: `POST /v1/completions/inline`

Gated by `authMiddleware()` + `requireVerifiedEmail()` like every AI route.

**Request** `{ prefix: string, suffix: string, language: string, path?: string }`
- Client clamps prefix to last 4,000 chars, suffix to first 2,000. Server re-clamps
  defensively; body over 32 KB → 413. Missing/invalid fields → 400.

**Allowance (no credit burn)** — `checkInlineAllowance(db, userId)`:
- New table `inline_usage (user_id, usage_date /* UTC */, count)` — one upsert per
  request, O(1). New D1 migration (next sequential number at implementation time).
- Daily caps by plan: free **300**, pro **4,000**, proplus/ultra **10,000** (abuse
  ceilings, not product limits; constants in `src/config/tiers.ts`).
- Over cap → 429 `{ error, code: 'inline_quota', resetAt }` (next UTC midnight).
- Burst backstop: new Cloudflare rate-limit binding `RL_INLINE` (30 req/60 s, keyed by
  user id) → 429 `inline_quota` with a one-minute `resetAt`.
- No `checkAiBudget` call: completions never debit credits and are exempt from the
  $1/hour cap. `recordUsage` is called with a new `skipDebit` option so token counts
  still land in `usage_periods`/`request_log` (taskType `inline`) for COGS telemetry.

**Model call** — direct `env.AI.run` (with the existing `gateway: { id }` option), not
the chat AI SDK path, because FIM is a raw completion:
- Prompt: Qwen2.5-coder native fill-in-middle format
  `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>`.
- Params: `max_tokens: 128`, `temperature: 0.2`, `top_p: 0.9`,
  stop: `["<|fim_pad|>", "<|endoftext|>", "<|fim_prefix|>"]`.
- Worker-side 5 s abort → 504 `{ code: 'inline_timeout' }`.

**Response** `{ text: string, model: string }`
- Server post-processing: strip trailing whitespace; return `text: ""` (200) for
  whitespace-only, empty, or degenerate outputs (suggestion that merely repeats the
  start of the suffix). Empty text is the "no suggestion" signal — never an error.

### Editor: `editor/src/features/inline-suggest/`

New deep-module feature (barrel `index.ts`), services pure and DI-friendly for `bun test`.

**Provider** — `registerInlineSuggestProvider(monaco): IDisposable`, registered in
`EditorPanel.tsx` `beforeMount` beside the existing providers
(shape copied from `usage-hover-provider.ts`). `inlineSuggest: { enabled: true }` set
explicitly in editor options. Ghost text, Tab-accept, Esc-dismiss, and word-level partial
accept are Monaco built-ins.

**Request discipline** (the Cursor feel):
- ~250 ms idle debounce implemented against Monaco's `CancellationToken` — if the user
  keeps typing, the pending invocation cancels before any network call.
- Single-flight client (`inline-client.ts`, DI `fetchImpl`): a new request aborts the
  in-flight one; 4 s `AbortController` timeout; **zero retries** (a late completion is a
  wrong completion).
- LRU cache (~50 entries) keyed by `hash(path + tail(prefix, 500) + head(suffix, 200))`.
- **Type-through reuse**: when typed characters exactly match the front of the last
  suggestion, trim and re-serve it locally without a network call.

**Gating** — provider returns nothing (cheaply, before any work) when: file > 1 MB
(existing `isLargeFile` gate), non-`file://` tab (auth://, diff views), signed out,
`ai.inlineSuggestions.enabled` false, offline (connectivity store, Part 3), or circuit
breaker open.

**Silent failure + status** — failures never toast. New StatusBar item with states:
- **active** (default), **disabled** (setting off), **paused — quota** (429
  `inline_quota`; auto-resumes at `resetAt`, tooltip shows reset time),
- **offline**, **backoff** (circuit breaker: 3 consecutive failures → pause 60 s →
  single probe request → close or re-open), **signed out**.

**Settings & commands**
- `ai.inlineSuggestions.enabled` (default `true`) added to `DEFAULT_SETTINGS`,
  `SettingsSchema`, and the Settings panel (AI section).
- Command `ai.toggleInlineSuggestions` ("Toggle AI Inline Suggestions") in the command
  registry; keybinding chosen at implementation time from the free list (physical-key
  tokens per the react-hotkeys-hook v5 lesson).

---

## Part 3 — Edge-case hardening sweep

Existing coverage (kept as-is): chat retry with linear backoff, connect/first-token/idle
watchdogs, 401/403 auth notice, 402 stop + balance refresh, 429 copy, corrupted-stream
detection, structured server codes, retry-from-error-block. The gaps closed here:

**Offline ("internet was down")**
- New connectivity store (`editor/src/stores/connectivity.ts`): `navigator.onLine`
  seed + `online`/`offline` window events; a failed fetch that throws `TypeError` also
  flips it offline (belt-and-suspenders — `onLine` can lie).
- Chat send while offline fails **immediately** with "You're offline — check your
  connection" (no 3×180 s retry churn); the attempt is not counted against retries.
- Inline provider pauses (status: offline). On `online`, both resume automatically; the
  chat error block offers one-click retry via the existing retry-turn machinery.

**Plan limit over ("your plan's limit is over")**
- 402 error block gains a **"Manage plan & credits"** action → existing `openBilling()`.
- StatusBar credit warning when balance < 10 credits (reads `useAuthStore.credits`,
  refreshed by the existing post-402/refreshUsage flows).
- Inline `inline_quota` → paused indicator with reset tooltip; no toasts, no nagging.

**Server failing / server error**
- Layer 1: provider-outage fallback to CF models (Part 1) — invisible to users.
- Layer 2: inline circuit breaker (Part 2).
- Layer 3: taxonomy additions in `turn-errors.ts` (`inline_quota`, `inline_timeout`,
  `provider_rate_limit`, `provider_auth_failure`, `provider_unavailable`,
  `gateway_timeout`) with human copy — nothing renders as a raw 500/stack.
- Provider-key failure logs loudly server-side (`provider_auth_failure` structured log)
  for ops while users ride the fallback.

**Auth expiry**
- Chat: existing 401 → clear auth → sign-in gate (unchanged).
- Inline: 401 → pause with **signed out** status (no toast spam); resumes on sign-in.

---

## Testing

**Server (vitest + workers pool, real D1):**
- `checkInlineAllowance`: per-plan caps, UTC-midnight rollover, counter upsert.
- Inline route matrix: 400 (bad body), 401, 403 (unverified), 413, 429 (quota + burst),
  504 (timeout), 200-empty (degenerate output).
- `resolveModel`: `@cf/*` vs external branching; provider→secret selection; typed error
  when `CF_ACCOUNT_ID`/secret missing.
- Fallback: mocked gateway fetch — 5xx/timeout/429 → one fallback attempt; provider 401
  → fallback + `provider_auth_failure` log; 400 → no fallback; `fallbackModel` recorded.
- Catalog guard: every `INTENSITY_CONFIG` model (incl. inline) has a `MODEL_CATALOG` entry.
- Raw-JSON serde tests for any new invoke/request payload shapes (standing lesson).

**Editor (bun test src):**
- Debounce/cancellation scheduler (token cancelled → no fetch).
- Single-flight abort + 4 s timeout.
- LRU + type-through trimming.
- Circuit-breaker state machine (closed → open → half-open probe → closed/open).
- Connectivity store transitions (events + fetch-failure signal).
- Gating matrix (large file / non-file tab / signed out / disabled / offline / breaker).

**Manual QA** (appended to `docs/superpowers/plans/2026-07-14-ai-agent-overhaul-manual-checklist.md`):
kill wifi mid-stream and mid-typing; exhaust a dev account's credits (402 path + billing
CTA); revoke a provider key on the dev gateway (fallback + ops log); hammer inline past
the daily cap (pause + reset); verify Tab-accept/Esc/partial-accept feel in real files.

## Rollout

1. Phase A (routing) ships behind no flag — tier map change is server-side and instant;
   verify on dev (`api-dev` + `arcane-ai-gateway-dev`) before prod deploy.
2. Phase B (inline) ships with `ai.inlineSuggestions.enabled` default **true**; the
   setting is the kill switch. Server endpoint deploys before the editor release that
   calls it.
3. Phase C (hardening) lands with B where shared (status bar), independently elsewhere.

## Risks

- **External latency/quality**: MiniMax/Moonshot latency from CF POPs is unproven here;
  fallback + gateway logs give observability. Tier map is config — cheap to revert.
- **Qwen FIM quality in Unity/C# context**: acceptable for v1; the eval harness
  (`editor/tooling/unity-eval`) can grow an inline-completion eval later if needed.
- **Quota costs**: caps bound worst-case COGS (10k × ~2k tokens/day/user on Qwen coder
  is cents); telemetry (`taskType: 'inline'`) makes real COGS visible from day one.
