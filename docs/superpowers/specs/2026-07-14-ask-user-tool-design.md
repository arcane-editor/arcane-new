# ask_user tool — design spec

Approved 2026-07-14. Gives the AI agent a way to pause mid-turn, ask the user a structured question, and continue the same turn with the answer.

## Problem

The agent has no way to ask the user anything. When requirements are ambiguous it either guesses (wrong work) or asks in prose at the end of a turn (loses the turn; no structured answer). The interactive machinery already exists for write approvals (`approval-gate.ts` pending-promise map + `permissionRequest` messages + `PermissionRequestBlock`), but it is permission-shaped: fixed option ids, no free text, no multi-select.

## Decisions

- **UX: Cursor style.** The question renders as an inline card with clickable option chips; the user can instead answer free-form by typing in the normal chat composer, which routes to the pending question while one is active.
- **Modes:** registered in `agent`, `plan-planning`, `plan-execution`. Not `ask` (plain chat already is Q&A).
- **Approach A** (new flow mirroring approval-gate) over extending `permissionRequest` — keeps permission semantics untouched (freshly hardened in the 2026-07-14 overhaul) and lets the question UI evolve independently.

## Components

1. **Tool `ask_user`** (`services/ask-user-tool.ts`, client-side like `todo-tool.ts`):
   - Params: `question: string` (required, non-empty); `options?: { label: string; description?: string }[]` (0 or 2–4 entries; labels non-empty, unique); `allowMultiple?: boolean` (only meaningful with options).
   - `execute(toolCallId, params, signal)` → `requestUserQuestion(...)` → blocks until answered/cancelled → tool result text `User answered: <answer>` (multi-select: comma-joined labels; free text verbatim) or `User cancelled the question (turn aborted).`
   - Wrapped by `withRepeatCallGuard` only — no checkpoint/diffs/approval (mutates nothing).
2. **Service `question-gate.ts`** — mirrors `approval-gate.ts`: module `pending` map keyed by toolCallId; `requestUserQuestion` pushes a `questionRequest` message into the store and returns a promise; `resolvePendingQuestion(toolCallId, answer)` resolves + locks the message; abort listener resolves as cancelled AND locks the message (the T8 abort-locking pattern — no stale active UI).
3. **Store (`stores/ai.ts`)** — new message kind `questionRequest` on `AiMessage`: `{ toolCallId, question, options?, allowMultiple?, resolvedAnswer?: string, cancelled?: boolean }`; actions `addQuestionRequest`, `resolveQuestionRequest(toolCallId, answer | {cancelled:true})`. Selector `pendingQuestion` (newest unresolved questionRequest, only while `isAgentRunning`). Session restore: `loadSessionIntoStore` sweeps unresolved questionRequests → `cancelled: true` (the loop that asked is gone).
4. **UI `QuestionBlock.tsx`** — visual sibling of `PermissionRequestBlock`: question text, option chips (single-select resolves on click; `allowMultiple` renders toggles + an Answer button), locked state shows the given answer (or "Cancelled"). Rendered from `MessageList`.
5. **ChatInput answer mode** — while `pendingQuestion` exists: placeholder becomes "Answer the agent's question — or click an option above"; submit resolves the question instead of sending a message; input is enabled even though the agent is running (it is normally disabled mid-run). Extracted pure predicate for routing so it's testable.
6. **Prompts** — short "## Asking the user" section in `agent.ts`, `plan-planning.ts`, `plan-execution.ts`: ask only when the decision is genuinely the user's or requirements are ambiguous; offer 2–4 concrete options where possible; batch related unknowns into one question; don't over-ask; never ask before trivially reversible actions.
7. **Telemetry interplay** — `ask_user` does NOT count as a mutating call for the todo-nudge counters.

## Data flow

model emits tool_call ask_user → vendor loop executes tool sequentially → question-gate pushes questionRequest message + registers pending resolver → user clicks a chip OR types in composer → `resolveQuestionRequest` locks the card + resolves the promise → tool result returns to the loop → model continues the same turn. Stop/abort → cancelled result + locked card; the model sees the cancellation text only if the turn somehow continues (normally the turn ends).

## Error handling

- Invalid params (empty question, 1 option, >4 options, duplicate labels): tool returns a deterministic error result (isError) without rendering a card — the model self-corrects, same convention as todo-tool validation.
- Double-resolve / resolve-after-abort: no-ops (pending map deletion guards, as in approval-gate).
- Question pending at app quit: nothing persisted as pending — restore sweep marks it cancelled.

## Testing

- `question-gate.test.ts`: resolve path, abort → cancelled + lock, double-resolve no-op (DI style like write-approval-gate tests).
- `ask-user-tool.test.ts`: schema validation matrix; answer formatting (single, multi, free text); cancelled formatting.
- ChatInput routing predicate test (pure): pending question + non-empty input → routes to resolve; no pending → normal send.
- `prompts.test.ts`: all three prompts mention `ask_user`.
- Store/UI glue rides on tsc + review + manual pass (repo convention).

## Out of scope

Ask-mode registration; question timeouts; server-side changes (none needed — the tool passes through as an OpenAI function def); images/rich content in questions.
