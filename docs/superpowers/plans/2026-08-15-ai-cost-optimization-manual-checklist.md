# AI Cost & Context Optimization — Owner / Deploy Checklist (2026-08-15)

Branch: `feat/ai-cost-context-optimization`. Everything below needs owner
credentials or a deploy — code-side work is done and green (editor
`bun run verify`; server vitest 254 + tsc).

## Deploy gates

- [ ] Apply D1 migration `0021_unity_search_cache.sql` to **dev** then **prod**
      (`npx wrangler d1 migrations apply arcane_db --env dev` / prod).
- [ ] Deploy `arcane-server` to dev. `ROUTING_V2="on"` is already set in
      `[env.dev.vars]`; prod ships `"off"` until the A/B below.
- [ ] Ship an editor build (Arcane Dev) with the client changes.

## Incident follow-up (2026-08-15 afternoon): third-party tiers were dead on arrival

First real request after deploy 400'd. Root causes (verified by local repro
against the live gateway; NOT introduced by the optimization work):

1. Cloudflare serves the gpt-5.6 family ONLY in **Responses-API format**
   (dashboard model page: "Request formats: responses"; the 7003 "Invalid
   value at input" was the run catalog's schema rejecting our
   Chat-Completions `messages` body — luna/terra/sol all 400'd while
   gpt-5.4*/5.1/grok, which are cataloged as chat-completions, validated).
   → FIXED in code (`ac42088`): llm-router's openai wire plugin now uses
   `.responses()` for `gpt-5.6*` model ids and `.chat()` for everything
   else. Standard tier stays on `openai/gpt-5.6-luna` per owner decision;
   gpt-5.4-mini remains only as an unrouted catalog reference.
2. Unified billing refuses with `AiGatewayError 2021: "Gateway authentication
   is required to use unified billing"` — credits were topped up, but the dev
   gateway still has Authenticated Gateway DISABLED.
   → OWNER ACTION (the one remaining blocker for low+high tiers):
   dash.cloudflare.com → AI → AI Gateway → `arcane-ai-gateway-dev` →
   Settings → enable **Authenticated Gateway**. Binding-path traffic (the
   worker) is pre-authenticated within the account, so no code change and
   glm-5.2 is unaffected. Repeat for `arcane-ai-gateway` before prod.

## Wire-format contract (added after the luna incident — read before ANY model change)

Cloudflare's run catalog validates request bodies against a PER-MODEL schema;
the wrong wire format 400s (AiGatewayError 7003) on every request. Verified
probe matrix, 2026-08-15, against the live gateway (SCHEMA-REJECT = 400 7003,
accepted = passes to the unified-billing gate):

| Model                | chat            | responses       |
|----------------------|-----------------|-----------------|
| openai/gpt-5.6-luna  | SCHEMA-REJECT   | accepted        |
| openai/gpt-5.6-terra | SCHEMA-REJECT   | accepted        |
| openai/gpt-5.6-sol   | (untested)      | accepted        |
| openai/gpt-5.4       | accepted        | accepted        |
| openai/gpt-5.4-mini  | accepted        | (untested)      |
| xai/grok-4.6         | accepted        | SCHEMA-REJECT   |
| @cf/* (glm, bge)     | native Workers AI — no gateway schema        |

Enforcement now in code: `ModelInfo.wireFormat` in `src/lib/costs.ts` is
REQUIRED for every unified-route model (model-catalog.test.ts fails without
it) and drives llm-router's openai wire plugin. **Process for adding any
third-party model:** (1) open its dashboard page (AI → Models → <model>) and
read the "Request formats" field; (2) probe both formats through a local
`wrangler dev --env dev` against the real gateway — a 400 7003 means wrong
format, a 402 2021 means accepted-awaiting-billing; (3) set `wireFormat` in
the catalog entry; the contract test forces this.

## Verify caching actually bills cached (the whole point)

- [ ] Run a 3+ turn **agent** send against dev on each tier (low = gpt-5.4-mini,
      mid = glm-5.2, high = grok-4.6), then:
      `SELECT model, input_tokens, cached_input_tokens FROM request_logs ORDER BY id DESC LIMIT 20;`
      Expect `cached_input_tokens > 0` from turn 2 onward on low/mid; high is
      best-effort (xAI's chat-completions cache hint is a header the gateway
      path doesn't expose — if grok never caches, revisit with a custom
      provider or Responses API).
- [ ] Acceptance (spec §7): ≥60% cached share of input tokens on ≥3-turn agent
      sends for low/mid.
- [ ] Second identical `unity_api_search` query returns instantly (D1 cache
      hit) — confirm no bge embed row lands in `request_logs` for the repeat.

## Eval baselining (needs real API keys — not runnable from the dev sandbox)

- [ ] `cd editor && bun run eval -- --preset server-mid` (and cf-low/cf-high as
      applicable) before/after flag flips. Gate: grounding low ≥10, mid/high
      ≥11 of 12; codegen no regression; note the new "Cached in %" column.
- [ ] A/B `ROUTING_V2` off→on on an ask-heavy mix; check quality parity +
      cost/send drop, then flip prod to `"on"`.

## Known deviations from the plan (deliberate, recorded)

- Tool-description slimming was scaled back to caps + the prescriptive
  `unity_api_search` trigger: with caching active, prefix text bills at
  10–25%, and trimming contract text out of tool descriptions is the classic
  way to regress tool triggering.
- Grounding-lint revise turns stay on the main model (context continuity),
  not the side-task lane.
- No `routed_reason` D1 column — routing decisions are dev-logged; billing
  already records the actually-served model.

## Environment note (this dev machine)

- `editor/tooling/unity-eval/run-task.test.ts` hangs under `bun test` on this
  machine **on a pristine tree too** (pre-existing; not part of
  `bun run verify`). There are also days-old spinning `bun test` processes
  from other repos (PIDs seen: 65806, 10486, 85571) burning a CPU core each —
  worth killing.
