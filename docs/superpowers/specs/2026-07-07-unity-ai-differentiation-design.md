# Arcane AI Differentiation — Design

> **Date:** 2026-07-07
> **Status:** Approved design. Next step: implementation plan (writing-plans).
> **Scope:** Make Arcane's AI good enough that Unity devs switch editors for it. Covers harness features, model strategy, a <$500 Unity-specialization fine-tune, and the eval that gates all of it. Spans `editor/` and `arcane-server/`.
> **Companion docs:** `STANDOUT-FEATURES.md` (market strategy, 2026-06-29), `editor/AI-SPEC.md` (research synthesis — partially stale, corrected below).

---

## 1. Goal & thesis

Make Arcane's AI the reason a Unity dev switches editors. The differentiator is **not** "a better chatbot" — Cursor/Copilot will always have frontier models Arcane can't outspend. The differentiator is what the codebase is already ~70% built for: **an agent that proves it's right** — grounded in the live project (version, pipeline, scene, console), gated by analyzers, verified by real compilation and tests, safe with serialized data — and **visibly so** in the UI.

Phased hero capabilities (user-confirmed):
1. **Verified agentic edits** — the trust moat. (Delivered by Phases 0–2.)
2. **Grounded Unity Q&A / debugging** — same harness, cheaper to add. (Delivered by Phase 0's prompt rewrite + the existing grounding tools + Phase 2's docs fetch; no separate phase needed.)
3. **Inline tab completion** — last; new subsystem, least Unity-differentiated. (Phase 4.)

### Constraints (user-confirmed 2026-07-06/07)

| Constraint | Answer |
|---|---|
| "Dull" diagnosis | Generic/ungrounded + weak agent ability + weak model (NOT chat UX) |
| Serving stack | Open to anything — external APIs, CF as one tier, self-host later |
| Hero capability | All three, phased (order above) |
| Fine-tune goal | Unity specialization (not cost, not marketing) |
| Fine-tune serving | Training only for now; serving decided after eval results |
| Approach | Eval-first, but quick wins ship immediately in parallel |

## 2. Verified current state (code-checked 2026-07-06)

**Models** — all Cloudflare Workers AI, chosen server-side from `reasoningLevel` (`arcane-server/src/config/plans.ts:19-24`): low = Qwen2.5-Coder-32B, mid (default) = Kimi K2.7-code, high/super = GLM-5.2. Client default effort is `mid` (`editor/src/stores/ai.ts:236`). No BYOK; $1/hr soft cap per user (`chat.ts:12`). Server passes client messages through verbatim — model routing is a small, contained change.

**`editor/AI-SPEC.md` corrections** (it understates what's built):
- Compaction **exists** (`vendor/compaction.ts`, no-LLM elision, wired at `agent-loop.ts:78`) — but window hardcoded 32768 (`agent-service.ts:201`).
- A **closed verification loop exists**: `withUnityAnalyzerGate` + `withUnityCompileGate` feed analyzer findings and real compiler errors back into tool results; compile gate includes a de-hallucinator (real type members injected on CS1061/CS0117 from the D1 API index); 4 repair attempts/file cap.
- **Version-accurate grounding exists**: `unity_api_search` tool → server Vectorize (`unity-docs-v1`) + D1 `unity_api_signatures`.
- **Tiered routing exists** (user-driven 4-tier effort → model), not heuristic.

**Genuinely missing:** eval infra, AI telemetry, prompt caching (prompt is structured for it but no breakpoint sent), web/docs fetch, todo/plan tool on the Arcane path, max-turn cap, loop detection, LSP-diagnostics feedback to the model, tool-call hardening (PI #2119 modes), semantic scene/prefab diff.

**Mechanical "dull" causes:** default = mid model; chat `max_tokens` 4096 (`arcane-stream.ts:89`); every prompt enforces terseness ("keep prose tight", "one short line", "no preamble"); flat persona; 32k compaction window over-elides long sessions; 1KB graphify snapshot cap (`graph-context.ts:18`).

## 3. Phase 0 — Quick wins (ship immediately, ~1 week)

### Editor (`editor/src/features/ai-panel/`)
- **Prompt rewrite** (`services/prompts/`). Keep agent-mode tool discipline; delete blanket terseness. Ask mode: senior-Unity-dev persona that explains root causes, cites the project's actual facts (version/pipeline/assembly) in answers, adapts length to the question. Agent mode: keep "explain before you act"; replace "brief summary" with "report what changed, what was verified, what to watch."
- **Output ceilings** (`arcane-stream.ts:89`): chat 4096 → 16384; plan/edit 8192 → 24576.
- **Per-tier compaction windows** (`agent-service.ts:201`): map tier → real model context (low 32k; mid/high 128k+). Server returns the resolved model's window in stream metadata so the client stays honest.
- **Default effort** `mid` → `high` (`ai.ts:236`). The $1/hr cap bounds downside; first impressions should run the best model.
- **Graph snapshot budget by tier** (`graph-context.ts:18`): 1KB → 4KB on high tiers.

### Server (`arcane-server/`)
- **External provider routing** in `src/services/llm-router.ts`: keep the Workers AI binding as the low tier and universal failover; add OpenAI-compatible upstreams keyed per tier in `plans.ts` (OpenRouter or direct DeepSeek/Moonshot/Z.ai). First lineup to trial: mid = DeepSeek-V4 or Qwen3-Coder (cheap + prefix caching), high = Kimi K2.5 / GLM-5.2 full-size via API. Provider keys via `wrangler secret`.
- **Prompt caching**: exploit the existing stable-prefix/volatile-tail prompt order — DeepSeek auto prefix caching; `cache_control` breakpoints where supported.
- **Minimal AI telemetry**: extend `request_logs` (turns per task, tool-error counts, compile-gate repair counts). Feeds eval seeds and fine-tune data later.

## 4. Phase 1 — The Unity eval (parallel with Phase 0)

Location: `editor/tooling/unity-eval/`. The verifier already exists (analyzers, compile gate, headless test runner, GUID index) — the eval packages it.

- **Task set: 40–80 tasks, three families**
  1. **Codegen** — feature tasks against fixture projects. Pass = 0 analyzer errors + `-batchmode` compile + required behavior present (structural assert or EditMode test).
  2. **Grounding Q&A** — version/pipeline-specific questions with ground truth from the `unity_api_signatures` D1 data; auto-checkable for API names/signatures.
  3. **Agentic multi-step** — safe serialized-field rename (FSA attribute present, refs intact per GUID index), fix a console NRE from scene context, asmdef split. Pass = end-state checks.
- **Fixtures**: 2–3 minimal Unity projects (URP + Built-in; new + legacy Input) under `editor/fixtures/`.
- **Runner**: headless Bun/Node script driving the real vendor agent loop (same tools, same prompts) against a chosen model config. Scores pass/fail + turns + tokens + cost + wall time; JSON results per run; comparison table across runs.
- **Role**: regression gate for every prompt/model/fine-tune change; also marketing material (no public Unity AI benchmark exists).

## 5. Phase 2 — Harness depth: the verified agent

Goal: an agent run **ends with proof**, not "done!".

- **Todo/plan tool** for the Arcane path; render with the checklist UI the Claude path already has (`ClaudePlanList.tsx` pattern).
- **Turn discipline**: max-turn cap with graceful wrap-up; loop detection (same tool + same args repeated → forced-rethink prompt).
- **LSP feedback**: feed `csharp-ls` diagnostics into write/edit tool results alongside the analyzer gate (today shown to the user, never to the model).
- **Verification-as-artifact (the demo moment)**: on task completion the agent must run a closing pass — analyzers → compile (live gate or batchmode) → affected EditMode tests → GUID-index integrity for touched assets — rendered as a **Verified card** in chat: "✓ compiles clean · ✓ 3/3 tests pass · ✓ 0 analyzer errors · ✓ 14 scene references intact." Failure → bounded self-repair (existing 4-attempt cap).
- **Tool-call hardening** for open models (PI #2119): detect stream-hang, orphaned tool_results, empty tool calls; retry with repair hints; keep schemas enum-simple.
- **Heuristic escalation**: repair attempts ≥ 2 or planning steps → auto-bump one tier, visible in UI ("escalated to High for this step").
- **Docs fetch tool**: extend `get_unity_docs` from URL-only to fetch-and-extract of the version-matched page, cached offline.
- **Explicitly deferred**: embeddings/RAG over user projects (graphify + `unity_api_search` suffice), MCP on the Arcane path, subagents.

## 6. Phase 3 — <$500 Unity-specialization fine-tune (gated on the eval)

**Goal:** a model measurably better *at Unity* than anything its size — version-correct APIs, pipeline awareness, serialization safety, fluent in Arcane's exact tool schema. **Non-goal:** general coding ability (router keeps general work on big-tier models).

- **Base model:** Qwen3-Coder-30B-A3B-Instruct (MoE, ~3B active: trains like a small model; Fireworks/Together can serve it as serverless LoRA per-token later). Fallback: Qwen2.5-Coder-14B.
- **Data (~$150–300 API spend):**
  1. *Verified agentic traces* — rejection sampling by verification: a strong teacher (Kimi K2.5 / DeepSeek via Phase-0 routing) runs through Arcane's own harness on generated tasks over open-license Unity repos + fixtures; keep only traces passing the verifier (compile + analyzers + tests). Target 3–8k traces in Arcane's exact tool-call format.
  2. *Grounding pairs (nearly free)* — auto-generated Q→A and deprecated-API→replacement pairs from `unity_api_signatures` + migration maps.
  3. *Repair pairs* — (broken code + real compiler error) → fix; harvested from compile-gate telemetry + synthetic corruption of fixture code.
- **Training (~$50–150):** QLoRA rank 16–32 via Axolotl or LLaMA-Factory on 1–2× rented H100 (~$2–3/GPU-hr, 10–30 GPU-hr incl. failed runs). Managed alternative: Together fine-tuning API.
- **Gate:** must beat **both** its base model **and** the current mid tier on the eval's grounding + agentic families. Win → decide serving then (serverless LoRA, per-token, no fixed cost). Lose → <$500 spent to prove the model isn't the bottleneck; dataset remains reusable on future bases.
- **Budget:** data $150–300 + training $50–150 + eval runs $30–50 = **$230–500 total**.

## 7. Phase 4 — Tab completion (sketch; own design doc when scheduled)

Monaco inline-completion provider + FIM model. Start off-the-shelf (Qwen2.5-Coder-7B FIM or Codestral on a fast provider; <400ms target; debounce + prefix caching), inject Unity facts + nearby types via LSP into FIM context. Phase-3's data pipeline makes a later 1.5–7B Unity-C# FIM fine-tune (~$100) straightforward. Deliberately last: least Unity-differentiated, most infrastructure-heavy.

## 8. Risks

- **External APIs add keys/spend** → per-tier caps in `plans.ts`, prefix caching, CF binding failover, keep the $1/hr user cap.
- **Prompt rewrites regress agent discipline** → the eval catches it (why Phase 1 runs in parallel with Phase 0).
- **Unity's own AI improves** → moat is verification UX + editor-grade IDE + pricing, not bridge access (`STANDOUT-FEATURES.md` §4).
- **Solo-dev scope creep** → Phases 0–1 are days; Phase 2 items independently shippable; Phase 3 gated; Phase 4 deferred.

## 9. Acceptance checks (per phase)

- **Phase 0:** new config measurably better than old on the eval (run retroactively once the eval lands); external routing failover works (kill upstream key → CF fallback serves).
- **Phase 1:** eval runs green end-to-end headlessly on at least 2 model configs; produces a comparison table.
- **Phase 2:** Verified card renders on real fixture tasks; tool-failure and repair telemetry visibly drop after hardening; agent completes a 10+-step fixture task without drift (todo tool exercised).
- **Phase 3:** the eval gate decides adoption; a written go/no-go note with numbers.
