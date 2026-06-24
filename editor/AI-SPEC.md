# Optimizing the Arcane Agent for Unity — Claude-Code-level output on cheap models

> **Status: research complete, awaiting 4 constraints.** This file currently captures verified codebase facts + research synthesis. The *Recommended Approach* (phased roadmap + model shortlist) is filled in once the user answers the four constraint questions below. Do not treat this as final until the "Recommended Approach" and "Verification" sections are populated and approved.

## Context

The user is building **Arcane**, an AI coding agent inside a Tauri + React Unity IDE. The goal: make it produce **Claude-Code-level agentic coding output, but specialized for Unity game development, at minimal cost** — explicitly *without* heavy reliance on frontier models (favoring open models like DeepSeek, Kimi K2.5, MiniMax, Qwen3-Coder, GLM). A `graphify` knowledge graph of the Unity project already exists and is partially wired in.

The central question this plan answers: **how do we close the quality gap to Claude Code using cheap/open models?** The research answer (two independent streams converged): *the harness and grounding matter more than the model.* ~70% of Claude Code's edge is a portable harness (small tools, compaction discipline, grounded verification, plan/todo tracking); only ~30% is raw model capability. So the plan invests primarily in **verification loops + Unity grounding + context/cost discipline**, and treats model choice as a swappable, secondary lever.

## Current architecture (verified from code)

- **Two agent backends** (`src/stores/ai.ts`): an **Arcane path** (default) and a **Claude/ACP path**. Optimize the Arcane path; the Claude path is tightly coupled to Anthropic's bridge and not worth retargeting.
- **Arcane loop is PI-derived and already OpenAI-compatible.** `vendor/agent-loop.ts` runs the loop; `vendor/agent.ts` wraps it with a **pluggable `streamFn`**; `arcane-stream.ts` POSTs OpenAI-format `chat/completions` (tools converted to `function` format, `tool_calls` parsed) to `api.arcaneai.org`. **Swapping models = change base URL + key + model name + settings UI.** No loop rewrite. Tool-calling is already OpenAI-style, not Anthropic `tool_use`.
- **Mode-aware system prompts** (`services/prompts/`): ask / agent / plan-planning / plan-execution, each decorated with **Unity facts** (`unity-facts.ts` — version, URP/HDRP, input system, packages, `.ai/unity-rules.md`), a hardcoded **Unity context crib** (`unity-context.ts` — lifecycle/gotchas), and a **graphify snapshot** (`graphify/services/graph-context.ts`, capped ~1KB).
- **Tools** (`vendor/tools/`): `read`, `list`, `write`, `edit`, `bash` (Typebox schema → OpenAI function), plus **graphify tools** (`graphify_query/explain/path`) and **Unity read/mutate tools** with an approval + compile gate (`withUnityAnalyzerGate`).
- **graphify** = structural knowledge graph only (AST + LLM-extracted edges; NetworkX node-link JSON). **No embeddings / vector search anywhere in the repo.**
- **MCP** is supported only on the Claude path today (`mcp-config.ts`, `~/.arcane/mcp-servers.json`); the Arcane loop has no native MCP.
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

_TBD — populated after the four constraints are confirmed. Will be a phased roadmap (P0 restore compaction + verification loop → P1 Unity grounding via off-the-shelf MCP + version detection → P2 cost structuring + tool hardening → P3 routing tiers + internal eval), with the model shortlist resolved against the privacy answer._

## Verification

_TBD — will describe the internal Unity eval (analyzers + batchmode compile), a before/after quality+cost comparison on a sample of Unity tasks, and per-phase acceptance checks._
