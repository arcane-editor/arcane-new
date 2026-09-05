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
    // Twice: once in the design branch (filtered down to unity_ui_write) and
    // once in the final agent / plan-execution return. Both sit after every
    // read-only early return, which is what this actually pins.
    const occurrences = SRC.split('createUnityAssetMutateTools(').length - 1;
    expect(occurrences).toBe(2);
    const lastReadOnly = Math.max(
      SRC.indexOf("if (mode === 'ask')"),
      SRC.indexOf("if (mode === 'plan-planning')"),
      SRC.indexOf("if (mode === 'preplanning')"),
    );
    expect(SRC.indexOf('createUnityAssetMutateTools(')).toBeGreaterThan(lastReadOnly);
  });

  it('gives design mode only the UI writer out of the asset-mutate set', () => {
    // The other three mutate subsystems the design dock never shows you.
    expect(SRC).toContain(".filter((t) => t.name === 'unity_ui_write')");
  });

  it('scopes design-mode writes to the session document, outside every other gate', () => {
    // Outside, so a refusal costs no approval prompt and no checkpoint —
    // the same placement, and the same reason, as guardRealPath.
    expect(SRC).toMatch(/withDesignScope\(\s*guardRealPath\(/);
  });

  it('leaves bash out of design mode', () => {
    // bash bypasses the checkpoint, the approval gate and every asset check.
    const design = SRC.slice(SRC.indexOf("if (mode === 'ui-design')"));
    const branch = design.slice(0, design.indexOf('withRepeatCallGuard'));
    expect(branch).not.toContain('createBashTool');
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

// Task 14 — `unity_ui_write`'s per-send GUID-check registry
// (`unity-tools/guid-verify.ts`) mirrors `test-run-registry.ts`'s: nothing
// else clears it, so a send that never explicitly resets it would leak the
// previous send's pending checks into Task 15's verifier.
describe('agent-service.ts — unity_ui_write wiring (Task 14)', () => {
  it('imports resetPendingGuidChecks from the unity-tools barrel', () => {
    expect(SRC).toContain('resetPendingGuidChecks,');
    expect(SRC).toContain("} from './unity-tools';");
  });

  // M12: the working row's model-call count is per-submit, and nothing cleared
  // it — so a new send opened showing the previous one's total.
  it('clears the working row\'s model-call count at send start, next to resetTurnGovernor()', () => {
    expect(SRC).toContain(
      'resetTurnGovernor();\n    // The working row\'s "N model calls" count belongs to the CURRENT submit.',
    );
    expect(SRC).toContain('useAiStore.getState().setModelCallBudget(null);');
  });

  it('resets the pending-guid-check registry every send, next to resetTestRunRegistry()', () => {
    expect(SRC).toContain('resetTestRunRegistry();\n    resetPendingGuidChecks();');
  });

  it('registers unity_ui_write in createUnityAssetMutateTools, alongside the other asset-mutate tools', () => {
    const barrel = readFileSync(
      path.resolve(import.meta.dir, './unity-tools/index.ts'),
      'utf8',
    );
    expect(barrel).toContain(
      'createUnityUiWriteTool(workspacePath, { ...defaultUiWriteDeps, onWrite })',
    );
    // Same array `createUnityAssetMutateTools` returns, so it inherits the
    // checkpoint/write-approval wrapping this file applies to every entry —
    // no separate wiring block for it.
    const fnStart = barrel.indexOf('export function createUnityAssetMutateTools(');
    const fnBody = barrel.slice(fnStart, barrel.indexOf('\n}', fnStart));
    expect(fnBody).toContain('createUnityAssetEditTool(');
    expect(fnBody).toContain('createUnityUiWriteTool(');
  });
});

describe('agent-service.ts — abort wins in detectTurnOutcome (Task 4)', () => {
  it('calls addStoppedMarker({ promptMode }) from the aborted outcome branch', () => {
    expect(SRC).toContain(
      "} else if (outcome.type === 'aborted') {\n      useAiStore.getState().addStoppedMarker({ promptMode });\n    }",
    );
  });

  it('no longer wraps the outcome check in an `if (!this.abortRequested)` guard', () => {
    // T4: detectTurnOutcome's own rule 0 is the single source of truth for
    // an abort now, so runSend must call it unconditionally rather than
    // skipping the whole outcome inspection for a user-aborted send.
    expect(SRC).not.toContain('if (!this.abortRequested) {\n      const outcome = detectTurnOutcome(');
    expect(SRC).toContain('const outcome = detectTurnOutcome(this.agent.getMessages().slice(before), this.abortRequested);');
  });

  it('rebuilds resumed history through the pairing restorer, not inline', () => {
    // `restoreAgentMessages` moved to `restore-history.ts` so its rules could be
    // tested for real rather than grepped for — an unpaired tool call in a
    // resumed transcript is rejected by the provider on every attempt, and the
    // retry loop turns that into a hang ending in a bare "Server error". What
    // it actually does now lives in `restore-history.test.ts`, including that a
    // `stopped` marker never reaches the model.
    expect(SRC).toContain("import { restoreAgentMessages } from './restore-history';");
    expect(SRC).toContain('this.agent.setMessages(restoreAgentMessages(messages));');
    expect(SRC).not.toContain('function restoreAgentMessages');
  });
});

// Task 13 — the post-turn console check. Three wiring facts carry the whole
// feature: the baseline is captured at SEND START (a baseline taken after the
// turn would find nothing), the closing branch runs the merged check rather
// than the bare verified pass, and the repair is bounded to one pass.
describe('agent-service.ts — post-turn console check (Task 13)', () => {
  const CONSOLE_CHECK_SRC = readFileSync(
    path.resolve(import.meta.dir, './console-check.ts'),
    'utf8',
  );
  const IO_SRC = readFileSync(path.resolve(import.meta.dir, './console-check-io.ts'), 'utf8');

  it('captures the console baseline at send start, immediately after beginVerifiedPass()', () => {
    const beginVerified = SRC.indexOf('beginVerifiedPass();');
    const beginConsole = SRC.indexOf('beginConsoleCheck(consoleBaselineNow());');
    expect(beginVerified).toBeGreaterThan(-1);
    expect(beginConsole).toBeGreaterThan(beginVerified);
    // Nothing between them but the comment explaining why the baseline is richer.
    const between = SRC.slice(beginVerified + 'beginVerifiedPass();'.length, beginConsole);
    expect(between.replace(/\s|\/\/[^\n]*/g, '')).toBe('');
  });

  it('keeps markConsoleTurnStart — the get_console_errors tool still uses that baseline', () => {
    expect(SRC).toContain('markConsoleTurnStart(useUnityStore.getState().logSeq);');
  });

  it('keeps the store/RPC boundary out of agent-service.ts entirely', () => {
    // `console-check.ts` is pure; `console-check-io.ts` is the one place the
    // check reads a store, calls the bridge, or touches the filesystem.
    expect(SRC).toContain("from './console-check-io';");
    expect(SRC).not.toContain('bridgeRpc');
    expect(SRC).not.toContain('getConsoleSnapshot');
  });

  it('builds the baseline from the store: seq, compile identity, liveness and the Unity row high-water mark', () => {
    expect(IO_SRC).toMatch(
      /export function consoleBaselineNow\(\): ConsoleCheckBaseline \{[\s\S]*?seq: unity\.logSeq,[\s\S]*?compileIdentity: unity\.lastCompilation\?\.receivedAt \?\? null,[\s\S]*?editorAwake: unity\.editorAwake,[\s\S]*?maxUnityRow: maxUnityRow\(unity\.logs\),/,
    );
  });

  it('runs runClosingChecks in the non-ask branch, replacing the bare verified pass', () => {
    expect(SRC).toContain('await this.runClosingChecks(promptMode);');
    expect(SRC).not.toContain('runVerifiedPassIfNeeded');
  });

  it('still runs the grounding linter, not the closing checks, for ask mode', () => {
    expect(SRC).toContain(
      "if (opts.mode === 'ask') {\n        await this.runGroundingLint();\n      } else {",
    );
  });

  it('runs the closing checks when a test ran even if no file was written', () => {
    expect(SRC).toContain('const recordedRuns = takeRecordedTestRuns();');
    expect(SRC).toContain(
      'if (touchedFileCount() === 0 && recordedRuns.length === 0 && runAttempts.length === 0) return;',
    );
  });

  // R11: an unfinished run used to leave the whole card unrendered.
  it('drains the unfinished attempts separately and runs the checks for them too', () => {
    expect(SRC).toContain('const runAttempts = takeRecordedTestRunAttempts();');
    expect(SRC).toContain('takeRecordedTestRunAttempts,');
  });

  it('never feeds an attempt to collectNewProblems as a run — it only reaches testsResult', () => {
    // `latestRun(...)` is the only thing handed to the problem collector; the
    // attempts go to the row copy, which says the run did not finish.
    expect(SRC).toContain('testsResult(latestRun(recordedRuns), runAttempts)');
    expect(SRC).not.toContain('latestRun(runAttempts)');
  });

  it('bounds the repair at exactly one pass', () => {
    expect(CONSOLE_CHECK_SRC).toContain('export const MAX_CONSOLE_REPAIRS = 1;');
    expect(CONSOLE_CHECK_SRC).toMatch(
      /if \(attempts >= MAX_CONSOLE_REPAIRS\) return false;/,
    );
    expect(SRC).toContain('recordConsoleRepairAttempt();');
    expect(SRC).toContain('shouldRepair(before, consoleRepairAttempts(), {');
  });

  it('grants the repair pass its own call budget, like the grounding linter does', () => {
    expect(SRC).toContain('grantExtraCalls(CONSOLE_REPAIR_CALL_GRANT);');
  });

  // Global Constraint 8: repairCount latches the whole conversation onto a
  // costlier tier. The console check must never touch it.
  it('reports the repair on its own telemetry field, never repairCount', () => {
    const method = SRC.match(/private async runConsoleCheck\([\s\S]*?\n  \}\n/);
    expect(method).not.toBeNull();
    // Comments stripped: the code, not the prose explaining it, is what runs.
    const body = method![0].replace(/\/\/[^\n]*/g, '');
    expect(body).toContain('recordConsoleRepair();');
    // Nothing in the repair branch may read or write the escalation counter.
    expect(body).not.toMatch(/repairCount/i);
  });

  it('emits exactly ONE card — the pre-repair pass is never shown on its own', () => {
    const emits = SRC.match(/addVerifiedPassMessage\(/g) ?? [];
    // The setting-off / no-baseline early return, and the merged result.
    expect(emits).toHaveLength(2);
    expect(SRC).toContain('useAiStore.getState().addVerifiedPassMessage(merged);');
  });

  it('gates the whole check on unity.consoleCheck.enabled and the repair on autoRepair', () => {
    expect(SRC).toContain(
      "useSettingsStore.getState().getSetting('unity.consoleCheck.enabled') !== false;",
    );
    expect(SRC).toContain(
      "useSettingsStore.getState().getSetting('unity.consoleCheck.autoRepair') !== false,",
    );
  });

  it('treats a failed console snapshot as unavailable, never as an error of the check', () => {
    expect(IO_SRC).toMatch(/\} catch \{\s*snapshotStatus = 'unavailable';\s*\}/);
  });

  // F2. A Stop mid-tool leaves a 'toolUse'/'error' tail, so `prompt()` resolves
  // rather than throwing — without this guard a cancelled send triggered a live
  // recompile and the card claimed a repaired outcome.
  it('re-checks the abort flag after the repair prompt, before the second verified pass', () => {
    const method = SRC.match(/private async runConsoleCheck\([\s\S]*?\n  \}\n/)![0];
    const promptIdx = method.indexOf('buildConsoleRepairPrompt({');
    const abortIdx = method.indexOf('if (this.abortRequested) {');
    const secondPassIdx = method.indexOf('secondPass = await runVerifiedPass(workspacePath);');
    expect(abortIdx).toBeGreaterThan(promptIdx);
    expect(secondPassIdx).toBeGreaterThan(abortIdx);
    expect(method).toContain(
      "return unrepaired({ attempted: true, trigger: trigger ?? 'console', interrupted: true });",
    );
  });

  // F1. `after` carries the post-repair degradation; without it an empty
  // second read ("we could not look") rendered as a successful repair.
  it('judges the repair against the post-repair read, and only calls a compile clean when it IS clean', () => {
    expect(SRC).toContain('console: consoleResult(before, outcome, after),');
    expect(SRC).toContain("secondCompileClean: secondPass.compile === 'clean',");
  });

  it('reports the problems honestly when the repair turn itself fails', () => {
    // `repaired: true` with a zero outcome renders a green tick beside "2 new
    // errors". A failed repair must fall back to the un-repaired result.
    expect(SRC).toMatch(
      /\} catch \{[\s\S]*?return \{\s*\.\.\.firstPass,\s*console: consoleResult\(before, null\),/,
    );
  });

  it('never compares a snapshot row against the ring seq — its index goes in unityRow', () => {
    // Unity's row index is a different numbering; conflating the two is what
    // sent `sinceTurnStart` filtering into the wrong space once already. And
    // only a `logEntries` answer HAS a row index — see console-check-io.test.ts
    // for the hookRing half (I3).
    expect(IO_SRC).toMatch(
      /snapshot = snap\.entries\.map\(\(row\) => \(\{[\s\S]*?seq: null,\s*unityRow: snap\.source === 'logEntries' \? row\.seq : null,/,
    );
  });

  it('de-duplicates the repair prompt\'s code regions, unlike the byte-pinned fix prompt', () => {
    expect(SRC).toContain('buildRegions(repairPromptFrames(before), tauriRegionDeps(), {');
    expect(SRC).toContain('dedupe: true,');
  });
});


// The three wirings that make a design turn see the screen it is changing.
// All source-greps, for the reason this file exists: `agent-service.ts` pulls
// Monaco and the stores, so it cannot be imported under Bun.
describe('agent-service.ts — design-mode context and closing checks', () => {
  it('prefixes every design send with the screen brief', () => {
    // On the message tail, not the system prompt: that decoration is frozen per
    // conversation so the provider's prefix cache holds, and a brief that
    // changes with the document would re-bill the whole conversation each turn.
    expect(SRC).toContain("import { buildDesignBrief } from './design-brief';");
    expect(SRC).toMatch(/promptMode === 'ui-design' && opts\.uiDesign/);
    expect(SRC).toMatch(/const brief = await buildDesignBrief\(/);
  });

  it('runs the closing checks for a design turn', () => {
    // It was the one kind of turn that could finish with no closing check at
    // all — it could write an unstyled screen, say it was done, and nothing
    // anywhere disagreed.
    expect(SRC).toContain("const isDesign = promptMode === 'ui-design';");
    expect(SRC).toMatch(/promptMode !== 'agent' && promptMode !== 'plan-execution' && !isDesign/);
  });

  it('does not trigger a Unity recompile for a turn that touched no C#', () => {
    // `computeCompile` waits on a real recompile rather than reading a cached
    // verdict, and a `.uxml`/`.uss` turn cannot have introduced a compile error.
    expect(SRC).toMatch(/runVerifiedPass\(workspacePath, undefined, \{ skipCompile: isDesign \}\)/);
  });

  it('drops the cached C# usage map when a script is written or edited', () => {
    // The brief reads that map fresh every send. Without invalidation, an agent
    // that renames a handler in one turn is shown the pre-rename map in the
    // next — by the index whose whole purpose is catching renames.
    expect(SRC).toContain('function dropUsageIndexIfCs(path: string): void');
    expect(SRC).toContain('m.invalidateUsageIndex()');
    expect(SRC.match(/dropUsageIndexIfCs\(path\);/g)?.length).toBe(2);
  });
});
