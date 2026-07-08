# Unity Fine-Tune — Pickup Handoff

> **Purpose:** self-contained context doc so this work can be resumed in a fresh session ("pick it up later") without re-deriving anything. The executable step-by-step plan lives next to this file: **`2026-07-08-unity-finetune-and-eval-growth.md`**. This doc is the *why/state/how-to-resume*; the plan is the *what*.
>
> **Status:** planned, not started. Everything it depends on (Phases 0-1) is shipped and committed on `heads/v0.2.0`.

---

## 1. Where the project stands (as of 2026-07-08)

**Shipped on `heads/v0.2.0` (commits `f45b5e6..f087eb1`, ~22 commits, all task-reviewed + final whole-branch review passed):**

- **Phase 0 quick wins (client-side; model lineup untouched):** per-tier compaction windows matching the real CF models (low 32k / mid 256k / high 200k), output ceilings 16k chat / 24k plan+edit, ask/agent prompt rewrite (root-cause depth, no more enforced terseness), default effort `high`, tier-scaled graphify snapshot (4KB on high), per-send telemetry (turns / tool errors / repair loops) client→server→D1.
- **Phase 1 eval harness (`editor/tooling/unity-eval/`):** headless runner driving the REAL vendor agent loop against fixture Unity projects; 12 seed tasks; retry/timeout-hardened stream; CLI `bun run eval`; 29 tests green; baselines committed. Read its `README.md` first when resuming — it documents everything including fidelity gaps.
- **Docs:** design spec `docs/superpowers/specs/2026-07-07-unity-ai-differentiation-design.md` (approved; Phase 3 §6 = the fine-tune design) and the executed plan `docs/superpowers/plans/2026-07-07-ai-quick-wins-and-eval.md`.

**12-task baseline results (the reason Phase 3 exists):**

| Tier | Model | codegen | grounding | agentic | Total |
|---|---|---|---|---|---|
| mid | @cf/moonshotai/kimi-k2.7-code | 4/4 | 3/4 | 4/4 | **11/12** |
| high | @cf/zai-org/glm-5.2 | 4/4 | 2/4 | 4/4 | **10/12** |

Every genuine failure was **pipeline/input grounding** (`_Color` in URP answers, `Input.GetAxis` in new-Input-System projects). Both models code fine; neither grounds reliably. That is exactly what the fine-tune targets.

**Loose ends from the shipped work (not blockers, but do them):**
- [ ] `arcane-server` is **not redeployed** — telemetry columns stay NULL in prod until `cd arcane-server && npm run deploy`. Migration 0010 is already applied remotely; deploy order is safe either way.
- [ ] Branch is unpushed (user's call).
- [ ] Default effort `high` is now questionable — mid beat high 11/12 vs 10/12 (within noise on 12 tasks; the 44-task re-baseline in the new plan answers this properly). One-line revert in `editor/src/stores/ai.ts` if desired.
- [ ] Deferred minors + follow-ups are listed in `.superpowers/sdd/progress.md` (gitignored scratch — survives locally, not in git).

## 2. The Phase 3 goal, in one paragraph

Train a Unity-specialized LoRA on an open code model for **under $500 total**, using data your own infrastructure generates and verifies (compile/analyzer/check-gated), and adopt it **only if it beats both its own base model AND the current mid tier** (kimi-k2.7-code) on the grounding + agentic families of a grown, 44-task eval at `--repeats 3`. If it loses, the ~$300-500 bought proof the model isn't the bottleneck plus a permanent, reusable dataset — not a waste.

## 3. Decisions already made (with the user, 2026-07-06 → 2026-07-08) — do not re-litigate

| Decision | Answer | Why / consequence |
|---|---|---|
| Product model lineup | **FROZEN** — CF Workers AI only (qwen2.5-coder-32b / kimi-k2.7-code / glm-5.2), no routing changes | User decision 2026-07-07. The fine-tune is offline R&D; wiring it into the product is a separate, later plan gated on the eval. |
| Teacher model | External API, **offline only** (data generation) | Doesn't touch the product. Teacher = strongest DeepSeek on Together (exact id verified in plan Task 7). |
| Training/serving vendor | **Together AI — the single new account** | User wants no account sprawl; prefers Cloudflare. Verified impossible on CF: no training compute, and CF LoRA serving supports only Mistral/Gemma/Llama-class bases (not Qwen-Coder) — see [CF LoRA docs](https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/). Together covers teacher inference + LoRA training + serverless adapter serving under one key. |
| Base model | `Qwen/Qwen3-Coder-30B-A3B-Instruct` if Together's fine-tune API lists it; fallback `Qwen/Qwen2.5-Coder-14B-Instruct` ($0.48/M training tokens tier) | Plan Task 7 verifies against the live catalog before anything is spent. |
| Serving the result | **Deferred** ("training only for now") | Gate run uses Together serverless LoRA (per-token, no fixed cost). Productization only after a GO verdict. |
| Sequencing | **Eval grows first, inside the same plan** (12 → 44 tasks) | 12 tasks is too noisy to gate anything (±1 task = noise, proven by run-to-run variance in the baselines). |
| Budget | **$500 hard ceiling**, tracked in `editor/tooling/unity-finetune/BUDGET.md` (committed) | Envelope: traces ≤$120, training ≤$150, gate inference ≤$60, rest contingency. Tasks stop BLOCKED before overspending. |

## 4. The plan at a glance (full detail in `2026-07-08-unity-finetune-and-eval-growth.md`)

| # | Task | Part | Needs user? | Spends money? |
|---|---|---|---|---|
| 1 | `--repeats` flag + majority scoring | A: eval growth | no | no |
| 2 | Third fixture `urp2022-legacyinput` (URP + legacy input trap) | A | no | no |
| 3 | +32 tasks → 44 (grounding-heavy) + structural self-tests | A | no | no |
| 4 | Re-baseline mid+high at 44 tasks, repeats 3 (local wrangler dev route) | A | no | ~$2-5 Workers AI |
| 5 | Grounding + repair pair generators (deterministic, from migration maps + `unity_api_signatures` D1) | B: data | no | $0 |
| 6 | Teacher-trace recorder (rejection sampling through the eval harness) | B | no | mock-tested $0 |
| 7 | **Together account bootstrap** + capability verification (PROVIDER.md) | C: train | **YES — ~5 min: create account, API key → `editor/tooling/unity-finetune/.env` as `TOGETHER_API_KEY`** | ~$2 smoke |
| 8 | Dataset assembly + full teacher-trace run (~1.5k kept traces) | C | no | ≤$120 |
| 9 | LoRA fine-tune on Together | C | no | ≤$150 |
| 10 | Gate: three-way 44-task eval (fine-tune vs base vs CF mid) → `GATE-DECISION.md` | C | no | ≤$60 |

Key technical ideas baked into the plan:
- **Rejection sampling by verification:** teacher traces are recorded by wrapping the eval harness's own `runTask`/StreamFn; only conversations whose end-state passes the task's checks are kept. The 44 gate tasks are excluded from trace-generation task variants by construction (no leakage).
- **Near-free grounding data:** thousands of version-correct Q→A and deprecated→replacement pairs generated deterministically from `editor/.../unity-tools/migration-tool.ts` maps + the server's `unity_api_signatures` D1 table. No LLM needed for that slice.
- **Verify-first steps everywhere external facts are involved** (Together endpoints/format/tool-role support, D1 schema, deprecation boundary versions) — nothing external is hardcoded on faith.

## 5. How to resume (exact steps)

1. Open a Claude Code session in this repo and say:
   > Execute `docs/superpowers/plans/2026-07-08-unity-finetune-and-eval-growth.md` with superpowers:subagent-driven-development.
2. The executor should check `.superpowers/sdd/progress.md` for a ledger before dispatching anything (prior-session ledger may list completed tasks — never re-run those; if the scratch dir was cleaned, trust `git log`).
3. Tasks 1-6 run fully autonomously. **Task 7 will pause for you** (Together signup + key). Tasks 8-10 are autonomous again but spend real money against BUDGET.md envelopes.
4. Prerequisites already in place on this machine: `wrangler` is logged in (account `1420a69fe10a9c3d49ccb95c432b9412`); local D1 has all migrations; two dev eval users exist on the local server (`eval-mid@arcane.dev` / `eval-high@arcane.dev` — passwords were session-scoped; just sign up fresh ones via `POST /v1/auth/signup` on `wrangler dev` if needed).
5. Useful context files, in reading order: `editor/tooling/unity-eval/README.md` → the plan → design spec §6 → `editor/AI-SPEC.md` (Recommended Approach section points back to all of this).

## 6. What happens after a GO verdict (explicitly out of scope here)

A separate plan: productizing the adapter — most likely a new arcane-server tier routing to Together's serverless LoRA per-token (keeps zero fixed cost), price/margin modeling vs the CF tiers, and the marketing story ("our Unity-tuned model, verified by our own compile-gated eval"). If the verdict is NO-GO, the dataset and 44-task eval remain permanent assets, and the next lever per the design spec is Phase 2 harness depth (verified-agent UX: todo tool, LSP feedback, Verified card).

---
*Prepared 2026-07-08 at the end of the Phases 0-1 execution session. Everything referenced is committed on `heads/v0.2.0` except gitignored scratch (`.superpowers/`, eval `results/` other than `results/baselines/`).*
