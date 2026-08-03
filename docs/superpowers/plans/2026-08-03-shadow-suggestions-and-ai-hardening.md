# Shadow Suggestions, External Model Routing & AI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route MiniMax 3 / Kimi 3 through Cloudflare AI Gateway custom providers, add Cursor-Tab-style inline AI completions powered by Qwen2.5-coder, and close the remaining AI edge-case gaps (offline, quotas, provider outages, credit exhaustion).

**Architecture:** Three phases. (A) `llm-router.ts` grows an external branch: non-`@cf/` model ids go to the gateway's `/compat` endpoint via `@ai-sdk/openai-compatible`, with provider keys as Worker secrets and one-shot fallback to CF-catalog models. (B) A new non-streaming `POST /v1/completions/inline` endpoint (FIM prompt → `env.AI.run`, per-plan daily allowance, no credit debit) feeds a Monaco `InlineCompletionsProvider` in a new `editor/src/features/inline-suggest/` module (debounce, single-flight, LRU + type-through cache, circuit breaker, silent failure + status-bar item). (C) Connectivity store with offline fast-fail, new error-taxonomy entries, credits CTA.

**Tech Stack:** Cloudflare Worker (Hono 4, `ai` v6, `workers-ai-provider`, D1), React 19 + Zustand + Monaco 0.55 (Tauri v2), vitest workers pool (server), bun test (editor).

**Spec:** `docs/superpowers/specs/2026-08-03-shadow-suggestions-and-ai-hardening-design.md` (approved 2026-08-03).

## Global Constraints

- Server package manager is **npm** (`arcane-server/`); editor is **bun** (`editor/`). Never mix.
- Server tests: `cd arcane-server && npm test`; types: `npm run check:types`. Editor tests: `cd editor && bun test src`; deep-module lint: `bun run check:modules`.
- Editor features expose ONLY their `index.ts` barrel (`editor/CLAUDE.md`). Stores live in `editor/src/stores/`.
- Editor services must be pure/DI-friendly (bun test, no jsdom): no top-level `monaco-editor` runtime imports in services with tests (type-only or structural types instead).
- Tier map (spec): low = `custom-minimax/MiniMax-M3`, mid = `@cf/zai-org/glm-5.2`, high = super = `custom-moonshot/kimi-k3`, inline = `@cf/qwen/qwen2.5-coder-32b-instruct`.
- Inline daily caps (spec): free 300, pro 4000, proplus 10000, ultra 10000. Inline requests NEVER debit credits.
- Inline endpoint is non-streaming, `max_tokens: 128`, `temperature: 0.2`, `top_p: 0.9`, 5s server timeout.
- Editor inline client: 250ms debounce, 4s timeout, zero retries, silent failure (no toasts).
- New error codes (exact strings): `inline_quota`, `inline_timeout`, `inline_bad_request`, `inline_too_large`, `inline_unavailable`, `inline_error`, `provider_rate_limit`, `provider_auth_failure`, `provider_unavailable`, `gateway_timeout`.
- wrangler bindings/vars are NOT inherited into `[env.dev]` — every addition goes in prod block, `[env.dev]` block, AND `wrangler.test.toml`.
- Commit after every task. Conventional-commit style messages (`feat(server): …`, `feat(editor): …`).

---

# Phase A — External model routing via AI Gateway

### Task A1: Model catalog + tier map + guard test

**Files:**
- Modify: `arcane-server/src/config/plans.ts`
- Modify: `arcane-server/src/lib/costs.ts`
- Test: `arcane-server/test/model-catalog.test.ts` (create)

**Interfaces:**
- Consumes: existing `INTENSITY_CONFIG`, `MODEL_CATALOG`.
- Produces: `INLINE_MODEL: string` exported from `plans.ts`; `MODEL_CATALOG` entries for `custom-minimax/MiniMax-M3` and `custom-moonshot/kimi-k3`; `ModelInfo.provider` widened to `'workers-ai' | 'minimax' | 'moonshot'`. Later tasks import `INLINE_MODEL` and rely on `getMaxOutput`/`estimateCost` working for the new ids.

- [ ] **Step 1: Write the failing guard test**

```ts
// arcane-server/test/model-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { INTENSITY_CONFIG, INLINE_MODEL } from '../src/config/plans.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';

describe('model catalog coverage', () => {
    it('every routed model (intensity tiers + inline) has a MODEL_CATALOG entry', () => {
        const routed = new Set<string>([
            ...Object.values(INTENSITY_CONFIG).map((c) => c.model),
            INLINE_MODEL,
        ]);
        for (const model of routed) {
            expect(
                MODEL_CATALOG[model],
                `MODEL_CATALOG is missing "${model}" — estimateCost() would return $0 and silently skip the credit debit`,
            ).toBeDefined();
        }
    });

    it('tier map matches the approved spec', () => {
        expect(INTENSITY_CONFIG.low.model).toBe('custom-minimax/MiniMax-M3');
        expect(INTENSITY_CONFIG.mid.model).toBe('@cf/zai-org/glm-5.2');
        expect(INTENSITY_CONFIG.high.model).toBe('custom-moonshot/kimi-k3');
        expect(INTENSITY_CONFIG.super.model).toBe('custom-moonshot/kimi-k3');
        expect(INLINE_MODEL).toBe('@cf/qwen/qwen2.5-coder-32b-instruct');
    });
});
```

- [ ] **Step 2: Run it — must fail** (`INLINE_MODEL` not exported, old tier map)

Run: `cd arcane-server && npx vitest run test/model-catalog.test.ts`
Expected: FAIL ("INLINE_MODEL" has no exported member / tier assertions fail)

- [ ] **Step 3: Update `plans.ts`** — replace the `INTENSITY_CONFIG` literal and add `INLINE_MODEL`; update the file-header comment (it currently claims "All ids are Cloudflare Workers AI catalog models … No external provider keys" — now wrong):

```ts
// low/high route to EXTERNAL providers (MiniMax, Moonshot) through the AI
// Gateway's /compat endpoint using custom-provider slugs — see
// services/llm-router.ts. mid + inline stay on the Workers AI binding.
// The "FROZEN — CF only" constraint was lifted by the 2026-08-03 design.
// ⚠️ Verify the exact upstream model-id strings when registering the custom
// providers (see the manual-setup runbook); they are config, not code.

export const INTENSITY_CONFIG: Record<Intensity, IntensityConfig> = {
    low:   { model: 'custom-minimax/MiniMax-M3', label: 'Low' },
    mid:   { model: '@cf/zai-org/glm-5.2',       label: 'Mid' },
    high:  { model: 'custom-moonshot/kimi-k3',   label: 'High' },
    super: { model: 'custom-moonshot/kimi-k3',   label: 'Extra High' }, // alias of high until a dedicated model is chosen
};

/** Model for inline (tab) completions — cheap, fast, FIM-capable, CF binding. */
export const INLINE_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
```

- [ ] **Step 4: Update `costs.ts`** — widen the provider union and add the two external entries (keep every existing entry — they are the fallbacks):

```ts
interface ModelInfo {
    provider: 'workers-ai' | 'minimax' | 'moonshot';
    // …rest unchanged
}
```

Add to `MODEL_CATALOG`:

```ts
    // low — MiniMax M3 via AI Gateway custom provider. ⚠️ Prices below are
    // provisional — confirm against MiniMax's pricing page during the manual
    // setup (runbook) and adjust; wrong prices skew credit debits.
    'custom-minimax/MiniMax-M3':  { provider: 'minimax',  inputCostPer1M: 0.40, outputCostPer1M: 2.20, contextWindow: 200000, maxOutput: 32000, tier: 'fast' },
    // high/super — Kimi 3 via AI Gateway custom provider. Same price caveat.
    'custom-moonshot/kimi-k3':    { provider: 'moonshot', inputCostPer1M: 0.60, outputCostPer1M: 2.50, contextWindow: 256000, maxOutput: 32000, tier: 'premium' },
```

- [ ] **Step 5: Run the test — must pass**

Run: `cd arcane-server && npx vitest run test/model-catalog.test.ts`
Expected: PASS

- [ ] **Step 6: Full server suite + types** (catches anything asserting the old tier map)

Run: `cd arcane-server && npm test && npm run check:types`
Expected: PASS. If an existing test pinned the old models, update it to import from `plans.ts` rather than hard-coding ids.

- [ ] **Step 7: Commit**

```bash
git add arcane-server/src/config/plans.ts arcane-server/src/lib/costs.ts arcane-server/test/model-catalog.test.ts
git commit -m "feat(server): new tier map (MiniMax M3 low, GLM mid, Kimi 3 high) + catalog guard test"
```

---

### Task A2: External-provider branch in llm-router

**Files:**
- Modify: `arcane-server/src/services/llm-router.ts`
- Modify: `arcane-server/package.json` (new dependency)
- Test: `arcane-server/test/llm-router.test.ts` (create)

**Interfaces:**
- Consumes: `createOpenAICompatible` from new dep `@ai-sdk/openai-compatible`.
- Produces (all exported from `llm-router.ts`):
  - `interface ExternalRoutingEnv { CF_ACCOUNT_ID?: string; MINIMAX_API_KEY?: string; MOONSHOT_API_KEY?: string }`
  - `type LlmEnv = WorkersAiEnv & ExternalRoutingEnv`
  - `class LlmConfigError extends Error`
  - `isExternalModel(modelId: string): boolean`
  - `externalApiKey(modelId: string, env: ExternalRoutingEnv): string` (throws `LlmConfigError`)
  - `gatewayCompatUrl(env: ExternalRoutingEnv & { CF_AI_GATEWAY_ID?: string }): string` (throws `LlmConfigError`)
  - `resolveModel(modelId: string, env: LlmEnv, gatewayOverrides?: GatewayOverrides)` — handles both branches. Existing call sites (`routes/embeddings.ts`, `routes/graph.ts`) pass `c.env`, which structurally satisfies `LlmEnv` — no change needed there.

- [ ] **Step 1: Install the OpenAI-compatible AI SDK provider** (major must match `ai@^6`):

Run: `cd arcane-server && npm install @ai-sdk/openai-compatible@latest`
Then: `npx vitest run test/health.test.ts` to confirm the install didn't break the pool.

- [ ] **Step 2: Write the failing tests**

```ts
// arcane-server/test/llm-router.test.ts
import { describe, it, expect } from 'vitest';
import {
    isExternalModel, externalApiKey, gatewayCompatUrl, resolveModel, LlmConfigError,
} from '../src/services/llm-router.ts';

const FULL_ENV = {
    AI: {} as Ai,
    CF_AI_GATEWAY_ID: 'gw-test',
    CF_ACCOUNT_ID: 'acct-test',
    MINIMAX_API_KEY: 'mk-test',
    MOONSHOT_API_KEY: 'msk-test',
};

describe('external model routing', () => {
    it('classifies @cf/ ids as internal, everything else as external', () => {
        expect(isExternalModel('@cf/zai-org/glm-5.2')).toBe(false);
        expect(isExternalModel('custom-minimax/MiniMax-M3')).toBe(true);
        expect(isExternalModel('custom-moonshot/kimi-k3')).toBe(true);
    });

    it('maps each custom-provider prefix to its secret', () => {
        expect(externalApiKey('custom-minimax/MiniMax-M3', FULL_ENV)).toBe('mk-test');
        expect(externalApiKey('custom-moonshot/kimi-k3', FULL_ENV)).toBe('msk-test');
    });

    it('throws LlmConfigError when the needed secret is missing', () => {
        expect(() => externalApiKey('custom-minimax/MiniMax-M3', {})).toThrow(LlmConfigError);
        expect(() => externalApiKey('custom-unknown/x', FULL_ENV)).toThrow(LlmConfigError);
    });

    it('builds the gateway /compat base URL and throws without CF_ACCOUNT_ID', () => {
        expect(gatewayCompatUrl(FULL_ENV)).toBe('https://gateway.ai.cloudflare.com/v1/acct-test/gw-test/compat');
        expect(() => gatewayCompatUrl({ CF_AI_GATEWAY_ID: 'gw-test' })).toThrow(LlmConfigError);
        expect(() => gatewayCompatUrl({ CF_ACCOUNT_ID: 'acct-test' })).toThrow(LlmConfigError);
    });

    it('resolveModel returns an AI SDK model carrying the requested id (both branches)', () => {
        expect(resolveModel('custom-minimax/MiniMax-M3', FULL_ENV).modelId).toBe('custom-minimax/MiniMax-M3');
        expect(resolveModel('@cf/zai-org/glm-5.2', FULL_ENV).modelId).toBe('@cf/zai-org/glm-5.2');
    });
});
```

- [ ] **Step 3: Run — must fail** (`isExternalModel` not exported, etc.)

Run: `cd arcane-server && npx vitest run test/llm-router.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement in `llm-router.ts`** (add below `workersAiProvider`; replace the current `resolveModel`; update the file-header comment that says "no provider API keys"):

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// External providers (MiniMax, Moonshot) are reached through the AI Gateway's
// unified /compat endpoint using custom-provider slugs. Keys are Worker
// secrets sent per-request as the Authorization header (owner declined BYOK).
export interface ExternalRoutingEnv {
    CF_ACCOUNT_ID?: string;
    MINIMAX_API_KEY?: string;
    MOONSHOT_API_KEY?: string;
}

export type LlmEnv = WorkersAiEnv & ExternalRoutingEnv;

/** Configuration (not model) failure: missing account id / gateway / secret. */
export class LlmConfigError extends Error {}

export function isExternalModel(modelId: string): boolean {
    return !modelId.startsWith('@cf/');
}

export function externalApiKey(modelId: string, env: ExternalRoutingEnv): string {
    if (modelId.startsWith('custom-minimax/')) {
        if (!env.MINIMAX_API_KEY) throw new LlmConfigError('MINIMAX_API_KEY secret is not set');
        return env.MINIMAX_API_KEY;
    }
    if (modelId.startsWith('custom-moonshot/')) {
        if (!env.MOONSHOT_API_KEY) throw new LlmConfigError('MOONSHOT_API_KEY secret is not set');
        return env.MOONSHOT_API_KEY;
    }
    throw new LlmConfigError(`No provider key mapping for model "${modelId}"`);
}

export function gatewayCompatUrl(env: ExternalRoutingEnv & { CF_AI_GATEWAY_ID?: string }): string {
    if (!env.CF_ACCOUNT_ID) throw new LlmConfigError('CF_ACCOUNT_ID is not set');
    if (!env.CF_AI_GATEWAY_ID) throw new LlmConfigError('CF_AI_GATEWAY_ID is not set');
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/compat`;
}

export function resolveModel(modelId: string, env: LlmEnv, gatewayOverrides?: GatewayOverrides) {
    if (!isExternalModel(modelId)) {
        return workersAiProvider(env, gatewayOverrides)(modelId);
    }
    const provider = createOpenAICompatible({
        name: 'ai-gateway-compat',
        baseURL: gatewayCompatUrl(env),
        apiKey: externalApiKey(modelId, env),
    });
    return provider(modelId);
}
```

Also change `streamCompletion`'s signature to `env: LlmEnv` (it currently takes `WorkersAiEnv`).

- [ ] **Step 5: Run — must pass; then full suite + types**

Run: `cd arcane-server && npx vitest run test/llm-router.test.ts && npm test && npm run check:types`
Expected: PASS. Note: if `resolveModel(…).modelId` fails because the workers-ai provider nests the id differently, assert `typeof resolveModel(...)` is `'object'` and non-null for the `@cf/` branch instead — the external branch's `modelId` assertion must stay.

- [ ] **Step 6: Commit**

```bash
git add arcane-server/src/services/llm-router.ts arcane-server/test/llm-router.test.ts arcane-server/package.json arcane-server/package-lock.json
git commit -m "feat(server): route non-@cf models through AI Gateway /compat with per-provider secrets"
```

---

### Task A3: Provider-failure fallback + fallback telemetry

**Files:**
- Create: `arcane-server/migrations/0014_ai_routing.sql`
- Modify: `arcane-server/src/services/llm-router.ts`
- Modify: `arcane-server/src/types.ts`
- Modify: `arcane-server/src/routes/chat.ts`
- Modify: `arcane-server/src/lib/usage.ts`
- Modify: `arcane-server/src/lib/db.ts` (`createRequestLog`)
- Test: `arcane-server/test/llm-router.test.ts` (extend), `arcane-server/test/usage.test.ts` (extend)

**Interfaces:**
- Produces:
  - `StreamEvent` gains `| { type: 'fallback'; model: string }`; error variant's `code` widens to `'model_error' | 'rate_limit' | 'server_error' | 'provider_rate_limit' | 'provider_auth_failure' | 'provider_unavailable' | 'gateway_timeout'`.
  - `llm-router.ts` exports `fallbackModelFor(modelId: string): string | null`, `shouldFallback(error: unknown): boolean`, `classifyStreamError(error: unknown, externalModel: boolean): StreamEvent extends … (the widened code union minus 'server_error')`, and `streamCompletion(req, env, streamTextImpl = streamText)` (DI param for tests).
  - `UsageExtras` gains `fallbackModel?: string` and `skipDebit?: boolean` (skipDebit consumed here, used by Phase B).
  - `request_logs.fallback_model` column. Semantics: `request_logs.model` = the model that actually served; `fallback_model` = non-null (set to that same serving id) iff a fallback occurred.
- Consumes: A2's exports.

- [ ] **Step 1: Migration**

```sql
-- arcane-server/migrations/0014_ai_routing.sql
-- Fallback observability: when an external provider (MiniMax/Moonshot) fails
-- before first token and a CF-catalog model serves instead, `model` records
-- the ACTUAL serving model and `fallback_model` is set to it (non-null ⇒
-- fallback happened). NOTE: ADD COLUMN is not idempotent (see 0013 header).
ALTER TABLE request_logs ADD COLUMN fallback_model TEXT;
```

Run: `cd arcane-server && npm run db:migrate:local`
Expected: applies cleanly. (The vitest pool applies migrations automatically via `test/apply-migrations.ts` — no test change needed.)

- [ ] **Step 2: Write failing router tests** (append to `test/llm-router.test.ts`):

```ts
import { fallbackModelFor, shouldFallback, classifyStreamError, streamCompletion } from '../src/services/llm-router.ts';
import type { ChatCompletionRequest, StreamEvent } from '../src/types.ts';

describe('fallback policy', () => {
    it('maps external models to CF fallbacks, CF models to null', () => {
        expect(fallbackModelFor('custom-minimax/MiniMax-M3')).toBe('@cf/qwen/qwen2.5-coder-32b-instruct');
        expect(fallbackModelFor('custom-moonshot/kimi-k3')).toBe('@cf/zai-org/glm-5.2');
        expect(fallbackModelFor('@cf/zai-org/glm-5.2')).toBeNull();
    });

    it('falls back on 5xx/429/timeout/provider-auth, not on request errors', () => {
        expect(shouldFallback({ statusCode: 500 })).toBe(true);
        expect(shouldFallback({ statusCode: 429 })).toBe(true);
        expect(shouldFallback({ statusCode: 401 })).toBe(true);  // expired key → users keep working
        expect(shouldFallback(new Error('fetch failed'))).toBe(true);
        expect(shouldFallback({ statusCode: 400 })).toBe(false);
        expect(shouldFallback({ statusCode: 422 })).toBe(false);
    });

    it('classifies external errors with provider_* codes', () => {
        expect(classifyStreamError({ statusCode: 429 }, true)).toBe('provider_rate_limit');
        expect(classifyStreamError({ statusCode: 401 }, true)).toBe('provider_auth_failure');
        expect(classifyStreamError({ statusCode: 503 }, true)).toBe('provider_unavailable');
        expect(classifyStreamError(new Error('gateway timed out'), true)).toBe('gateway_timeout');
        expect(classifyStreamError({ statusCode: 429 }, false)).toBe('rate_limit');
        expect(classifyStreamError(new Error('capacity'), false)).toBe('rate_limit');
        expect(classifyStreamError(new Error('boom'), false)).toBe('model_error');
    });
});

describe('streamCompletion fallback', () => {
    const REQ: ChatCompletionRequest = {
        model: 'custom-minimax/MiniMax-M3',
        messages: [{ role: 'user', content: 'hi' }],
    };

    function fakeStreamText(partsByCall: Array<Array<Record<string, unknown>>>) {
        let call = 0;
        const fn = () => {
            const parts = partsByCall[Math.min(call, partsByCall.length - 1)];
            call += 1;
            return { fullStream: (async function* () { for (const p of parts) yield p; })() };
        };
        return fn as unknown as typeof import('ai').streamText;
    }

    it('emits a fallback event and the fallback model’s output when the primary errors pre-token', async () => {
        const impl = fakeStreamText([
            [{ type: 'error', error: { statusCode: 503 } }],
            [{ type: 'text-delta', text: 'hello' }],
        ]);
        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, FULL_ENV, impl)) events.push(e);
        expect(events).toEqual([
            { type: 'fallback', model: '@cf/qwen/qwen2.5-coder-32b-instruct' },
            { type: 'text', content: 'hello' },
        ]);
    });

    it('does NOT fall back after content has streamed', async () => {
        const impl = fakeStreamText([
            [{ type: 'text-delta', text: 'partial' }, { type: 'error', error: { statusCode: 503 } }],
        ]);
        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, FULL_ENV, impl)) events.push(e);
        expect(events[0]).toEqual({ type: 'text', content: 'partial' });
        expect(events[1]?.type).toBe('error');
    });

    it('falls back at most once (fallback errors surface as errors)', async () => {
        const impl = fakeStreamText([[{ type: 'error', error: { statusCode: 503 } }]]);
        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, FULL_ENV, impl)) events.push(e);
        expect(events[0]?.type).toBe('fallback');
        expect(events[1]?.type).toBe('error');
    });

    it('falls back immediately on a config error (missing secret)', async () => {
        const impl = fakeStreamText([[{ type: 'text-delta', text: 'cf' }]]);
        const envNoKey = { ...FULL_ENV, MINIMAX_API_KEY: undefined };
        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, envNoKey, impl)) events.push(e);
        expect(events[0]).toEqual({ type: 'fallback', model: '@cf/qwen/qwen2.5-coder-32b-instruct' });
        expect(events[1]).toEqual({ type: 'text', content: 'cf' });
    });
});
```

- [ ] **Step 3: Run — must fail**

Run: `cd arcane-server && npx vitest run test/llm-router.test.ts`
Expected: FAIL (missing exports)

- [ ] **Step 4: Implement in `llm-router.ts`**

Widen/replace `classifyStreamError` (export it) and add the fallback machinery; restructure `streamCompletion` into a thin wrapper + `streamOnce`:

```ts
export type StreamErrorCode =
    | 'rate_limit' | 'model_error'
    | 'provider_rate_limit' | 'provider_auth_failure' | 'provider_unavailable' | 'gateway_timeout';

export function classifyStreamError(error: unknown, externalModel: boolean): StreamErrorCode {
    const status = typeof error === 'object' && error !== null
        ? (error as { statusCode?: number }).statusCode
        : undefined;
    if (externalModel) {
        if (status === 429) return 'provider_rate_limit';
        if (status === 401 || status === 403) return 'provider_auth_failure';
        if (status !== undefined && status >= 500) return 'provider_unavailable';
        if (/timeout|timed out/i.test(String(error))) return 'gateway_timeout';
        return 'model_error';
    }
    if (status === 429) return 'rate_limit';
    return /rate limit|\b3036\b|\b3040\b|capacity/i.test(String(error)) ? 'rate_limit' : 'model_error';
}

// One-shot CF-catalog fallback per external model, so chat survives a
// MiniMax/Moonshot outage. Keys must exist in MODEL_CATALOG (guard test A1).
const FALLBACK_MODEL: Record<string, string> = {
    'custom-minimax/MiniMax-M3': '@cf/qwen/qwen2.5-coder-32b-instruct',
    'custom-moonshot/kimi-k3':   '@cf/zai-org/glm-5.2',
};

export function fallbackModelFor(modelId: string): string | null {
    return FALLBACK_MODEL[modelId] ?? null;
}

/** 400-class request errors would fail identically anywhere — no fallback.
 *  Everything else (5xx, 429, network/timeout, provider 401/403) falls back. */
export function shouldFallback(error: unknown): boolean {
    const status = typeof error === 'object' && error !== null
        ? (error as { statusCode?: number }).statusCode
        : undefined;
    if (status !== undefined && status >= 400 && status < 500
        && status !== 401 && status !== 403 && status !== 429) return false;
    return true;
}

type StreamTextFn = typeof streamText;

export async function* streamCompletion(
    req: ChatCompletionRequest, env: LlmEnv, streamTextImpl: StreamTextFn = streamText,
): AsyncGenerator<StreamEvent> {
    let modelId = req.model;
    let allowFallback = true;
    // A missing secret / account id is a config failure, not a model failure —
    // fall back immediately (and loudly) instead of 500ing the request.
    try {
        resolveModel(modelId, env, { skipCache: true });
    } catch (err) {
        const fb = err instanceof LlmConfigError ? fallbackModelFor(modelId) : null;
        if (!fb) throw err;
        console.error(JSON.stringify({ event: 'provider_config_fallback', model: modelId, fallback: fb, message: String(err) }));
        yield { type: 'fallback', model: fb };
        modelId = fb;
        allowFallback = false;
    }
    yield* streamOnce(req, modelId, env, allowFallback, streamTextImpl);
}

async function* streamOnce(
    req: ChatCompletionRequest, modelId: string, env: LlmEnv,
    allowFallback: boolean, streamTextImpl: StreamTextFn,
): AsyncGenerator<StreamEvent> {
    const model = resolveModel(modelId, env, { skipCache: true });
    const messages = convertMessages(req.messages);
    const tools = convertTools(req.tools);
    const cap = getMaxOutput(modelId);
    const maxOutputTokens = Math.min(req.max_tokens ?? 8192, cap);

    const result = streamTextImpl({
        model, messages, ...(tools ? { tools } : {}), maxOutputTokens, temperature: req.temperature,
    });

    let yieldedContent = false;
    for await (const part of result.fullStream) {
        switch (part.type) {
            // text-delta / tool-call / reasoning-delta cases: unchanged bodies,
            // but each also sets `yieldedContent = true` before yielding.
            // usage/finish case: unchanged.
            case 'error': {
                const external = isExternalModel(modelId);
                const fb = fallbackModelFor(modelId);
                if (allowFallback && fb && !yieldedContent && shouldFallback(part.error)) {
                    console.error(JSON.stringify({
                        event: 'provider_fallback', model: modelId, fallback: fb,
                        code: classifyStreamError(part.error, external), message: String(part.error),
                    }));
                    yield { type: 'fallback', model: fb };
                    yield* streamOnce(req, fb, env, false, streamTextImpl);
                    return;
                }
                yield { type: 'error', code: classifyStreamError(part.error, external), message: String(part.error) };
                break;
            }
        }
    }
}
```

Carry over the existing `text-delta`/`tool-call`/`finish`/`reasoning-delta` case bodies verbatim from the current `streamCompletion` (including the `cached_input_tokens` comment), adding `yieldedContent = true` to the three content-bearing cases.

- [ ] **Step 5: `types.ts`** — widen `StreamEvent`:

```ts
export type StreamEvent =
    | { type: 'text'; content: string }
    | { type: 'tool_call'; id: string; name: string; arguments: string; finished: boolean }
    | { type: 'usage'; input_tokens: number; output_tokens: number; cached_input_tokens?: number }
    | { type: 'thinking'; thought: string; signature: string }
    | { type: 'fallback'; model: string }
    | { type: 'error'; code?: 'model_error' | 'rate_limit' | 'server_error' | 'provider_rate_limit' | 'provider_auth_failure' | 'provider_unavailable' | 'gateway_timeout'; message: string };
```

- [ ] **Step 6: `usage.ts` + `db.ts`** — add to `UsageExtras`:

```ts
    /** Actual serving model when a provider fallback fired (non-null ⇒ fallback). */
    fallbackModel?: string;
    /** Inline completions: meter tokens but never debit credits (allowance model). */
    skipDebit?: boolean;
```

In `recordUsage`, destructure so `skipDebit` never reaches the log row and gates the debit:

```ts
    const { skipDebit, ...logExtras } = extras;
    // …createRequestLog({ userId, model, …, ...logExtras })
    // debit arm becomes:
    micro > 0 && !skipDebit
        ? debitCredits(db, userId, micro).catch(err => console.error('Failed to debit credits:', err))
        : Promise.resolve(),
```

In `db.ts` `createRequestLog`: add `fallbackModel?: string` to the `data` type, `fallback_model` to the column list, and `data.fallbackModel ?? null` to the binds (17 → 18 placeholders).

- [ ] **Step 7: Failing-then-passing usage tests** (append to `test/usage.test.ts`; read the file first and reuse its imports — the code below only needs `env`, `seedPasswordUser`, and `recordUsage`):

```ts
it('skipDebit meters tokens without touching the credit balance', async () => {
    const user = await seedPasswordUser('skipdebit@test.dev', 'password123');
    await env.arcane_db.prepare('UPDATE users SET plan_credits_micro = 500000 WHERE id = ?')
        .bind(user.id).run();

    await recordUsage(env.arcane_db, user.id, '@cf/qwen/qwen2.5-coder-32b-instruct',
        1000, 100, 50, { taskType: 'inline', skipDebit: true });

    const bal = await env.arcane_db.prepare('SELECT plan_credits_micro FROM users WHERE id = ?')
        .bind(user.id).first<{ plan_credits_micro: number }>();
    expect(bal?.plan_credits_micro).toBe(500000); // untouched

    const log = await env.arcane_db.prepare(
        'SELECT task_type, input_tokens FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(user.id).first<{ task_type: string; input_tokens: number }>();
    expect(log).toMatchObject({ task_type: 'inline', input_tokens: 1000 }); // still metered
});

it('fallbackModel lands in request_logs.fallback_model', async () => {
    const user = await seedPasswordUser('fbmodel@test.dev', 'password123');
    await recordUsage(env.arcane_db, user.id, '@cf/qwen/qwen2.5-coder-32b-instruct',
        10, 10, 5, { fallbackModel: '@cf/qwen/qwen2.5-coder-32b-instruct' });
    const log = await env.arcane_db.prepare(
        'SELECT fallback_model FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(user.id).first<{ fallback_model: string | null }>();
    expect(log?.fallback_model).toBe('@cf/qwen/qwen2.5-coder-32b-instruct');
});
```

- [ ] **Step 8: `chat.ts`** — in BOTH branches (non-stream loop and SSE loop), intercept fallback events before any other handling and do not forward them to the client:

```ts
let fallbackModel: string | undefined;
// inside each `for await (const event of streamCompletion(body, env))`:
if (event.type === 'fallback') { fallbackModel = event.model; continue; }
```

And in both `logUsage` calls: pass the ACTUAL serving model and the telemetry field —

```ts
await logUsage(env.arcane_db, user, fallbackModel ?? body.model, inputTokens, outputTokens, durationMs, {
    // …existing extras unchanged, plus:
    fallbackModel,
});
```

- [ ] **Step 9: Full suite + types, then commit**

Run: `cd arcane-server && npm test && npm run check:types`
Expected: PASS

```bash
git add arcane-server/migrations/0014_ai_routing.sql arcane-server/src arcane-server/test
git commit -m "feat(server): one-shot CF fallback when external providers fail, with fallback telemetry"
```

---

### Task A4: Env plumbing + manual-setup runbook

**Files:**
- Modify: `arcane-server/wrangler.toml` (prod `[vars]` + `[env.dev.vars]`)
- Modify: `arcane-server/wrangler.test.toml`
- Modify: `arcane-server/src/types.ts` (Bindings)
- Create: `docs/superpowers/plans/2026-08-03-ai-routing-manual-setup.md`

**Interfaces:**
- Produces: `CF_ACCOUNT_ID` var everywhere; `Bindings` gains `CF_ACCOUNT_ID?: string; MINIMAX_API_KEY?: string; MOONSHOT_API_KEY?: string;` (all optional — secrets absent until the owner sets them; the router falls back loudly, per A3).

- [ ] **Step 1: `types.ts` Bindings** — add after `CF_AI_GATEWAY_ID`:

```ts
        CF_ACCOUNT_ID?: string;      // account id for the gateway /compat URL (external models)
        MINIMAX_API_KEY?: string;    // secret — MiniMax key, sent through the gateway per-request
        MOONSHOT_API_KEY?: string;   // secret — Moonshot (Kimi) key
```

- [ ] **Step 2: `wrangler.toml`** — add to BOTH `[vars]` and `[env.dev.vars]` (bindings are not inherited):

```toml
# Cloudflare account id — required to build the AI Gateway /compat URL for
# external models (MiniMax/Moonshot custom providers). `wrangler whoami` shows it.
# Empty = external routing unconfigured → router falls back to CF models (loud log).
CF_ACCOUNT_ID = ""
```

And to `wrangler.test.toml`'s `[vars]`: `CF_ACCOUNT_ID = ""` (tests exercise the config-fallback path).

- [ ] **Step 3: Runbook** — create `docs/superpowers/plans/2026-08-03-ai-routing-manual-setup.md`:

```markdown
# AI Routing Manual Setup (owner-gated)

One-time steps to activate MiniMax/Kimi routing. Until done, low/high tiers
serve their CF fallbacks (qwen-coder / glm-5.2) and log `provider_config_fallback`.

## 1. Rotate the leaked MiniMax key
`editor/.env` contains a plaintext `MINMAX="sk-api-…"` key. Rotate it in the
MiniMax console FIRST, then delete that line from `editor/.env`.

## 2. Account id
`cd arcane-server && npx wrangler whoami` → set `CF_ACCOUNT_ID` in BOTH
`[vars]` and `[env.dev.vars]` of `wrangler.toml` (it is not a secret).

## 3. Register custom providers (both gateways: arcane-ai-gateway, arcane-ai-gateway-dev)
Dashboard → AI → AI Gateway → <gateway> → Custom Providers → Create:
- slug `minimax`  → base URL = MiniMax's OpenAI-compatible endpoint (from their current API docs)
- slug `moonshot` → base URL = Moonshot's OpenAI-compatible endpoint (from their current API docs)
Slugs MUST be exactly `minimax` / `moonshot` — the router derives keys from the
`custom-minimax/` / `custom-moonshot/` model prefixes.

## 4. Verify model ids + prices
Confirm the exact model-id strings for MiniMax 3 and Kimi 3 in the provider
docs. If they differ from `MiniMax-M3` / `kimi-k3`, update BOTH
`src/config/plans.ts` (INTENSITY_CONFIG) and `src/lib/costs.ts` (MODEL_CATALOG
keys). Update the provisional prices in MODEL_CATALOG from the pricing pages.

## 5. Secrets
    cd arcane-server
    npx wrangler secret put MINIMAX_API_KEY
    npx wrangler secret put MOONSHOT_API_KEY
    npx wrangler secret put MINIMAX_API_KEY --env dev
    npx wrangler secret put MOONSHOT_API_KEY --env dev

## 6. Verify on dev before prod
Deploy: `npm run deploy:dev`. In the editor (dev build), send a chat at Low and
at High effort. Check: gateway logs show custom-provider requests; no
`provider_fallback` / `provider_config_fallback` events in
`wrangler tail arcane-server-dev`; `/v1/usage` shows non-zero cost. Then deploy prod.
```

- [ ] **Step 4: Verify + commit**

Run: `cd arcane-server && npm test && npm run check:types`
Expected: PASS

```bash
git add arcane-server/wrangler.toml arcane-server/wrangler.test.toml arcane-server/src/types.ts docs/superpowers/plans/2026-08-03-ai-routing-manual-setup.md
git commit -m "feat(server): CF_ACCOUNT_ID + provider-secret plumbing and routing runbook"
```

---

# Phase B — Shadow/tab inline completions

### Task B1: `inline_usage` table + counter helper

**Files:**
- Create: `arcane-server/migrations/0015_inline_usage.sql`
- Modify: `arcane-server/src/lib/db.ts`
- Test: `arcane-server/test/inline-allowance.test.ts` (create)

**Interfaces:**
- Produces: `incrementInlineUsage(db: D1Database, userId: number, usageDate: string): Promise<number>` in `db.ts` — atomic upsert returning the NEW count. `usageDate` is a `YYYY-MM-DD` UTC key.

- [ ] **Step 1: Migration**

```sql
-- arcane-server/migrations/0015_inline_usage.sql
-- Per-user daily counter for inline (tab) completions. Allowance model, not
-- credits: inline requests are free but capped per plan per UTC day (spec
-- 2026-08-03). One O(1) upsert per request; rejected requests still bump the
-- counter (harmless — it only gates, it is not billing).
CREATE TABLE IF NOT EXISTS inline_usage (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date TEXT    NOT NULL,   -- UTC day, 'YYYY-MM-DD'
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, usage_date)
);
```

- [ ] **Step 2: Failing test**

```ts
// arcane-server/test/inline-allowance.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { incrementInlineUsage } from '../src/lib/db.ts';
import { seedPasswordUser } from './helpers.ts';

describe('incrementInlineUsage', () => {
    it('starts at 1, increments atomically, and is per-day', async () => {
        const user = await seedPasswordUser('inline-ctr@test.dev', 'password123');
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-03')).toBe(1);
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-03')).toBe(2);
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-04')).toBe(1);
    });
});
```

Run: `cd arcane-server && npx vitest run test/inline-allowance.test.ts` → FAIL (no export)

- [ ] **Step 3: Implement in `db.ts`** (next to the other counters):

```ts
// --- Inline completion allowance counter (migration 0015) ---

/** Atomically bump today's inline-completion count and return the new value. */
export async function incrementInlineUsage(db: D1Database, userId: number, usageDate: string): Promise<number> {
    const row = await db.prepare(`
        INSERT INTO inline_usage (user_id, usage_date, count) VALUES (?, ?, 1)
        ON CONFLICT(user_id, usage_date) DO UPDATE SET count = count + 1
        RETURNING count
    `).bind(userId, usageDate).first<{ count: number }>();
    return row?.count ?? 1;
}
```

- [ ] **Step 4: Run — PASS; commit**

```bash
git add arcane-server/migrations/0015_inline_usage.sql arcane-server/src/lib/db.ts arcane-server/test/inline-allowance.test.ts
git commit -m "feat(server): inline_usage daily counter table + atomic increment"
```

---

### Task B2: Inline allowance gate

**Files:**
- Modify: `arcane-server/src/config/tiers.ts`
- Create: `arcane-server/src/lib/inline-allowance.ts`
- Test: `arcane-server/test/inline-allowance.test.ts` (extend)

**Interfaces:**
- Produces:
  - `tiers.ts`: `export const INLINE_DAILY_CAP: Record<TierId, number> = { free: 300, pro: 4000, proplus: 10000, ultra: 10000 };`
  - `inline-allowance.ts`:
    - `type InlineAllowanceResult = { ok: true; count: number } | { ok: false; status: 429; code: 'inline_quota'; error: string; resetAt: string }`
    - `checkInlineAllowance(db: D1Database, userId: number, now?: Date): Promise<InlineAllowanceResult>`
    - `utcDateKey(now?: Date): string`, `nextUtcMidnight(now?: Date): string` (exported for tests)
- Consumes: B1's `incrementInlineUsage`, `getUserBillingRow` from `db.ts`.

- [ ] **Step 1: Failing tests** (append):

```ts
import { checkInlineAllowance, utcDateKey, nextUtcMidnight } from '../src/lib/inline-allowance.ts';
import { INLINE_DAILY_CAP } from '../src/config/tiers.ts';

describe('checkInlineAllowance', () => {
    it('UTC date helpers', () => {
        const t = new Date('2026-08-03T23:59:00Z');
        expect(utcDateKey(t)).toBe('2026-08-03');
        expect(nextUtcMidnight(t)).toBe('2026-08-04T00:00:00.000Z');
    });

    it('caps are per spec', () => {
        expect(INLINE_DAILY_CAP).toEqual({ free: 300, pro: 4000, proplus: 10000, ultra: 10000 });
    });

    it('allows under the cap, rejects over it with inline_quota + resetAt', async () => {
        const user = await seedPasswordUser('inline-cap@test.dev', 'password123');
        // Pre-load today's counter to the free cap so the NEXT call tips over.
        await env.arcane_db.prepare(
            'INSERT INTO inline_usage (user_id, usage_date, count) VALUES (?, ?, ?)'
        ).bind(user.id, utcDateKey(), INLINE_DAILY_CAP.free - 1).run();

        const under = await checkInlineAllowance(env.arcane_db, user.id);
        expect(under).toMatchObject({ ok: true, count: INLINE_DAILY_CAP.free });

        const over = await checkInlineAllowance(env.arcane_db, user.id);
        expect(over.ok).toBe(false);
        if (!over.ok) {
            expect(over.status).toBe(429);
            expect(over.code).toBe('inline_quota');
            expect(Date.parse(over.resetAt)).toBeGreaterThan(Date.now());
        }
    });
});
```

Run → FAIL.

- [ ] **Step 2: Implement.** `tiers.ts` — add the constant (after `TIERS`):

```ts
/** Daily inline (tab) completion allowance per plan — abuse ceilings, not
 *  billing: inline completions never debit credits (2026-08-03 design). */
export const INLINE_DAILY_CAP: Record<TierId, number> = {
    free: 300, pro: 4000, proplus: 10000, ultra: 10000,
};
```

`src/lib/inline-allowance.ts`:

```ts
// Allowance gate for POST /v1/completions/inline. Deliberately NOT
// checkAiBudget: inline completions are free (no credit debit) and exempt
// from the $1/hr cap — they are bounded by this per-plan daily counter plus
// the RL_INLINE burst limiter at the route.
import { getUserBillingRow, incrementInlineUsage } from './db.ts';
import { INLINE_DAILY_CAP, type TierId } from '../config/tiers.ts';

export type InlineAllowanceResult =
    | { ok: true; count: number }
    | { ok: false; status: 429; code: 'inline_quota'; error: string; resetAt: string };

export function utcDateKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export async function checkInlineAllowance(
    db: D1Database, userId: number, now: Date = new Date(),
): Promise<InlineAllowanceResult> {
    const row = await getUserBillingRow(db, userId);
    const plan = (row?.plan ?? 'free') as TierId;
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

- [ ] **Step 3: Run — PASS; commit**

```bash
git add arcane-server/src/config/tiers.ts arcane-server/src/lib/inline-allowance.ts arcane-server/test/inline-allowance.test.ts
git commit -m "feat(server): per-plan daily inline-completion allowance gate"
```

---

### Task B3: FIM prompt + request clamp + output cleaning

**Files:**
- Create: `arcane-server/src/lib/fim.ts`
- Test: `arcane-server/test/fim.test.ts` (create)

**Interfaces:**
- Produces (`fim.ts` exports):
  - `interface InlineCompletionRequest { prefix: string; suffix: string; language: string; path?: string }`
  - `FIM_MAX_PREFIX_CHARS = 4000`, `FIM_MAX_SUFFIX_CHARS = 2000`
  - `clampInlineRequest(body: unknown): InlineCompletionRequest | null`
  - `buildFimPrompt(req: InlineCompletionRequest): string`
  - `cleanCompletion(raw: string, suffix: string): string` — `''` means "no suggestion".

- [ ] **Step 1: Failing tests**

```ts
// arcane-server/test/fim.test.ts
import { describe, it, expect } from 'vitest';
import {
    clampInlineRequest, buildFimPrompt, cleanCompletion,
    FIM_MAX_PREFIX_CHARS, FIM_MAX_SUFFIX_CHARS,
} from '../src/lib/fim.ts';

describe('clampInlineRequest', () => {
    it('rejects non-objects and missing fields', () => {
        expect(clampInlineRequest(null)).toBeNull();
        expect(clampInlineRequest('x')).toBeNull();
        expect(clampInlineRequest({ prefix: 'a', suffix: 'b' })).toBeNull();
        expect(clampInlineRequest({ prefix: 1, suffix: 'b', language: 'csharp' })).toBeNull();
    });
    it('clamps prefix from the END and suffix from the START', () => {
        const r = clampInlineRequest({
            prefix: 'x'.repeat(FIM_MAX_PREFIX_CHARS + 10) + 'TAIL',
            suffix: 'HEAD' + 'y'.repeat(FIM_MAX_SUFFIX_CHARS + 10),
            language: 'csharp',
        })!;
        expect(r.prefix.length).toBe(FIM_MAX_PREFIX_CHARS);
        expect(r.prefix.endsWith('TAIL')).toBe(true);
        expect(r.suffix.length).toBe(FIM_MAX_SUFFIX_CHARS);
        expect(r.suffix.startsWith('HEAD')).toBe(true);
    });
});

describe('buildFimPrompt', () => {
    it('uses qwen2.5-coder FIM tokens', () => {
        expect(buildFimPrompt({ prefix: 'A', suffix: 'B', language: 'csharp' }))
            .toBe('<|fim_prefix|>A<|fim_suffix|>B<|fim_middle|>');
    });
});

describe('cleanCompletion', () => {
    it('cuts at FIM/end control tokens and trims trailing whitespace', () => {
        expect(cleanCompletion('foo();<|endoftext|>garbage', '')).toBe('foo();');
        expect(cleanCompletion('bar()  \n\n', '')).toBe('bar()');
    });
    it('returns empty for whitespace-only output', () => {
        expect(cleanCompletion('   \n\t', '')).toBe('');
    });
    it('returns empty when the completion just repeats the suffix', () => {
        expect(cleanCompletion('return result;\n}', '  return result;\n}\n')).toBe('');
    });
    it('keeps a real completion that happens to share a short token with the suffix', () => {
        expect(cleanCompletion('x);', ');')).toBe('x);');
    });
});
```

Run: `npx vitest run test/fim.test.ts` → FAIL.

- [ ] **Step 2: Implement `src/lib/fim.ts`**

```ts
// Fill-in-middle plumbing for inline completions (qwen2.5-coder prompt
// format). Pure functions — the route (routes/inline.ts) composes them.

export interface InlineCompletionRequest {
    prefix: string;
    suffix: string;
    language: string;
    path?: string;
}

export const FIM_MAX_PREFIX_CHARS = 4000;
export const FIM_MAX_SUFFIX_CHARS = 2000;

const FIM_STOP_TOKENS = ['<|fim_pad|>', '<|endoftext|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|repo_name|>', '<|file_sep|>'];

/** Validate + defensively re-clamp a request body (the client clamps too). */
export function clampInlineRequest(body: unknown): InlineCompletionRequest | null {
    if (typeof body !== 'object' || body === null) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.prefix !== 'string' || typeof b.suffix !== 'string' || typeof b.language !== 'string') return null;
    return {
        prefix: b.prefix.slice(-FIM_MAX_PREFIX_CHARS),
        suffix: b.suffix.slice(0, FIM_MAX_SUFFIX_CHARS),
        language: b.language.slice(0, 64),
        ...(typeof b.path === 'string' ? { path: b.path.slice(-256) } : {}),
    };
}

export function buildFimPrompt(req: InlineCompletionRequest): string {
    return `<|fim_prefix|>${req.prefix}<|fim_suffix|>${req.suffix}<|fim_middle|>`;
}

/**
 * Post-process raw model output into a suggestion. Empty string = "no
 * suggestion" (a 200 with text:'' — never an error). Strips anything after a
 * FIM control token, trims trailing whitespace, and drops degenerate outputs:
 * whitespace-only, or a completion that merely re-types what already follows
 * the cursor (compared against the suffix's first non-blank 8+ chars).
 */
export function cleanCompletion(raw: string, suffix: string): string {
    let text = raw;
    for (const stop of FIM_STOP_TOKENS) {
        const i = text.indexOf(stop);
        if (i !== -1) text = text.slice(0, i);
    }
    text = text.replace(/\s+$/, '');
    if (text.trim().length === 0) return '';
    const suffixHead = suffix.trimStart().slice(0, 40);
    if (suffixHead.length >= 8 && text.trim().startsWith(suffixHead.slice(0, Math.min(suffixHead.length, text.trim().length)))) {
        // completion is a pure re-type of the following text
        if (suffixHead.startsWith(text.trim()) || text.trim().startsWith(suffixHead)) return '';
    }
    return text;
}
```

- [ ] **Step 3: Run — PASS** (iterate on the degenerate check until the four `cleanCompletion` cases pass exactly); **commit**

```bash
git add arcane-server/src/lib/fim.ts arcane-server/test/fim.test.ts
git commit -m "feat(server): FIM prompt builder, request clamp, and completion cleaning"
```

---

### Task B4: `POST /v1/completions/inline` route

**Files:**
- Create: `arcane-server/src/routes/inline.ts`
- Modify: `arcane-server/index.ts` (mount + gates)
- Modify: `arcane-server/src/types.ts` (`RL_INLINE?: RateLimiter`)
- Modify: `arcane-server/wrangler.toml` (RL_INLINE in prod + dev)
- Test: `arcane-server/test/inline-route.test.ts` (create)

**Interfaces:**
- Consumes: `INLINE_MODEL` (A1), `checkInlineAllowance` (B2), `clampInlineRequest`/`buildFimPrompt`/`cleanCompletion` (B3), `recordUsage` with `skipDebit` (A3).
- Produces: route contract — 200 `{ text, model }` (`text: ''` = no suggestion); 400 `inline_bad_request`; 401/403 (middleware); 413 `inline_too_large`; 429 `inline_quota` (+`resetAt`); 503 `inline_unavailable` (no AI binding); 504 `inline_timeout`; 500 `inline_error`. The editor client (B6) codes against exactly this.

- [ ] **Step 1: Failing route tests** (model-call success paths are covered by B3 unit tests + manual QA; the pool has no AI binding, so the happy path asserts the 503 config guard):

```ts
// arcane-server/test/inline-route.test.ts
import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';
import { INLINE_DAILY_CAP } from '../src/config/tiers.ts';
import { utcDateKey } from '../src/lib/inline-allowance.ts';

const GOOD_BODY = { prefix: 'int x = ', suffix: ';', language: 'csharp' };

describe('POST /v1/completions/inline', () => {
    it('401 without a token', async () => {
        const res = await jsonPost('/v1/completions/inline', GOOD_BODY);
        expect(res.status).toBe(401);
    });

    it('403 for unverified email', async () => {
        const user = await seedPasswordUser('inl-unv@test.dev', 'password123', { verified: false });
        const res = await jsonPost('/v1/completions/inline', GOOD_BODY, await tokenFor(user));
        expect(res.status).toBe(403);
    });

    it('400 inline_bad_request for missing fields and invalid JSON', async () => {
        const user = await seedPasswordUser('inl-bad@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await jsonPost('/v1/completions/inline', { prefix: 'a' }, token);
        expect(res.status).toBe(400);
        expect((await res.json() as { code: string }).code).toBe('inline_bad_request');

        const raw = await SELF.fetch('https://example.com/v1/completions/inline', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: 'not json',
        });
        expect(raw.status).toBe(400);
    });

    it('413 inline_too_large for oversized bodies', async () => {
        const user = await seedPasswordUser('inl-big@test.dev', 'password123');
        const res = await jsonPost('/v1/completions/inline',
            { ...GOOD_BODY, prefix: 'x'.repeat(40_000) }, await tokenFor(user));
        expect(res.status).toBe(413);
        expect((await res.json() as { code: string }).code).toBe('inline_too_large');
    });

    it('429 inline_quota with resetAt once the daily cap is hit', async () => {
        const user = await seedPasswordUser('inl-q@test.dev', 'password123');
        await env.arcane_db.prepare(
            'INSERT INTO inline_usage (user_id, usage_date, count) VALUES (?, ?, ?)'
        ).bind(user.id, utcDateKey(), INLINE_DAILY_CAP.free).run();
        const res = await jsonPost('/v1/completions/inline', GOOD_BODY, await tokenFor(user));
        expect(res.status).toBe(429);
        const body = await res.json() as { code: string; resetAt: string };
        expect(body.code).toBe('inline_quota');
        expect(Date.parse(body.resetAt)).toBeGreaterThan(Date.now());
    });

    it('503 inline_unavailable when the AI binding is absent (test env)', async () => {
        const user = await seedPasswordUser('inl-ok@test.dev', 'password123');
        const res = await jsonPost('/v1/completions/inline', GOOD_BODY, await tokenFor(user));
        expect(res.status).toBe(503);
        expect((await res.json() as { code: string }).code).toBe('inline_unavailable');
    });
});
```

Run → FAIL (404s: route not mounted).

- [ ] **Step 2: Implement `src/routes/inline.ts`**

```ts
// Inline (tab) completion endpoint. Non-streaming by design: ~50-token FIM
// completions gain nothing from SSE, and this path needs 300ms-class budgets,
// zero retries, and NO credit debit (allowance model — see lib/inline-allowance).
import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { INLINE_MODEL } from '../config/plans.ts';
import { checkInlineAllowance } from '../lib/inline-allowance.ts';
import { clampInlineRequest, buildFimPrompt, cleanCompletion } from '../lib/fim.ts';
import { recordUsage } from '../lib/usage.ts';

export const inlineRouter = new Hono<AppEnv>();

const MAX_BODY_BYTES = 32 * 1024;
const MODEL_TIMEOUT_MS = 5_000;

inlineRouter.post('/v1/completions/inline', async (c) => {
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) {
        return c.json({ error: 'Request too large', code: 'inline_too_large' }, 413);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
        return c.json({ error: 'Invalid JSON', code: 'inline_bad_request' }, 400);
    }
    const req = clampInlineRequest(parsed);
    if (!req) {
        return c.json({ error: 'prefix, suffix and language are required', code: 'inline_bad_request' }, 400);
    }

    const user = c.get('user') as AuthPayload;
    const userId = parseInt(user.sub);

    // Burst backstop (30/60s per user). Fails open when the binding is absent
    // (tests / local dev), same policy as the auth limiters.
    if (c.env.RL_INLINE) {
        const { success } = await c.env.RL_INLINE.limit({ key: user.sub });
        if (!success) {
            return c.json({
                error: 'Too many completion requests — slow down a little.',
                code: 'inline_quota',
                resetAt: new Date(Date.now() + 60_000).toISOString(),
            }, 429);
        }
    }

    const allowance = await checkInlineAllowance(c.env.arcane_db, userId);
    if (!allowance.ok) {
        return c.json({ error: allowance.error, code: allowance.code, resetAt: allowance.resetAt }, allowance.status);
    }

    if (!c.env.AI) return c.json({ error: 'AI backend unavailable', code: 'inline_unavailable' }, 503);

    const started = Date.now();
    try {
        // Promise.race timeout: on expiry the client gets a fast 504; the
        // orphaned run finishes server-side and is simply discarded.
        const result = await Promise.race([
            c.env.AI.run(
                INLINE_MODEL as Parameters<Ai['run']>[0],
                { prompt: buildFimPrompt(req), max_tokens: 128, temperature: 0.2, top_p: 0.9 },
                c.env.CF_AI_GATEWAY_ID ? { gateway: { id: c.env.CF_AI_GATEWAY_ID } } : {},
            ),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('inline_timeout')), MODEL_TIMEOUT_MS)),
        ]);
        const rawText = typeof (result as { response?: unknown })?.response === 'string'
            ? (result as { response: string }).response
            : '';
        const text = cleanCompletion(rawText, req.suffix);

        // Telemetry only — skipDebit. Token counts are chars/4 estimates: the
        // text-generation binding does not reliably return usage for this path.
        const inputEstimate = Math.ceil((req.prefix.length + req.suffix.length) / 4);
        const outputEstimate = Math.ceil(text.length / 4);
        await recordUsage(c.env.arcane_db, userId, INLINE_MODEL, inputEstimate, outputEstimate,
            Date.now() - started, { taskType: 'inline', skipDebit: true });

        return c.json({ text, model: INLINE_MODEL });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'inline_timeout') {
            return c.json({ error: 'Completion timed out', code: 'inline_timeout' }, 504);
        }
        console.error(JSON.stringify({ event: 'inline_error', userId: user.sub, message }));
        return c.json({ error: 'Completion failed', code: 'inline_error' }, 500);
    }
});
```

- [ ] **Step 3: Mount + bindings.** `index.ts` — import `inlineRouter`, add the gate next to the other AI gates and mount with the AI routers:

```ts
app.use('/v1/completions/*', authMiddleware(), requireVerifiedEmail());
// …
app.route('/', inlineRouter);
```

`types.ts` Bindings: `RL_INLINE?: RateLimiter;  // 30/60s/user inline-completion burst cap (absent in tests → fail open)`.

`wrangler.toml` — add to the prod ratelimits AND `[env.dev]` (namespace ids must be account-unique; follow the existing 1001/1002 ↔ 2001/2002 convention):

```toml
[[ratelimits]]
name = "RL_INLINE"
namespace_id = "1003"
simple = { limit = 30, period = 60 }
```

(dev: `namespace_id = "2003"`.)

- [ ] **Step 4: Also extend `test/gating.test.ts`** — add `'/v1/completions/inline'` to its `AI_PATHS` array so the 403 sweep covers it.

- [ ] **Step 5: Run everything — PASS; commit**

Run: `cd arcane-server && npm test && npm run check:types`

```bash
git add arcane-server/src/routes/inline.ts arcane-server/index.ts arcane-server/src/types.ts arcane-server/wrangler.toml arcane-server/test/inline-route.test.ts arcane-server/test/gating.test.ts
git commit -m "feat(server): POST /v1/completions/inline with allowance gate, burst limit, FIM call"
```

---

### Task B5: Editor — inline status store

**Files:**
- Create: `editor/src/stores/inline-suggest.ts`
- Test: `editor/src/stores/inline-suggest.test.ts` (create)

**Interfaces:**
- Produces:
  - `type InlineSuggestStatus = 'active' | 'disabled' | 'signed-out' | 'offline' | 'quota' | 'backoff'`
  - `useInlineSuggestStore` (zustand): `{ status: InlineSuggestStatus; quotaResetAt: string | null; setStatus(status: InlineSuggestStatus, quotaResetAt?: string | null): void; quotaActive(now?: number): boolean }`
- Consumed by: B9 provider, B10 status-bar item.

- [ ] **Step 1: Failing test**

```ts
// editor/src/stores/inline-suggest.test.ts
import { describe, it, expect } from 'bun:test';
import { useInlineSuggestStore } from './inline-suggest';

describe('inline-suggest store', () => {
    it('defaults to active with no quota reset', () => {
        const s = useInlineSuggestStore.getState();
        expect(s.status).toBe('active');
        expect(s.quotaResetAt).toBeNull();
    });

    it('setStatus stores quota resetAt only for quota status', () => {
        useInlineSuggestStore.getState().setStatus('quota', '2099-01-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaResetAt).toBe('2099-01-01T00:00:00.000Z');
        useInlineSuggestStore.getState().setStatus('active');
        expect(useInlineSuggestStore.getState().quotaResetAt).toBeNull();
    });

    it('quotaActive is true only while status=quota and resetAt is in the future', () => {
        const store = useInlineSuggestStore.getState();
        store.setStatus('quota', '2099-01-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaActive()).toBe(true);
        store.setStatus('quota', '2000-01-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaActive()).toBe(false);
        store.setStatus('active');
        expect(useInlineSuggestStore.getState().quotaActive()).toBe(false);
    });
});
```

Run: `cd editor && bun test src/stores/inline-suggest.test.ts` → FAIL.

- [ ] **Step 2: Implement `editor/src/stores/inline-suggest.ts`**

```ts
import { create } from 'zustand';

// Status surfaced by the status-bar item. Failures are SILENT (no toasts) —
// this store is the only user-visible signal for the inline-suggest pipeline.
export type InlineSuggestStatus =
    | 'active' | 'disabled' | 'signed-out' | 'offline' | 'quota' | 'backoff';

interface InlineSuggestState {
    status: InlineSuggestStatus;
    /** ISO time when the daily quota resets; non-null only while status='quota'. */
    quotaResetAt: string | null;
    setStatus: (status: InlineSuggestStatus, quotaResetAt?: string | null) => void;
    /** True while the quota pause is still in force. */
    quotaActive: (now?: number) => boolean;
}

export const useInlineSuggestStore = create<InlineSuggestState>((set, get) => ({
    status: 'active',
    quotaResetAt: null,
    setStatus: (status, quotaResetAt) =>
        set({ status, quotaResetAt: status === 'quota' ? (quotaResetAt ?? null) : null }),
    quotaActive: (now = Date.now()) => {
        const { status, quotaResetAt } = get();
        return status === 'quota' && quotaResetAt !== null && Date.parse(quotaResetAt) > now;
    },
}));
```

- [ ] **Step 3: Run — PASS; commit**

```bash
git add editor/src/stores/inline-suggest.ts editor/src/stores/inline-suggest.test.ts
git commit -m "feat(editor): inline-suggest status store"
```

---

### Task B6: Editor — inline client (single-flight, 4s timeout, zero retries)

**Files:**
- Create: `editor/src/features/inline-suggest/services/inline-client.ts`
- Test: `editor/src/features/inline-suggest/services/inline-client.test.ts`

**Interfaces:**
- Produces:
  - `interface InlineRequest { prefix: string; suffix: string; language: string; path?: string }`
  - `type InlineResult = { ok: true; text: string } | { ok: false; reason: 'aborted' | 'offline' | 'auth' | 'quota' | 'server' | 'timeout'; resetAt?: string }`
  - `createInlineClient(cfg?: { fetchImpl?: typeof fetch; getToken?: () => string | null; baseUrl?: string; timeoutMs?: number }): { fetchCompletion(req: InlineRequest): Promise<InlineResult> }`
  - `export const inlineClient` — production instance (real fetch, `useAuthStore` token, `ARCANE_API_URL`).
- Consumes: server contract from B4.

- [ ] **Step 1: Failing tests**

```ts
// editor/src/features/inline-suggest/services/inline-client.test.ts
import { describe, it, expect } from 'bun:test';
import { createInlineClient, type InlineResult } from './inline-client';

const REQ = { prefix: 'a', suffix: 'b', language: 'csharp' };
const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function clientWith(fetchImpl: typeof fetch, timeoutMs = 4000) {
    return createInlineClient({ fetchImpl, getToken: () => 'tok', baseUrl: 'https://x.test', timeoutMs });
}

describe('inline client', () => {
    it('returns text on 200', async () => {
        const c = clientWith(async () => ok({ text: 'foo();', model: 'm' }));
        expect(await c.fetchCompletion(REQ)).toEqual({ ok: true, text: 'foo();' });
    });

    it('auth result without a token — and never calls fetch', async () => {
        let called = false;
        const c = createInlineClient({ fetchImpl: async () => { called = true; return ok({}); }, getToken: () => null });
        expect(await c.fetchCompletion(REQ)).toEqual({ ok: false, reason: 'auth' });
        expect(called).toBe(false);
    });

    it('maps statuses: 401→auth, 429→quota(+resetAt), 500→server', async () => {
        const mk = (status: number, body: unknown) => clientWith(async () => ok(body, status));
        expect(await mk(401, {}).fetchCompletion(REQ)).toEqual({ ok: false, reason: 'auth' });
        const quota = await mk(429, { code: 'inline_quota', resetAt: '2099-01-01T00:00:00.000Z' }).fetchCompletion(REQ);
        expect(quota).toEqual({ ok: false, reason: 'quota', resetAt: '2099-01-01T00:00:00.000Z' });
        expect(await mk(500, {}).fetchCompletion(REQ)).toEqual({ ok: false, reason: 'server' });
    });

    it('network throw → offline', async () => {
        const c = clientWith(async () => { throw new TypeError('fetch failed'); });
        expect(await c.fetchCompletion(REQ)).toEqual({ ok: false, reason: 'offline' });
    });

    it('timeout → timeout result', async () => {
        const c = clientWith(((_url: string, init: RequestInit) =>
            new Promise((_, reject) => {
                init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            })) as unknown as typeof fetch, 30);
        expect(await c.fetchCompletion(REQ)).toEqual({ ok: false, reason: 'timeout' });
    });

    it('single-flight: a new request aborts the in-flight one', async () => {
        let firstSignal: AbortSignal | undefined;
        let call = 0;
        const c = clientWith(((_url: string, init: RequestInit) => {
            call += 1;
            if (call === 1) {
                firstSignal = init.signal!;
                return new Promise((_, reject) => {
                    init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                });
            }
            return Promise.resolve(ok({ text: 'second' }));
        }) as unknown as typeof fetch);
        const p1 = c.fetchCompletion(REQ);
        const p2 = c.fetchCompletion(REQ);
        const [r1, r2] = await Promise.all([p1, p2]) as InlineResult[];
        expect(firstSignal?.aborted).toBe(true);
        expect(r1).toEqual({ ok: false, reason: 'aborted' });
        expect(r2).toEqual({ ok: true, text: 'second' });
    });
});
```

Run: `cd editor && bun test src/features/inline-suggest` → FAIL.

- [ ] **Step 2: Implement `inline-client.ts`**

```ts
// Fetch wrapper for POST /v1/completions/inline. Deliberately NOT
// arcane-stream: no retries (a late completion is a wrong completion), 4s
// hard timeout, single-flight (a new request aborts the previous one).
import { ARCANE_API_URL } from '../../../config/api';
import { useAuthStore } from '../../../stores/auth';

export interface InlineRequest {
    prefix: string;
    suffix: string;
    language: string;
    path?: string;
}

export type InlineResult =
    | { ok: true; text: string }
    | { ok: false; reason: 'aborted' | 'offline' | 'auth' | 'quota' | 'server' | 'timeout'; resetAt?: string };

interface InlineClientConfig {
    fetchImpl?: typeof fetch;
    getToken?: () => string | null;
    baseUrl?: string;
    timeoutMs?: number;
}

export function createInlineClient(cfg: InlineClientConfig = {}) {
    const fetchImpl = cfg.fetchImpl ?? fetch;
    const getToken = cfg.getToken ?? (() => useAuthStore.getState().token);
    const baseUrl = cfg.baseUrl ?? ARCANE_API_URL;
    const timeoutMs = cfg.timeoutMs ?? 4_000;

    let inflight: AbortController | null = null;

    async function fetchCompletion(req: InlineRequest): Promise<InlineResult> {
        const token = getToken();
        if (!token) return { ok: false, reason: 'auth' };

        inflight?.abort();
        const controller = new AbortController();
        inflight = controller;
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            let res: Response;
            try {
                res = await fetchImpl(`${baseUrl}/v1/completions/inline`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify(req),
                    signal: controller.signal,
                });
            } catch {
                if (controller.signal.aborted) {
                    // Superseded by a newer request vs timed out: if we are no
                    // longer the tracked in-flight request, we were replaced.
                    return { ok: false, reason: inflight === controller ? 'timeout' : 'aborted' };
                }
                return { ok: false, reason: 'offline' };
            }
            if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
            if (res.status === 429) {
                const body = (await res.json().catch(() => ({}))) as { resetAt?: string };
                return { ok: false, reason: 'quota', ...(body.resetAt ? { resetAt: body.resetAt } : {}) };
            }
            if (!res.ok) return { ok: false, reason: 'server' };
            const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
            if (!body || typeof body.text !== 'string') return { ok: false, reason: 'server' };
            return { ok: true, text: body.text };
        } finally {
            clearTimeout(timer);
            if (inflight === controller) inflight = null;
        }
    }

    return { fetchCompletion };
}

/** Production client (real fetch, auth-store token, configured API base). */
export const inlineClient = createInlineClient();
```

- [ ] **Step 3: Run — PASS; commit**

```bash
git add editor/src/features/inline-suggest
git commit -m "feat(editor): inline completion client — single-flight, 4s timeout, zero retries"
```

---

### Task B7: Editor — suggestion cache (LRU + type-through)

**Files:**
- Create: `editor/src/features/inline-suggest/services/suggest-cache.ts`
- Test: `editor/src/features/inline-suggest/services/suggest-cache.test.ts`

**Interfaces:**
- Produces:
  - `cacheKey(path: string, prefix: string, suffix: string): string`
  - `createSuggestCache(capacity?: number): { get(key: string): string | null; set(key: string, text: string, ctx: { path: string; prefix: string; suffix: string }): void; tryTypeThrough(path: string, prefix: string, suffix: string): string | null }`
  - Note: cached `''` is a valid entry meaning "server said no suggestion" — `get` returning `''` must short-circuit a re-request in the provider (B9).

- [ ] **Step 1: Failing tests**

```ts
// editor/src/features/inline-suggest/services/suggest-cache.test.ts
import { describe, it, expect } from 'bun:test';
import { createSuggestCache, cacheKey } from './suggest-cache';

describe('suggest cache', () => {
    it('stores and retrieves by key, including empty suggestions', () => {
        const c = createSuggestCache();
        const k = cacheKey('/a.cs', 'pre', 'suf');
        expect(c.get(k)).toBeNull();
        c.set(k, 'foo();', { path: '/a.cs', prefix: 'pre', suffix: 'suf' });
        expect(c.get(k)).toBe('foo();');
        const k2 = cacheKey('/a.cs', 'pre2', 'suf');
        c.set(k2, '', { path: '/a.cs', prefix: 'pre2', suffix: 'suf' });
        expect(c.get(k2)).toBe('');
    });

    it('keys hash on prefix TAIL and suffix HEAD', () => {
        const long = 'x'.repeat(1000);
        expect(cacheKey('/a', long + 'same500tail'.padStart(500, 'x'), 's'))
            .toBe(cacheKey('/a', 'DIFFERENT' + long.slice(0, 1000 - 9) + 'same500tail'.padStart(500, 'x'), 's'));
    });

    it('evicts least-recently-used beyond capacity', () => {
        const c = createSuggestCache(2);
        c.set('k1', 'a', { path: '', prefix: '', suffix: '' });
        c.set('k2', 'b', { path: '', prefix: '', suffix: '' });
        c.get('k1'); // touch k1 → k2 is now LRU
        c.set('k3', 'c', { path: '', prefix: '', suffix: '' });
        expect(c.get('k2')).toBeNull();
        expect(c.get('k1')).toBe('a');
    });

    it('type-through: typing the suggested chars trims the suggestion locally', () => {
        const c = createSuggestCache();
        c.set('k', 'return x;', { path: '/a.cs', prefix: 'int f() { ', suffix: ' }' });
        expect(c.tryTypeThrough('/a.cs', 'int f() { ret', ' }')).toBe('urn x;');
        expect(c.tryTypeThrough('/a.cs', 'int f() { wrong', ' }')).toBeNull();  // diverged
        expect(c.tryTypeThrough('/b.cs', 'int f() { ret', ' }')).toBeNull();    // other file
        expect(c.tryTypeThrough('/a.cs', 'int f() { ret', ' }X')).toBeNull();   // suffix changed
        expect(c.tryTypeThrough('/a.cs', 'int f() { return x;', ' }')).toBeNull(); // fully typed
    });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `suggest-cache.ts`**

```ts
// LRU cache + "type-through": if the user types exactly the characters the
// last suggestion predicted, serve the trimmed remainder locally instead of
// hitting the network. Pure, DI-free, bun-testable.

const KEY_PREFIX_TAIL = 500;
const KEY_SUFFIX_HEAD = 200;

export function cacheKey(path: string, prefix: string, suffix: string): string {
    return `${path} ${prefix.slice(-KEY_PREFIX_TAIL)} ${suffix.slice(0, KEY_SUFFIX_HEAD)}`;
}

interface LastSuggestion {
    path: string;
    prefix: string;
    suffix: string;
    text: string;
}

export function createSuggestCache(capacity = 50) {
    // Map iteration order is insertion order → delete+set on read = LRU.
    const map = new Map<string, string>();
    let last: LastSuggestion | null = null;

    function get(key: string): string | null {
        const v = map.get(key);
        if (v === undefined) return null;
        map.delete(key);
        map.set(key, v);
        return v;
    }

    function set(key: string, text: string, ctx: { path: string; prefix: string; suffix: string }): void {
        if (map.has(key)) map.delete(key);
        map.set(key, text);
        if (map.size > capacity) map.delete(map.keys().next().value as string);
        if (text !== '') last = { ...ctx, text };
    }

    function tryTypeThrough(path: string, prefix: string, suffix: string): string | null {
        if (!last || last.path !== path || last.suffix !== suffix) return null;
        if (!prefix.startsWith(last.prefix)) return null;
        const typed = prefix.slice(last.prefix.length);
        if (typed.length === 0 || !last.text.startsWith(typed)) return null;
        const rest = last.text.slice(typed.length);
        return rest.length > 0 ? rest : null;
    }

    return { get, set, tryTypeThrough };
}
```

- [ ] **Step 3: Run — PASS** (fix the key test if the padStart arithmetic doesn't line up — the invariant under test is: two prefixes with the same last-500 chars produce the same key). **Commit**

```bash
git add editor/src/features/inline-suggest/services/suggest-cache.ts editor/src/features/inline-suggest/services/suggest-cache.test.ts
git commit -m "feat(editor): inline-suggest LRU cache with type-through reuse"
```

---

### Task B8: Editor — idle debounce + circuit breaker

**Files:**
- Create: `editor/src/features/inline-suggest/services/idle-debounce.ts`
- Create: `editor/src/features/inline-suggest/services/circuit-breaker.ts`
- Test: `editor/src/features/inline-suggest/services/idle-debounce.test.ts`, `…/circuit-breaker.test.ts`

**Interfaces:**
- Produces:
  - `interface CancellationTokenLike { isCancellationRequested: boolean; onCancellationRequested?: (listener: () => void) => { dispose(): void } }` (structural — Monaco's `CancellationToken` satisfies it; no monaco import)
  - `waitForIdle(delayMs: number, token: CancellationTokenLike): Promise<boolean>` — false ⇢ cancelled during the wait.
  - `createCircuitBreaker(cfg?: { threshold?: number; cooldownMs?: number; now?: () => number }): { allows(): boolean; recordSuccess(): void; recordFailure(): void }` — 3 consecutive failures open it for 60s; after cooldown requests are allowed again (half-open); any success closes, any failure re-arms the cooldown.

- [ ] **Step 1: Failing tests**

```ts
// idle-debounce.test.ts
import { describe, it, expect } from 'bun:test';
import { waitForIdle, type CancellationTokenLike } from './idle-debounce';

function makeToken(): CancellationTokenLike & { cancel(): void } {
    let cancelled = false;
    const listeners: Array<() => void> = [];
    return {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested(listener) {
            listeners.push(listener);
            return { dispose() { const i = listeners.indexOf(listener); if (i !== -1) listeners.splice(i, 1); } };
        },
        cancel() { cancelled = true; for (const l of [...listeners]) l(); },
    };
}

describe('waitForIdle', () => {
    it('resolves true after the delay when not cancelled', async () => {
        expect(await waitForIdle(10, makeToken())).toBe(true);
    });
    it('resolves false immediately for an already-cancelled token', async () => {
        const t = makeToken(); t.cancel();
        expect(await waitForIdle(1000, t)).toBe(false);
    });
    it('resolves false promptly when cancelled mid-wait', async () => {
        const t = makeToken();
        const started = Date.now();
        const p = waitForIdle(5000, t);
        setTimeout(() => t.cancel(), 10);
        expect(await p).toBe(false);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});
```

```ts
// circuit-breaker.test.ts
import { describe, it, expect } from 'bun:test';
import { createCircuitBreaker } from './circuit-breaker';

describe('circuit breaker', () => {
    it('opens after 3 consecutive failures, allows again after cooldown', () => {
        let t = 0;
        const b = createCircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: () => t });
        expect(b.allows()).toBe(true);
        b.recordFailure(); b.recordFailure();
        expect(b.allows()).toBe(true);
        b.recordFailure();
        expect(b.allows()).toBe(false);
        t = 59_999; expect(b.allows()).toBe(false);
        t = 60_001; expect(b.allows()).toBe(true);          // half-open probe window
        b.recordFailure();                                   // probe failed → re-armed
        expect(b.allows()).toBe(false);
        t = 120_002; expect(b.allows()).toBe(true);
        b.recordSuccess();                                   // probe succeeded → closed
        expect(b.allows()).toBe(true);
        b.recordFailure(); b.recordFailure();
        expect(b.allows()).toBe(true);                       // count reset by success
    });
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

```ts
// idle-debounce.ts
// Debounce implemented against Monaco's CancellationToken (structural type so
// bun tests need no monaco import): the provider awaits this before any
// network call; continued typing cancels the token and we never fetch.
export interface CancellationTokenLike {
    isCancellationRequested: boolean;
    onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export function waitForIdle(delayMs: number, token: CancellationTokenLike): Promise<boolean> {
    return new Promise((resolve) => {
        if (token.isCancellationRequested) { resolve(false); return; }
        let sub: { dispose(): void } | undefined;
        const timer = setTimeout(() => {
            sub?.dispose();
            resolve(!token.isCancellationRequested);
        }, delayMs);
        sub = token.onCancellationRequested?.(() => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}
```

```ts
// circuit-breaker.ts
// After `threshold` consecutive failures, pause requests for `cooldownMs`.
// Post-cooldown requests are allowed (half-open): one success closes the
// breaker, one failure re-arms the cooldown. The single-flight client keeps
// the half-open probe volume at one request at a time.
export function createCircuitBreaker(
    cfg: { threshold?: number; cooldownMs?: number; now?: () => number } = {},
) {
    const threshold = cfg.threshold ?? 3;
    const cooldownMs = cfg.cooldownMs ?? 60_000;
    const now = cfg.now ?? Date.now;

    let failures = 0;
    let openedAt: number | null = null;

    return {
        allows(): boolean {
            if (openedAt === null) return true;
            return now() - openedAt >= cooldownMs;
        },
        recordSuccess(): void {
            failures = 0;
            openedAt = null;
        },
        recordFailure(): void {
            failures += 1;
            if (failures >= threshold) openedAt = now();
        },
    };
}
```

- [ ] **Step 3: Run — PASS; commit**

```bash
git add editor/src/features/inline-suggest/services/idle-debounce.ts editor/src/features/inline-suggest/services/idle-debounce.test.ts editor/src/features/inline-suggest/services/circuit-breaker.ts editor/src/features/inline-suggest/services/circuit-breaker.test.ts
git commit -m "feat(editor): idle debounce vs CancellationToken + failure circuit breaker"
```

---

### Task B9: Editor — connectivity store, gating, provider assembly, registration

**Files:**
- Create: `editor/src/stores/connectivity.ts`
- Create: `editor/src/features/inline-suggest/services/gating.ts`
- Create: `editor/src/features/inline-suggest/services/inline-provider.ts`
- Create: `editor/src/features/inline-suggest/index.ts`
- Modify: `editor/src/features/editor/components/EditorPanel.tsx`
- Modify: `editor/src/App.tsx` (init connectivity listeners)
- Test: `editor/src/stores/connectivity.test.ts`, `editor/src/features/inline-suggest/services/gating.test.ts`

**Interfaces:**
- Produces:
  - `useConnectivityStore`: `{ online: boolean; setOnline(online: boolean): void; reportFetchFailure(): void }` + `initConnectivityListeners(): () => void` (window online/offline events + 30s `navigator.onLine` re-sync so a false-offline heals).
  - `shouldRequestInline(gate: { enabled: boolean; loggedIn: boolean; online: boolean; breakerAllows: boolean; quotaActive: boolean; scheme: string; contentLength: number }): boolean`
  - `registerInlineSuggestProvider(monaco: Monaco): IDisposable | undefined` — idempotent (module guard; `beforeMount` runs again on EditorPanel remounts).
  - Barrel `index.ts` exports: `registerInlineSuggestProvider`, `InlineSuggestStatusItem` (B10 adds the component; export it there).
- Consumes: B5 store, B6 `inlineClient`, B7 cache, B8 debounce/breaker, and the settings key `'ai.inlineSuggestions.enabled'`. The key is added in Step 8 of THIS task (schema + default); B10 then only builds UI on top of it.

- [ ] **Step 1: Failing tests**

```ts
// editor/src/stores/connectivity.test.ts
import { describe, it, expect } from 'bun:test';
import { useConnectivityStore } from './connectivity';

describe('connectivity store', () => {
    it('defaults online and toggles', () => {
        expect(useConnectivityStore.getState().online).toBe(true);
        useConnectivityStore.getState().setOnline(false);
        expect(useConnectivityStore.getState().online).toBe(false);
        useConnectivityStore.getState().setOnline(true);
    });
    it('reportFetchFailure flips offline', () => {
        useConnectivityStore.getState().reportFetchFailure();
        expect(useConnectivityStore.getState().online).toBe(false);
        useConnectivityStore.getState().setOnline(true);
    });
});
```

```ts
// editor/src/features/inline-suggest/services/gating.test.ts
import { describe, it, expect } from 'bun:test';
import { shouldRequestInline } from './gating';

const OPEN = {
    enabled: true, loggedIn: true, online: true, breakerAllows: true,
    quotaActive: false, scheme: 'file', contentLength: 100,
};

describe('shouldRequestInline', () => {
    it('passes the all-clear gate', () => {
        expect(shouldRequestInline(OPEN)).toBe(true);
    });
    it.each([
        ['disabled', { enabled: false }],
        ['signed out', { loggedIn: false }],
        ['offline', { online: false }],
        ['breaker open', { breakerAllows: false }],
        ['quota active', { quotaActive: true }],
        ['non-file scheme', { scheme: 'auth' }],
        ['large file', { contentLength: 1_000_001 }],
    ] as const)('blocks when %s', (_label, override) => {
        expect(shouldRequestInline({ ...OPEN, ...override })).toBe(false);
    });
});
```

(If this bun version lacks `it.each`, unroll into individual `it` cases.)

Run → FAIL.

- [ ] **Step 2: Implement `editor/src/stores/connectivity.ts`**

```ts
import { create } from 'zustand';

// App-wide connectivity signal. Seeded from navigator.onLine, kept fresh by
// window online/offline events + a 30s re-sync (initConnectivityListeners in
// App.tsx), and pessimistically flipped offline by any fetch network-throw
// (navigator.onLine can report true while requests fail — belt & suspenders;
// the 30s re-sync heals a false offline).
interface ConnectivityState {
    online: boolean;
    setOnline: (online: boolean) => void;
    reportFetchFailure: () => void;
}

export const useConnectivityStore = create<ConnectivityState>((set) => ({
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    setOnline: (online) => set({ online }),
    reportFetchFailure: () => set({ online: false }),
}));

/** Install window listeners + periodic re-sync. Returns a cleanup fn. */
export function initConnectivityListeners(): () => void {
    const sync = () => useConnectivityStore.getState().setOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    const timer = window.setInterval(sync, 30_000);
    sync();
    return () => {
        window.removeEventListener('online', sync);
        window.removeEventListener('offline', sync);
        window.clearInterval(timer);
    };
}
```

- [ ] **Step 3: Implement `gating.ts`**

```ts
// Pure gate — every reason inline suggestions must NOT fire, in one testable
// place. 1 MB matches EditorPanel's isLargeFile threshold.
export interface InlineGate {
    enabled: boolean;
    loggedIn: boolean;
    online: boolean;
    breakerAllows: boolean;
    quotaActive: boolean;
    scheme: string;
    contentLength: number;
}

export const INLINE_MAX_FILE_CHARS = 1_000_000;

export function shouldRequestInline(gate: InlineGate): boolean {
    return gate.enabled
        && gate.loggedIn
        && gate.online
        && gate.breakerAllows
        && !gate.quotaActive
        && gate.scheme === 'file'
        && gate.contentLength <= INLINE_MAX_FILE_CHARS;
}
```

- [ ] **Step 4: Implement `inline-provider.ts`** (assembly — no unit test; every piece it composes is tested):

```ts
import type { Monaco } from '@monaco-editor/react';
import type { IDisposable, languages } from 'monaco-editor';
import { inlineClient, type InlineResult } from './inline-client';
import { createSuggestCache, cacheKey } from './suggest-cache';
import { createCircuitBreaker } from './circuit-breaker';
import { waitForIdle } from './idle-debounce';
import { shouldRequestInline } from './gating';
import { useAuthStore } from '../../../stores/auth';
import { useSettingsStore } from '../../../stores/settings';
import { useConnectivityStore } from '../../../stores/connectivity';
import { useInlineSuggestStore, type InlineSuggestStatus } from '../../../stores/inline-suggest';

const DEBOUNCE_MS = 250;
const PREFIX_CHARS = 4000;
const SUFFIX_CHARS = 2000;

const cache = createSuggestCache();
const breaker = createCircuitBreaker();

let registered = false;

function gateStatus(gate: { enabled: boolean; loggedIn: boolean; online: boolean; breakerAllows: boolean; quotaActive: boolean }): InlineSuggestStatus {
    if (!gate.enabled) return 'disabled';
    if (!gate.loggedIn) return 'signed-out';
    if (!gate.online) return 'offline';
    if (gate.quotaActive) return 'quota';
    if (!gate.breakerAllows) return 'backoff';
    return 'active';
}

function handleFailure(result: Extract<InlineResult, { ok: false }>): void {
    const store = useInlineSuggestStore.getState();
    switch (result.reason) {
        case 'aborted':
            return; // superseded — not a failure
        case 'quota':
            store.setStatus('quota', result.resetAt ?? null);
            return;
        case 'auth':
            store.setStatus('signed-out');
            return;
        case 'offline':
            useConnectivityStore.getState().reportFetchFailure();
            store.setStatus('offline');
            return;
        case 'timeout':
        case 'server':
            breaker.recordFailure();
            if (!breaker.allows()) store.setStatus('backoff');
            return;
    }
}

export function registerInlineSuggestProvider(monaco: Monaco): IDisposable | undefined {
    // beforeMount runs on every EditorPanel remount; language providers are
    // global — never double-register (same policy the other providers need).
    if (registered) return undefined;
    registered = true;

    return monaco.languages.registerInlineCompletionsProvider('*', {
        async provideInlineCompletions(model, position, _context, token) {
            const empty: languages.InlineCompletions = { items: [] };

            const gate = {
                enabled: useSettingsStore.getState().settings['ai.inlineSuggestions.enabled'],
                loggedIn: useAuthStore.getState().loggedIn,
                online: useConnectivityStore.getState().online,
                breakerAllows: breaker.allows(),
                quotaActive: useInlineSuggestStore.getState().quotaActive(),
                scheme: model.uri.scheme,
                contentLength: model.getValueLength(),
            };
            if (!shouldRequestInline(gate)) {
                useInlineSuggestStore.getState().setStatus(gateStatus(gate));
                return empty;
            }
            if (useInlineSuggestStore.getState().status !== 'active') {
                useInlineSuggestStore.getState().setStatus('active');
            }

            const fullText = model.getValue();
            const offset = model.getOffsetAt(position);
            const prefix = fullText.slice(Math.max(0, offset - PREFIX_CHARS), offset);
            const suffix = fullText.slice(offset, offset + SUFFIX_CHARS);
            const path = model.uri.path;
            const range = new monaco.Range(
                position.lineNumber, position.column, position.lineNumber, position.column,
            );

            // Local answers first — no debounce needed for zero-cost paths.
            const typed = cache.tryTypeThrough(path, prefix, suffix);
            if (typed) return { items: [{ insertText: typed, range }] };
            const key = cacheKey(path, prefix, suffix);
            const cached = cache.get(key);
            if (cached !== null) {
                return cached === '' ? empty : { items: [{ insertText: cached, range }] };
            }

            if (!(await waitForIdle(DEBOUNCE_MS, token))) return empty;

            const result = await inlineClient.fetchCompletion({
                prefix, suffix, language: model.getLanguageId(), path,
            });
            if (!result.ok) {
                handleFailure(result);
                return empty;
            }
            breaker.recordSuccess();
            cache.set(key, result.text, { path, prefix, suffix });
            if (token.isCancellationRequested || result.text === '') return empty;
            return { items: [{ insertText: result.text, range }] };
        },
        freeInlineCompletions() {
            // items are plain objects — nothing to dispose
        },
    });
}
```

- [ ] **Step 5: Barrel `editor/src/features/inline-suggest/index.ts`**

```ts
export { registerInlineSuggestProvider } from './services/inline-provider';
```

- [ ] **Step 6: Register in `EditorPanel.tsx`** — add the import (with the other feature imports): `import { registerInlineSuggestProvider } from '../../inline-suggest';` — call it in `beforeMount` after `initTestCodeLens(monaco);`, and add to the `options` object: `inlineSuggest: { enabled: !isLargeFile },`.

- [ ] **Step 7: Init connectivity in `App.tsx`** — `import { initConnectivityListeners } from './stores/connectivity';` and add alongside the existing top-level `useEffect` hooks:

```ts
useEffect(() => initConnectivityListeners(), []);
```

- [ ] **Step 8: Verify**

First add the settings key (the provider reads it): `SettingsSchema` in `src/types/index.ts` after `'ai.edits.alwaysApproveUnityAssets'`: `'ai.inlineSuggestions.enabled': boolean;` and `DEFAULT_SETTINGS` in `src/stores/settings.ts`: `'ai.inlineSuggestions.enabled': true,`.

Run: `cd editor && bun test src && bun run check:modules && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add editor/src
git commit -m "feat(editor): Monaco inline-suggest provider with gating, cache, debounce, breaker"
```

---

### Task B10: Editor — setting, command, settings UI, status-bar item

**Files:**
- Modify: `editor/src/types/index.ts` (SettingsSchema), `editor/src/stores/settings.ts` (DEFAULT_SETTINGS) — if not already done in B9 Step 8
- Modify: `editor/src/App.tsx` (command)
- Modify: `editor/src/features/settings/components/SettingsPanel.tsx`
- Create: `editor/src/features/inline-suggest/components/InlineSuggestStatusItem.tsx`
- Modify: `editor/src/features/inline-suggest/index.ts` (export component)
- Modify: `editor/src/features/app-shell/components/StatusBar.tsx`

**Interfaces:**
- Consumes: B5 store, settings key `'ai.inlineSuggestions.enabled'` (default `true`).
- Produces: command id `ai.toggleInlineSuggestions` (keybinding `mod+alt+i` — verified free; only `mod+alt+left/right` are taken); `<InlineSuggestStatusItem />` exported from the barrel.

- [ ] **Step 1: Confirm the settings key exists** (added in B9 Step 8: `'ai.inlineSuggestions.enabled'` in `SettingsSchema` + `DEFAULT_SETTINGS`). If missing, add it now.

- [ ] **Step 2: Command in `App.tsx`** — find the `registerCommands([` array (AI-category commands live around lines 440–880) and append:

```ts
    {
      id: 'ai.toggleInlineSuggestions',
      label: 'Toggle AI Inline Suggestions',
      category: 'AI',
      keybinding: 'mod+alt+i',
      handler: () => {
        const s = useSettingsStore.getState();
        s.setSetting('ai.inlineSuggestions.enabled', !s.settings['ai.inlineSuggestions.enabled']);
      },
    },
```

- [ ] **Step 3: Settings panel row** — open `SettingsPanel.tsx`, locate the row rendering `'ai.checkpoints.enabled'`, and add an identical-markup toggle row above it: key `'ai.inlineSuggestions.enabled'`, label **"Inline suggestions (Tab)"**, description **"Ghost-text code suggestions as you type. Accept with Tab."**

- [ ] **Step 4: Status-bar item** — create `InlineSuggestStatusItem.tsx`:

```tsx
import { Sparkles } from 'lucide-react';
import { useInlineSuggestStore, type InlineSuggestStatus } from '../../../stores/inline-suggest';
import { useSettingsStore } from '../../../stores/settings';

const LABELS: Record<InlineSuggestStatus, string> = {
  active: 'Tab',
  disabled: 'Tab off',
  'signed-out': 'Tab · sign in',
  offline: 'Tab · offline',
  quota: 'Tab · daily limit',
  backoff: 'Tab · paused',
};

const TITLES: Record<InlineSuggestStatus, string> = {
  active: 'AI inline suggestions are active. Click to disable.',
  disabled: 'AI inline suggestions are off. Click to enable.',
  'signed-out': 'Sign in to use AI inline suggestions.',
  offline: 'Offline — suggestions resume when the connection returns.',
  quota: 'Daily completion limit reached.',
  backoff: 'Suggestions paused after repeated errors — retrying shortly.',
};

export function InlineSuggestStatusItem() {
  const status = useInlineSuggestStore((s) => s.status);
  const quotaResetAt = useInlineSuggestStore((s) => s.quotaResetAt);
  const title = status === 'quota' && quotaResetAt
    ? `${TITLES.quota} Resumes at ${new Date(quotaResetAt).toLocaleTimeString()}.`
    : TITLES[status];
  const toggle = () => {
    const s = useSettingsStore.getState();
    s.setSetting('ai.inlineSuggestions.enabled', !s.settings['ai.inlineSuggestions.enabled']);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      className={`flex items-center gap-1 px-2 hover:bg-white/10 ${status === 'active' ? '' : 'opacity-60'}`}
    >
      <Sparkles size={12} />
      <span>{LABELS[status]}</span>
    </button>
  );
}
```

Match the exact className conventions of neighboring StatusBar items when wiring it in (read them; adjust classes to blend in).

- [ ] **Step 5: Export + render.** Barrel: `export { InlineSuggestStatusItem } from './components/InlineSuggestStatusItem';`. In `StatusBar.tsx`: `import { InlineSuggestStatusItem } from '../../inline-suggest';` and render it next to `<GraphifyStatusBadge />`.

- [ ] **Step 6: Verify + manual smoke**

Run: `cd editor && bun test src && bun run check:modules && bunx tsc --noEmit`
Expected: PASS.
Manual (requires dev server running the new endpoint, or expect graceful 'backoff'): `bun run tauri dev`, open a `.cs` file, type, pause 250ms → ghost text appears; Tab accepts; Esc dismisses; toggle via status-bar item and `mod+alt+i`; check the Settings panel row.

- [ ] **Step 7: Commit**

```bash
git add editor/src
git commit -m "feat(editor): inline-suggest setting, toggle command, settings row, status-bar item"
```

---

# Phase C — Edge-case hardening

### Task C1: Chat offline fast-fail + fetch-failure reporting

**Files:**
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts`
- Modify: `editor/src/features/ai-panel/services/turn-errors.ts`
- Test: `editor/src/features/ai-panel/services/arcane-stream.test.ts` (extend), `…/turn-errors.test.ts` (extend)

**Interfaces:**
- Consumes: `useConnectivityStore` (B9).
- Produces: offline error message (exact string, used by taxonomy + tests): `You're offline — check your internet connection, then retry.`

- [ ] **Step 1: Failing tests.** In `arcane-stream.test.ts` (follow its existing harness — it builds a `StreamFn` via `createArcaneStreamFn({ fetchImpl })` and collects events):

```ts
it('fails immediately with an offline error when the connectivity store says offline', async () => {
    useConnectivityStore.getState().setOnline(false);
    try {
        let fetchCalled = false;
        const streamFn = createArcaneStreamFn({
            fetchImpl: (async () => { fetchCalled = true; throw new Error('unreachable'); }) as typeof fetch,
        });
        const events = await collectStreamEvents(streamFn); // see note below
        const errorEvent = events.find((e) => e.type === 'error');
        expect(String((errorEvent as { error: Error }).error.message)).toContain("You're offline");
        expect(fetchCalled).toBe(false);
    } finally {
        useConnectivityStore.getState().setOnline(true);
    }
});

it('a network-level fetch throw flips the connectivity store offline', async () => {
    useConnectivityStore.getState().setOnline(true);
    try {
        const streamFn = createArcaneStreamFn({
            fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
            maxAttempts: 1,
        });
        await collectStreamEvents(streamFn);
        expect(useConnectivityStore.getState().online).toBe(false);
    } finally {
        useConnectivityStore.getState().setOnline(true);
    }
});
```

**Note on `collectStreamEvents`:** `arcane-stream.test.ts` already has tests that invoke a `StreamFn` built by `createArcaneStreamFn({ fetchImpl })` (with a fake context/options) and gather the events pushed to the returned `AssistantMessageEventStream` — read the file first and reuse whatever helper/pattern those tests use for invocation + collection (also: the auth-store token must be set the way those tests set it, or the offline check must come AFTER the token check per the implementation ordering below — put the offline check after the token check and set a token in these tests exactly like the neighbors do). `collectStreamEvents` above stands for that existing pattern, not a new helper to invent.

In `turn-errors.test.ts`:

```ts
it("classifies offline errors as network with a You're-offline title", () => {
    const e = classifyTurnError("You're offline — check your internet connection, then retry.");
    expect(e.kind).toBe('network');
    expect(e.title).toBe("You're offline");
    expect(e.retriable).toBe(true);
});
```

Run: `cd editor && bun test src/features/ai-panel` → FAIL.

- [ ] **Step 2: Implement.** `arcane-stream.ts`:
  - Import `useConnectivityStore` from `'../../../stores/connectivity'`.
  - In `doStream`, immediately after the `token` null-check block, add:

```ts
  // Offline fast-fail: no point burning 3 retries × long timeouts when the
  // OS says there's no network. The connectivity store heals via window
  // events + periodic re-sync, and the error block's Retry covers resume.
  if (!useConnectivityStore.getState().online) {
    stream.push({
      type: 'error',
      error: new Error("You're offline — check your internet connection, then retry."),
    });
    return;
  }
```

  - In the connect-phase `catch (error)` block (the one that handles `cfg.fetchImpl` throwing), before the abort check, add: `useConnectivityStore.getState().reportFetchFailure();`

  `turn-errors.ts` — in `classifyTurnErrorTable`, add BEFORE the `NETWORK_SUBSTRINGS` check:

```ts
  if (lower.includes("you're offline") || lower.includes('you are offline')) {
    return {
      kind: 'network',
      title: "You're offline",
      detail: 'Check your internet connection, then press Retry.',
      raw,
      retriable: true,
    };
  }
```

- [ ] **Step 3: Run — PASS; commit**

Run: `cd editor && bun test src`

```bash
git add editor/src/features/ai-panel
git commit -m "feat(editor): offline fast-fail for chat + connectivity reporting from fetch failures"
```

---

### Task C2: Error taxonomy additions + credits CTA + low-credit warning

**Files:**
- Modify: `editor/src/features/ai-panel/services/turn-errors.ts`
- Modify: `editor/src/features/ai-panel/components/ErrorBlock.tsx`
- Modify: `editor/src/features/app-shell/components/StatusBar.tsx`
- Test: `editor/src/features/ai-panel/services/turn-errors.test.ts` (extend)

**Interfaces:**
- Produces: `TurnErrorKind` gains `'credits'`; `classifyServerCode` maps the four new server codes; ErrorBlock renders a "Manage plan & credits" action for `kind === 'credits'`; StatusBar warns when `credits < 10`.

- [ ] **Step 1: Failing tests** (append to `turn-errors.test.ts`):

```ts
describe('new server codes + credits kind', () => {
    it('maps provider/gateway codes', () => {
        expect(classifyServerCode('provider_rate_limit')).toBe('rate_limit');
        expect(classifyServerCode('provider_auth_failure')).toBe('server');
        expect(classifyServerCode('provider_unavailable')).toBe('server');
        expect(classifyServerCode('gateway_timeout')).toBe('timeout');
        expect(classifyServerCode('nonsense')).toBeNull();
    });

    it('classifies out-of-credits as a non-retriable credits error', () => {
        const e = classifyTurnError('You are out of credits. Upgrade your plan or add a top-up to keep using AI.');
        expect(e.kind).toBe('credits');
        expect(e.retriable).toBe(false);
        const e2 = classifyTurnError('You are out of AI credits. Open Account to upgrade or buy credits.');
        expect(e2.kind).toBe('credits');
    });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `turn-errors.ts`:**
  - Add `'credits'` to `TurnErrorKind`.
  - In `classifyServerCode`'s switch, add: `case 'provider_rate_limit': return 'rate_limit';`, `case 'provider_auth_failure': return 'server';`, `case 'provider_unavailable': return 'server';`, `case 'gateway_timeout': return 'timeout';`
  - In `classifyTurnError`, the code-marker branch currently only short-circuits for `rate_limit` and `server` kinds — a `timeout` kind from `gateway_timeout` would fall through to the substring table and land on `unknown`. Add a third branch after the `server` one:

```ts
    if (kind === 'timeout') {
      return {
        kind: 'timeout',
        title: 'Connection timed out',
        detail: 'This is usually temporary — try again in a moment.',
        raw: stripped,
        retriable: true,
      };
    }
```

  - Add a matching assertion to the Step 1 tests: `expect(classifyTurnError('[code:gateway_timeout] upstream timed out').kind).toBe('timeout');`
  - In `classifyTurnErrorTable`, add BEFORE the `rate limit` check:

```ts
  if (lower.includes('out of credits') || lower.includes('out of ai credits')) {
    return {
      kind: 'credits',
      title: 'Out of credits',
      detail: 'Upgrade your plan or add a top-up to continue.',
      raw,
      retriable: false,
    };
  }
```

- [ ] **Step 3: ErrorBlock CTA.** Read `ErrorBlock.tsx` first. Where the Retry button renders (it is gated on `error.retriable`), add a sibling button rendered when `error.kind === 'credits'`, using the same button styling: label **"Manage plan & credits"**, `onClick={() => { void useAuthStore.getState().openBilling(); }}` (import `useAuthStore` from `'../../../stores/auth'`).

- [ ] **Step 4: StatusBar low-credit warning.** In `StatusBar.tsx`, read `const credits = useAuthStore((s) => s.credits);` (add the import) and render, next to the other right-side items, only when `credits !== null && credits < 10`:

```tsx
<button
  type="button"
  onClick={() => { void useAuthStore.getState().openBilling(); }}
  title="You're almost out of AI credits — click to manage your plan."
  className="…match neighboring warning-item classes…"
>
  <AlertTriangle size={12} />
  <span>{Math.max(0, Math.floor(credits))} credits</span>
</button>
```

(`AlertTriangle` is already imported in this file.)

- [ ] **Step 5: Run everything — PASS; commit**

Run: `cd editor && bun test src && bun run check:modules && bunx tsc --noEmit`

```bash
git add editor/src
git commit -m "feat(editor): provider error codes, out-of-credits CTA, low-credit status warning"
```

---

### Task C3: Manual QA checklist + full verification sweep

**Files:**
- Modify: `docs/superpowers/plans/2026-07-14-ai-agent-overhaul-manual-checklist.md` (append section)

- [ ] **Step 1: Append to the manual checklist:**

```markdown
## 2026-08-03 — Shadow suggestions, external routing, hardening

Routing (dev env, after the manual-setup runbook):
- [ ] Chat at Low effort → gateway logs show `custom-minimax/…`; response streams normally
- [ ] Chat at High effort → `custom-moonshot/…` likewise
- [ ] Remove the MiniMax key from a dev secret → Low chat still answers (CF fallback), `wrangler tail` shows `provider_config_fallback`, request_logs.fallback_model set
- [ ] /v1/usage shows non-zero cost for external-model chats (catalog prices)

Inline suggestions:
- [ ] Type in a .cs file, pause → ghost text ≤ ~1s; Tab accepts; Esc dismisses; typing through the suggestion keeps it trimmed without new requests (watch network)
- [ ] Toggle off via status-bar item / mod+alt+i / Settings row → no requests fire
- [ ] Seed inline_usage to the cap on dev → status bar shows "Tab · daily limit" with reset tooltip; no toasts
- [ ] Stop the dev server → after 3 failures status shows "Tab · paused", requests stop for ~60s, then a single probe
- [ ] File > 1MB → no inline requests

Offline / credits:
- [ ] Kill wifi → chat send fails INSTANTLY with "You're offline"; wifi back → Retry succeeds; inline shows "Tab · offline" then recovers
- [ ] Kill wifi mid-stream → existing stall/network error path still works (no regression)
- [ ] Zero a dev account's credits → chat shows "Out of credits" with working "Manage plan & credits" button; status bar shows the low-credit warning; inline completions STILL work (allowance, not credits)
```

- [ ] **Step 2: Full verification sweep** (all must pass):

Run: `cd arcane-server && npm test && npm run check:types`
Run: `cd editor && bun test src && bun run check:modules && bunx tsc --noEmit`
Expected: PASS everywhere.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-14-ai-agent-overhaul-manual-checklist.md
git commit -m "docs: manual QA checklist for shadow suggestions, routing, and hardening"
```
