# Optimizing the UnityIDE Agent for Unity — Claude-Code-level output on cheap models

> **Status: research complete, awaiting 4 constraints.** This file currently captures verified codebase facts + research synthesis. The *Recommended Approach* (phased roadmap + model shortlist) is filled in once the user answers the four constraint questions below. Do not treat this as final until the "Recommended Approach" and "Verification" sections are populated and approved.

## Context

The user is building **UnityIDE**, an AI coding agent inside a Tauri + React Unity IDE. The goal: make it produce **Claude-Code-level agentic coding output, but specialized for Unity game development, at minimal cost** — explicitly *without* heavy reliance on frontier models (favoring open models like DeepSeek, Kimi K2.5, MiniMax, Qwen3-Coder, GLM). A `graphify` knowledge graph of the Unity project already exists and is partially wired in.

The central question this plan answers: **how do we close the quality gap to Claude Code using cheap/open models?** The research answer (two independent streams converged): *the harness and grounding matter more than the model.* ~70% of Claude Code's edge is a portable harness (small tools, compaction discipline, grounded verification, plan/todo tracking); only ~30% is raw model capability. So the plan invests primarily in **verification loops + Unity grounding + context/cost discipline**, and treats model choice as a swappable, secondary lever.

## Current architecture (verified from code)

- **Two agent backends** (`src/stores/ai.ts`): an **UnityIDE path** (default) and a **Claude/ACP path**. Optimize the UnityIDE path; the Claude path is tightly coupled to Anthropic's bridge and not worth retargeting.
- **UnityIDE loop is PI-derived and already OpenAI-compatible.** `vendor/agent-loop.ts` runs the loop; `vendor/agent.ts` wraps it with a **pluggable `streamFn`**; `hosted-stream.ts` POSTs OpenAI-format `chat/completions` (tools converted to `function` format, `tool_calls` parsed) to `api.unityide.app`. **Swapping models = change base URL + key + model name + settings UI.** No loop rewrite. Tool-calling is already OpenAI-style, not Anthropic `tool_use`.
- **Mode-aware system prompts** (`services/prompts/`): ask / agent / plan-planning / plan-execution, each decorated with **Unity facts** (`unity-facts.ts` — version, URP/HDRP, input system, packages, `.ai/unity-rules.md`), a hardcoded **Unity context crib** (`unity-context.ts` — lifecycle/gotchas), and a **graphify snapshot** (`graphify/services/graph-context.ts`, capped ~1KB).
- **Tools** (`vendor/tools/`): `read`, `list`, `write`, `edit`, `bash` (Typebox schema → OpenAI function), plus **graphify tools** (`graphify_query/explain/path`) and **Unity read/mutate tools** with an approval + compile gate (`withUnityAnalyzerGate`).
- **graphify** = structural knowledge graph only (AST + LLM-extracted edges; NetworkX node-link JSON). **No embeddings / vector search anywhere in the repo.**
- **MCP** is supported only on the Claude path today (`mcp-config.ts`, `~/.unityide/mcp-servers.json`); the UnityIDE loop has no native MCP.
- **Unity awareness today:** 67 lifecycle methods (`features/csharp/services/lifecycle-db.ts`), `csharp-ls` LSP, `UNITY_API_LIST` for @-mentions, live scene/console context.

## Gaps blocking "Claude Code level" (verified + research-confirmed)

1. **No semantic/version-accurate Unity API grounding** — static facts + 1KB graph snapshot; cheap models hallucinate Unity APIs.
2. **Context compaction stripped from the fork** — upstream PI *ships* compaction (trigger `contextWindow−16384`, keep-recent-20k, structured summary, file-op tracking); the fork's loop appears to have removed it → unbounded history → weak-model goal-drift + runaway cost. **Verify against `vendor/agent-loop.ts` before fixing.**
3. **No closed verification loop** — there's an analyzer *gate*, but compile/diagnostic errors aren't fed back so the model self-corrects.
4. **Single model for everything** — no routing/escalation tiers.
5. **No prompt-caching cost structure** — requests aren't structured as stable-prefix + volatile-tail.
6. **Tool-call fragility with open models** — PI bug #2119 (3 malformed-response failure modes) will surface behind OpenRouter/LiteLLM.

## Research synthesis (two streams, June 2026, citation-backed in chat history)

### Stream A — Unity grounding & verification (highest correctness ROI)
- **Verification loop is the #1 lever.** Tier 1: in-process Roslyn `CSharpCompilation` + **Microsoft.Unity.Analyzers** (43 `UNT####` rules: GC allocs, `GetComponent`/`Camera.main` in Update, physics-in-Update `UNT0004`, editor-in-runtime `UNT0040`, serialization `UNT0011/0013`, non-alloc physics `UNT0028`, cached `WaitForSeconds` `UNT0038`, …) — milliseconds, no Unity needed, references `Library/ScriptAssemblies/*.dll`. Tier 2: reuse existing `csharp-ls` diagnostics. Tier 3: Unity `-batchmode` compile as final gate when an install exists. Feed structured diagnostics (with the *real* signature pulled from the API index for `CS1061/CS0117/CS1501`) back into a repair prompt; cap 3–5 iterations.
- **Version/pipeline/input detection** from `ProjectVersion.txt`, `Packages/manifest.json` + `packages-lock.json`, `ProjectSettings.asset → activeInputHandler`. Inject into the prompt; **hard-filter retrieval to these versions** (URP `_BaseColor` vs Built-in `_Color`; Input System vs Input Manager).
- **API grounding = structured index, not vector RAG.** Reuse off-the-shelf MCP: **`unity-api-mcp` (Codeturion)** — per-version SQLite signatures + deprecation tables, BM25, <15ms, the hallucination-killer; **`unity-docs-mcp` (Saqoosha)** — prose manual/how-to. De-Hallucinator pattern: inject real signatures for intended types before generation.
- **Build a small internal Unity eval** (prompt → must-pass-analyzers + must-compile-in-batchmode), modeled on ACM 10.1145/3663532.3664466 — becomes the regression gate for model/prompt swaps. *No public Unity-specific model benchmark exists*, so this is the real tiebreaker.
- **Model proxies (verify on own eval):** MiniMax M2.5 — best tool-use/instruction-following (76.8% BFCL); Qwen3-Coder-Next — best cost + long context (256K/1M, ~$0.22/$1.00 Mtok, self-hostable ~30–46GB); Kimi K2.5/K2.6 — best raw codegen.

### Stream B — Harness, context, cost (highest cost/reliability ROI)
- **Restore PI compaction (P0).** Then add **no-LLM compaction first**: Claude-Code "microcompaction" (replace stale tool outputs with `[Tool result cleared]`) + Cline file-read dedup (keep only latest version of each file). **Trigger at 80%** for weak models. No-LLM elision preserves KV cache; *summarizing* compaction busts it.
- **Cost levers:** DeepSeek *automatic* prefix caching (>50% free, up to 98% cheaper reads) — structure requests stable-prefix + volatile-tail with a `cache_control` breakpoint; OpenRouter sticky routing; retrieval instead of dumping whole files; max-tokens discipline.
- **Tool hardening:** keep PI's 4-tool minimalism; **avoid JSON-Schema `format`/numeric/array/union constraints** (weak models break — put rules in `description`); prefer `enum`; use vLLM/SGLang structured decoding for 100% schema adherence if self-hosting. **Fix PI #2119** (stream hang, orphaned tool_result, empty tool-use) — required for open-model reliability.
- **Verification > self-critique per dollar** (Reflexion 91% vs 80%). **Plan-then-act**: stronger model writes plan to a `TODO.md`; cheap model executes per step via ReAct.
- **Routing last:** prefer **heuristic escalation** (retry-count ≥2, planning/compaction steps, agent self-flag) over a learned classifier. Tiers e.g. tier-1 DeepSeek-V4/Qwen3-Coder (cheap + caching) → tier-2 GLM/Kimi.
- *Caveat:* all model SWE-bench numbers are vendor-reported/directional — confirm on LiveBench/own eval before locking tiers.

## Open constraints — needed before finalizing

1. **Code privacy / data residency** → gates the model shortlist (OpenRouter-any vs Western-hosted vs self-host vs advise).
2. **Deployment & who pays** → gates how hard to optimize cost (host+meter vs BYOK vs personal).
3. **Priority capability** → agentic edits vs codebase Q&A vs inline completion vs all.
4. **Retrieval-infra appetite** → prompt+graph only vs add embeddings/RAG vs full Unity pipeline vs best-ROI.

Working lean (to be confirmed): privacy 1a/1b, deployment 2a, capability 3a, infra 4b.

## Recommended Approach

Superseded by the approved design + plan (2026-07-07):
- Design: `../docs/superpowers/specs/2026-07-07-unity-ai-differentiation-design.md`
- Plan (Phases 0-1): `../docs/superpowers/plans/2026-07-07-ai-quick-wins-and-eval.md`

Constraint answers (2026-07-06): privacy = open to any provider; deployment = hosted, UnityIDE pays (CF failover retained); priority = verified agentic edits, then grounded Q&A, then completion; retrieval = graphify + unity_api_search (no new embeddings infra).
Note: several "Gaps" above are now closed in code — compaction exists (`vendor/compaction.ts`), the verification loop exists (analyzer + compile gates feed diagnostics back), and `unity_api_search` provides version-accurate grounding. See the design doc §2 for the verified current state.

## Verification

The internal Unity eval lives at `tooling/unity-eval/` (12 seed tasks across codegen / grounding / agentic families, scored by unity-analyzers + file/answer checks against fixture projects). Run: `bun run eval -- --base-url <url> --api-key-env <VAR> --model <id> --label <name>`. Baselines are committed under `tooling/unity-eval/results/baselines/`. Every prompt/model/routing change ships with a before/after run.

## Prompt caching status (2026-08 — ACTIVE)

Superseded the 2026-07 "deliberately off" record. Design + rollout:
`../docs/superpowers/specs/2026-08-15-ai-cost-and-context-optimization-design.md`.

- **Caching by route, and it is no longer uniform.** `@cf/zai-org/glm-5.3` (Deep Think planner + Max hard-task executor — $0.26/M cached vs $1.40 fresh, 81% off) and `openai/gpt-5.6-sol` (Max planner — $0.50/M vs $5.00, 90% off, implicit breakpoint + `prompt_cache_key`) both cache server-side automatically. Workers AI shipped real prefix caching in 2026-03 and takes `x-session-affinity` for cache-shard routing; the OpenAI family wants `prompt_cache_key` in the body. **`spark/muse-spark-1.3-contributor` (executor on all three tiers + the Standard planner, since 2026-09-03) is the exception**: it is a `direct`-route model with no Cloudflare in the path, so neither hint applies. Prefix caching there is opportunistic — if the endpoint reports cached tokens in its OpenAI-compatible usage details the AI SDK surfaces them and billing picks them up with no extra wiring, but nothing is guaranteed, and its cached rate is SEEDED equal to its input rate, so no discount is modelled either way. Retired from the lineup: `@cf/zai-org/glm-5.3-flash` (2026-09-03), `xai/grok-4.6` (2026-08-30) and `spark/muse-spark-1.2-contributor` (2026-08-27) — all three stay in `MODEL_CATALOG` so historical usage rows still cost out.
- **The client's job is prefix STABILITY, not breakpoints.** The volatile decoration (facts, context pack, graph snapshot) is frozen per conversation (`prompts/frozen-context.ts`); the plan body left the plan-execution system prompt; tool sets no longer flap (graphify/memory tools always registered; governor sends `tool_choice: 'none'` instead of stripping `tools`); mid-send model escalation was replaced by send-boundary latched escalation (`send-escalation.ts`). Drift surfaces as tail notes on the newest user message.
- **`skipCache: true` on the gateway stays** — that disables AI Gateway's unrelated exact-match response-replay cache (a replayed sampled completion is semantically wrong). Provider prefix caching is a different mechanism and is unaffected.
- **Measurement:** `request_logs.cached_input_tokens` (was always 0; now fed by providers), `estimateCost` already bills cached tokens at catalog cached rates, and the eval report carries a "Cached in %" column + run-level cache share.
- **Compaction stays elision-only, and that matters MORE now:** with caching live, unelided history bills at 10–25% of fresh price, while summarizing compaction would rewrite the prefix and re-bill everything.
- The server-side search cache for `/v1/unity/api/search` (the old "same normalized query re-embeds" skip) now exists: D1 `unity_search_cache`, 7-day TTL (migration 0021).

## Model routing status (2026-08)

**Current lineup (2026-09-03).** Standard = spark planner + executor. Deep Think = glm-5.3 planner + spark executor. Max = gpt-5.6-sol planner + spark executor, escalating to glm-5.3 on hard tasks. Inline (tab) = qwen3-30b-a3b-fp8. `spark/muse-spark-1.3-contributor` took every slot glm-5.3-flash held on 2026-09-03. No routed model has a long-context repricing cliff — grok's 200k cliff went with it.

Two consequences of routing spark that are easy to miss. It is a `direct`-route model, so those slots sit outside Cloudflare entirely — no AI Gateway, no gateway cache or logs, its own availability. And its conservative 131,072 catalog seed is once again the smallest window in every tier's lineup, so `/v1/config` publishes 131,072 for all three tiers (it published 1,048,576 / 1,048,576 / 400,000 while glm-5.3-flash held those slots) and the editor compacts that much sooner. Raising the seed in the catalog raises every tier at once.

**Reasoning effort (2026-09-03).** `config/routing.ts` resolves an effort level alongside the model, from the same (tier, role) pair: Standard and Deep Think plan at `max` and execute at `xhigh`; Max inverts it and puts `max` on the executor, with the planner and the hard-task executor at `xhigh`. The memory side-task lane sends none. `max` is then CLAMPED to spark — no other provider implements it — so today Deep Think's glm-5.3 planner serves `xhigh` despite the table asking for `max`, and flips by itself if that slot ever moves to spark. `services/llm-router.ts` maps the level onto each wire (`providerOptions.spark.reasoningEffort` → `reasoning_effort`; `providerOptions.openai.reasoningEffort`; `providerOptions['workers-ai'].reasoning_effort`, flattened to `high` — the ceiling that wire publishes) and retries once with the field dropped if a provider rejects it, the same fallback `tool_choice` has. Effort is a streamCompletion ARGUMENT, never a request field, so a client cannot ask for more than its tier resolves to.

**These are CODE DEFAULTS ONLY.** A deployed environment whose D1 `app_config` table holds a `model_routing` doc ignores `DEFAULT_MODEL_ROUTING` entirely (`lib/app-config.ts`'s `getModelRouting`). Changing `config/plans.ts` does nothing there — the doc has to be rewritten through `PUT /admin/config/models`.

`config/routing.ts` (flag `ROUTING_V2`, on in dev / off in prod): effort tier is a ceiling, not a model pin — short attachment-free non-code asks route down to the low model; `taskType: 'memory'` (the memory distiller/consolidator side-task lane) always routes to `INLINE_MODEL`. Routing is sticky per conversation (provider caches are per-model). The served model rides the usage SSE event.

## Project context & memory status (2026-08)

- **Context pack** (`prompts/context-pack.ts`, frozen per conversation): asmdef assembly map + graphify god-node key files + per-project memory digest, deterministic and effort-budgeted.
- **`project_symbols` tool**: file/type symbol tables straight from graph.json (Rust `graphify_symbols`) — replaces whole-file reads used only to find a member.
- **Per-project memory** (`services/memory/`): markdown entries under `Library/UnityIDE/memory` (user-visible/editable), written by a post-send distiller on the side-task lane, deduped-before-write, hard-capped per category with never-recalled-only eviction, consolidated near the cap, recalled via the digest + `memory_search`. Task context is one overwrite-only file. Setting: `ai.memory.enabled`.
