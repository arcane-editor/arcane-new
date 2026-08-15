# Agent Reliability & Plan UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI agent survive Unity recompiles (no silent stops, no hangs, no poisoned conversations), make typed messages resume a pending plan instead of re-planning, and turn the plan preview into a two-way-toggling, block-editable document.

**Architecture:** Three workstreams. A: harden the post-write compile pipeline end-to-end (Unity C# extension → journal transport → IDE compile-wait state machine → compile gate → agent loop → OpenAI conversion). B: phase-aware routing in the plan controller plus plan-state persistence. C: restructure `EditorPanel`'s markdown branch so `PlanDocumentView` owns both view modes, with a pure `block-edit` service for in-place preview edits.

**Tech Stack:** React 19 + TypeScript (Vite), Zustand, Monaco, react-markdown/remark-gfm (AST `position` offsets), Tauri v2 (Rust `unity_ipc`), Unity C# editor package (journal transport), Bun test runner.

**Spec:** `docs/superpowers/specs/2026-08-15-agent-reliability-and-plan-ux-design.md`

## Global Constraints

- Deep Modules: cross-feature imports ONLY via feature barrels (`index.ts`); `bun run check:modules` enforces.
- Every degraded path reports honestly — no path may fake success (spec "Error handling").
- Bun-testable logic must not import store/tauri/Monaco chains — use the existing DI seams (`HintLookup`, `DiagnosticsFetcher` pattern).
- Compile pacing decision: wait-per-write (fixed gate), plan read-only during execution, hybrid block editing (approved scope).
- Completion gate: `bun run verify` green (tsc, module check, JS + Rust suites, IntelliSense e2e). A `SKIPPED` IntelliSense check is not a pass.
- Commit per task on branch `feat/agent-reliability-and-plan-ux`; commit messages end with the Claude Fable co-author trailer.

---

### Task A1: compile-wait state machine (pure core + wiring)

**Files:**
- Create: `editor/src/features/unity-bridge/services/compile-wait-core.ts`
- Create: `editor/src/features/unity-bridge/services/compile-wait-core.test.ts`
- Modify: `editor/src/features/unity-bridge/services/compile-wait.ts` (full rewrite of `triggerRecompileAndWait` to wrap the core)
- Modify: `editor/src/features/unity-bridge/index.ts` (export the new `CompileWaitOutcome` type)

**Interfaces:**
- Produces: `type CompileWaitOutcome = { status: 'report'; report: CompilationPayload } | { status: 'no-compile' } | { status: 'unknown'; reason: 'timeout' | 'bridge-lost' | 'aborted' }` and `triggerRecompileAndWait(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CompileWaitOutcome>` (consumed by Task A2).
- Core seam: `waitForCompileReport(io: CompileWaitIo, opts): Promise<CompileWaitOutcome>` with `interface CompileWaitIo { getSnap(): UnitySnap; subscribe(cb: (snap: UnitySnap, prev: UnitySnap) => void): () => void; refreshAssets(): Promise<unknown> }`, `interface UnitySnap { connected: boolean; bridgeState: string; isCompiling: boolean; lastCompilation: CompilationPayload | null }`.

- [ ] **Step 1: Write failing tests** for the core state machine (fake timers via injected `setTimer`/`clearTimer` or bun's fake clock; fake `CompileWaitIo` driven by the test):
  - resolves `report` when a fresh `lastCompilation` identity lands after `refreshAssets` resolves
  - `refreshAssets` REJECTS but a fresh `lastCompilation` lands afterwards → still resolves `report` (the reload-flap case — the old code resolved null here)
  - `refreshAssets` rejects, snap stays `connected`, no activity for the probe window → retries `refreshAssets` exactly once, then resolves report when the event lands
  - `refreshAssets` rejects, snap `connected:false` with no compile activity for the probe window → `{ status: 'unknown', reason: 'bridge-lost' }`
  - `refreshAssets` resolves ok, NO compile activity within the quiet window → `{ status: 'no-compile' }`
  - `refreshAssets` resolves ok, `isCompiling` flips true (activity), but no report ever → `{ status: 'unknown', reason: 'timeout' }` at the overall cap
  - abort signal → `{ status: 'unknown', reason: 'aborted' }`, all timers/subscriptions cleaned
  - `bridgeState: 'reloading'` counts as activity (blocks no-compile/bridge-lost)
- [ ] **Step 2: Run tests, verify FAIL** (`bun test compile-wait-core`)
- [ ] **Step 3: Implement the core.** Constants: `OVERALL_TIMEOUT_MS = 90_000` (matches the Rust reload-widened peer-dead window), `NO_COMPILE_QUIET_MS = 5_000`, `PROBE_MS = 12_000`, one refresh retry. Activity := `isCompiling === true` observed, or `bridgeState === 'reloading'`, or a fresh `lastCompilation`. On each refresh attempt: resolve-ok → arm quiet timer (fires → `no-compile` if no activity); reject → arm probe timer (fires → if activity: do nothing (overall cap governs); else if disconnected: `bridge-lost`; else if retries left: retry refresh; else: `timeout`).
- [ ] **Step 4: Run tests, verify PASS**
- [ ] **Step 5: Rewrite `compile-wait.ts`** as a thin adapter: `CompileWaitIo` over `useUnityStore` (`getSnap` from `getState()`, `subscribe` via zustand subscribe, `refreshAssets` via `bridgeRpc`) and keep the "subscribe before trigger" ordering inside the core. Export `CompileWaitOutcome` from the barrel.
- [ ] **Step 6: `bun run typecheck` (or `tsc --noEmit` via the verify script) to catch the changed return type at call sites** — expected: `compile-gate.ts` breaks (fixed in A2).
- [ ] **Step 7: Commit** `fix(unity-bridge): compile-wait survives the domain-reload flap instead of faking success`

### Task A2: compile gate — honest outcomes, hint budget, bridge warning

**Files:**
- Modify: `editor/src/features/ai-panel/services/unity-tools/compile-gate.ts`
- Test: `editor/src/features/ai-panel/services/unity-tools/compile-gate.test.ts` (extend if present, else create — gate already has DI for `HintLookup`; inject a fake `triggerRecompileAndWait` by adding it as an optional param defaulting to the real one, mirroring `lsp-gate.ts`'s `fetchDiagnostics` seam)

**Interfaces:**
- Consumes: `CompileWaitOutcome` from A1.
- Produces: tool-result notes with the existing `[Unity compile]` sentinel for every outcome (repair-sentinel elision in `compaction.ts` keys on that prefix — keep it).

- [ ] **Step 1: Write failing tests:**
  - not a successful write (`res` text lacks `Successfully wrote|edited` prefix) → no recompile triggered, result unchanged (add the same `isSuccessfulWrite` regex used by `lsp-gate.ts:70-73`)
  - bridge not connected → result gains `[Unity compile] Unity bridge not connected — compile status unknown; Unity will pick up this change when it next gains focus.` and the once-per-send notification hook fires exactly once across two writes
  - outcome `no-compile` → note `[Unity compile] Assets refreshed — no recompile was needed.`
  - outcome `unknown/timeout` → note `[Unity compile] Compile status unknown (timed out waiting for Unity's report) — verify before finishing.`
  - outcome `unknown/bridge-lost` → note naming the bridge loss; `unknown/aborted` → result unchanged
  - outcome `report` with errors → existing repair note; `buildCompileHints` hangs → note still returns within the hint budget with hints omitted
- [ ] **Step 2: Run tests, verify FAIL**
- [ ] **Step 3: Implement.** Switch on `outcome.status`; add `const HINTS_BUDGET_MS = 8_000` and a local `raceWithFallback<T>(p: Promise<T>, ms: number, fallback: T): Promise<T>` (clears its timer on settle); bridge warning via `useNotificationsStore.getState().addNotification({ type: 'warning', message: 'Unity bridge is not connected — the agent cannot verify compiles. Unity will only pick up changes when focused.' })` guarded by a module flag reset in `resetCompileGate()`. NOTE: `compile-gate.ts` must stay Bun-safe — import the notifications store lazily (dynamic import inside the branch) or route through an injected `warn` callback defaulting to a dynamic import, mirroring `defaultFetchDiagnostics`.
- [ ] **Step 4: Run tests, verify PASS**
- [ ] **Step 5: Commit** `fix(ai): compile gate reports honest outcomes and bounds hint lookups`

### Task A3: timeouts on every grounding fetch

**Files:**
- Modify: `editor/src/features/ai-panel/services/unity-tools/api-client.ts:67-81` (`postJson`)
- Test: extend `api-client` tests if present; else add `editor/src/features/ai-panel/services/unity-tools/api-client.test.ts` for the timeout wiring (mock global fetch; assert an `AbortSignal` is passed and that an abort rejection maps to `{ ok: false, reason: 'offline' }`)

- [ ] **Step 1: Write failing test** (fetch receives `options.signal`; a fetch that rejects with `DOMException('TimeoutError')` returns `{ ok: false, reason: 'offline' }`)
- [ ] **Step 2: Verify FAIL**
- [ ] **Step 3: Implement:** `const FETCH_TIMEOUT_MS = 10_000;` and `fetch(url, { ..., signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })`. The existing `catch` already maps everything to `'offline'`.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit** `fix(ai): grounding fetches can no longer hang the tool loop`

### Task A4: per-tool timeout in the agent loop

**Files:**
- Modify: `editor/src/features/ai-panel/services/vendor/types.ts` (add `timeoutMs?: number` to `AgentTool`)
- Modify: `editor/src/features/ai-panel/services/vendor/agent-loop.ts:134-158` (wrap `tool.execute`)
- Modify: the Unity test-runner tool (grep `unity-tools` for the tool that calls `bridgeRpc.runTests`; set `timeoutMs: 6 * 60_000`)
- Test: `editor/src/features/ai-panel/services/vendor/agent-loop.test.ts` (extend if present, else create with a minimal `AgentLoopConfig` whose `streamFn` emits one tool call then a stop)

**Interfaces:**
- Produces: `AgentTool.timeoutMs?: number` — default `120_000` in the loop.

- [ ] **Step 1: Write failing tests:** a tool whose `execute` never resolves → loop emits a `tool_execution_end` with `isError: true` and text `Error: Tool "<name>" timed out after 120s` and continues to the next LLM turn; an abort mid-execute → loop ends without hanging; a tool with `timeoutMs: 50` times out at its own budget.
- [ ] **Step 2: Verify FAIL**
- [ ] **Step 3: Implement** `executeToolBounded`: `Promise.race` of `tool.execute(...)`, a timer rejection (`new Error(\`Tool "${name}" timed out after ${Math.round(ms/1000)}s\`)`), and an abort rejection wired to `config.signal` (`{ once: true }` listener, removed on settle; timer cleared on settle). Use it at `agent-loop.ts:138`.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit** `fix(ai): per-tool timeout — a hung tool degrades to an error result instead of freezing the agent`

### Task A5: orphaned tool-call repair + stream fallthrough stopReason

**Files:**
- Modify: `editor/src/features/ai-panel/services/openai-format.ts` (add `repairToolPairs` post-pass inside `convertToOpenAI`)
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts:635-647` (no-`[DONE]` fallthrough)
- Test: `editor/src/features/ai-panel/services/openai-format.test.ts` (extend)

- [ ] **Step 1: Write failing tests:** assistant message with two `tool_calls` followed by only one matching tool result → converted output inserts `{ role: 'tool', tool_call_id: '<missing>', content: '[interrupted — no result produced]' }` immediately after the answered ones; a `toolResult` whose id matches no preceding assistant tool_call → dropped; well-formed conversations pass through byte-identical.
- [ ] **Step 2: Verify FAIL**
- [ ] **Step 3: Implement `repairToolPairs(messages: OpenAIMessage[]): OpenAIMessage[]`** — single forward scan: for each assistant-with-tool_calls, collect expected ids, consume the following contiguous `role:'tool'` run keeping matches, synthesize results for unanswered ids, drop non-matching/stray tool messages. Call it as the `return` of `convertToOpenAI`.
- [ ] **Step 4: In `arcane-stream.ts`,** change the no-`[DONE]` finalization: if `contentBlocks.some(c => c.type === 'toolCall')`, push an `error` event (`new Error('Stream ended unexpectedly mid-response')`, `partial` carrying the blocks with `stopReason: 'error'`) instead of `done/stop` — half-streamed tool calls must not execute; the repair pass keeps the history sendable and ErrorBlock offers Retry.
- [ ] **Step 5: Verify PASS** (including existing openai-format tests)
- [ ] **Step 6: Commit** `fix(ai): repair orphaned tool calls — one broken turn no longer 400s every later send`

### Task A6: LSP gate fast-skip while csharp-ls is restarting

**Files:**
- Modify: `editor/src/features/lsp/services/diagnostics.ts` (~line 120, top of `requestFileDiagnostics`)

- [ ] **Step 1: Implement:** import `isCsharpProjectLoaded` from `./project-readiness`; at the top of `requestFileDiagnostics`, after the `isRunning` check: `if (!isCsharpProjectLoaded()) return [];` with a comment noting the agent-loop context (a new `.cs` file itself schedules a csharp-ls restart, so during the post-write window the 4s race can never win — fail fast instead).
- [ ] **Step 2: Run the lsp/diagnostics tests if any exist, plus `tsc`**
- [ ] **Step 3: Commit** `fix(lsp): diagnostics fast-skip while the project graph is loading`

### Task A7: Unity extension — compile reports survive the domain reload

**Files:**
- Modify: `arcane-extension/Editor/BridgeClient.cs` (final outbox drain in `WorkerLoop`'s `finally`)
- Modify: `arcane-extension/Editor/CompilationHook.cs` (persist success reports in `SessionState`; expose `PendingResultKey`; erase on `compilationStarted`)
- Modify: `arcane-extension/Editor/BridgeBootstrap.cs` (replay the pending report after `_client.Start()`)

No Unity test rig exists — correctness is asserted by IDE-side behavior (A1 tests cover the consumption side) and manual verification against a live Unity project.

- [ ] **Step 1: `BridgeClient.WorkerLoop` finally block →** `FlushOutboxFinal(); WriteFarewell(); CloseJournals();` where `FlushOutboxFinal()` drains `_outbox` into `_writer` ignoring `_running` (guarded `try/catch`, null-writer check, flush at end). Rationale comment: `FlushOutbox` stops at `_running == false`, so a `compilation_finished` enqueued by the main thread right before a reload shutdown was silently discarded — and a SUCCESSFUL compile always reloads, so the report was lost exactly when the compile worked. Safe: this runs before `Stop()`'s `Join` returns, so the next AppDomain does not exist yet.
- [ ] **Step 2: `CompilationHook`:** `internal const string PendingResultKey = "Arcane.Bridge.PendingCompileResult";` In `OnCompilationFinished`, when `_errors == 0` (only success reports are followed by a reload that can eat them): `SessionState.SetString(PendingResultKey, payload.Serialize());` In `OnCompilationStarted`: `SessionState.EraseString(PendingResultKey);` (a new compile supersedes any pending replay).
- [ ] **Step 3: `BridgeBootstrap.Start`,** after `_client.Start()`: read the key; if non-empty, erase it, `JsonValue.TryParse`, set `payload["replayed"] = true`, `_client.Send(Protocol.Envelope(MsgType.CompilationFinished, payload))`. Belt-and-braces for the case where the worker was wedged and `Join(1500)` expired (journals died with the AppDomain, the final drain never ran).
- [ ] **Step 4: Build check** — the extension has no compiler in this repo; visually verify braces/usings, and confirm `MsgType.CompilationFinished` and `SessionState` usings already exist in each touched file.
- [ ] **Step 5: Commit** `fix(unity-bridge): compilation_finished survives the domain reload (final drain + SessionState replay)`

### Task B1: phase-aware plan routing + resume

**Files:**
- Modify: `editor/src/features/ai-panel/services/plan-controller.ts`
- Modify: `editor/src/features/ai-panel/components/ChatInput.tsx:69-80`
- Modify: `editor/src/features/ai-panel/services/retry-turn.ts:163-172` (restored-session fallback)
- Test: `editor/src/features/ai-panel/services/plan-controller.test.ts` (extend if present; else test the exported pure router)

**Interfaces:**
- Produces: `planController.resumeExecution(text: string): Promise<void>`; `planController.sendPlanModeMessage(text: string, attachments: Attachment[]): Promise<void>`; pure `routePlanSend(phase: PlanPhase, activePlanPath: string | null): 'resume' | 'plan'` (exported for tests).

- [ ] **Step 1: Write failing tests** for `routePlanSend`: `('awaiting-execute', '/p.md') → 'resume'`; `('executing', '/p.md') → 'resume'` (stuck-phase recovery); `('awaiting-execute', null) → 'plan'`; `('idle', '/p.md') → 'plan'`; `('planning', '/p.md') → 'plan'`.
- [ ] **Step 2: Verify FAIL**
- [ ] **Step 3: Implement in `plan-controller.ts`:**
  - Extract the body of `executePlan` into `runExecution(planPath: string, sendText: string)`; wrap the `sendMessage` await in `try { … } finally { useAiStore.getState().setPlanPhase('awaiting-execute'); }` so a rejected send can't stick `'executing'`.
  - `PlanRef.status` transitions inside `runExecution`: before send, `addSessionPlan({ ...existingRefFor(planPath) ?? fallback, status: 'executing' })`; in the `finally`, re-read the plan file (best-effort) and set `status: planStepsOf-all-done ? 'done' : 'executing'` (import `planStepsOf` via the `markdown-preview` barrel — type-only import of `PlanNote` already comes from there).
  - `executePlan(planPath)` = `runExecution(planPath, \`Execute the plan at ${planPath}.\`)` (unchanged callers).
  - `resumeExecution(text)` = read `activePlanPath` from the store; guard "no active plan" → `setError`; `runExecution(activePlanPath, text)` — the user's text IS the send text; the plan pointer/body prefix is already injected by `agent-service.ts:573-585` from `opts.planExecution`. Does NOT touch `pendingPrompt`.
  - `sendPlanModeMessage(text, attachments)`: `routePlanSend(planPhase, activePlanPath) === 'resume' ? resumeExecution(text) : startPlanning(text, attachments)`.
- [ ] **Step 4: `ChatInput.tsx`:** replace the `planController.startPlanning(text, attachments)` call with `planController.sendPlanModeMessage(text, attachments)`. Update the plan-mode placeholder: when `planPhase` is `'awaiting-execute'` or `'executing'` → `'Message continues the current plan — Regenerate to re-plan. ⏎ to send.'` (subscribe `planPhase` in the component).
- [ ] **Step 5: `retry-turn.ts` fallback:** in the restored-session branch (no `lastSend`), when `current.mode === 'plan'`, call `planController.sendPlanModeMessage(text, attachments)` instead of the bare `sendMessage` (which resolved to plan-planning).
- [ ] **Step 6: Verify PASS; run the full ai-panel test file set**
- [ ] **Step 7: Commit** `fix(ai): typed messages resume plan execution instead of re-planning`

### Task B2: persist plan state across reload

**Files:**
- Modify: `editor/src/features/ai-panel/services/session-persistence.ts` (`SessionData` + `SaveSessionInput`: add `planPhase?: PlanPhase; activePlanPath?: string | null`)
- Modify: `editor/src/stores/ai.ts` (`buildSaveInput`, `loadSessionIntoStore`)
- Test: extend the store/session tests where `buildSaveInput`/`loadSessionIntoStore` are covered (locate via `grep -l loadSessionIntoStore src/stores/*.test.ts src/features/ai-panel/services/*.test.ts`)

- [ ] **Step 1: Write failing tests:** a session saved while `planPhase:'awaiting-execute'` + `activePlanPath:'/x.md'` restores those exact values; saved `'executing'` restores as `'awaiting-execute'`; saved `'planning'` restores as `'idle'`; a legacy record without the keys restores `'idle'`/`null`.
- [ ] **Step 2: Verify FAIL**
- [ ] **Step 3: Implement:** add both fields to the two interfaces; `buildSaveInput` passes `planPhase: state.planPhase, activePlanPath: state.activePlanPath`; `loadSessionIntoStore` replaces the hard-coded `planPhase: 'idle', activePlanPath: null` with `...normalizePlanRestore(session.planPhase, session.activePlanPath)` where the normalizer maps `executing → awaiting-execute`, `planning → idle`, `undefined → idle`, and returns `activePlanPath ?? null` (nulled when phase normalizes to `idle` AND the saved phase was `planning`).
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit** `feat(ai): plan phase and active plan survive app reload`

### Task C1: block-edit service (pure)

**Files:**
- Create: `editor/src/features/markdown-preview/services/block-edit.ts`
- Create: `editor/src/features/markdown-preview/services/block-edit.test.ts`
- Modify: `editor/src/features/markdown-preview/index.ts` (export `replaceBlock`, `toggleTaskAt`)

**Interfaces:**
- Produces: `replaceBlock(source: string, start: number, end: number, newText: string): string` (offset splice, trims a single trailing newline duplication) and `toggleTaskAt(source: string, offset: number): string | null` (finds the first `- [ ]` / `- [x]` / `* [ ]` task marker on the line containing `offset`; returns toggled source or `null` when the line has no marker).

- [ ] **Step 1: Write failing tests:** splice mid-document preserves surrounding text exactly; splice covering the final block without trailing newline; multi-byte content (emoji in plan text) — offsets are UTF-16 code-unit offsets straight from the AST, so `'🚀'.length === 2` must round-trip; `toggleTaskAt` flips `[ ]`→`[x]` and back, case-insensitive `[X]`, returns `null` on a plain bullet; indented nested task lines.
- [ ] **Step 2: Verify FAIL**
- [ ] **Step 3: Implement** (pure string ops, no imports).
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit** `feat(markdown-preview): pure block-edit service`

### Task C2: two-way view toggle — PlanDocumentView owns both modes

**Files:**
- Modify: `editor/src/features/editor/components/EditorPanel.tsx:196-232` and the Monaco fallback (~312)
- Modify: `editor/src/features/markdown-preview/components/PlanDocumentView.tsx` (source mode = embedded Monaco)

- [ ] **Step 1: Restructure the markdown branch:** `if (isMarkdownPath(activeFile.name) && !activeFile.diff)`: FIRST `if (isPlanPath(activeFile.path)) return <PlanDocumentView …/>` (no `mode === 'preview'` gate — the component reads/sets `markdownViewMode` itself, which it already does at line 34). THEN the plain-md `mode === 'preview'` standalone preview as today. Plain-md `mode === 'source'` falls through to Monaco; add a slim banner in the Monaco fallback (same pattern as the structuredCandidate banner at ~315): rendered when `isMarkdownPath(activeFile.name) && !activeFile.diff`, text `Markdown source`, button `Preview` → `setMarkdownViewMode(path, 'preview')`.
- [ ] **Step 2: `PlanDocumentView` source mode:** replace the dead `<pre className="plan-doc-source">` with a `MonacoEditor` (import `@monaco-editor/react` + `fileUri` from the lsp barrel + theme/`ensureMonacoTheme` from the theme barrel + `useThemeStore`): `path={fileUri(path)}`, `language="markdown"`, `value={content}`, `onChange` → `useWorkspaceStore.getState().updateFileContent(path, value)`, `options={{ readOnly: executing, minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true }}`, `beforeMount/onMount` call `ensureMonacoTheme`. Normal dirty/save semantics apply in source mode (the Execute dirty-guard already handles it).
- [ ] **Step 3: Manual check via `bun run typecheck` + module-boundary check** (imports must come from barrels: `features/lsp`, `features/theme`).
- [ ] **Step 4: Commit** `fix(editor): plan and markdown view toggles work both ways`

### Task C3: editable preview blocks + read-only while executing

**Files:**
- Modify: `editor/src/features/markdown-preview/components/MarkdownPreview.tsx` (editable-block rendering)
- Modify: `editor/src/features/markdown-preview/components/PlanDocumentView.tsx` (wire commit + executing pill)
- Modify: `editor/src/App.css` (`.plan-doc-pill`, `.md-block-editing` styles appended near the existing `.plan-doc*` rules)

**Interfaces:**
- `MarkdownPreview` gains props: `editable?: boolean`, `onCommitBlockEdit?: (start: number, end: number, newText: string) => void`, `onToggleTask?: (offset: number) => void`.

- [ ] **Step 1: Extend the `markdownComponents` override set** to `p`, `h1`–`h4`, `li`: each receives `node` (hast element with `position.start.offset` / `position.end.offset` on the markdown source). When `editable` and the component is clicked with a COLLAPSED selection (`window.getSelection()?.isCollapsed`, so select-to-suggest keeps winning on real selections) and the click target is not an `input`/`a`, set `editingBlock = { start, end, draft: source.slice(start, end) }` state. Render that block as an auto-sized `<textarea className="md-block-editing">` seeded with the raw markdown slice: Enter (no shift) or blur → `onCommitBlockEdit(start, end, draft)`; Esc → cancel. Checkbox `<input type="checkbox">` clicks (task items) call `onToggleTask(liStartOffset)` instead of entering edit mode (remove the `disabled` attr react-markdown sets by overriding `input` to a live checkbox when `editable`).
- [ ] **Step 2: `PlanDocumentView`:** `const readOnly = executing;` pass `editable={!readOnly}` and implement commit: `onCommitBlockEdit` → `replaceBlock(content, start, end, newText)` → `useWorkspaceStore.getState().updateFileContent(path, next); void useWorkspaceStore.getState().saveFile(path);` (atomic commit — tab returns to clean immediately, so the Execute dirty-guard and the fs-watcher live refresh both keep working); `onToggleTask` → `toggleTaskAt` (null-safe). Add the header pill when `executing`: `<span className="plan-doc-pill">read-only while executing</span>`.
- [ ] **Step 3: The `content` prop the commit closes over must be the CURRENT tab content** (it is — EditorPanel passes `activeFile.content`); guard staleness by no-oping the commit when `source.slice(start, end)` no longer matches the draft's original slice (the agent rewrote the file mid-edit; drop the edit and let the reload win — matches the read-only-during-execution decision).
- [ ] **Step 4: Styles:** `.md-block-editing` (full-width, inherit font, min-height 1.6em, background `var(--bg-sidebar)`, 1px `var(--border)` radius 4), `.plan-doc-pill` (small, muted, rounded, `var(--warning-bg, #4d3800)` tint).
- [ ] **Step 5: Manual verify in the running app if feasible; otherwise `bun run typecheck` + full JS suite**
- [ ] **Step 6: Commit** `feat(markdown-preview): Notion-style block editing in plan preview, read-only during execution`

### Task V: full verification

- [ ] **Step 1: `bun run verify`** — tsc, `check:modules`, JS suite, Rust suite, `verify:intellisense`. A SKIPPED IntelliSense result is reported as "did not run", never as a pass.
- [ ] **Step 2: Fix anything red; re-run until green**
- [ ] **Step 3: Commit any fixes** and stop for the human merge gate (no push without ask)

## Self-review notes

- Spec coverage: A1↔"compile-wait rework", A2↔"gate honesty + A5 warning + A6 isSuccessfulWrite half", A3/A4↔"timeouts everywhere", A5↔"orphan repair + fallthrough", A6↔"LSP fast-skip", A7↔"Unity-side survival"; B1↔routing/resume/try-finally/PlanRef, B2↔persistence, retry fallback in B1; C1-C3↔toggle/block-edit/read-only. The spec's "compile events written synchronously to the journal" is implemented as the strictly-safer final-drain (same guarantee, no cross-thread writer access from the main thread — the writer is worker-owned).
- Type consistency: `CompileWaitOutcome` statuses used in A1 and A2 match; `routePlanSend` phases match `PlanPhase` in `stores/ai.ts:168`.
