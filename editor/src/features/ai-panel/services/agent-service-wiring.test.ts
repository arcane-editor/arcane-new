import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// `agent-service.ts` can't be imported here to exercise `createToolsForPromptMode`
// or `AgentService` directly: it statically imports `stores/workspace.ts`
// (for `assetsRootPath`/`getCurrentWorkspacePath`), which transitively pulls
// in `stores/theme.ts` → `features/theme/apply.ts`, which touches `document`
// at module-eval time — fatal under plain `bun test` (no DOM), the same
// constraint `arcane-stream.test.ts`'s header documents for `stores/ai` and
// `session-persistence.test.ts`'s header documents for the ai-panel barrel.
// A source-text assertion sidesteps this entirely (same technique
// `session-persistence.test.ts`'s `AI_STORE_SRC` uses) and is exactly as
// precise: it fails the instant the wiring described below changes. The
// actual DECISION logic these wiring points delegate to
// (`includesTodoTool`/`nudgeEligible` in `todo-gates.ts`) is fully exercised
// directly in `todo-gates.test.ts`; this file only pins that agent-service.ts
// calls into it correctly, and that the deleted auto-plan.ts feature left no
// dangling references.
const SRC = readFileSync(path.resolve(import.meta.dir, './agent-service.ts'), 'utf8');

describe('agent-service.ts — createToolsForPromptMode wiring (Task 11)', () => {
  it('takes an `effort` parameter', () => {
    expect(SRC).toMatch(
      /function createToolsForPromptMode\(mode: PromptMode, workspacePath: string, effort: Effort\)/,
    );
  });

  it("has its own early-return branch for 'preplanning' (read-only + ask_user + todo, no write/edit/bash)", () => {
    const match = SRC.match(
      /if \(mode === 'preplanning'\) \{\s*return \[([\s\S]*?)\]\.map\(withRepeatCallGuard\);\s*\}/,
    );
    expect(match).not.toBeNull();
    const branch = match![1];
    expect(branch).toContain('...readOnly');
    expect(branch).toContain('...graphTools');
    expect(branch).toContain('...memoryTools');
    expect(branch).toContain('...unityRead');
    expect(branch).toContain('createAskUserTool()');
    expect(branch).toContain('createTodoTool()');
    // Structurally excluded — these constructors are never named in this
    // branch's return statement, so they cannot appear in the built array.
    expect(branch).not.toContain('createWriteTool');
    expect(branch).not.toContain('createEditTool');
    expect(branch).not.toContain('createBashTool');
  });

  it("the 'preplanning' branch precedes the mutating (agent/plan-execution) toolset, so it never falls through to it", () => {
    const preplanIdx = SRC.indexOf("if (mode === 'preplanning')");
    const writeToolIdx = SRC.indexOf('const writeTool: AgentTool');
    expect(preplanIdx).toBeGreaterThan(-1);
    expect(writeToolIdx).toBeGreaterThan(-1);
    expect(preplanIdx).toBeLessThan(writeToolIdx);
  });

  it('gates `createTodoTool()` in the mutating toolset behind `includesTodoTool(mode, effort)`, not unconditionally', () => {
    expect(SRC).toContain('...(includesTodoTool(mode, effort) ? [createTodoTool()] : []),');
  });

  it('constructs the class instance and re-syncs tools with an explicit effort (never the old 2-arg call)', () => {
    expect(SRC).toContain("createToolsForPromptMode('agent', workspacePath, 'mid')");
    expect(SRC).toContain('createToolsForPromptMode(promptMode, workspacePath, effort)');
    expect(SRC).not.toMatch(/createToolsForPromptMode\(mode, workspacePath\)\)/);
  });
});

describe('agent-service.ts — TODO_NUDGE_TEXT gating (Task 11)', () => {
  it("gates the retrospective nudge to nudgeEligible(effectiveEffort), for agent/plan-execution only", () => {
    expect(SRC).toContain(
      "if ((promptMode === 'agent' || promptMode === 'plan-execution') && nudgeEligible(effectiveEffort)) {",
    );
  });

  it('imports the gate from todo-gates.ts', () => {
    expect(SRC).toContain("import { includesTodoTool, nudgeEligible } from './todo-gates';");
  });
});

describe('agent-service.ts — wasLastSendAborted (Task 11)', () => {
  it('exposes wasLastSendAborted() returning the persisted abortRequested flag', () => {
    expect(SRC).toMatch(/wasLastSendAborted\(\): boolean \{\s*return this\.abortRequested;\s*\}/);
  });

  it('abortRequested is reset at the top of every sendMessage (survives until the NEXT send starts)', () => {
    expect(SRC).toContain('this.abortRequested = false;');
  });

  it('abortRequested is only otherwise set by abort()', () => {
    const setSites = SRC.match(/this\.abortRequested = (true|false);/g) ?? [];
    // Exactly two assignment sites: the per-send reset (false, in sendMessage)
    // and the user-initiated abort (true, in abort()).
    expect(setSites).toHaveLength(2);
    expect(setSites).toContain('this.abortRequested = false;');
    expect(setSites).toContain('this.abortRequested = true;');
  });
});

describe('agent-service.ts — auto-plan.ts fully removed (Task 11)', () => {
  it('has no references to the deleted auto-plan module or its exports', () => {
    expect(SRC).not.toMatch(/from '\.\/auto-plan'/);
    expect(SRC).not.toContain('assessTaskSize(');
    expect(SRC).not.toContain('TODO_FIRST_TEXT');
    expect(SRC).not.toContain("ai.autoPlan.enabled");
  });
});
