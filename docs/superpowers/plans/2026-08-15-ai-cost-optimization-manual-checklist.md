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

## Verify caching actually bills cached (the whole point)

- [ ] Run a 3+ turn **agent** send against dev on each tier (low = gpt-5.6-luna,
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
