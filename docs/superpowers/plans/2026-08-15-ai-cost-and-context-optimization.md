# AI Cost & Context Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate provider prompt caching end-to-end, add task-aware model routing, give the model a deterministic project context pack + per-project memory, and cut fixed per-turn token overhead.

**Architecture:** Editor-side: freeze the volatile system-prompt tail per conversation, stabilize tool sets, remove mid-send model switching, add a context-pack builder + memory store as new ai-panel service modules. Server-side: routing layer over the tier map, provider cache params, D1 grounding cache. Verification through the existing eval harness with a new cached-token metric.

**Tech Stack:** TypeScript (React 19 editor, Hono/Workers server), Bun tests + vitest, TypeBox tool schemas, Python sidecar (graphify), D1.

**Spec:** `docs/superpowers/specs/2026-08-15-ai-cost-and-context-optimization-design.md`

## Global Constraints

- `editor/`: run `bun run verify` before claiming done (tsc + module-boundary check + JS/Rust suites + verify:intellisense). Deep-module rule: cross-feature imports only via `index.ts` barrels.
- `arcane-server/`: `npx vitest run` + `npx tsc --noEmit` green.
- NEVER modify `editor/src/features/ai-panel/services/vendor/*` — compose via decorators.
- Prompt/tool changes must not regress the eval baselines (grounding low ≥10, mid/high ≥11 of 12) — offline replay preset where live creds are unavailable.
- Keep `skipCache: true` on chat/graph-enrich gateway calls (it disables the unrelated exact-match response cache).
- `cached_input_tokens` plumbing (llm-router → chat.ts → request_logs → costs.ts) is already correct — do not re-plumb, only feed it.

---

### Task 1: Frozen per-conversation prompt decoration

**Files:**
- Create: `editor/src/features/ai-panel/services/prompts/frozen-context.ts`
- Create: `editor/src/features/ai-panel/services/prompts/frozen-context.test.ts`
- Modify: `editor/src/features/ai-panel/services/prompts/index.ts` (decorate)
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (dispose/reset/resume hooks)

**Interfaces:**
- Produces: `getFrozenDecoration(sessionId: string | null, effort: Effort): { factsBlock: string | null; graphSnapshot: string | null }` — captures live blocks on first call per sessionId (per effort-independent snapshot; graph budget uses the effort of the *first* send), returns the identical strings on every later call for the same sessionId. `resetFrozenDecoration(): void` clears all. `graphChangedSinceFreeze(): boolean` — true when graphify store's summary identity changed after freezing.
- Consumes: `getUnityFactsBlock()` (unity-facts.ts), `buildGraphSnapshot`/`graphSnapshotBudget` (graphify barrel), `useAiStore.getState().sessionId`.

- [ ] Test: same sessionId → byte-identical blocks across calls even when underlying stores change between calls; new sessionId → recapture; null sessionId → passthrough (no freezing).
- [ ] Implement module (module-level `Map<string, Frozen>` capped to last 4 sessions).
- [ ] `decorate()` in prompts/index.ts uses `getFrozenDecoration(useAiStore.getState().sessionId, effort)` instead of calling the live builders.
- [ ] `AgentService.dispose()` and `reset()` call `resetFrozenDecoration()`.
- [ ] `bun test frozen-context` green; commit.

### Task 2: Facts primed at workspace open (kill turn-1/turn-2 divergence)

**Files:**
- Modify: `editor/src/features/ai-panel/services/prompts/unity-facts.ts`
- Verify existing subscription (lines 208–221) already primes on `isUnityProject` — confirm the prime also fires on initial workspace load (subscribe fires only on *changes*; add an immediate check at module init via the same `queueMicrotask`).

- [ ] In the `queueMicrotask` block, after subscribing, run the same prime check once immediately: `const s = useProjectContextStore.getState(); if (s.isUnityProject) { const wp = useWorkspaceStore.getState().workspacePath; if (wp) void primeUnityFacts(wp); }`.
- [ ] Test (extend existing unity-facts tests if present, else new): cold cache + Unity project → `getUnityFactsBlock()` still returns version-only block, but `primeUnityFacts` resolves and second call returns full block (behavior unchanged); the freeze in Task 1 is what guarantees stability — this task only makes the *first frozen snapshot* usually complete.
- [ ] Commit.

### Task 3: Plan-execution prompt stops embedding the live plan

**Files:**
- Modify: `editor/src/features/ai-panel/services/prompts/plan-execution.ts` (drop `planContent` from the template; keep path + instructions; instructions change from "Below is the current contents" to "Read the plan file first if it is not already in this conversation")
- Modify: `editor/src/features/ai-panel/services/prompts/index.ts` (`PlanExecutionPromptArgs` no longer needs planContent in the system prompt path — keep the type for the send path)
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (`sendMessage`: for `promptMode === 'plan-execution'`, prepend the plan to `promptText` on the **first** plan-execution send of a conversation; later sends prepend one line: `[Plan file: <path> — re-read it for current checkbox state]`)

**Interfaces:**
- Produces: module-level `planInjectedFor: Set<string>` keyed `${sessionId}:${planPath}` in agent-service (cleared in dispose/reset like `lastSend`).
- First-send prefix format: `## Approved plan (${planPath})\n\n${planContent}\n\n---\n\n`.

- [ ] Update template + type; update/extend `prompts` tests asserting plan body is absent from the system prompt and path is present.
- [ ] Wire the send-path injection; test via existing agent-service test seams if present, else a focused unit test on an extracted pure helper `buildPlanSendPrefix(alreadyInjected: boolean, planPath: string, planContent: string): string`.
- [ ] Commit.

### Task 4: Stable tool sets — graphify tools always registered

**Files:**
- Modify: `editor/src/features/graphify/services/graphify-tools.ts` — each `execute` first checks `useGraphifyStore.getState().status`; when not `present`/`stale`, return `textResult('Graph not built for this workspace yet. Suggest the user builds it from the Graphify panel — then this tool can traverse the codebase graph.')`. Note: graphify-tools currently has no store import; the check must live behind an injectable `isAvailable` option defaulting to the store read, so eval/Bun contexts stay DOM-safe (same dynamic-import pattern as turn-governor's `defaultOnCapReached` if store import is unsafe — verify at implementation).
- Modify: `editor/src/features/ai-panel/services/agent-service.ts:158-166` — remove the `graphAvailable` conditional; always include the three tools.

- [ ] Test: tools return the guidance string when status is `absent`, real results path unchanged when present (mock client).
- [ ] Commit.

### Task 5: Governor keeps tools, sends `tool_choice: none`

**Files:**
- Create: `editor/src/features/ai-panel/services/stream-extras.ts` — `export interface StreamExtras { toolChoice?: 'none' } export function withStreamExtras(ctx: Context, extras: StreamExtras): Context` (returns `{...ctx}` carrying a well-known non-enumerable-safe field `__arcaneExtras`), `export function getStreamExtras(ctx: Context): StreamExtras | undefined`.
- Modify: `editor/src/features/ai-panel/services/turn-governor.ts:152-157` — governedContext keeps `tools: context.tools`, adds extras `{toolChoice: 'none'}` via `withStreamExtras`.
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts` — request body gains `tool_choice: 'none'` when `getStreamExtras(context)?.toolChoice === 'none'`.
- Modify: `arcane-server/src/types.ts` — `ChatCompletionRequest` gains `tool_choice?: 'none' | 'auto'`.
- Modify: `arcane-server/src/services/llm-router.ts` — `streamText({... , ...(req.tool_choice === 'none' ? { toolChoice: 'none' as const } : {})})`.

- [ ] Editor test: governor at cap → context still has tools, extras set, wrap-up message appended. arcane-stream test: body contains `tool_choice: 'none'`.
- [ ] Server test: request with `tool_choice: 'none'` → streamText called with `toolChoice: 'none'` (existing streamTextImpl injection seam).
- [ ] Update turn-governor header comment (no longer strips tools). Commit.

### Task 6: Replace mid-send escalation with send-boundary, conversation-latched escalation

**Files:**
- Delete: `editor/src/features/ai-panel/services/turn-escalation.ts` + its test file
- Create: `editor/src/features/ai-panel/services/send-escalation.ts` + test
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (stack becomes `withStreamErrorGuard(withTurnGovernor(arcaneStream))`; remove resetTurnEscalation; call `resolveSendEffort` before `syncForPromptMode`)
- Modify: `editor/src/features/ai-panel/services/turn-telemetry.ts` — add `getPreviousSendRepairCount(): number` (snapshot the pre-reset value in `resetTurnTelemetry`, same pattern as `getPreviousSendNudgeCounts`).

**Interfaces:**
- Produces: `resolveSendEffort(sessionId: string | null, requested: Effort, prevRepairCount: number, isEnabled: () => boolean): { effort: Effort; escalatedNow: boolean }` — latches per sessionId: once escalated, every later send in that conversation uses the bumped tier (cache stickiness) until the conversation ends or the user *raises* effort manually. Threshold: `prevRepairCount >= 2`, `low→mid`, `mid→high`, high stays.
- On `escalatedNow`, agent-service posts the existing style notice: `addSystemMessage('Escalating to ${tier} for this conversation after repeated compile repairs')` and calls `recordEscalation()`.

- [ ] Tests for the latch state machine (escalate once, sticky, manual-raise resets latch, disabled setting passthrough).
- [ ] Wire into sendMessage; remove all turn-escalation imports; grep repo for `turn-escalation` and fix references (eval harness does not use it — verify).
- [ ] `bun test` + `bunx tsc --noEmit` green; commit.

### Task 7: Conversation id + provider cache params to the server

**Files:**
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts:237-243` — metadata gains `conversationId: useAiStore.getState().sessionId ?? undefined`.
- Modify: `arcane-server/src/types.ts` — metadata type gains `conversationId?: string`.
- Modify: `arcane-server/src/services/llm-router.ts` — `streamCompletion` forwards a cache hint when the model supports it: for `openai/*` models pass `providerOptions: { openai: { promptCacheKey: req.metadata?.conversationId } }`; for `xai/*` attempt the same shape under `xai`; verify against installed `workers-ai-provider`/`ai` types at implementation — **if the provider ignores/rejects providerOptions, ship without and leave a comment** (implicit caching still applies).
- Modify: `arcane-server/src/routes/chat.ts` errCtx to include conversationId for log correlation.

- [ ] Server test: metadata.conversationId round-trips into the streamText call's providerOptions (via injection seam) for an `openai/*` model and is absent for `@cf/*`.
- [ ] Commit.

### Task 8: Eval harness cached-token metric

**Files:**
- Modify: `editor/tooling/unity-eval/eval-stream.ts` (`UsageTotals` gains `cachedInput: number`; accumulate from `cached_input_tokens`)
- Modify: `editor/tooling/unity-eval/eval-types.ts` (`TaskResult.cachedInputTokens?: number`)
- Modify: `editor/tooling/unity-eval/run-task.ts`, `run-eval.ts`, `report.ts` (thread + report column + stdout `cache share: X%`)

- [ ] Extend existing eval-stream unit tests with a usage event carrying `cached_input_tokens`.
- [ ] Commit.

### Task 9: Server routing layer (flag-gated)

**Files:**
- Create: `arcane-server/src/config/routing.ts` + `arcane-server/src/config/routing.test.ts` (mirror existing test layout — check where plans/tiers tests live)
- Modify: `arcane-server/src/routes/chat.ts` (use `resolveModelForSend`)
- Modify: `arcane-server/src/types.ts` (metadata gains `routing?: { promptChars?: number; attachments?: number; codeIntent?: boolean }`)
- Modify: `arcane-server/wrangler.toml` (`ROUTING_V2 = "off"` var; `"on"` in dev env)

**Interfaces:**
- Produces:
```ts
export interface RoutingSignals { taskType?: string; mode?: string; promptChars?: number; attachments?: number; codeIntent?: boolean }
export function resolveModelForSend(tier: Intensity, plan: string, signals: RoutingSignals, flag: string | undefined): { model: string; routedTier: Intensity; reason: string }
```
- Rules v1: flag off → identity (tier model, reason `'static'`). Flag on: `mode === 'ask' && (promptChars ?? Infinity) < 600 && !attachments && !codeIntent && tier !== 'low'` → low model, reason `'simple-ask-downgrade'`. `taskType === 'memory'` → `INLINE_MODEL`, reason `'side-task'`. Everything else → tier model. Never returns a tier the plan can't use (callers already gate; routing only ever moves *down* except side-task).

- [ ] Vitest: table-driven rules; flag off is identity.
- [ ] chat.ts logs `reason` in dev console + passes routedTier's model; usage event (llm-router `finish`) gains `model: req.model` so the client can see the actual model; editor `ArcaneStreamEvent` type gains `model?: string` and `recordSessionUsage` stores it (UI chip later — store only).
- [ ] Editor: `arcane-stream.ts` metadata gains `routing: { promptChars: <last user message text length>, attachments: <count from context — not available here; compute in agent-service and thread via aiStore? Simplest: promptChars = length of last user-role message content; attachments/codeIntent omitted v1>` — implement `promptChars` + `codeIntent` (regex ``` or `write|edit|refactor|implement|fix` in last user msg) client-side in arcane-stream from `context.messages`.
- [ ] Commit.

### Task 10: Context pack (assembly map + key files, deterministic)

**Files:**
- Create: `editor/src/features/ai-panel/services/prompts/context-pack.ts` + test
- Modify: `editor/src/features/ai-panel/services/prompts/index.ts` (decorate: `parts.push(facts, contextPack, snapshot)` — contextPack between facts and graph snapshot, all frozen via Task 1's module which now also freezes the pack)
- Modify: `editor/src/features/graphify/services/graph-context.ts` (drop the `Graph: N nodes, M edges…` counts line — replace with `'## Codebase graph snapshot'` header only; update `graph-context.test.ts`)

**Interfaces:**
- Produces: `buildContextPack(effort: Effort): string | null`:
```
## Assemblies (asmdef graph)
- Scripts.Runtime → refs: Unity.InputSystem, Scripts.Core
- Scripts.Editor (editor-only) → refs: Scripts.Runtime
…(top 15 by referenced-ness, sorted by name; from useAsmdefStore.getState().graph)
## Key files
- Assets/Scripts/Core/GameManager.cs
…(god-node source_files ∪ activeFile, deduped, sorted, ≤12)
```
- Char budgets: low 1536 / mid 2560 / high 4096 (constant map, exported for tests). Deterministic: sorted output, no counts.

- [ ] Test: deterministic ordering; budget truncation; null for non-Unity/empty stores.
- [ ] Commit.

### Task 11: `project_symbols` — sidecar symbol tables + tool

**Files:**
- Modify: `editor/tooling/arcane-graph-sidecar/arcane_graph.py` (during build, additionally write `symbols.json` next to `graph.json`: `{ files: { "<rel path>": { types: [{ name, kind, members: ["MethodName(sig) -> ret", …] }] } }` — from the AST it already parses; cap 64 members/type)
- Modify: `editor/src-tauri/src/graphify.rs` (new command `graphify_symbols(workspace_path, file: Option<String>, type_name: Option<String>) -> String` — loads symbols.json from the graph dir, filters, serializes ≤2KB)
- Modify: `editor/src/features/graphify/services/graphify-client.ts` (+`graphifySymbols` invoke wrapper), `graphify-tools.ts` (+`createProjectSymbolsTool`), `editor/src/features/graphify/index.ts` (export)
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (register in all modes alongside other graph tools)

- [ ] Python: extend build path; regenerate a fixture graph in the sidecar's existing test flow (check `build.sh`/tests; if none, validate by running the sidecar on a tiny fixture dir in CI-safe test or manual smoke).
- [ ] Rust: unit test with a temp symbols.json (follow existing graphify.rs test patterns).
- [ ] Tool description: `"List the types and member signatures in a file or type without reading the whole file. Prefer this over read when you only need to know what exists."` Availability-gated like Task 4.
- [ ] Note: sidecar binary is PyInstaller-built (`src-tauri/binaries/`); dev flow needs `build.sh` run — mark in commit message; tool must degrade gracefully when symbols.json is missing (older graph builds): return `'Symbols not available — rebuild the graph.'`
- [ ] Commit.

### Task 12: Memory store core (files, caps, dedupe)

**Files:**
- Create: `editor/src/features/ai-panel/services/memory/memory-store.ts` + `memory-types.ts` + `memory-store.test.ts`

**Interfaces:**
```ts
export interface MemoryEntry { slug: string; category: 'decision'|'convention'|'gotcha'; title: string; body: string; created: string; lastUsed: string; timesUsed: number }
export interface MemoryFs { read(path: string): Promise<string>; write(path: string, content: string): Promise<void>; list(dir: string): Promise<string[]>; remove(path: string): Promise<void> }  // impl over tauri invokes
export const CAPS = { perCategory: 30, entryBytes: 1024, storeBytes: 200_000 } as const;
export function memoryDir(workspacePath: string): string  // `${workspacePath}/Library/ArcaneIDE/memory`
export async function loadEntries(fs: MemoryFs, workspacePath: string): Promise<MemoryEntry[]>
export async function upsertEntry(fs: MemoryFs, workspacePath: string, candidate: { category; title; body }): Promise<'created'|'updated'|'rejected-cap'>  // dedupe: normalized-title exact OR ≥0.6 keyword-overlap → update + bump salience; at cap → evict lowest (timesUsed, then oldest lastUsed) only if candidate outranks, else rejected-cap
export function buildMemoryDigest(entries: MemoryEntry[], maxChars: number): string | null  // top-N by timesUsed*recencyWeight, category order decision>gotcha>convention; bumps nothing
export function searchEntries(entries: MemoryEntry[], query: string): MemoryEntry[]  // keyword AND-match on title+body
export async function writeTaskContext(fs: MemoryFs, workspacePath: string, content: string): Promise<void>  // overwrites task-context.md, 4KB cap
```
- Frontmatter: hand-rolled `---\nkey: value\n---\n` parser (no dep). File name = slug.

- [ ] Pure tests with an in-memory MemoryFs: round-trip, dedupe-updates, cap eviction/rejection, digest cap + ranking, search.
- [ ] Commit.

### Task 13: Memory distiller + wiring into sends

**Files:**
- Create: `editor/src/features/ai-panel/services/memory/distiller.ts` + test
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (fire-and-forget after successful mutating sends: `void distillSend(...)` after `runVerifiedPassIfNeeded`)
- Create: `editor/src/features/ai-panel/services/memory/memory-request.ts` — small non-stream POST to `/v1/chat/completions` with `stream: false`, `metadata: { taskType: 'memory', reasoningLevel: 'low' }` (server routes to INLINE_MODEL via Task 9's side-task rule), auth token from useAuthStore.

**Interfaces:**
- `distillSend(input: { finalAssistantText: string; touchedFiles: string[]; userPrompt: string }, deps: { request: (prompt: string) => Promise<string>; fs: MemoryFs; workspacePath: string }): Promise<void>`
- Distiller prompt (verbatim, single user message): asks for JSON `{"facts": [{"category": "...", "title": "...", "body": "..."}]}` with 0–2 facts, criteria: durable, project-specific, not derivable from code/index, no code bodies/secrets; plus `{"taskContext": "one-paragraph summary of current work state"}`. Parse defensively; on parse failure, drop silently.
- Gating: only `promptMode` agent/plan-execution, `touchedFileCount() > 0`, setting `ai.memory.enabled !== false`, not aborted.

- [ ] Tests: JSON parse paths, gating, upsert + writeTaskContext calls (mock deps).
- [ ] Commit.

### Task 14: Memory digest in prompt + `memory_search` tool + consolidation

**Files:**
- Modify: `editor/src/features/ai-panel/services/prompts/context-pack.ts` (append `## Project memory` digest ≤700 tokens ≈ 2800 chars — loaded synchronously from a module-level cache primed at workspace open like unity-facts; create `memory/memory-cache.ts` with `primeMemory(workspacePath)`, `getMemoryDigestSync()`, `bumpUsage(slugs)` writing lastUsed/timesUsed lazily)
- Create: `editor/src/features/ai-panel/services/memory/memory-tool.ts` (`memory_search` AgentTool, all modes, availability = store non-empty)
- Create: `editor/src/features/ai-panel/services/memory/consolidate.ts` + test — `maybeConsolidate(fs, workspacePath, request)`: when a category > 24 entries, send entry list to the side-task lane asking for merge/delete instructions JSON `{"merge": [[slugA, slugB, newTitle, newBody]], "delete": [slug]}`, apply; called fire-and-forget after distillation.

- [ ] Tests: digest cache sync behavior; consolidation apply logic (pure part).
- [ ] Register tool in `createToolsForPromptMode` (all modes). Commit.

### Task 15: Token diet — tool descriptions + caps

**Files:**
- Modify: `editor/src/features/ai-panel/services/vendor/tools/*.ts` — NO (vendor frozen). Instead: descriptions live in vendor tool factories? **Check at implementation**: if vendor factories hardcode descriptions, add a non-vendor `tool-slimming.ts` decorator `withSlimDescription(tool, newDescription)` applied in agent-service; vendor untouched.
- Modify: `editor/src/features/ai-panel/services/unity-tools/*.ts` descriptions (non-vendor), `todo-tool.ts`, `ask-user-tool.ts`, graphify tool descriptions.
- Create: `editor/src/features/ai-panel/services/tool-budget.test.ts` — asserts total JSON-serialized `{name, description, parameters}` payload for agent-mode toolset ≤ **7,000 chars** (from ~10.5k) and ask-mode ≤ 4,500. Test builds the real toolsets with mocked stores.
- Modify: `editor/src/features/ai-panel/services/prompts/unity-facts.ts` — cap unityRules at 6,000 chars: `facts.unityRules.trim().slice(0, 6000)` + `'\n[…truncated — full rules in .ai/unity-rules.md]'` when over.
- Modify: `editor/src/features/ai-panel/services/unity-tools/api-search-tool.ts` — wrap returns in existing `cap()` from `text-result.ts`.
- Modify: `editor/src/features/graphify/services/graphify-client.ts` or tools — enforce `budget` cap on `graphify_query` output: hard-slice at `budget * 4` chars, default 8,000.

- [ ] `unity_api_search` description rewritten prescriptively: `"Verify Unity API signatures against this project's Unity version. Call BEFORE writing any Unity API usage you are not certain exists with that exact signature, and whenever a compile error mentions a missing member. Returns real signatures + doc links."`
- [ ] Run offline eval replay preset for grounding tasks; if `tool_called` regression, revert only the offending description. Commit.

### Task 16: Server grounding search cache (D1)

**Files:**
- Create: `arcane-server/migrations/0016_unity_search_cache.sql` — `CREATE TABLE unity_search_cache (cache_key TEXT PRIMARY KEY, response TEXT NOT NULL, expires_at INTEGER NOT NULL); CREATE INDEX idx_unity_search_cache_expiry ON unity_search_cache(expires_at);`
- Modify: `arcane-server/src/routes/unity-api.ts` `/v1/unity/api/search` — before embedding: `cache_key = sha256(JSON.stringify({q: normalizedQuery, v, rp, is, dt, topK}))`; hit + unexpired → return cached JSON (still `recordUsage`? **No** — a cache hit skips the embed, record zero-cost or skip recordUsage for the embed; keep request_log optional); miss → existing path, then best-effort INSERT OR REPLACE with `expires_at = now + 7d`. Opportunistic cleanup: DELETE expired rows with probability 1/50 per request.

- [ ] Vitest with the existing D1 test pool pattern: hit path skips embed (inject/spy), miss path stores.
- [ ] Commit.

### Task 17: Verification sweep + docs

- [ ] `cd editor && bun run verify` green; `cd arcane-server && npx vitest run && npx tsc --noEmit` green.
- [ ] Offline eval replay: grounding tasks parity vs baselines; record token + cache columns.
- [ ] Update `editor/AI-SPEC.md` §Prompt caching (now active; describe freeze mechanism + provider hookup + routing flag) and §deferred (memory/context pack now exist).
- [ ] Final commit; summary report with measured before/after fixed-overhead chars and any open items (gateway header pass-through, prod flag flips, D1 migration apply).

## Self-review notes

- Spec §1.3 (`<project-update>` tail): folded into Task 1 as `graphChangedSinceFreeze()` + a one-line note appended in agent-service's sendMessage when true — implemented in Task 1/3 wiring, kept deliberately minimal.
- Spec §2 side-task lane: Task 9 (`taskType: 'memory'`) + Task 13. Grounding-lint revise stays on the main model in v1 (it must match conversation context; revisit later) — deviation from spec §6.3, recorded here.
- Spec §7 acceptance metrics that need live traffic (≥60% cached share) are post-deploy checks — the plan lands the instrumentation; flag flips + D1 migration application are owner/deploy steps listed in the final report.
