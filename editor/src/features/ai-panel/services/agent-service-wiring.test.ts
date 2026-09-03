import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// `agent-service.ts` can't be imported here to exercise `createToolsForPromptMode`
// or `AgentService` directly: it statically imports `stores/workspace.ts`
// (for `assetsRootPath`/`getCurrentWorkspacePath`), which transitively pulls
// in `stores/theme.ts` → `features/theme/apply.ts`, which touches `document`
// at module-eval time — fatal under plain `bun test` (no DOM), the same
// constraint `hosted-stream.test.ts`'s header documents for `stores/ai` and
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
      /if \(mode === 'preplanning'\) \{\s*return \[([\s\S]*?)\]\.map\(\(t\) => withRepeatCallGuard\(t, workspacePath\)\);\s*\}/,
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

describe('agent-service.ts — turn governor wiring (Task 3)', () => {
  it('wires withTurnGovernor with a per-call config closure, not a one-shot config object', () => {
    expect(SRC).toContain('withTurnGovernor(hostedStream, () => ({');
  });

  it('reads the per-tier cap table from server-config on every call', () => {
    expect(SRC).toContain('caps: turnCapsFromConfig(useServerConfigStore.getState().config),');
  });

  it('reports live progress onto the ai store for the working-row count', () => {
    expect(SRC).toContain(
      'onProgress: (used, cap) => useAiStore.getState().setModelCallBudget({ used, cap }),',
    );
  });

  it('pushes the soft-limit and cap-reached notices as system messages', () => {
    expect(SRC).toContain(
      "onSoftLimit: (_effort, used, cap) => useAiStore.getState().addSystemMessage(softLimitNotice(used, cap)),",
    );
    expect(SRC).toContain(
      "onCapReached: (_effort, cap) => useAiStore.getState().addSystemMessage(capReachedNotice(cap)),",
    );
  });

  it('exposes wasLastSendCapped() beside wasLastSendAborted()', () => {
    expect(SRC).toMatch(/wasLastSendCapped\(\): boolean \{\s*return wasCapReachedThisSend\(\);\s*\}/);
  });

  it('imports turnCapsFromConfig alongside the existing server-config accessors', () => {
    expect(SRC).toContain('turnCapsFromConfig,');
  });

  it('imports the notice helpers and wasCapReachedThisSend from turn-governor.ts', () => {
    expect(SRC).toContain('wasCapReachedThisSend,');
    expect(SRC).toContain('softLimitNotice,');
    expect(SRC).toContain('capReachedNotice,');
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

// The three Unity subsystems whose failures never reach a compiler. The read
// tools have to be in EVERY mode (the model needs them to answer a question as
// much as to write code), and the mutate tools only in the modes that write —
// with the same checkpoint and approval treatment every other file write gets,
// because "restore this turn" silently stops covering whatever is left out.
describe('agent-service.ts — Unity subsystem tools', () => {
  it('registers the read tools through the shared barrel, so every mode gets them', () => {
    // `createUnityReadTools` is spread into ask / plan-planning / preplanning
    // and the agent path alike; the barrel decides the contents.
    expect(SRC).toContain('const unityRead: AgentTool[] = isUnity ? createUnityReadTools(workspacePath) : [];');
    const barrel = readFileSync(
      path.resolve(import.meta.dir, './unity-tools/index.ts'),
      'utf8',
    );
    for (const factory of [
      'createUnityInputActionsTool(workspacePath)',
      'createUnityScriptableObjectsTool(workspacePath)',
      'createUnityUiToolkitTool(workspacePath)',
    ]) {
      expect(barrel).toContain(factory);
    }
  });

  it('keeps the asset-mutate tools out of the read-only modes', () => {
    // They appear exactly once, in the final (agent / plan-execution) return.
    const occurrences = SRC.split('createUnityAssetMutateTools(').length - 1;
    expect(occurrences).toBe(1);
    const ask = SRC.indexOf("if (mode === 'ask')");
    expect(SRC.indexOf('createUnityAssetMutateTools(')).toBeGreaterThan(ask);
  });

  it('gives the asset-mutate tools a checkpoint and the write-approval policy', () => {
    // Both gates key off a top-level `path`, which is why all three tools
    // declare one — see the barrel's comment on `createUnityAssetMutateTools`.
    expect(SRC).toMatch(
      /createUnityAssetMutateTools\(workspacePath, \{[\s\S]*?\}\)\.map\(\(t\) =>[\s\S]*?withWriteApproval\(withCheckpoint\(t, workspacePath/,
    );
  });

  it('registers their writes with the verified pass and the buffer reload', () => {
    // bash already bypasses both and is documented as doing so; a second
    // silent bypass is exactly what this wiring exists to prevent.
    expect(SRC).toMatch(/onWrite: \(path\) => \{[\s\S]*?recordTouchedFile\(abs\);[\s\S]*?onFileWritten\(abs\);/);
  });

  it('gates them on the project being a Unity one, like every other Unity tool', () => {
    expect(SRC).toContain('...(isUnity\n      ? createUnityAssetMutateTools(workspacePath, {');
  });
});
