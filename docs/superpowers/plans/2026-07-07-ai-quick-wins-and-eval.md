# AI Quick Wins + Unity Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 0 (client-side harness/config quick wins — **no model changes**) and Phase 1 (headless Unity eval harness) of `docs/superpowers/specs/2026-07-07-unity-ai-differentiation-design.md`.

> **Scope decision (user, 2026-07-07):** keep the existing Cloudflare Workers AI model lineup untouched. No external providers, no routing changes. Improve the harness and client-side context handling; measure with the eval.

**Architecture:** Two workstreams. (A) Quick wins: the editor (`editor/`) gains per-tier compaction windows matched to the real CF models, higher output ceilings, rewritten ask/agent prompts, tiered graph-snapshot budget, and turn telemetry; the server (`arcane-server/`) gains only telemetry columns (model routing untouched). (B) Eval: a Bun-run harness in `editor/tooling/unity-eval/` drives the *real* vendor agent loop headlessly (tools take injected operations; a non-streaming OpenAI-compatible StreamFn) against fixture Unity projects, scoring tasks with the existing unity-analyzers plus file/answer checks. Baselines run against the SAME CF models via Cloudflare's OpenAI-compatible REST endpoint.

**Tech Stack:** TypeScript, Bun (`bun test` — no test infra exists yet in either package; this plan bootstraps it), Hono + `ai` SDK v6 on Cloudflare Workers (unchanged), D1 migrations via wrangler, Zustand, Typebox.

## Global Constraints

- **Model lineup is frozen**: `low` = `@cf/qwen/qwen2.5-coder-32b-instruct`, `mid` = `@cf/moonshotai/kimi-k2.7-code`, `high`/`super` = `@cf/zai-org/glm-5.2`. No task may edit `arcane-server/src/config/plans.ts` model ids or `llm-router.ts` routing.
- Default effort tier: `high` (was `mid`) — `editor/src/stores/ai.ts`. (Tier selection among the EXISTING models; not a lineup change.)
- Output ceilings: `chat: 16384, plan: 24576, edit: 24576` (was 4096/8192/8192).
- Tier context windows (the real windows of the frozen lineup, from `arcane-server/src/lib/costs.ts` MODEL_CATALOG): `low: 32768, mid: 256000, high: 200000, super: 200000`.
- Graph snapshot budget: 4096 chars on `high`/`super`, 1024 on `low`/`mid`.
- The $1/hr user cap stays untouched.
- Editor deep-modules rule: import features only via their `index.ts` barrel (`editor/CLAUDE.md`). Exception: `editor/tooling/` scripts are not features and may import `src/` modules, but still prefer barrels.
- Editor package manager is **bun**; arcane-server uses npm + wrangler. Tests in both run with `bun test`.
- All prompts/limits changed here must keep the stable-prefix → volatile-tail ordering in `prompts/index.ts` `decorate()` (prompt-cache friendliness).

---

## Part A — Phase 0 quick wins

### Task 1: REMOVED — external upstream routing

**Dropped by user decision (2026-07-07): the CF Workers AI model lineup stays as-is.** No external providers, no `model_info` event, no failover changes. Task numbering below is preserved to avoid churn. Server-side work in this plan is limited to Task 2 (telemetry columns).

---

### Task 2: Server — telemetry columns + logging

**Files:**
- Create: `arcane-server/migrations/0010_request_telemetry.sql`
- Modify: `arcane-server/src/lib/db.ts:155-162` (`createRequestLog`)
- Modify: `arcane-server/src/routes/chat.ts` (`logUsage` + both branches)
- Modify: `arcane-server/src/types.ts` (metadata.telemetry)
- Test: manual D1 verification (schema change; no pure logic to unit-test)

**Interfaces:**
- Consumes: existing `usage` StreamEvent (input/output tokens only — Workers AI reports no cached-token figure today).
- Produces: `request_logs` columns `task_type TEXT, turn_index INTEGER, tool_error_count INTEGER, repair_count INTEGER, cached_input_tokens INTEGER` (cached column is future-proofing; logged NULL for now); request `metadata.telemetry?: { turnIndex?: number; toolErrorCount?: number; repairCount?: number }` (Task 6 sends it).

- [ ] **Step 1: Write the migration**

Create `arcane-server/migrations/0010_request_telemetry.sql`:

```sql
-- Per-request agent telemetry (client-reported) + provider cache hits.
ALTER TABLE request_logs ADD COLUMN task_type TEXT;
ALTER TABLE request_logs ADD COLUMN turn_index INTEGER;
ALTER TABLE request_logs ADD COLUMN tool_error_count INTEGER;
ALTER TABLE request_logs ADD COLUMN repair_count INTEGER;
ALTER TABLE request_logs ADD COLUMN cached_input_tokens INTEGER;
```

- [ ] **Step 2: Apply locally and verify**

```bash
cd arcane-server && npx wrangler d1 execute arcane-db --local --file=migrations/0010_request_telemetry.sql
npx wrangler d1 execute arcane-db --local --command "PRAGMA table_info(request_logs);"
```

Expected: the five new columns listed.

- [ ] **Step 3: Extend types + db helper**

`arcane-server/src/types.ts` — inside `ChatCompletionRequest.metadata` add:

```ts
        telemetry?: { turnIndex?: number; toolErrorCount?: number; repairCount?: number };
```

`arcane-server/src/lib/db.ts` — extend `createRequestLog`:

```ts
export async function createRequestLog(
    db: D1Database,
    data: {
        userId: number; model: string; inputTokens: number; outputTokens: number;
        costUsd: number; durationMs: number;
        taskType?: string; turnIndex?: number; toolErrorCount?: number;
        repairCount?: number; cachedInputTokens?: number;
    },
): Promise<void> {
    await db.prepare(
        `INSERT INTO request_logs
         (user_id, model, input_tokens, output_tokens, cost_usd, duration_ms,
          task_type, turn_index, tool_error_count, repair_count, cached_input_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        data.userId, data.model, data.inputTokens, data.outputTokens, data.costUsd, data.durationMs,
        data.taskType ?? null, data.turnIndex ?? null, data.toolErrorCount ?? null,
        data.repairCount ?? null, data.cachedInputTokens ?? null,
    ).run();
}
```

- [ ] **Step 4: Thread telemetry through chat.ts**

In `arcane-server/src/routes/chat.ts`, change `logUsage` to accept and forward the extras:

```ts
async function logUsage(
    db: D1Database, user: AuthPayload, model: string,
    inputTokens: number, outputTokens: number, durationMs: number,
    extras: { taskType?: string; turnIndex?: number; toolErrorCount?: number; repairCount?: number; cachedInputTokens?: number },
): Promise<void> {
    const cost = estimateCost(model, inputTokens, outputTokens);
    const periodStart = getCurrentPeriodStart();
    await Promise.all([
        upsertUsagePeriod(db, parseInt(user.sub), periodStart, getNextPeriodStart(), inputTokens, outputTokens, cost)
            .catch(err => console.error('Failed to log usage period:', err)),
        createRequestLog(db, {
            userId: parseInt(user.sub), model, inputTokens, outputTokens,
            costUsd: cost, durationMs, ...extras,
        }).catch(err => console.error('Failed to log request:', err)),
    ]);
}
```

In both branches, call (cachedInputTokens is intentionally omitted — Workers AI doesn't report it; the column stays NULL until a provider does):

```ts
await logUsage(env.arcane_db, user, body.model, inputTokens, outputTokens, durationMs, {
    taskType: body.metadata?.taskType,
    turnIndex: body.metadata?.telemetry?.turnIndex,
    toolErrorCount: body.metadata?.telemetry?.toolErrorCount,
    repairCount: body.metadata?.telemetry?.repairCount,
});
```

- [ ] **Step 5: Typecheck, apply migration remotely, commit**

```bash
cd arcane-server && npx tsc --noEmit && bun test src
npx wrangler d1 execute arcane-db --remote --file=migrations/0010_request_telemetry.sql
git add arcane-server && git commit -m "feat(server): request_logs telemetry columns (turns, tool errors, repairs, cache hits)"
```

---

### Task 3: Editor — per-tier compaction windows + default effort high

**Files:**
- Modify: `editor/src/features/ai-panel/services/types.ts`
- Modify: `editor/src/features/ai-panel/services/vendor/agent.ts` (add setter)
- Modify: `editor/src/features/ai-panel/services/agent-service.ts:236-250`
- Modify: `editor/src/stores/ai.ts` (default effort)
- Modify: `editor/package.json` (bootstrap `bun test`)
- Test: `editor/src/features/ai-panel/services/types.test.ts`, `editor/src/features/ai-panel/services/vendor/agent.test.ts`

**Interfaces:**
- Consumes: nothing new server-side (model lineup frozen; windows are static facts about the frozen lineup).
- Produces: `TIER_CONTEXT_WINDOWS: Record<Effort, number>` (types.ts); `Agent.setContextWindow(n: number): void`. Task 4 builds on the same files.

- [ ] **Step 1: Bootstrap bun test in the editor**

```bash
cd editor && bun add -d @types/bun
```

Add to `editor/package.json` scripts: `"test": "bun test src"`.

- [ ] **Step 2: Write the failing tests**

Create `editor/src/features/ai-panel/services/types.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { TIER_CONTEXT_WINDOWS } from './types';

describe('TIER_CONTEXT_WINDOWS', () => {
  it('matches the real windows of the frozen CF model lineup', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(32768);    // @cf/qwen/qwen2.5-coder-32b-instruct
    expect(TIER_CONTEXT_WINDOWS.mid).toBe(256000);   // @cf/moonshotai/kimi-k2.7-code
    expect(TIER_CONTEXT_WINDOWS.high).toBe(200000);  // @cf/zai-org/glm-5.2
    expect(TIER_CONTEXT_WINDOWS.super).toBe(200000); // @cf/zai-org/glm-5.2
  });
});
```

Create `editor/src/features/ai-panel/services/vendor/agent.test.ts` (proves the setter exists and a prompt still completes; uses a stub streamFn):

```ts
import { describe, it, expect } from 'bun:test';
import { Agent } from './agent';
import { AssistantMessageEventStream } from './event-stream';
import type { StreamFn } from './types';

function stubStream(): StreamFn {
  return () => {
    const s = new AssistantMessageEventStream();
    s.push({ type: 'start' });
    s.push({
      type: 'done',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: 1 },
    });
    return s;
  };
}

describe('Agent.setContextWindow', () => {
  it('exists and is used on the next prompt without reconstructing the agent', async () => {
    const agent = new Agent({
      model: { id: 'x', name: 'x', provider: 'test' },
      streamFn: stubStream(),
      contextWindow: 32768,
    });
    agent.setContextWindow(200000);
    const messages = await agent.prompt('hi');
    expect(messages.at(-1)?.role).toBe('assistant');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd editor && bun test src/features/ai-panel`
Expected: FAIL — `TIER_CONTEXT_WINDOWS` not exported; `setContextWindow` not a function.
If `tsc`/module-resolution friction appears (e.g. `bun:test` types), fix by adding `"types": ["bun"]` — but only if the existing `tsconfig.json` already restricts `types`; otherwise `@types/bun` auto-includes.

- [ ] **Step 4: Implement**

`editor/src/features/ai-panel/services/types.ts` — append:

```ts
/**
 * Context window per tier — the real window of the model the server maps each
 * tier to (must track arcane-server config/plans.ts + lib/costs.ts):
 *   low   → @cf/qwen/qwen2.5-coder-32b-instruct (32k)
 *   mid   → @cf/moonshotai/kimi-k2.7-code       (256k)
 *   high  → @cf/zai-org/glm-5.2                 (200k)
 *   super → @cf/zai-org/glm-5.2                 (200k)
 * Compaction previously assumed 32k for every tier, eliding context the big
 * models actually have room for.
 */
export const TIER_CONTEXT_WINDOWS: Record<Effort, number> = {
  low: 32768,
  mid: 256000,
  high: 200000,
  super: 200000,
};
```

`editor/src/features/ai-panel/services/vendor/agent.ts` — next to `setReasoning` add:

```ts
  /** LOCAL: adjust the compaction token budget per send (server-tier aware). */
  setContextWindow(contextWindow: number): void {
    this.contextWindow = contextWindow;
  }
```

`editor/src/stores/ai.ts` — change line 237 `effort: 'mid',` → `effort: 'high',` and the session-restore fallback at line ~457 `?? 'mid'` → `?? 'high'`.

`editor/src/features/ai-panel/services/agent-service.ts` — in `sendMessage` right after `this.agent.setReasoning(opts.effort);` (line 248):

```ts
    // Compaction budget: the real window of the model this tier maps to
    // (server model lineup is fixed; see TIER_CONTEXT_WINDOWS).
    this.agent.setContextWindow(TIER_CONTEXT_WINDOWS[opts.effort]);
```

Add `TIER_CONTEXT_WINDOWS` to the existing `./types` import.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd editor && bun test src/features/ai-panel && bunx tsc --noEmit`
Expected: PASS + clean typecheck. (If `tsc --noEmit` isn't wired, `bun run build` runs `tsc` — use that but expect it to also run vite.)

- [ ] **Step 6: Commit**

```bash
git add editor && git commit -m "feat(editor): per-tier compaction windows, default effort high"
```

---

### Task 4: Editor — output ceilings + tiered graph-snapshot budget

**Files:**
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts:89`
- Modify: `editor/src/features/graphify/services/graph-context.ts`
- Modify: `editor/src/features/graphify/index.ts` (re-export if signature changes)
- Modify: `editor/src/features/ai-panel/services/prompts/index.ts` (`decorate` + `buildSystemPrompt` gain effort)
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (pass effort through `syncForPromptMode`)
- Test: `editor/src/features/graphify/services/graph-context.test.ts`

**Interfaces:**
- Consumes: `Effort` type, `buildGraphSnapshot(activeFilePath)` (existing).
- Produces: `buildGraphSnapshot(activeFilePath: string | null, opts?: { maxChars?: number }): string | null`; `graphSnapshotBudget(effort: Effort): number` (exported from graph-context, re-exported via the graphify barrel); `buildSystemPrompt(mode, workspacePath, opts?: { effort?: Effort; planExecution?: {...} })` — signature reshaped (see Step 3); `AgentService.syncForPromptMode(promptMode, effort, planExecutionArgs?)`.

- [ ] **Step 1: Write the failing test**

Create `editor/src/features/graphify/services/graph-context.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { graphSnapshotBudget, capSnapshot } from './graph-context';

describe('graph snapshot budget', () => {
  it('gives high tiers 4096 chars and low tiers 1024', () => {
    expect(graphSnapshotBudget('low')).toBe(1024);
    expect(graphSnapshotBudget('mid')).toBe(1024);
    expect(graphSnapshotBudget('high')).toBe(4096);
    expect(graphSnapshotBudget('super')).toBe(4096);
  });

  it('caps text at the budget with an ellipsis', () => {
    const text = 'x'.repeat(5000);
    expect(capSnapshot(text, 1024).length).toBe(1024);
    expect(capSnapshot(text, 1024).endsWith('…')).toBe(true);
    expect(capSnapshot('short', 1024)).toBe('short');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/graphify`
Expected: FAIL — `graphSnapshotBudget` / `capSnapshot` not exported.

- [ ] **Step 3: Implement**

`editor/src/features/graphify/services/graph-context.ts`:

```ts
import type { Effort } from '../../ai-panel/services/types';
```

(If that import violates the deep-modules checker — graphify importing ai-panel internals — define a local `type Tier = 'low' | 'mid' | 'high' | 'super'` instead; run `bun run check:modules` to decide.)

```ts
export function graphSnapshotBudget(effort: Effort): number {
  return effort === 'high' || effort === 'super' ? 4096 : MAX_CHARS;
}

export function capSnapshot(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}
```

Change `buildGraphSnapshot` signature to `buildGraphSnapshot(activeFilePath: string | null, opts?: { maxChars?: number })` and its last line to:

```ts
  return capSnapshot(out, opts?.maxChars ?? MAX_CHARS);
```

Re-export `graphSnapshotBudget` from `editor/src/features/graphify/index.ts` alongside `buildGraphSnapshot`.

`editor/src/features/ai-panel/services/prompts/index.ts` — reshape to carry effort (single options object replaces the overloads):

```ts
import type { ChatMode, Effort } from '../types';
import { buildGraphSnapshot, graphSnapshotBudget } from '../../../graphify';

function decorate(base: string, effort: Effort): string {
  const parts: string[] = [base];
  const facts = getUnityFactsBlock();
  if (facts) parts.push(facts);
  const activeFilePath = useWorkspaceStore.getState().activeFilePath;
  const snapshot = buildGraphSnapshot(activeFilePath, { maxChars: graphSnapshotBudget(effort) });
  if (snapshot) parts.push(snapshot);
  return parts.join('\n\n');
}

export interface BuildSystemPromptOpts {
  effort?: Effort;
  planExecution?: Omit<PlanExecutionPromptArgs, 'workspacePath'>;
}

export function buildSystemPrompt(
  mode: PromptMode,
  workspacePath: string,
  opts?: BuildSystemPromptOpts,
): string {
  const effort = opts?.effort ?? 'mid';
  switch (mode) {
    case 'ask':
      return decorate(buildAskPrompt(workspacePath), effort);
    case 'agent':
      return decorate(buildAgentPrompt(workspacePath), effort);
    case 'plan-planning':
      return decorate(buildPlanPlanningPrompt(workspacePath), effort);
    case 'plan-execution':
      if (!opts?.planExecution) {
        throw new Error('plan-execution prompt requires planPath and planContent');
      }
      return decorate(
        buildPlanExecutionPrompt({ workspacePath, ...opts.planExecution }),
        effort,
      );
  }
}
```

`editor/src/features/ai-panel/services/agent-service.ts` — update `syncForPromptMode(promptMode, effort: Effort, planExecutionArgs?)` to pass `{ effort, planExecution: planExecutionArgs }` into `buildSystemPrompt`, update its two call sites (`constructor` → `buildSystemPrompt('agent', workspacePath, { effort: 'mid' })`; `sendMessage` → `this.syncForPromptMode(promptMode, opts.effort, opts.planExecution)`). Search the repo for other `buildSystemPrompt(` callers (plan-controller is likely one) and update them to the new signature.

`editor/src/features/ai-panel/services/arcane-stream.ts:89`:

```ts
  const maxTokensByTask = { chat: 16384, plan: 24576, edit: 24576 } as const;
```

- [ ] **Step 4: Run tests + typecheck + module check**

Run: `cd editor && bun test src && bunx tsc --noEmit && bun run check:modules`
Expected: all PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add editor && git commit -m "feat(editor): raise output ceilings, tier-scaled graph snapshot budget"
```

---

### Task 5: Editor — prompt rewrite (ask + agent personas)

**Files:**
- Modify: `editor/src/features/ai-panel/services/prompts/ask.ts`
- Modify: `editor/src/features/ai-panel/services/prompts/agent.ts`
- Test: `editor/src/features/ai-panel/services/prompts/prompts.test.ts`

**Interfaces:**
- Consumes/Produces: `buildAskPrompt(workspacePath)` / `buildAgentPrompt(workspacePath)` — signatures unchanged, content changes only. Plan-mode prompts are intentionally untouched (their structure is load-bearing for the plan-controller).

- [ ] **Step 1: Write the failing regression tests**

Create `editor/src/features/ai-panel/services/prompts/prompts.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { buildAskPrompt } from './ask';
import { buildAgentPrompt } from './agent';

describe('prompt personas (anti-terseness regression)', () => {
  const ask = buildAskPrompt('/proj');
  const agent = buildAgentPrompt('/proj');

  it('ask prompt teaches root causes and adapts depth', () => {
    expect(ask).toContain('root cause');
    expect(ask).toContain('Match depth to the question');
    expect(ask).not.toContain('Keep examples small and self-contained');
  });

  it('agent prompt reports verification, not brevity', () => {
    expect(agent).toContain('what was verified');
    expect(agent).not.toContain('Keep prose tight');
    expect(agent).not.toContain('a brief summary');
  });

  it('both keep the grounding instructions and Unity context', () => {
    expect(ask).toContain('Investigate before answering');
    expect(agent).toContain('unity_api_search');
    expect(agent).toContain('Read before you edit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/ai-panel/services/prompts`
Expected: FAIL on the new-content assertions.

- [ ] **Step 3: Rewrite ask.ts "How to respond"**

Replace lines 23-29 of `ask.ts` (the `## How to respond` section) with:

```
## How to respond

- **Investigate before answering.** If the question touches the project's code, read the relevant files first — answer from what the code actually says, not from what similar projects usually do.
- **Explain the root cause, not just the fix.** When diagnosing a problem, name the underlying Unity mechanism (lifecycle ordering, serialization, domain reload, script execution order, etc.) and connect it to what the user is seeing. The user should come away understanding *why*.
- **Ground answers in THIS project.** When the Unity version, render pipeline, or input system changes the answer, say which applies here and why — an answer that is correct for URP can be wrong for Built-in.
- **Match depth to the question.** A one-line factual question deserves a direct answer. A design or debugging question deserves structure: what's happening, why, the options with trade-offs, and your recommendation for this project's setup.
- Use Unity terminology naturally; cite files and lines you have read (e.g. \`PlayerController.cs:24\`); use fenced \`\`\`csharp blocks for code.
```

Keep everything else in the file unchanged.

- [ ] **Step 4: Rewrite agent.ts "Output style"**

Replace lines 27-31 of `agent.ts` (the `## Output style` section) with:

```
## Output style

- **Before acting:** one or two sentences on what you're about to do and why — enough that the user could stop you if you've misread the goal.
- **While working:** a short line of intent before each meaningful tool call. Surface anything surprising the moment you find it — an existing helper you'll reuse, a conflicting pattern, a hidden dependency.
- **After finishing:** report what changed and **what was verified** — compiler/analyzer results and tests that ran — plus anything the user must do manually in the Unity editor (Inspector wiring, scene hookups). Include clickable file paths. If something is unverified or risky, say so plainly instead of claiming success.
- For Unity-specific gotchas (lifecycle ordering, coroutine vs async, destroyed-object \`==\` semantics), call them out when they affect the change you're making.
```

Keep `## Operating principles` line 21 but change its third bullet from
`**Explain before you act.** State briefly what you're about to do and why, then run the tools. Keep prose tight — the tool calls are visible to the user.`
to
`**Explain before you act.** State what you're about to do and why, then run the tools.`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd editor && bun test src/features/ai-panel/services/prompts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add editor && git commit -m "feat(editor): rewrite ask/agent prompts — root-cause depth over enforced terseness"
```

---

### Task 6: Editor — client turn telemetry

**Files:**
- Create: `editor/src/features/ai-panel/services/turn-telemetry.ts`
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (reset + subscribe)
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts` (send in metadata)
- Test: `editor/src/features/ai-panel/services/turn-telemetry.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` union from `vendor/types`; server `metadata.telemetry` (Task 2).
- Produces: `resetTurnTelemetry(): void`, `nextTurnTelemetry(): { turnIndex: number; toolErrorCount: number; repairCount: number }`, `recordTelemetryEvent(event: AgentEvent): void`.

- [ ] **Step 1: Write the failing test**

Create `editor/src/features/ai-panel/services/turn-telemetry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  resetTurnTelemetry,
  nextTurnTelemetry,
  recordTelemetryEvent,
} from './turn-telemetry';
import type { AgentEvent } from './vendor/types';

const toolEnd = (isError: boolean): AgentEvent =>
  ({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'edit', result: { content: [] }, isError }) as AgentEvent;

const repairResult = (text: string): AgentEvent =>
  ({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 't1', toolName: 'edit', content: text, isError: false, timestamp: 1 },
  }) as AgentEvent;

describe('turn telemetry', () => {
  beforeEach(() => resetTurnTelemetry());

  it('increments turnIndex per LLM request', () => {
    expect(nextTurnTelemetry().turnIndex).toBe(1);
    expect(nextTurnTelemetry().turnIndex).toBe(2);
  });

  it('counts tool errors', () => {
    recordTelemetryEvent(toolEnd(true));
    recordTelemetryEvent(toolEnd(false));
    expect(nextTurnTelemetry().toolErrorCount).toBe(1);
  });

  it('counts compile/analyzer repair feedback but not clean compiles', () => {
    recordTelemetryEvent(repairResult('[Unity compile] 2 compiler error(s) after writing X'));
    recordTelemetryEvent(repairResult('[Unity analyzers] 1 error-severity issue(s)'));
    recordTelemetryEvent(repairResult('[Unity compile] Clean'));
    expect(nextTurnTelemetry().repairCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/ai-panel/services/turn-telemetry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `editor/src/features/ai-panel/services/turn-telemetry.ts`:

```ts
/**
 * Per-user-send agent telemetry, reported to the server in request metadata
 * (request_logs columns) — turns per task, tool failures, repair loops.
 * Reset at the start of every user send; turnIndex increments per LLM request.
 */

import type { AgentEvent } from './vendor/types';

interface TurnTelemetry {
  turnIndex: number;
  toolErrorCount: number;
  repairCount: number;
}

let current: TurnTelemetry = { turnIndex: 0, toolErrorCount: 0, repairCount: 0 };

export function resetTurnTelemetry(): void {
  current = { turnIndex: 0, toolErrorCount: 0, repairCount: 0 };
}

/** Called once per outgoing LLM request; returns the snapshot to send. */
export function nextTurnTelemetry(): TurnTelemetry {
  current.turnIndex++;
  return { ...current };
}

const REPAIR_MARKERS = ['[Unity compile]', '[Unity analyzers]'];

export function recordTelemetryEvent(event: AgentEvent): void {
  if (event.type === 'tool_execution_end' && event.isError) {
    current.toolErrorCount++;
    return;
  }
  if (event.type === 'message_end' && event.message.role === 'toolResult') {
    const c = event.message.content;
    const text = typeof c === 'string' ? c : '';
    if (REPAIR_MARKERS.some((m) => text.includes(m)) && !text.includes('] Clean')) {
      current.repairCount++;
    }
  }
}
```

Wire it:
- `agent-service.ts` constructor, after the existing subscribe: `this.agent.subscribe((event) => recordTelemetryEvent(event));`
- `agent-service.ts` `sendMessage`, next to `resetCompileGate()`: `resetTurnTelemetry();`
- `arcane-stream.ts` body metadata:

```ts
    metadata: {
      taskType,
      mode: currentMode,
      reasoningLevel: options.reasoning ?? 'mid',
      telemetry: nextTurnTelemetry(),
    },
```

with `import { nextTurnTelemetry } from './turn-telemetry';`.

- [ ] **Step 4: Run tests + typecheck, commit**

```bash
cd editor && bun test src && bunx tsc --noEmit
git add editor && git commit -m "feat(editor): per-send agent telemetry reported in request metadata"
```

---

## Part B — Phase 1: the Unity eval harness

### Task 7: Extract shared OpenAI conversion module

**Files:**
- Create: `editor/src/features/ai-panel/services/openai-format.ts`
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts` (import instead of local defs)
- Test: `editor/src/features/ai-panel/services/openai-format.test.ts`

**Interfaces:**
- Produces: `convertToOpenAI(systemPrompt: string, messages: Message[]): OpenAIMessage[]` and the `OpenAIMessage` / `OpenAIUserPart` types, moved verbatim from `arcane-stream.ts:294-391` into `openai-format.ts` and exported. `arcane-stream.ts` re-imports them; behavior identical. Task 9's eval StreamFn imports from here.

- [ ] **Step 1: Write the failing test**

Create `editor/src/features/ai-panel/services/openai-format.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { convertToOpenAI } from './openai-format';

describe('convertToOpenAI', () => {
  it('emits system + user + assistant tool_calls + tool results', () => {
    const out = convertToOpenAI('SYS', [
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'assistant', timestamp: 2, stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.cs' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: '1  code', isError: false, timestamp: 3 },
    ] as never);
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out[2].tool_calls?.[0].function.name).toBe('read');
    expect(JSON.parse(out[2].tool_calls![0].function.arguments)).toEqual({ path: 'a.cs' });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '1  code' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/ai-panel/services/openai-format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Move the code**

Create `openai-format.ts`; cut `arcane-stream.ts` lines 294-391 (the `// ---- Message format conversion ----` block: `OpenAIUserPart`, `OpenAIMessage`, `convertToOpenAI`) into it verbatim, adding `export` to all three and this import:

```ts
import type { Message, ToolCall } from './vendor/types';
```

In `arcane-stream.ts`, add `import { convertToOpenAI } from './openai-format';` and remove the now-unused local `Message`/`ToolCall` imports if `tsc` flags them.

- [ ] **Step 4: Run tests + typecheck, commit**

```bash
cd editor && bun test src && bunx tsc --noEmit
git add editor && git commit -m "refactor(editor): extract convertToOpenAI into shared openai-format module"
```

---

### Task 8: Eval scaffolding — types, fixtures, fixture facts

**Files:**
- Create: `editor/tooling/unity-eval/eval-types.ts`
- Create: `editor/tooling/unity-eval/fixture-facts.ts`
- Create: `editor/tooling/unity-eval/fixtures/builtin-legacy/ProjectSettings/ProjectVersion.txt`
- Create: `editor/tooling/unity-eval/fixtures/builtin-legacy/Packages/manifest.json`
- Create: `editor/tooling/unity-eval/fixtures/builtin-legacy/Assets/Scripts/PlayerController.cs`
- Create: `editor/tooling/unity-eval/fixtures/builtin-legacy/Assets/Scripts/Mover.cs`
- Create: `editor/tooling/unity-eval/fixtures/urp-newinput/ProjectSettings/ProjectVersion.txt`
- Create: `editor/tooling/unity-eval/fixtures/urp-newinput/Packages/manifest.json`
- Create: `editor/tooling/unity-eval/fixtures/urp-newinput/Assets/Scripts/Health.cs`
- Test: `editor/tooling/unity-eval/fixture-facts.test.ts`

**Interfaces:**
- Produces:

```ts
// eval-types.ts
export type CheckSpec =
  | { type: 'file_exists'; path: string }
  | { type: 'file_contains'; path: string; pattern: string; flags?: string }
  | { type: 'file_not_contains'; path: string; pattern: string; flags?: string }
  | { type: 'analyzer_clean'; glob: string }
  | { type: 'answer_matches'; pattern: string; flags?: string }
  | { type: 'answer_not_matches'; pattern: string; flags?: string };

export interface EvalTask {
  id: string;
  family: 'codegen' | 'grounding' | 'agentic';
  fixture: 'builtin-legacy' | 'urp-newinput';
  mode: 'ask' | 'agent';
  prompt: string;
  checks: CheckSpec[];
  maxTurns?: number; // default 12
}

export interface TaskResult {
  taskId: string; family: string; pass: boolean;
  checks: { spec: CheckSpec; pass: boolean; detail: string }[];
  turns: number; wallMs: number; inputTokens: number; outputTokens: number;
  error?: string;
}
```

- `buildFixtureFacts(fixtureDir: string): Promise<string>` (fixture-facts.ts) — returns a `## Unity project facts` block matching the shape `unity-facts.ts` produces.

- [ ] **Step 1: Create fixture builtin-legacy**

`ProjectSettings/ProjectVersion.txt`:

```
m_EditorVersion: 2022.3.45f1
m_EditorVersionWithRevision: 2022.3.45f1 (12345abcdef0)
```

`Packages/manifest.json`:

```json
{
  "dependencies": {
    "com.unity.textmeshpro": "3.0.9",
    "com.unity.ugui": "1.0.0"
  }
}
```

`Assets/Scripts/PlayerController.cs` (deliberately seeded: legacy input, a serialized `speed` field for the rename task, an unassigned Rigidbody for the NRE task):

```csharp
using UnityEngine;

public class PlayerController : MonoBehaviour
{
    [SerializeField] private float speed = 5f;

    private Rigidbody rb;

    void Start()
    {
        rb.linearVelocity = Vector3.zero;
    }

    void Update()
    {
        float h = Input.GetAxis("Horizontal");
        float v = Input.GetAxis("Vertical");
        transform.Translate(new Vector3(h, 0f, v) * speed * Time.deltaTime);
    }
}
```

`Assets/Scripts/Mover.cs` (seeded: lifecycle-typo `update`, GetComponent-in-Update for the analyzer task):

```csharp
using UnityEngine;

public class Mover : MonoBehaviour
{
    void update()
    {
        var rb = GetComponent<Rigidbody>();
        rb.AddForce(Vector3.forward);
    }
}
```

- [ ] **Step 2: Create fixture urp-newinput**

`ProjectSettings/ProjectVersion.txt`:

```
m_EditorVersion: 6000.0.23f1
m_EditorVersionWithRevision: 6000.0.23f1 (abcdef123456)
```

`Packages/manifest.json`:

```json
{
  "dependencies": {
    "com.unity.render-pipelines.universal": "17.0.3",
    "com.unity.inputsystem": "1.11.2",
    "com.unity.textmeshpro": "3.0.9"
  }
}
```

`Assets/Scripts/Health.cs`:

```csharp
using UnityEngine;

public class Health : MonoBehaviour
{
    [SerializeField] private int maxHealth = 100;

    public int Current { get; private set; }

    void Awake()
    {
        Current = maxHealth;
    }
}
```

- [ ] **Step 3: Write the failing fixture-facts test**

Create `editor/tooling/unity-eval/fixture-facts.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { buildFixtureFacts } from './fixture-facts';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

describe('buildFixtureFacts', () => {
  it('detects Built-in + legacy input', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'builtin-legacy');
    expect(facts).toContain('Unity version: 2022.3.45f1');
    expect(facts).toContain('Render pipeline: Built-in');
    expect(facts).toContain('Input system: Input Manager (legacy)');
  });

  it('detects URP + new Input System', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'urp-newinput');
    expect(facts).toContain('Unity version: 6000.0.23f1');
    expect(facts).toContain('Render pipeline: URP');
    expect(facts).toContain('Input system: Input System (new)');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd editor && bun test tooling/unity-eval`
Expected: FAIL — module not found. (Note the `test` script targets `src`; run tooling tests with the explicit path.)

- [ ] **Step 5: Implement eval-types.ts and fixture-facts.ts**

`eval-types.ts`: exactly the interfaces from this task's **Interfaces** block.

`fixture-facts.ts`:

```ts
/**
 * Headless replacement for unity-facts.ts: derives the "Unity project facts"
 * prompt block directly from fixture files (no Tauri, no stores).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildFixtureFacts(fixtureDir: string): Promise<string> {
  const versionTxt = await readFile(
    join(fixtureDir, 'ProjectSettings', 'ProjectVersion.txt'),
    'utf8',
  );
  const version = versionTxt.match(/m_EditorVersion:\s*(\S+)/)?.[1] ?? 'unknown';

  const manifest = JSON.parse(
    await readFile(join(fixtureDir, 'Packages', 'manifest.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const deps = manifest.dependencies ?? {};

  const pipeline = deps['com.unity.render-pipelines.universal']
    ? 'URP'
    : deps['com.unity.render-pipelines.high-definition']
      ? 'HDRP'
      : 'Built-in';
  const input = deps['com.unity.inputsystem']
    ? 'Input System (new)'
    : 'Input Manager (legacy)';

  return [
    '## Unity project facts (authoritative — match these)',
    `- Unity version: ${version}`,
    `- Render pipeline: ${pipeline}`,
    `- Input system: ${input}`,
  ].join('\n');
}
```

- [ ] **Step 6: Run tests to verify they pass, commit**

```bash
cd editor && bun test tooling/unity-eval
git add editor/tooling/unity-eval && git commit -m "feat(eval): task types, Unity fixtures, headless project-facts builder"
```

---

### Task 9: Eval — local fs/bash operations + provider StreamFn

**Files:**
- Create: `editor/tooling/unity-eval/local-operations.ts`
- Create: `editor/tooling/unity-eval/eval-stream.ts`
- Test: `editor/tooling/unity-eval/local-operations.test.ts`
- Test: `editor/tooling/unity-eval/eval-stream.test.ts`

**Interfaces:**
- Consumes: operations interfaces from `../../src/features/ai-panel/services/vendor/tools/{read,write,edit,bash,list}` (`ReadOperations{readFile,access}`, `WriteOperations{writeFile,mkdir}`, `EditOperations{readFile,writeFile,access}`, `BashOperations{exec(command,cwd,{timeout})→{stdout,stderr,exitCode}}`, `ListOperations{scanAll,readDirectory}`); `convertToOpenAI` from Task 7; `AssistantMessageEventStream`, `StreamFn`, `AssistantMessage` from vendor.
- Produces: `localReadOperations/localWriteOperations/localEditOperations/localBashOperations/localListOperations`; `createEvalStreamFn(cfg: EvalModelConfig, usage: UsageTotals): StreamFn` with `EvalModelConfig = { baseUrl: string; apiKey: string; model: string; label: string }` and `UsageTotals = { input: number; output: number; requests: number }` (mutated in place).

- [ ] **Step 1: Write the failing operations test**

Create `editor/tooling/unity-eval/local-operations.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localReadOperations,
  localWriteOperations,
  localListOperations,
  localBashOperations,
} from './local-operations';

describe('local operations', () => {
  it('write→read→list→bash roundtrip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-ops-'));
    try {
      await localWriteOperations.mkdir(join(dir, 'sub'));
      await localWriteOperations.writeFile(join(dir, 'sub', 'a.cs'), 'class A {}');
      expect(await localReadOperations.readFile(join(dir, 'sub', 'a.cs'))).toBe('class A {}');
      const all = await localListOperations.scanAll(dir);
      expect(all.some((p) => p.endsWith('a.cs'))).toBe(true);
      const entries = await localListOperations.readDirectory(dir);
      expect(entries).toEqual([{ name: 'sub', isDir: true }]);
      const r = await localBashOperations.exec('echo hi', dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('hi');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test tooling/unity-eval/local-operations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement local-operations.ts**

```ts
/**
 * node:fs / child_process implementations of the vendor tool operation
 * interfaces — lets the eval drive the REAL agent tools without Tauri.
 */

import { readFile, writeFile, access, mkdir, readdir } from 'node:fs/promises';
import { exec as cpExec } from 'node:child_process';
import { join } from 'node:path';
import type { ReadOperations } from '../../src/features/ai-panel/services/vendor/tools/read';
import type { WriteOperations } from '../../src/features/ai-panel/services/vendor/tools/write';
import type { EditOperations } from '../../src/features/ai-panel/services/vendor/tools/edit';
import type { BashOperations } from '../../src/features/ai-panel/services/vendor/tools/bash';
import type { ListOperations } from '../../src/features/ai-panel/services/vendor/tools/list';

export const localReadOperations: ReadOperations = {
  readFile: (p) => readFile(p, 'utf8'),
  access: (p) => access(p),
};

export const localWriteOperations: WriteOperations = {
  writeFile: (p, content) => writeFile(p, content, 'utf8'),
  mkdir: (p) => mkdir(p, { recursive: true }).then(() => undefined),
};

export const localEditOperations: EditOperations = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, content) => writeFile(p, content, 'utf8'),
  access: (p) => access(p),
};

export const localBashOperations: BashOperations = {
  exec: (command, cwd, options) =>
    new Promise((resolve) => {
      cpExec(
        command,
        { cwd, timeout: options?.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          });
        },
      );
    }),
};

async function scanAllRec(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await scanAllRec(p, out);
    else out.push(p);
  }
}

export const localListOperations: ListOperations = {
  scanAll: async (p) => {
    const out: string[] = [];
    await scanAllRec(p, out);
    return out;
  },
  readDirectory: async (p) => {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  },
};
```

- [ ] **Step 4: Run operations test to verify it passes**

Run: `cd editor && bun test tooling/unity-eval/local-operations.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing eval-stream test (mocked fetch)**

Create `editor/tooling/unity-eval/eval-stream.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'bun:test';
import { createEvalStreamFn } from './eval-stream';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockResponse(message: unknown, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message }], usage }), { status: 200 })) as typeof fetch;
}

const ctx = { systemPrompt: 'SYS', messages: [], tools: [] };

describe('createEvalStreamFn', () => {
  it('converts a text answer into a done event', async () => {
    mockResponse({ role: 'assistant', content: 'hello' });
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test' }, usage);
    const events: unknown[] = [];
    for await (const ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { type: string }).type === 'done') as { message: { content: { type: string; text?: string }[]; stopReason: string } };
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(done.message.stopReason).toBe('stop');
    expect(usage).toEqual({ input: 10, output: 5, requests: 1 });
  });

  it('converts tool_calls and sets stopReason toolUse', async () => {
    mockResponse({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.cs"}' } }],
    });
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test' }, usage);
    const events: unknown[] = [];
    for await (const ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) events.push(ev);
    const done = events.find((e) => (e as { type: string }).type === 'done') as { message: { content: { type: string; id?: string; name?: string; arguments?: unknown }[]; stopReason: string } };
    expect(done.message.stopReason).toBe('toolUse');
    expect(done.message.content[0]).toEqual({ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.cs' } });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd editor && bun test tooling/unity-eval/eval-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement eval-stream.ts**

```ts
/**
 * Non-streaming OpenAI-compatible StreamFn for the eval harness. Headless runs
 * don't need incremental deltas, so we do one POST per turn and emit a single
 * 'done' event carrying the finished assistant message.
 */

import { AssistantMessageEventStream } from '../../src/features/ai-panel/services/vendor/event-stream';
import { convertToOpenAI } from '../../src/features/ai-panel/services/openai-format';
import type {
  StreamFn,
  AssistantMessage,
} from '../../src/features/ai-panel/services/vendor/types';

export interface EvalModelConfig {
  baseUrl: string; // e.g. https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
  apiKey: string;
  model: string;
  label: string;
}

export interface UsageTotals {
  input: number;
  output: number;
  requests: number;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createEvalStreamFn(cfg: EvalModelConfig, usage: UsageTotals): StreamFn {
  return (context, options) => {
    const stream = new AssistantMessageEventStream();

    (async () => {
      const messages = convertToOpenAI(context.systemPrompt, context.messages);
      const tools = context.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));

      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: false,
          max_tokens: 8192,
        }),
        signal: options.signal,
      });
      if (!res.ok) throw new Error(`${cfg.label} HTTP ${res.status}: ${await res.text()}`);

      const json = (await res.json()) as OpenAIChatResponse;
      const msg = json.choices?.[0]?.message ?? {};
      usage.input += json.usage?.prompt_tokens ?? 0;
      usage.output += json.usage?.completion_tokens ?? 0;
      usage.requests++;

      const content: AssistantMessage['content'] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // leave args empty; the tool will report the schema error back
        }
        content.push({ type: 'toolCall', id: tc.id, name: tc.function.name, arguments: args });
      }

      stream.push({ type: 'start' });
      stream.push({
        type: 'done',
        message: {
          role: 'assistant',
          content,
          stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        },
      });
    })().catch((err) => {
      stream.push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
    });

    return stream;
  };
}
```

- [ ] **Step 8: Run tests to verify they pass, commit**

```bash
cd editor && bun test tooling/unity-eval
git add editor/tooling/unity-eval && git commit -m "feat(eval): local tool operations + non-streaming OpenAI-compatible StreamFn"
```

---

### Task 10: Eval — checks engine

**Files:**
- Create: `editor/tooling/unity-eval/checks.ts`
- Test: `editor/tooling/unity-eval/checks.test.ts`

**Interfaces:**
- Consumes: `CheckSpec` from eval-types; `runAnalyzersOnText` from `../../src/features/unity-analyzers` (barrel export, signature `(text: string, filePath: string, opts?) => Finding[]` with `Finding.severity: 'error' | 'warning' | 'info' | 'hint'` — verified at `unity-analyzers/index.ts:66`).
- Produces: `runChecks(specs: CheckSpec[], ctx: { workDir: string; finalAnswer: string }): Promise<{ spec: CheckSpec; pass: boolean; detail: string }[]>`.

- [ ] **Step 1: Smoke-check the analyzer import is Bun-safe**

```bash
cd editor && bun -e "const m = await import('./src/features/unity-analyzers/index.ts'); const f = m.runAnalyzersOnText('using UnityEngine;\nclass A : MonoBehaviour { void Update() { GetComponent<Rigidbody>(); } }', 'A.cs'); console.log(JSON.stringify(f.map(x => x.ruleId ?? x.severity)));"
```

Expected: prints a JSON array including the getcomponent-in-update finding — proves the barrel imports without Monaco/Tauri at runtime. If it throws on a Monaco/Tauri import, import `runAnalyzersOnText` from the deeper service module it's re-exported from instead (follow `unity-analyzers/index.ts:18` to the source) and note the exception in a comment.

- [ ] **Step 2: Write the failing test**

Create `editor/tooling/unity-eval/checks.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from './checks';

describe('runChecks', () => {
  it('evaluates file and answer checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      await mkdir(join(dir, 'Assets/Scripts'), { recursive: true });
      await writeFile(join(dir, 'Assets/Scripts/A.cs'), 'using UnityEngine;\npublic class A : MonoBehaviour { void Update() { } }');
      const results = await runChecks(
        [
          { type: 'file_exists', path: 'Assets/Scripts/A.cs' },
          { type: 'file_contains', path: 'Assets/Scripts/A.cs', pattern: 'MonoBehaviour' },
          { type: 'file_not_contains', path: 'Assets/Scripts/A.cs', pattern: 'InputSystem' },
          { type: 'analyzer_clean', glob: 'Assets/Scripts/*.cs' },
          { type: 'answer_matches', pattern: '_BaseColor' },
          { type: 'answer_not_matches', pattern: 'GetKey' },
        ],
        { workDir: dir, finalAnswer: 'Use material.SetColor("_BaseColor", c) in URP.' },
      );
      expect(results.map((r) => r.pass)).toEqual([true, true, true, true, true, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails analyzer_clean on error-severity findings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      await mkdir(join(dir, 'Assets'), { recursive: true });
      await writeFile(
        join(dir, 'Assets/Bad.cs'),
        'using UnityEngine;\npublic class Bad : MonoBehaviour { void update() { } }',
      );
      const results = await runChecks([{ type: 'analyzer_clean', glob: 'Assets/*.cs' }], {
        workDir: dir,
        finalAnswer: '',
      });
      expect(results[0].pass).toBe(false);
      expect(results[0].detail.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

Note: the second test assumes the near-miss-messages rule reports `void update()` at error severity. If it reports as warning, adjust the seeded file to something that IS an error-severity rule (check `editor/src/features/unity-analyzers/rules/near-miss-messages.ts` for the severity, and `fixtures/analyzers/*.cs` for known-bad samples) — the check contract (`error`-severity findings fail the check) stays the same.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd editor && bun test tooling/unity-eval/checks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement checks.ts**

```ts
/**
 * Task pass/fail checks. All file paths are relative to the task's workDir
 * (the temp copy of the fixture the agent worked in).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Glob } from 'bun';
import { runAnalyzersOnText } from '../../src/features/unity-analyzers';
import type { CheckSpec } from './eval-types';

export interface CheckOutcome {
  spec: CheckSpec;
  pass: boolean;
  detail: string;
}

async function tryRead(workDir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(workDir, rel), 'utf8');
  } catch {
    return null;
  }
}

async function runone(
  spec: CheckSpec,
  ctx: { workDir: string; finalAnswer: string },
): Promise<CheckOutcome> {
  switch (spec.type) {
    case 'file_exists': {
      const content = await tryRead(ctx.workDir, spec.path);
      return { spec, pass: content !== null, detail: content === null ? `missing: ${spec.path}` : 'exists' };
    }
    case 'file_contains':
    case 'file_not_contains': {
      const content = await tryRead(ctx.workDir, spec.path);
      if (content === null) return { spec, pass: false, detail: `missing: ${spec.path}` };
      const hit = new RegExp(spec.pattern, spec.flags).test(content);
      const want = spec.type === 'file_contains';
      return { spec, pass: hit === want, detail: `pattern ${hit ? 'found' : 'not found'} in ${spec.path}` };
    }
    case 'analyzer_clean': {
      const errors: string[] = [];
      for await (const rel of new Glob(spec.glob).scan({ cwd: ctx.workDir })) {
        const text = await readFile(join(ctx.workDir, rel), 'utf8');
        const findings = runAnalyzersOnText(text, rel);
        for (const f of findings) {
          if (f.severity === 'error') errors.push(`${rel}: ${f.message ?? f.ruleId ?? 'error'}`);
        }
      }
      return { spec, pass: errors.length === 0, detail: errors.slice(0, 5).join(' | ') };
    }
    case 'answer_matches':
    case 'answer_not_matches': {
      const hit = new RegExp(spec.pattern, spec.flags).test(ctx.finalAnswer);
      const want = spec.type === 'answer_matches';
      return { spec, pass: hit === want, detail: `answer pattern ${hit ? 'matched' : 'did not match'}` };
    }
  }
}

export async function runChecks(
  specs: CheckSpec[],
  ctx: { workDir: string; finalAnswer: string },
): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const spec of specs) out.push(await runone(spec, ctx));
  return out;
}
```

If `Finding` has different property names than `message`/`ruleId`, adapt the detail line to the real shape (check `analyzer-engine.ts`'s `Finding` interface) — the test only asserts non-empty detail.

- [ ] **Step 5: Run tests to verify they pass, commit**

```bash
cd editor && bun test tooling/unity-eval
git add editor/tooling/unity-eval && git commit -m "feat(eval): file/answer/analyzer checks engine"
```

---

### Task 11: Eval — runner, reporter, mock end-to-end test

**Files:**
- Create: `editor/tooling/unity-eval/run-task.ts` (single-task runner)
- Create: `editor/tooling/unity-eval/run-eval.ts` (CLI entry)
- Create: `editor/tooling/unity-eval/report.ts`
- Test: `editor/tooling/unity-eval/run-task.test.ts`
- Modify: `editor/package.json` (add `"eval": "bun tooling/unity-eval/run-eval.ts"`)

**Interfaces:**
- Consumes: `Agent` + `convertToLlm` from vendor (`../../src/features/ai-panel/services/vendor/agent`, `.../messages`); `createReadTool/createListTool/createWriteTool/createEditTool/createBashTool` from vendor tools; `buildAskPrompt`/`buildAgentPrompt` from `../../src/features/ai-panel/services/prompts/ask` and `./agent` (direct module imports — they are pure; do NOT import `prompts/index.ts`, which pulls Zustand stores); Tasks 8-10 modules.
- Produces:

```ts
// run-task.ts
export async function runTask(
  task: EvalTask,
  streamFn: StreamFn,
  usage: UsageTotals,
  opts?: { keepWorkDir?: boolean },
): Promise<TaskResult>;
// report.ts
export function renderReport(results: TaskResult[], label: string): string; // markdown table
```

- CLI contract: `bun tooling/unity-eval/run-eval.ts --base-url <url> --api-key-env <ENVVAR> --model <id> --label <name> [--filter <substr>]` writes `editor/tooling/unity-eval/results/<ISO-timestamp>-<label>.json` and prints the markdown table.

- [ ] **Step 1: Write the failing mock end-to-end test**

Create `editor/tooling/unity-eval/run-task.test.ts` — a scripted fake model completes a codegen task deterministically, proving the whole loop (fixture copy → agent loop → tools → checks) without any API key:

```ts
import { describe, it, expect } from 'bun:test';
import { AssistantMessageEventStream } from '../../src/features/ai-panel/services/vendor/event-stream';
import type { StreamFn, AssistantMessage } from '../../src/features/ai-panel/services/vendor/types';
import { runTask } from './run-task';
import type { EvalTask } from './eval-types';

/** Plays a canned sequence of assistant messages, one per LLM call. */
function scriptedStreamFn(script: AssistantMessage['content'][]): StreamFn {
  let call = 0;
  return () => {
    const stream = new AssistantMessageEventStream();
    const content = script[Math.min(call++, script.length - 1)];
    stream.push({ type: 'start' });
    stream.push({
      type: 'done',
      message: {
        role: 'assistant',
        content,
        stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      },
    });
    return stream;
  };
}

const task: EvalTask = {
  id: 'mock-001',
  family: 'codegen',
  fixture: 'builtin-legacy',
  mode: 'agent',
  prompt: 'Create Assets/Scripts/Pickup.cs with a Pickup MonoBehaviour.',
  checks: [
    { type: 'file_exists', path: 'Assets/Scripts/Pickup.cs' },
    { type: 'file_contains', path: 'Assets/Scripts/Pickup.cs', pattern: 'class Pickup' },
  ],
  maxTurns: 4,
};

describe('runTask', () => {
  it('runs the real loop against a scripted model and scores checks', async () => {
    const streamFn = scriptedStreamFn([
      [
        { type: 'text', text: 'Creating the file.' },
        {
          type: 'toolCall', id: 'c1', name: 'write',
          arguments: {
            path: 'Assets/Scripts/Pickup.cs',
            content: 'using UnityEngine;\n\npublic class Pickup : MonoBehaviour\n{\n}\n',
          },
        },
      ],
      [{ type: 'text', text: 'Done — created Pickup.cs.' }],
    ]);
    const usage = { input: 0, output: 0, requests: 0 };
    const result = await runTask(task, streamFn, usage);
    expect(result.pass).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test tooling/unity-eval/run-task.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement run-task.ts**

```ts
/**
 * Run one eval task: copy the fixture to a temp dir, drive the REAL vendor
 * agent loop with local (non-Tauri) tool operations, then score the end state.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../../src/features/ai-panel/services/vendor/agent';
import { convertToLlm } from '../../src/features/ai-panel/services/vendor/messages';
import { createReadTool } from '../../src/features/ai-panel/services/vendor/tools/read';
import { createListTool } from '../../src/features/ai-panel/services/vendor/tools/list';
import { createWriteTool } from '../../src/features/ai-panel/services/vendor/tools/write';
import { createEditTool } from '../../src/features/ai-panel/services/vendor/tools/edit';
import { createBashTool } from '../../src/features/ai-panel/services/vendor/tools/bash';
import type { AgentTool, StreamFn } from '../../src/features/ai-panel/services/vendor/types';
import { buildAskPrompt } from '../../src/features/ai-panel/services/prompts/ask';
import { buildAgentPrompt } from '../../src/features/ai-panel/services/prompts/agent';
import {
  localReadOperations,
  localWriteOperations,
  localEditOperations,
  localBashOperations,
  localListOperations,
} from './local-operations';
import { buildFixtureFacts } from './fixture-facts';
import { runChecks } from './checks';
import type { EvalTask, TaskResult } from './eval-types';
import type { UsageTotals } from './eval-stream';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url).pathname;
const DEFAULT_MAX_TURNS = 12;

function buildTools(task: EvalTask, workDir: string): AgentTool[] {
  const read = createReadTool(workDir, { operations: localReadOperations });
  const list = createListTool(workDir, { operations: localListOperations });
  if (task.mode === 'ask') return [read, list];
  return [
    read,
    list,
    createWriteTool(workDir, { operations: localWriteOperations }),
    createEditTool(workDir, { operations: localEditOperations }),
    createBashTool(workDir, { operations: localBashOperations }),
  ];
}

export async function runTask(
  task: EvalTask,
  streamFn: StreamFn,
  usage: UsageTotals,
  opts?: { keepWorkDir?: boolean },
): Promise<TaskResult> {
  const workDir = await mkdtemp(join(tmpdir(), `unity-eval-${task.id}-`));
  await cp(join(FIXTURES_DIR, task.fixture), workDir, { recursive: true });

  const base = task.mode === 'ask' ? buildAskPrompt(workDir) : buildAgentPrompt(workDir);
  const facts = await buildFixtureFacts(workDir);
  const systemPrompt = `${base}\n\n${facts}`;

  const usageBefore = { ...usage };
  const agent = new Agent({
    systemPrompt,
    model: { id: 'eval', name: 'eval', provider: 'eval' },
    tools: buildTools(task, workDir),
    streamFn,
    convertToLlm,
    contextWindow: 131072,
  });

  const maxTurns = task.maxTurns ?? DEFAULT_MAX_TURNS;
  let turns = 0;
  agent.subscribe((event) => {
    if (event.type === 'turn_start') {
      turns++;
      if (turns > maxTurns) agent.abort();
    }
  });

  const started = Date.now();
  let error: string | undefined;
  let finalAnswer = '';
  try {
    const messages = await agent.prompt(task.prompt);
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && lastAssistant.role === 'assistant') {
      finalAnswer = lastAssistant.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      if (lastAssistant.stopReason === 'error') error = lastAssistant.errorMessage ?? 'model error';
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = Date.now() - started;

  const checks = await runChecks(task.checks, { workDir, finalAnswer });
  if (!opts?.keepWorkDir) await rm(workDir, { recursive: true, force: true });

  return {
    taskId: task.id,
    family: task.family,
    pass: !error && checks.every((c) => c.pass),
    checks: checks.map((c) => ({ spec: c.spec, pass: c.pass, detail: c.detail })),
    turns,
    wallMs,
    inputTokens: usage.input - usageBefore.input,
    outputTokens: usage.output - usageBefore.output,
    error,
  };
}
```

- [ ] **Step 4: Run the mock test to verify it passes**

Run: `cd editor && bun test tooling/unity-eval/run-task.test.ts`
Expected: PASS (turns = 2, all checks pass). Debug notes if it fails: `write` tool path resolution uses `resolveWithinRoot(path, cwd, allowedRoot)` — relative paths resolve against `workDir`; no `allowedRoot` is passed so the Assets-sandbox is off in eval (fixtures ARE the workspace root).

- [ ] **Step 5: Implement report.ts**

```ts
import type { TaskResult } from './eval-types';

export function renderReport(results: TaskResult[], label: string): string {
  const byFamily = new Map<string, TaskResult[]>();
  for (const r of results) {
    byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), r]);
  }
  const lines: string[] = [];
  const total = results.filter((r) => r.pass).length;
  lines.push(`# Unity eval — ${label}`, '', `**${total}/${results.length} passed**`, '');
  lines.push('| Task | Family | Pass | Turns | Wall (s) | Tokens in/out | Failing checks |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const failing = r.checks.filter((c) => !c.pass).map((c) => c.detail).join('; ') || (r.error ?? '');
    lines.push(
      `| ${r.taskId} | ${r.family} | ${r.pass ? '✅' : '❌'} | ${r.turns} | ${(r.wallMs / 1000).toFixed(1)} | ${r.inputTokens}/${r.outputTokens} | ${failing} |`,
    );
  }
  lines.push('');
  for (const [family, rs] of byFamily) {
    lines.push(`- **${family}**: ${rs.filter((r) => r.pass).length}/${rs.length}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 6: Implement run-eval.ts (CLI)**

```ts
/**
 * CLI: run the eval task set against one model config.
 *
 *   bun tooling/unity-eval/run-eval.ts \
 *     --base-url https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1 \
 *     --api-key-env CF_API_TOKEN --model @cf/moonshotai/kimi-k2.7-code \
 *     --label cf-mid [--filter grounding]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createEvalStreamFn } from './eval-stream';
import { runTask } from './run-task';
import { renderReport } from './report';
import { TASKS } from './tasks';
import type { TaskResult } from './eval-types';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    'api-key-env': { type: 'string' },
    model: { type: 'string' },
    label: { type: 'string' },
    filter: { type: 'string' },
  },
});

const baseUrl = values['base-url'];
const apiKeyEnv = values['api-key-env'];
const model = values.model;
const label = values.label ?? model ?? 'run';
if (!baseUrl || !apiKeyEnv || !model) {
  console.error('Required: --base-url --api-key-env --model. See file header.');
  process.exit(1);
}
const apiKey = process.env[apiKeyEnv];
if (!apiKey) {
  console.error(`Env var ${apiKeyEnv} is not set.`);
  process.exit(1);
}

const tasks = TASKS.filter((t) => !values.filter || t.id.includes(values.filter) || t.family.includes(values.filter));
const usage = { input: 0, output: 0, requests: 0 };
const streamFn = createEvalStreamFn({ baseUrl, apiKey, model, label }, usage);

const results: TaskResult[] = [];
for (const task of tasks) {
  console.error(`▶ ${task.id} …`);
  const r = await runTask(task, streamFn, usage);
  console.error(`  ${r.pass ? '✅' : '❌'} (${r.turns} turns, ${(r.wallMs / 1000).toFixed(1)}s)`);
  results.push(r);
}

const resultsDir = new URL('./results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(resultsDir, `${stamp}-${label}.json`);
await writeFile(outPath, JSON.stringify({ label, model, baseUrl, usage, results }, null, 2));

console.log(renderReport(results, label));
console.error(`\nSaved: ${outPath} — total tokens in/out: ${usage.input}/${usage.output} over ${usage.requests} requests`);
```

Add to `editor/package.json` scripts: `"eval": "bun tooling/unity-eval/run-eval.ts"`. Add `editor/tooling/unity-eval/results/` to `.gitignore` (results are artifacts, commit only curated baselines).

- [ ] **Step 7: Typecheck + full eval-dir tests (TASKS doesn't exist yet — create a placeholder)**

Create `editor/tooling/unity-eval/tasks.ts` containing `export const TASKS: EvalTask[] = [];` with the import — Task 12 fills it. Then:

```bash
cd editor && bun test tooling/unity-eval && bunx tsc --noEmit
```

Expected: PASS/clean. (If root tsc complains about tooling files, add `tooling` to tsconfig `include` or leave tooling out of tsc and rely on bun — note which in the commit.)

- [ ] **Step 8: Commit**

```bash
git add editor && git commit -m "feat(eval): headless runner + reporter driving the real agent loop"
```

---

### Task 12: Eval — seed task set, baseline runs, docs

**Files:**
- Modify: `editor/tooling/unity-eval/tasks.ts`
- Create: `editor/tooling/unity-eval/README.md`
- Modify: `editor/AI-SPEC.md` (fill the two TBD sections)

**Interfaces:**
- Consumes: everything from Tasks 8-11.
- Produces: `TASKS: EvalTask[]` (12 seed tasks: 4 codegen, 4 grounding, 4 agentic); two committed baseline result JSONs.

- [ ] **Step 1: Write the seed tasks**

Replace `editor/tooling/unity-eval/tasks.ts` with:

```ts
import type { EvalTask } from './eval-types';

export const TASKS: EvalTask[] = [
  // ── codegen ──────────────────────────────────────────────────────────
  {
    id: 'codegen-dash-cooldown', family: 'codegen', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'Add a dash ability: create Assets/Scripts/PlayerDash.cs, a MonoBehaviour that dashes the player forward when the dash key is pressed, with a 2 second cooldown. Use this project\'s input system.',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/PlayerDash.cs' },
      { type: 'file_contains', path: 'Assets/Scripts/PlayerDash.cs', pattern: 'cooldown', flags: 'i' },
      { type: 'file_not_contains', path: 'Assets/Scripts/PlayerDash.cs', pattern: 'UnityEngine\\.InputSystem' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/PlayerDash.cs' },
    ],
  },
  {
    id: 'codegen-damage-event', family: 'codegen', fixture: 'urp-newinput', mode: 'agent',
    prompt: 'Extend Assets/Scripts/Health.cs with a TakeDamage(int amount) method that clamps at zero and raises a UnityEvent<int> named onDamaged when damage is applied.',
    checks: [
      { type: 'file_contains', path: 'Assets/Scripts/Health.cs', pattern: 'TakeDamage' },
      { type: 'file_contains', path: 'Assets/Scripts/Health.cs', pattern: 'UnityEvent' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/Health.cs' },
    ],
  },
  {
    id: 'codegen-canvas-fade', family: 'codegen', fixture: 'urp-newinput', mode: 'agent',
    prompt: 'Create Assets/Scripts/UIFader.cs: a MonoBehaviour with a public method FadeOut(float seconds) that fades a CanvasGroup to alpha 0 over the given duration using a coroutine (not async/await).',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/UIFader.cs' },
      { type: 'file_contains', path: 'Assets/Scripts/UIFader.cs', pattern: 'IEnumerator' },
      { type: 'file_not_contains', path: 'Assets/Scripts/UIFader.cs', pattern: 'async\\s+void' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/UIFader.cs' },
    ],
  },
  {
    id: 'codegen-so-config', family: 'codegen', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'Create Assets/Scripts/EnemyConfig.cs: a ScriptableObject holding enemy stats (name, maxHealth, moveSpeed) that designers can create from the Assets menu.',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/EnemyConfig.cs' },
      { type: 'file_contains', path: 'Assets/Scripts/EnemyConfig.cs', pattern: 'ScriptableObject' },
      { type: 'file_contains', path: 'Assets/Scripts/EnemyConfig.cs', pattern: 'CreateAssetMenu' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/EnemyConfig.cs' },
    ],
  },

  // ── grounding (ask mode: version/pipeline-correct answers) ──────────
  {
    id: 'grounding-urp-color', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'How do I change a material\'s main color from a script at runtime in this project?',
    checks: [
      { type: 'answer_matches', pattern: '_BaseColor' },
      { type: 'answer_not_matches', pattern: '"_Color"' },
    ],
  },
  {
    id: 'grounding-builtin-color', family: 'grounding', fixture: 'builtin-legacy', mode: 'ask',
    prompt: 'How do I change a material\'s main color from a script at runtime in this project?',
    checks: [
      { type: 'answer_matches', pattern: '\\.color\\s*=|"_Color"' },
      { type: 'answer_not_matches', pattern: '_BaseColor' },
    ],
  },
  {
    id: 'grounding-input-read', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'Show me the idiomatic way to read WASD movement input in this project.',
    checks: [
      { type: 'answer_matches', pattern: 'InputAction|InputSystem|InputValue' },
      { type: 'answer_not_matches', pattern: 'Input\\.GetAxis' },
    ],
  },
  {
    id: 'grounding-legacy-input', family: 'grounding', fixture: 'builtin-legacy', mode: 'ask',
    prompt: 'Show me the idiomatic way to read WASD movement input in this project.',
    checks: [
      { type: 'answer_matches', pattern: 'Input\\.GetAxis' },
      { type: 'answer_not_matches', pattern: 'UnityEngine\\.InputSystem' },
    ],
  },

  // ── agentic (multi-step, safety-aware) ──────────────────────────────
  {
    id: 'agentic-fsa-rename', family: 'agentic', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'Rename the serialized field `speed` in Assets/Scripts/PlayerController.cs to `moveSpeed` WITHOUT losing the values designers set in the Inspector.',
    checks: [
      { type: 'file_contains', path: 'Assets/Scripts/PlayerController.cs', pattern: 'moveSpeed' },
      { type: 'file_contains', path: 'Assets/Scripts/PlayerController.cs', pattern: 'FormerlySerializedAs\\("speed"\\)' },
      { type: 'file_not_contains', path: 'Assets/Scripts/PlayerController.cs', pattern: '\\bfloat speed\\b' },
    ],
  },
  {
    id: 'agentic-nre-fix', family: 'agentic', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'PlayerController throws "NullReferenceException" in Start() at runtime. Find the root cause and fix it properly (not just a null check that hides the bug).',
    checks: [
      { type: 'file_contains', path: 'Assets/Scripts/PlayerController.cs', pattern: 'GetComponent<Rigidbody>|RequireComponent' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/PlayerController.cs' },
    ],
  },
  {
    id: 'agentic-update-perf', family: 'agentic', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'Assets/Scripts/Mover.cs has a per-frame performance problem. Find and fix it.',
    checks: [
      { type: 'file_not_contains', path: 'Assets/Scripts/Mover.cs', pattern: 'void\\s+(update|Update)\\(\\)[^}]*GetComponent' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/Mover.cs' },
    ],
  },
  {
    id: 'agentic-lifecycle-typo', family: 'agentic', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'The Mover script\'s movement code never runs in play mode. Investigate why and fix it.',
    checks: [
      { type: 'file_contains', path: 'Assets/Scripts/Mover.cs', pattern: 'void Update\\(\\)' },
      { type: 'file_not_contains', path: 'Assets/Scripts/Mover.cs', pattern: 'void update\\(\\)' },
    ],
  },
];
```

Note `agentic-update-perf` overlaps `agentic-lifecycle-typo` on Mover.cs — each task runs in its own fixture copy, so no interference.

- [ ] **Step 2: Full test suite + mock run**

```bash
cd editor && bun test tooling/unity-eval && bun test src
```

Expected: all PASS.

- [ ] **Step 3: Baseline run #1 — the mid tier (default until this plan ships)**

Baselines run against the SAME models the server serves, via Cloudflare's OpenAI-compatible REST endpoint (`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`). You need the Cloudflare account id (visible in `wrangler whoami` or the dashboard) and an API token with Workers AI read permission (`wrangler` login token works, or create one scoped to Workers AI). Ask the user for both; export as `CF_ACCOUNT_ID` and `CF_API_TOKEN`.

```bash
cd editor && CF_API_TOKEN=<token> bun run eval -- --base-url https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1 --api-key-env CF_API_TOKEN --model @cf/moonshotai/kimi-k2.7-code --label cf-mid-kimi-k2.7
```

Expected: a results JSON + markdown table; some tasks will fail — that's the point (it's a baseline, record it, don't fix tasks to pass). If the OpenAI-compat endpoint rejects a model id or tool calls, note it in the README and fall back to running that model through a temporary `/v1/chat/completions` call against a locally-run `wrangler dev` arcane-server with a dev JWT.

- [ ] **Step 4: Baseline run #2 — the high tier (the new default effort)**

```bash
cd editor && CF_API_TOKEN=<token> bun run eval -- --base-url https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1 --api-key-env CF_API_TOKEN --model @cf/zai-org/glm-5.2 --label cf-high-glm-5.2
```

Copy both result JSONs into `editor/tooling/unity-eval/results/baselines/` (this subdir IS committed) and note the pass rates in the README. This pair also directly answers "is defaulting to high worth it" with numbers.

- [ ] **Step 5: Write README.md**

Create `editor/tooling/unity-eval/README.md` covering: what the eval is (regression gate for prompt/model/fine-tune changes, per the 2026-07-07 design spec), how to run it (the CLI line), how to add a task (EvalTask shape + check types), the two fixtures and what's deliberately seeded in them, baseline results table (filled from Steps 3-4), and the rule: **every prompt/model/routing change must include a before/after eval run in its PR description.**

- [ ] **Step 6: Update AI-SPEC.md**

In `editor/AI-SPEC.md`, replace the `## Recommended Approach` TBD paragraph with:

```markdown
## Recommended Approach

Superseded by the approved design + plan (2026-07-07):
- Design: `../docs/superpowers/specs/2026-07-07-unity-ai-differentiation-design.md`
- Plan (Phases 0-1): `../docs/superpowers/plans/2026-07-07-ai-quick-wins-and-eval.md`

Constraint answers (2026-07-06): privacy = open to any provider; deployment = hosted, Arcane pays (CF failover retained); priority = verified agentic edits, then grounded Q&A, then completion; retrieval = graphify + unity_api_search (no new embeddings infra).
Note: several "Gaps" above are now closed in code — compaction exists (`vendor/compaction.ts`), the verification loop exists (analyzer + compile gates feed diagnostics back), and `unity_api_search` provides version-accurate grounding. See the design doc §2 for the verified current state.
```

Replace the `## Verification` TBD paragraph with:

```markdown
## Verification

The internal Unity eval lives at `tooling/unity-eval/` (12 seed tasks across codegen / grounding / agentic families, scored by unity-analyzers + file/answer checks against fixture projects). Run: `bun run eval -- --base-url <url> --api-key-env <VAR> --model <id> --label <name>`. Baselines are committed under `tooling/unity-eval/results/baselines/`. Every prompt/model/routing change ships with a before/after run.
```

- [ ] **Step 7: Commit**

```bash
git add editor/tooling/unity-eval editor/AI-SPEC.md && git commit -m "feat(eval): seed 12-task Unity eval set, baselines, docs; close AI-SPEC TBDs"
```

---

## Self-review notes

- **Spec coverage:** Phase 0 — prompt rewrite (T5), output ceilings (T4), per-tier compaction windows (T3), default effort (T3), graph budget (T4), telemetry (T2/T6). External model routing + prompt-caching breakpoints were dropped by user decision (models frozen); the client prompt keeps stable→volatile ordering so caching can be added later without rework. Phase 1 — eval types/fixtures (T8), runner on the real loop (T9/T11), three check families incl. analyzers (T10), seed tasks + baselines + README (T12). Unity `-batchmode` compile checks are deferred to a follow-up task once a Unity install is available on the eval machine — the spec lists batchmode as part of the codegen pass criteria; analyzer_clean stands in until then (recorded in the eval README).
- **Type consistency:** `chooseModelSpec`/`ModelSpec` (T1) used in T1 only; `TIER_CONTEXT_WINDOWS` + `setContextWindow` (T3) consumed in T3's agent-service edit; `EvalTask`/`TaskResult`/`CheckSpec` (T8) consumed by T10/T11/T12; `UsageTotals`/`createEvalStreamFn` (T9) consumed by T11; `convertToOpenAI` (T7) consumed by T9. `buildSystemPrompt` reshape (T4) touches agent-service + any plan-controller call sites — flagged in T4 Step 3.
- **Known judgment calls:** baselines use Cloudflare's OpenAI-compatible REST endpoint so the eval measures the exact frozen lineup; `Finding` field names in T10 flagged for verification; eval runs without the Assets/ sandbox (fixture root = workspace root) by design.
