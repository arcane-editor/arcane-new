# AI Cost & Context Optimization — Design

**Date:** 2026-08-15
**Status:** Approved (chat review §0–§4; §5–§7 approved by delegation)
**Owner branch:** `feat/ai-cost-context-optimization`

## Goals

1. **Better Unity-grounded responses** — the model starts every conversation knowing the project (structure, assemblies, conventions, past decisions) instead of rediscovering it.
2. **Lower cost** — cut the fixed per-turn overhead and make the remaining input tokens hit provider caches.
3. **Cache hits as the norm** — ≥60% of input tokens billed at cached rates on multi-turn agent sends.

Non-goals (explicitly deferred, unchanged from AI-SPEC.md): embeddings/RAG over user projects; server docs-corpus version expansion; BYOK.

## Current-state facts this design relies on

- Tier map (`arcane-server/src/config/plans.ts`): low=`openai/gpt-5.6-luna`, mid=`@cf/zai-org/glm-5.2`, high=`xai/grok-4.6`, inline=`@cf/zai-org/glm-4.7-flash`. No `super` tier (legacy alias → high).
- All three tier models support provider-native prefix caching (verified 2026-08-15):
  - gpt-5.6-luna: $0.20 → **$0.02 cached** (90%). GPT-5.6 family uses breakpoint-style caching: implicit default breakpoint works with zero request changes; writes bill 1.25×; 30-min TTL; `prompt_cache_key` (body field) recommended for reliable routing (~15 req/min/key).
  - glm-5.2 on Workers AI: $1.40 → **$0.26 cached** (81%). Workers AI shipped real prefix caching 2026-03, default-on for this model; optional session-affinity header improves hit rate.
  - grok-4.6: $2.00 → **$0.50 cached** (75%). Prefix-based; `x-grok-conv-id` header (Chat Completions) or `prompt_cache_key` (Responses API) as routing hints.
- `cached_input_tokens` is already plumbed end-to-end (llm-router → chat.ts → arcane-stream → D1 `request_logs` → `estimateCost` cached-rate math) and currently always reads 0.
- `skipCache: true` in `llm-router.ts` disables the **AI Gateway exact-match response cache** — correct, unrelated to provider prefix caching, and must stay.
- Fixed overhead per LLM call: ~2,700 tok system prompt + ~2,500–3,500 tok tool schemas, on up to 20 loop turns per send (turn-governor caps 10/16/20).
- Existing local indices (all Rust, none surfaced to the model today except a 1KB graph snapshot): GUID/reverse-ref index (`unity_index.rs`), asmdef graph (`asmdef.rs`), script classifier (`unity.rs`), file index (`file_index.rs`), graphify AST graph + Python sidecar (`graphify.rs`).
- Eval harness (`editor/tooling/unity-eval/`, 24 tasks) records input/output tokens but has no cache metric.

## §1 Cache activation

**Root cause of 0 cached tokens:** volatile content inside the system prompt. The system prompt renders before all history, so any change (graph auto-rebuild 3s after each mutating turn, facts arriving on turn 2, plan checkboxes) re-bills the entire conversation at fresh rates.

Changes (editor unless noted):

1. **Freeze the system prompt per conversation.** Unity facts block, `.ai/unity-rules.md` snapshot, and graph snapshot are captured once when a conversation's first send is built and reused verbatim for the conversation's lifetime.
2. **Prime facts at workspace open** (not first send) so turn 1 and turn 2 see the same block. If facts are still cold at first send, the frozen snapshot is the cold block for that whole conversation (stability beats completeness).
3. **Mid-conversation updates ride the tail.** If facts/graph/rules changed materially mid-conversation, append a small `<project-update>` block to the newest user message. Appending never invalidates prior prefix.
4. **Plan-execution stops embedding the live plan in the system prompt.** System prompt keeps static instructions + plan file path; the plan body is injected into the first user message of the conversation (written once, stable); the agent re-reads the plan file via `read` for current state.
5. **Stable tool sets.** Graphify tools always registered (respond "graph not built — suggest building it" when status is absent). Turn governor at cap sends `tool_choice: "none"` + its existing final-answer nudge instead of stripping the `tools` array.
6. **No mid-send model changes.** `withTurnEscalation` is removed from the stream stack (see §2 for its replacement).
7. **Server provider hookup** (`llm-router.ts`): pass `prompt_cache_key: metadata.conversationId` for openai/* models; attempt session-affinity for Workers AI binding and `x-grok-conv-id` for xai/* (both best-effort; if the AI SDK/gateway path can't set them, ship without — prefix caching still hits opportunistically). Editor sends `conversationId` in `metadata` (already has session ids).
8. **Comment/rename** around `skipCache` so gateway response-cache vs provider prefix-cache can't be confused.

Acceptance: `request_logs.cached_input_tokens > 0` on real traffic; ≥60% cached share of input tokens on sends with ≥3 turns; eval report shows per-run cached share.

## §2 Smart model routing

Effort becomes a **ceiling/billing tier**, not a model pin. New `resolveModelForSend(tier, signals)` in `arcane-server` replacing `resolveModelForTier`:

- **Heuristic signals** (no LLM call, v1): prompt mode (ask/agent/plan-*), user text length, attachment count/kinds, code-generation intent (fenced code, file mentions, imperative verbs), previous-send telemetry echoed by the client (`repairCount`, `toolErrorCount`, `escalated`).
- **Routing rules v1** (config-driven, flag-gated `ROUTING_V2` w/ static map fallback):
  - ask-mode, short, no attachments, no codegen intent → `low` model regardless of tier (never bills above actual model used).
  - agent/plan-execution stays on the tier model; plan-planning may drop one tier for short scoping asks.
  - Escalation at **send boundaries only**: previous send ended with repairs ≥ 2 or governor cap → next send routes one tier up (within plan entitlement), surfaced to the user in the existing model chip.
- **Sticky per conversation:** first routed model is pinned (this is also what makes `prompt_cache_key`/conv-id effective). Tier-up re-pins and accepts the one-time cold cache.
- **Side-task lane:** distillation (§4), grounding-lint revise turn, titles → `INLINE_MODEL`/low. Graph enrich unchanged.
- Billing/telemetry: bill by actual model (already the case); log `routedFrom`/`routedTo` + reason in `request_logs`.

## §3 Project context pack

A deterministic, capped block assembled client-side at conversation start, replacing today's facts+snapshot tail (same position in the prompt; frozen per §1). Budgets: ~1.5KB (low) / 2.5KB (mid) / 4KB (high) chars beyond the existing facts.

Contents, in order:
1. Project identity (existing facts block, unchanged).
2. **Assembly map** — from `asmdef.rs`: assembly names, reference edges, editor-only flags, root folders; condensed, sorted, capped (top ~15 assemblies by script count).
3. **Codebase shape** — existing graph snapshot (architecture summary, community labels, god nodes) at the new budget; drop volatile node/edge counts (jitter with no signal).
4. **Key files** — god nodes ∪ recently-edited (from session history) ∪ memory-pinned paths; ≤12 paths.
5. Conventions — `.ai/unity-rules.md` capped (§5).
6. **Memory digest** (§4) — ≤700 tok.

Determinism: sorted keys, stable ordering, no timestamps/counts; byte-identical unless content changed.

**New tool `project_symbols`:** the graphify Python sidecar (which already parses every `.cs`) additionally emits `symbols.json` (per-file: types, members, signatures, line numbers). Tool input `{path?: string, type?: string}` returns the symbol table for a file or a type (≤2KB). Gated like other graphify tools; suggests building the graph when absent. Purpose: replace whole-file `read`s used only to find a member.

## §4 Per-project memory

**Storage:** markdown files in `<workspace>/Library/ArcaneIDE/memory/` (machine-local, Unity-gitignored). One entry per file; frontmatter: `category` (decision | convention | gotcha), `title`, `created`, `lastUsed`, `timesUsed`, `sourceConversation`. Plus one rolling `task-context.md` (no frontmatter, overwritten).

**Write path (automatic):** after sends that completed ≥1 mutating tool call or plan step, one `INLINE_MODEL` distillation call over a compact send summary → 0–2 candidate facts. Dedupe before write: normalized-title match + keyword overlap against the index; matches update the existing entry (bump salience) instead of creating. Distiller criteria: durable, project-specific, not derivable from the index/code, no code bodies, no secrets. No model-facing `remember` tool in v1.

**Read path:** memory digest in the context pack — top-N by salience × recency × category weight, ≤700 tok — plus `memory_search` tool (keyword search over entries, read-only).

**Bloat control:**
1. Hard caps: ≤30 entries/category, ≤1KB/entry, ≤200KB store. Writes beyond a cap must merge or evict (lowest salience first) — never silently grow.
2. Consolidation: when a category exceeds 80% of cap, one INLINE_MODEL pass merges near-duplicates, rewrites stale entries, deletes finished-one-off items.
3. `task-context.md` is overwritten each session — the bloat-prone category structurally cannot grow.

Transparency: plain files the user can open/edit/delete; memory writes surfaced in the session UI log line.

Cache interplay: digest is frozen per conversation; new memories surface next conversation (or via `<project-update>` tail when pinned as important).

## §5 Token diet

1. **Tool schemas** (~2.5–3.5k tok/request): rewrite descriptions for contract precision at ~60% of current length; hoist duplicated behavioral guidance ("when in doubt…", cross-tool steering) into the system prompt once; keep trigger conditions in each tool's own description. Target: ≤1,800 tok total schema payload in agent mode. Verified against grounding/codegen evals (tool triggering must not regress).
2. **Caps on unbounded blocks:** `.ai/unity-rules.md` → 6KB with truncation notice; `unity_api_search` results → wrap in existing `cap()` (8KB); `graphify_query` → enforce its token budget as a hard output cap.
3. **Compaction:** unchanged trigger (80%); with caching live, unelided history is cheap (10–25% of fresh price), so aggressive summarization would now *cost* more than it saves — record this as the reason compaction stays elision-only.

## §6 Grounding efficiency & triggering

1. **Server embedding/search cache:** KV (or D1) cache on `/v1/unity/api/search` keyed by sha256(normalized query + version/pipeline/input/docType/topK), storing the final response; TTL 7 days. Saves the bge embed + Vectorize query on repeats (the AI-SPEC.md line-77 known skip).
2. **Triggering:** models under-call `unity_api_search` (eval residual). Make its description prescriptive about *when* ("before writing any Unity API usage you are not certain of; whenever a compile hint references a missing member") and keep the tiny schema. Measured by the existing `tool_called` eval assertion + `groundingToolCalls` telemetry.
3. Grounding-lint revise turn routes to the side-task lane (§2).

## §7 Verification & rollout

**Instrumentation first:** add cached-token capture to `eval-stream.ts` → `TaskResult.cachedInputTokens` → report column + totals; add a `bun run eval` cache-share line. D1: `request_logs` already has the column.

**Phases (each lands green: editor bun tests + tsc + check:modules; server vitest + types):**
- P1 Cache activation (§1) + eval cache metric. Gate: cached tokens > 0 against real providers on a manual smoke; eval parity (grounding low ≥10, mid/high ≥11 of 12; codegen no regression).
- P2 Routing (§2), flag-gated. Gate: eval A/B static-vs-routed non-inferior; cost/send down on ask-heavy mix.
- P3 Context pack + `project_symbols` (§3). Gate: eval parity + agentic tasks use fewer `read` tokens (report delta).
- P4 Memory (§4). Gate: unit tests for caps/dedupe/consolidation; manual QA script.
- P5 Token diet + grounding cache/triggering (§5–§6). Gate: fixed overhead ≤65% of baseline; grounding evals not regressed; server tests for KV cache.

**Success criteria (overall):**
- ≥60% cached input-token share on ≥3-turn agent sends (request_logs).
- Fixed per-turn overhead (system+tools) reduced ≥35%.
- Eval: no regression on grounding/codegen/agentic; agentic input tokens per task down ≥20%.
- Memory store bounded under caps after simulated 50-session soak.

**Risks:**
- Gateway header pass-through for session-affinity/`x-grok-conv-id` undocumented → ship best-effort, measure, don't block on it.
- gpt-5.6 cache writes bill 1.25× → first turn slightly costlier; break-even at 2nd turn (fine for agent loops).
- Tool-description slimming can regress triggering → eval-gated, revert per-tool if needed.
- Routing downgrades could degrade perceived quality → conservative v1 rules, flag + model chip transparency.
