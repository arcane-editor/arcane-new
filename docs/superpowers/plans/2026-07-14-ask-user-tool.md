# ask_user Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AI agent pause mid-turn, ask the user a structured question (option chips and/or free text via the chat composer), and continue the same turn with the answer as the tool result.

**Architecture:** A new client-side vendor tool (`ask_user`) blocks inside its `execute` on a promise held by a new `question-gate.ts` (mirror of `approval-gate.ts`); the pending question renders as a `questionRequest` message (`QuestionBlock.tsx`); answers come from option chips or from ChatInput, which routes to the pending question while one is active. Spec: `docs/superpowers/specs/2026-07-14-ask-user-tool-design.md`.

**Tech Stack:** React 19 + TypeScript + Zustand + typebox tool schemas + bun test. No server changes.

## Global Constraints

- vendor/ files READ-ONLY (`editor/src/features/ai-panel/services/vendor/`).
- Registered ONLY in `agent`, `plan-planning`, `plan-execution` modes — NOT `ask`.
- `ask_user` wrapped by `withRepeatCallGuard` only (no checkpoint/diffs/approval) and must NOT count as a mutating call in turn-telemetry's nudge counters (write/edit/bash only — verify by name list).
- Abort/Stop must both resolve the pending promise AND lock the question card (T8 abort-locking pattern — see `approval-gate.ts` abort listeners).
- Options: 0 or 2–4 entries; non-empty unique labels; invalid params → deterministic `isError` tool result, NO card rendered.
- Bun-safety: new tool + gate modules follow `todo-tool.ts`'s pattern — no store import at module scope; production callbacks reach the store via dynamic import / DI seam.
- All work in `editor/` on branch `ask-user-tool`. Commit convention `feat(ai): ...`. Every task ends with: `bun test` green, `bunx tsc --noEmit` clean, `bun run check:modules` OK; Task 3 also `bun run build`.

---

### Task 1: Pure core — ask-user tool + question gate (+ tests)

**Files:**
- Create: `editor/src/features/ai-panel/services/ask-user-tool.ts`
- Create: `editor/src/features/ai-panel/services/ask-user-tool.test.ts`
- Create: `editor/src/features/ai-panel/services/question-gate.ts`
- Create: `editor/src/features/ai-panel/services/question-gate.test.ts`

**Interfaces:**
- Consumes: `AgentTool`, `AgentToolResult` from `./vendor/types` (same imports as `todo-tool.ts`); typebox `Type`.
- Produces (Task 2/3 rely on these EXACT names):
  ```ts
  // ask-user-tool.ts
  export interface AskUserOption { label: string; description?: string }
  export interface AskUserParams { question: string; options?: AskUserOption[]; allowMultiple?: boolean }
  export type QuestionAnswer = { kind: 'answered'; answer: string } | { kind: 'cancelled' };
  export type RequestQuestionFn = (toolCallId: string, params: AskUserParams, signal?: AbortSignal) => Promise<QuestionAnswer>;
  export function validateAskUserParams(raw: unknown): { ok: true; params: AskUserParams } | { ok: false; error: string };
  export function formatAnswerResult(a: QuestionAnswer): string; // "User answered: X" | "User cancelled the question (turn aborted)."
  export function createAskUserTool(request?: RequestQuestionFn): AgentTool; // default = question-gate's requestUserQuestion via dynamic import
  // question-gate.ts
  export function requestUserQuestion(toolCallId: string, params: AskUserParams, signal?: AbortSignal): Promise<QuestionAnswer>;
  export function resolvePendingQuestion(toolCallId: string, answer: string): void; // no-op if unknown id
  export function hasPendingQuestion(toolCallId: string): boolean;
  ```

- [ ] **Step 1: Write failing tests** — `ask-user-tool.test.ts` (model on `todo-tool.test.ts` style): validation matrix (missing/empty/whitespace question → error; 1 option → error "provide 2-4 options or none"; 5 options → error; duplicate labels (case-sensitive compare) → error; empty label → error; 0 options OK; 2-4 options OK; allowMultiple without options → error); `formatAnswerResult` (answered → `User answered: pick B`, cancelled → exact cancel string); tool `execute` with an injected fake `request` resolving answered → result text contains the answer, `isError` undefined; injected request resolving cancelled → result text is the cancel string (NOT isError — cancellation is a normal outcome the model should read); invalid params → `isError: true` result AND the injected request was never called. `question-gate.test.ts`: resolve path (request → resolvePendingQuestion → promise resolves answered with the string, store-add callback observed via DI); abort → promise resolves cancelled AND the store-lock callback fired with cancelled; resolve-after-abort and double-resolve are no-ops; hasPendingQuestion true while pending, false after.
- [ ] **Step 2: Run tests, verify they fail** — `cd editor && bun test ask-user question-gate` → FAIL (modules don't exist).
- [ ] **Step 3: Implement `ask-user-tool.ts`** — mirror `todo-tool.ts`'s structure exactly: module doc comment (Bun-safe, DI seam), typebox schema:
  ```ts
  const askUserSchema = Type.Object({
    question: Type.String({ description: 'The question to ask the user. Be specific and concise.' }),
    options: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ description: 'Short answer choice (1-5 words).' }),
      description: Type.Optional(Type.String({ description: 'One-line explanation of this choice.' })),
    }), { description: '2-4 suggested answers rendered as buttons. Omit for a free-form question.' })),
    allowMultiple: Type.Optional(Type.Boolean({ description: 'Allow selecting several options (only with options).' })),
  });
  ```
  `createAskUserTool(request?)`: name `ask_user`, label `ask the user`, description telling the model: use when a decision is genuinely the user's or requirements are ambiguous; the call BLOCKS until the user answers; the result is the user's answer. `execute(id, raw, signal)`: `validateAskUserParams(raw)` → invalid: `{ content:[{type:'text',text:'Error: '+error}], isError:true }`; valid: `const a = await req(id, params, signal); return txt(formatAnswerResult(a))`. Default request fn (production): dynamic `const { requestUserQuestion } = await import('./question-gate')`.
- [ ] **Step 4: Implement `question-gate.ts`** — mirror `approval-gate.ts`, with DI deps for testability (store reached via dynamic import in the default deps, like todo-tool):
  ```ts
  const pending = new Map<string, (a: QuestionAnswer) => void>();
  export function requestUserQuestion(toolCallId, params, signal): Promise<QuestionAnswer> {
    void deps.addQuestionRequest(toolCallId, params);           // pushes the questionRequest message
    return new Promise((resolve) => {
      pending.set(toolCallId, resolve);
      signal?.addEventListener('abort', () => {
        if (pending.delete(toolCallId)) {                        // T8 lock pattern
          void deps.markQuestionCancelled(toolCallId);
          resolve({ kind: 'cancelled' });
        }
      });
    });
  }
  export function resolvePendingQuestion(toolCallId, answer) {
    const r = pending.get(toolCallId);
    if (!r) return;
    pending.delete(toolCallId);
    r({ kind: 'answered', answer });
  }
  ```
  (`deps.addQuestionRequest`/`markQuestionCancelled` call the Task-2 store actions via dynamic import; the UI calls the store action which calls `resolvePendingQuestion` — the gate never touches React.)
- [ ] **Step 5: Run tests green** — `bun test ask-user question-gate` → PASS; `bunx tsc --noEmit`; `bun run check:modules`.
- [ ] **Step 6: Commit** — `git add editor/src/features/ai-panel/services/ask-user-tool.* editor/src/features/ai-panel/services/question-gate.*` → `feat(ai): ask_user tool + question gate pure core`.

### Task 2: Store message kind, mode registration, prompts

**Files:**
- Modify: `editor/src/stores/ai.ts` (AiMessage union + `questionRequest` field + `addQuestionRequest`/`resolveQuestionRequest` actions + restore sweep in `loadSessionIntoStore`)
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (`createToolsForPromptMode`: append `createAskUserTool()` for agent/plan-execution; plan-planning currently returns the read-only early branch — add it there too, ONLY for plan-planning, not ask)
- Modify: `editor/src/features/ai-panel/services/prompts/agent.ts`, `prompts/plan-planning.ts`, `prompts/plan-execution.ts`, `prompts/prompts.test.ts`
- Modify: `editor/src/features/ai-panel/index.ts` (barrel: export tool/gate/types needed by the store and Task 3)

**Interfaces:**
- Consumes: Task 1's exports (via feature barrel from the store; direct relative imports inside the feature).
- Produces (Task 3 relies on): `AiMessage.role` gains `'questionRequest'`? NO — follow the `permissionRequest` precedent EXACTLY: check how permissionRequest messages are represented (`ai.ts:~73-80`: a message with a `permissionRequest` field — verify whether it's a role or a field, and mirror that shape for `questionRequest`). Produce:
  ```ts
  interface QuestionRequestData { toolCallId: string; question: string; options?: AskUserOption[]; allowMultiple?: boolean; resolvedAnswer?: string; cancelled?: boolean }
  addQuestionRequest(toolCallId: string, params: AskUserParams): void
  resolveQuestionRequest(toolCallId: string, outcome: { answer: string } | { cancelled: true }): void  // sets resolvedAnswer/cancelled, then calls resolvePendingQuestion(toolCallId, answer) for the answer case
  selectPendingQuestion(state): QuestionRequestData | null   // newest questionRequest with no resolvedAnswer && !cancelled && state.isAgentRunning
  ```
- [ ] **Step 1: Store changes** — mirror `addPermissionRequest`/`resolvePermissionRequest` (ai.ts ~:675-700) for questions. `resolveQuestionRequest` is the SINGLE entry point the UI uses: it locks the message (sets `resolvedAnswer` or `cancelled`), schedules a save, and for answers calls the gate's `resolvePendingQuestion` via the barrel (dynamic import if needed for Bun-safety — mirror how ai.ts reaches other feature services). The gate's abort path calls a lighter `markQuestionCancelled` store action that ONLY locks the message (it must NOT call back into the gate — the gate already resolved). Restore sweep: in `loadSessionIntoStore`, map any questionRequest message without `resolvedAnswer`/`cancelled` → `cancelled: true`.
- [ ] **Step 2: Registration** — in `createToolsForPromptMode`: agent + plan-execution get `createAskUserTool()` appended next to `createTodoTool()` (inside the existing `.map(withRepeatCallGuard)`); plan-planning's early read-only branch appends `[createAskUserTool()].map(withRepeatCallGuard)`; ask mode unchanged. Update the stack ordering comment. Confirm turn-telemetry's mutating-call list (write/edit/bash by name) doesn't match `ask_user` — add one assertion to the existing nudge-predicate test that an `ask_user` call doesn't increment mutating counts (extend the existing test file's fake-event pattern).
- [ ] **Step 3: Prompts** — add a `## Asking the user` section (4-5 lines, match each file's prose style) to all three prompts: call `ask_user` when a decision is genuinely the user's (scope, destructive trade-offs, ambiguous requirements) — the call blocks until they answer; offer 2-4 concrete options when the choices are enumerable; batch related unknowns into ONE question; do NOT ask for permission to proceed with obviously reversible work, and never ask more than twice per task. plan-planning's version: prefer asking BEFORE writing the plan when requirements are ambiguous. `prompts.test.ts`: assert all three prompts contain `ask_user`.
- [ ] **Step 4: Verify** — `bun test` green (new prompt + telemetry assertions), `bunx tsc --noEmit`, `bun run check:modules`.
- [ ] **Step 5: Commit** — `feat(ai): questionRequest store plumbing, ask_user registration + prompts`.

### Task 3: QuestionBlock UI + ChatInput answer mode + CSS

**Files:**
- Create: `editor/src/features/ai-panel/components/QuestionBlock.tsx`
- Create: `editor/src/features/ai-panel/services/question-routing.ts` (+ `question-routing.test.ts`) — pure predicate
- Modify: `editor/src/features/ai-panel/components/MessageList.tsx` (render questionRequest messages, next to the PermissionRequestBlock case)
- Modify: `editor/src/features/ai-panel/components/ChatInput.tsx` (answer mode)
- Modify: `editor/src/App.css` (`.ai-question-block*`, near the `.ai-permission-*` rules)

**Interfaces:**
- Consumes: `QuestionRequestData`, `resolveQuestionRequest`, `selectPendingQuestion` (Task 2); CSS variables/classes used by PermissionRequestBlock.
- Produces: `shouldRouteToQuestion(state: { pendingQuestion: boolean; text: string }): boolean` — true iff a pending question exists and trimmed text is non-empty.
- [ ] **Step 1: `QuestionBlock.tsx`** — model on `PermissionRequestBlock.tsx`'s structure (icon header + body + action row; reuse its CSS discipline): MessageCircleQuestion (lucide) + question text; option chips (buttons with label, `title={description}`); single-select: click → `resolveQuestionRequest(toolCallId, { answer: label })`; `allowMultiple`: chips toggle local selected-set + an "Answer" button submitting comma-joined labels (disabled with empty selection). Resolved state: chips locked (chosen ones highlighted), footer line `Answered: <resolvedAnswer>`; cancelled state: dimmed card + `Cancelled` footer. While unresolved also show a hint line: “…or type your answer below”.
- [ ] **Step 2: ChatInput answer mode** — subscribe `const pendingQuestion = useAiStore(selectPendingQuestion)`. At the TOP of `handleSubmit(text)`: if `shouldRouteToQuestion({ pendingQuestion: !!pendingQuestion, text })` → `useAiStore.getState().resolveQuestionRequest(pendingQuestion.toolCallId, { answer: text.trim() })`, clear the editor, and return WITHOUT `addUserMessage` (the answer shows in the locked QuestionBlock, not as a user bubble). Placeholder while pending: `Answer the agent's question — or click an option above.` Send-enable logic: `canSend` currently requires `!isAgentRunning` — extend to `(!isAgentRunning || !!pendingQuestion)` and make sure `LexicalChatInput`'s `disabled` prop stays false in answer mode (it's currently only disabled on missing workspace — verify). The Stop button stays visible while running (abort must remain reachable → it cancels the question via the tool signal).
- [ ] **Step 3: MessageList case** — render `<QuestionBlock>` for messages carrying `questionRequest` data, mirroring exactly how the permissionRequest case is keyed/rendered.
- [ ] **Step 4: CSS** — `.ai-question-block`, `-header`, `-text`, `-options`, `-chip` (+ `.is-selected`, `.is-locked`), `-footer`, `-hint` near the permission-block rules; reuse existing accent/border/bg vars only.
- [ ] **Step 5: Routing predicate test** — `question-routing.test.ts`: pending+text → true; pending+whitespace → false; no pending → false.
- [ ] **Step 6: Verify** — `bun test` green, `bunx tsc --noEmit`, `bun run check:modules`, `bun run build`.
- [ ] **Step 7: Commit** — `feat(ai): QuestionBlock UI + ChatInput answer mode`.

## Verification (end-to-end, after all tasks)

Manual (add to the open manual checklist as a new section): in agent mode, prompt "Ask me which of two approaches I prefer before doing anything" → question card with chips appears mid-turn, agent waits; click a chip → card locks with the answer, agent continues using it; repeat and answer by typing in the composer instead; repeat and press Stop while pending → card shows Cancelled, no error block (abort suppression from T5 still applies); restore a session that had an unanswered question → card shows Cancelled; plan mode: ambiguous request → model asks before writing the plan.
