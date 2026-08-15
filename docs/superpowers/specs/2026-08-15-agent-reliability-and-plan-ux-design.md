# Agent Reliability & Plan UX — Design

**Date:** 2026-08-15
**Status:** Approved (scope decisions: hybrid block editing; plan read-only during execution; wait-per-write compile pacing)

## Problem

Three defects make the AI agent nearly unusable for Unity work:

1. **The agent stops (or hangs) the moment Unity recompiles.** No error, no retry. Not one
   multi-step task has completed end-to-end.
2. **A typed message after a stopped plan-execution re-creates the plan** instead of resuming
   the remaining steps.
3. **Plan documents render as plain markdown** with a broken one-way Source toggle and no
   in-place editing.

## Root causes (from code exploration)

### Compile stall cluster

- `features/unity-bridge/services/compile-wait.ts` treats **any** `refreshAssets` RPC rejection
  as "bridge gone" and resolves `null` → the compile gate returns the bare "Successfully wrote"
  result. The RPC *predictably* rejects at the exact moment a compile starts: the C# dispatcher
  caps handlers at 8 s while `AssetDatabase.Refresh()` imports (`RpcDispatcher.cs`), the
  dispatcher cancels all waits on `beforeAssemblyReload` (`BridgeBootstrap.cs` →
  `MainThreadDispatcher.BeginShutdown`), and the Rust side drains pending RPCs on the reload
  disconnect (`unity_ipc.rs` `announce_disconnect`). The model gets a clean success, has nothing
  to do, and ends the turn — the literal reported symptom.
- `unity-tools/api-client.ts` `fetch` has **no timeout and no abort signal**;
  `buildCompileHints` issues up to 9 of them sequentially; `vendor/agent-loop.ts` has **no
  per-tool timeout**. When Unity reports compile errors, one hung fetch freezes the agent
  forever and even Stop cannot recover it.
- Aborts / stream errors leave assistant messages with `tool_calls` and no results; nothing
  outside compaction repairs orphans, so every subsequent send in that conversation 400s.
- The only focus-independent refresh trigger is the `refreshAssets` RPC inside that fragile
  gate; `refresh-on-save.ts` never fires for agent writes (agents write via `write_file`, not
  `saveFile`). With no bridge, nothing refreshes Unity at all.
- Unity-side `compilation_finished` can be lost: `BridgeClient.DrainOutbox()` discards queued
  messages on shutdown, and nothing replays compile state after the post-reload reconnect.
- Minor: the compile gate keys on `.cs` extension only (failed writes still trigger recompiles
  and consume repair budget); the LSP gate waits its full 4 s while csharp-ls is mid-restart
  (which a new `.cs` file itself triggers).

### Plan re-creation

- `ai-panel/components/ChatInput.tsx` branches on `mode === 'plan'` only and always calls
  `planController.startPlanning`. It never consults `planPhase`. Planning mode swaps in the
  plan-planning system prompt and **strips write/edit/bash/todo tools**, so the model cannot
  resume; it can only emit a new plan to a new timestamped file, orphaning the half-ticked one.
- `planPhase` / `activePlanPath` are not persisted (`stores/ai.ts` `buildSaveInput`), so a
  reload forgets an in-flight plan. `PlanRef.status` is only ever written `'draft'`.
- `executePlan` has no try/finally; a rejected send can stick `planPhase` at `'executing'`.
- `retry-turn.ts` post-restart fallback re-sends with bare `mode`, resolving to plan-planning.

### Plan preview

- `EditorPanel.tsx` gates the whole markdown branch on `mode === 'preview'` **before** checking
  `isPlanPath`, so clicking "Source" drops into plain Monaco with no way back;
  `PlanDocumentView`'s own source branch is dead code. Same one-way door for plain `.md`.
- Lexical exists only as the plain-text chat composer. (Full WYSIWYG was considered and
  rejected — hybrid block editing chosen instead.)

## Design

### Workstream A — compile-survivable agent loop (priority 1)

**A1. `compile-wait.ts` rework.** Classify `refreshAssets` rejection instead of abandoning:

- Rejection while the bridge was connected (handler timeout, cancelled-on-reload,
  disconnected-before-responding, RPC timeout) ⇒ **compile in progress**: keep waiting for the
  `unity-compilation` finished event, tolerating a bridge disconnect/reconnect cycle in the
  middle. Overall cap ~90 s (matches the Rust reload-widened peer-dead window).
- Bridge not connected at all ⇒ short-circuit as today, but the gate's tool result must say
  "Unity compile status unknown — bridge not connected", never plain success.
- On overall timeout ⇒ resolve a distinct `unknown` outcome (not fake success). Gate appends an
  honest note to the tool result.

**A2. Unity extension: compile results survive the domain reload.**
`CompilationHook` persists the last compile result via `SessionState`; after reconnect
(`connection_init` path in `BridgeBootstrap`), the extension re-announces the latest compile
state so the IDE-side wait can resolve even when the live event was lost. Compile events are
written to the journal synchronously on the main thread rather than through the outbox queue
that `DrainOutbox()` discards on shutdown.

**A3. Timeouts everywhere.**
- `api-client.ts`: every fetch gets `AbortSignal` composition (caller signal + ~10 s timeout).
- `buildCompileHints`: total time budget (~8 s), best-effort — hints never block the loop.
- `agent-loop.ts`: per-tool timeout (default ~120 s, overridable per tool; `runTests` keeps
  5 min) racing `tool.execute` with the abort signal; timeout ⇒ `isError` result, loop
  continues. `api-search-tool` accepts and forwards the signal.

**A4. Orphan repair.** Before each send (`openai-format.ts` layer), any assistant `tool_calls`
without a matching result gets a synthesized `"[interrupted before completing]"` result — the
invariant compaction already documents. Fix the `arcane-stream.ts` reader-end fallthrough that
hardcodes `stopReason:'stop'` when tool calls are present.

**A5. Honest bridge status.** When the gate short-circuits with no bridge, the AI panel shows a
persistent warning ("Unity bridge not connected — Unity picks up changes only on focus").

**A6. Small hardening.** Compile gate checks `isSuccessfulWrite` before triggering; LSP gate
fast-skips (no 4 s wait) while the csharp-ls readiness gate is down.

### Workstream B — resume, don't re-plan (priority 2)

- `ChatInput.handleSubmit` in plan mode routes by `planPhase`:
  - `awaiting-execute` / `executing` with `activePlanPath` ⇒ `planController.resumeExecution(text)`:
    re-read plan from disk, send with `promptMode:'plan-execution'` + `planExecution` args, the
    user's text as guidance. Does **not** overwrite `pendingPrompt`.
  - `idle` / `planning` ⇒ `startPlanning` as today.
- `executePlan`/`resumeExecution` wrap the send in try/finally so `planPhase` cannot stick.
- Persist `planPhase` + `activePlanPath` in the session record; on restore, normalize
  (`planning`→`idle`, `executing`→`awaiting-execute`).
- `PlanRef.status` transitions: `draft` → `executing` on execute; → `done` when all steps are
  ticked at turn end, else back to `executing`-resumable state.
- `retry-turn.ts` fallback respects a plan-execution `promptMode`.
- Composer placeholder hints "message continues plan execution; Regenerate re-plans" while a
  plan is pending.

### Workstream C — editable plan preview (priority 3)

- `EditorPanel.tsx`: check `isPlanPath` **before** the markdown-mode gate; `PlanDocumentView`
  owns both modes. Source mode embeds Monaco inside the plan chrome; toggle switches freely.
  Fix the plain-`.md` one-way door too (preview button from source mode).
- Preview-mode block editing (in `features/markdown-preview`):
  - Checkboxes clickable ⇒ toggle `- [ ]`/`- [x]` in source.
  - Click a heading/paragraph/list-item ⇒ inline editor for that block's raw markdown; commit
    on blur/Enter, cancel on Esc.
  - Source-range mapping via remark AST `position.start.offset`/`end.offset` (react-markdown
    `node` prop) — a pure `block-edit.ts` service (replace range, toggle checkbox), fully unit
    tested. No text-matching heuristics.
  - Commits write straight to disk through the existing save pipeline; the tab never goes
    dirty, so the Execute dirty-guard and the fs-watcher live-refresh keep working.
- `planPhase === 'executing'` for the active plan ⇒ read-only (checkboxes disabled, no inline
  edit, Monaco `readOnly`), with a "read-only while executing" pill; agent tick-offs stream in
  live as today.
- Plan notes keep working; reanchor after block edits via the existing `reanchorNotes`.

## Error handling

Every degraded path reports honestly: compile-status-unknown notes in tool results, bridge
warnings in the panel, timeout `isError` results the loop continues past. No path fakes
success.

## Testing

- Unit: compile-wait state machine (rejection classification, event resolution across a
  disconnect/reconnect, honest timeout), orphan repair, api-client timeout, per-tool timeout,
  composer phase-routing, plan-state persistence round-trip, `PlanRef` transitions,
  `block-edit` service (offset replacement, checkbox toggle, multi-byte content).
- `bun run verify` (tsc, module boundaries, JS + Rust suites, IntelliSense e2e) gates
  completion.

## Sequencing

A → B → C. A is the blocker for every real agent task; B is small; C is UI-heavy and
independent.
