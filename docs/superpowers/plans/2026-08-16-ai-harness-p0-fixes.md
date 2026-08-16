# AI Harness P0–P2 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 15 top-ranked findings from the 2026-08-16 AI-harness edge-case review (silent file destruction, missing sandbox, Stop semantics, crash containment, billing metering holes).

**Architecture:** Point fixes along the existing tool-decorator / agent-loop / SSE-stream / D1-billing seams. Pure logic is extracted into Bun-testable modules where the host module can't load under Bun (the established lsp-gate/checkpoint-gate DI pattern). No new subsystems.

**Tech Stack:** TypeScript (editor: React 19 + Zustand + bun test; server: Hono on workerd + vitest `cloudflare:test`).

**Spec:** `~/.claude/projects/-Users-inno-Documents-experiments-arcane-editor/memory/ai-harness-edge-case-review-2026-08-16.md` (the verified findings list). Each task names its finding.

## Global Constraints

- Branch: `fix/ai-harness-p0` off `dev`. One commit per task, message style `fix(ai): …`.
- Editor tests: `bun test src` (repo `editor/`). Full gate before claiming done: `bun run verify` (tsc + module-boundary + JS + Rust + intellisense; a SKIPPED intellisense check is NOT a pass).
- Server tests: `cd arcane-server && bun run test` (vitest, workerd pool).
- Deep-modules rule: cross-feature imports only via feature barrels (`features/<x>/index.ts`).
- Bun-testability: services with tests must not (transitively) import `stores/workspace.ts` / feature barrels at module scope (the `stores/theme.ts` `document` crash chain). Type-only imports are safe.
- Deferred by explicit decision (report, do not implement): credit **reservation ledger** for concurrent sends (architectural, billing not yet cut over to prod — owner call); single-request overshoot itself is test-pinned as intended.

---

### Task 1: edit-diff fuzzy-match index mapping (finding 1 — silent EOF deletion)

**Files:**
- Modify: `editor/src/features/ai-panel/services/vendor/tools/edit-diff.ts`
- Test (new): `editor/src/features/ai-panel/services/vendor/tools/edit-diff.test.ts`

**Interfaces:** `fuzzyFindText` / `applyEdits` signatures unchanged. `mapNormalizedIndexToOriginal` is deleted.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'bun:test';
import { fuzzyFindText, applyEdits } from './edit-diff';

describe('fuzzy whitespace matching', () => {
  it('tab-indented file + space-indented oldText edits only the target (regression: deleted rest of file)', () => {
    const content =
      'class A\n{\n\tvoid M1()\n\t{\n\t\tint x = 1;\n\t}\n\n\tvoid M2()\n\t{\n\t\tint y = 2;\n\t}\n}\n';
    const res = applyEdits(content, [
      {
        oldText: '    void M1()\n    {\n        int x = 1;\n    }',
        newText: '\tvoid M1()\n\t{\n\t\tint x = 2;\n\t}',
      },
    ]);
    expect(res.applied).toBe(true);
    expect(res.content).toContain('int x = 2;');
    expect(res.content).toContain('void M2()'); // the rest of the file survives
    expect(res.content).toContain('int y = 2;');
    expect(res.content.endsWith('}\n')).toBe(true);
  });

  it('maps the matched span over collapsed whitespace runs', () => {
    const m = fuzzyFindText('a\t\tb cd', 'a  b');
    expect(m.found).toBe(true);
    expect(m.startIndex).toBe(0);
    expect(m.endIndex).toBe(4); // "a\t\tb"
    expect(m.matchedText).toBe('a\t\tb');
  });

  it('maps CRLF content against LF oldText', () => {
    const m = fuzzyFindText('foo\r\nbar\r\nbaz', 'bar\nbaz');
    expect(m.matchedText).toBe('bar\r\nbaz');
  });

  it('fuzzy match at end of content does not run past EOF', () => {
    const m = fuzzyFindText('x\n\tend', '    end');
    expect(m.matchedText).toBe('\tend');
    expect(m.endIndex).toBe(6);
  });

  it('exact match still wins untouched', () => {
    const m = fuzzyFindText('alpha beta', 'beta');
    expect(m.startIndex).toBe(6);
  });

  it('no match reports applied:false', () => {
    expect(applyEdits('abc', [{ oldText: 'zzz', newText: 'y' }]).applied).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `bun test src/features/ai-panel/services/vendor/tools/edit-diff.test.ts` — expect the first four to FAIL (EOF-mapping bug).

- [ ] **Step 3: Implement.** Replace `mapNormalizedIndexToOriginal` with a span-mapped normalizer; rewrite the normalized branch of `fuzzyFindText`:

```ts
/**
 * Normalize whitespace while keeping, for every normalized char, the [start,
 * end) span of the original text it derives from. The old index mapper only
 * advanced past chars that compared EQUAL, so any tab-vs-space difference
 * (Unity's tab-indented templates vs model-emitted spaces) walked the end
 * index to EOF and the edit silently deleted the rest of the file.
 */
function normalizeWithMap(original: string): {
  normalized: string;
  starts: number[];
  ends: number[];
} {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < original.length) {
    const ch = original[i];
    if (ch === ' ' || ch === '\t') {
      let j = i + 1;
      while (j < original.length && (original[j] === ' ' || original[j] === '\t')) j++;
      chars.push(' ');
      starts.push(i);
      ends.push(j);
      i = j;
    } else if (ch === '\r' && original[i + 1] === '\n') {
      chars.push('\n');
      starts.push(i);
      ends.push(i + 2);
      i += 2;
    } else {
      chars.push(ch);
      starts.push(i);
      ends.push(i + 1);
      i += 1;
    }
  }
  return { normalized: chars.join(''), starts, ends };
}
```

In `fuzzyFindText`, replace the normalized-match block with:

```ts
  const norm = normalizeWithMap(content);
  const normalizedOld = normalizeWhitespace(oldText);
  const normalizedIndex =
    normalizedOld.length > 0 ? norm.normalized.indexOf(normalizedOld) : -1;

  if (normalizedIndex !== -1) {
    const startIndex = norm.starts[normalizedIndex];
    const endIndex = norm.ends[normalizedIndex + normalizedOld.length - 1];
    return { found: true, startIndex, endIndex, matchedText: content.slice(startIndex, endIndex) };
  }
```

Delete `mapNormalizedIndexToOriginal`. `normalizeWhitespace` stays (still used for `oldText`). Note `normalizeWithMap` must produce byte-identical output to `normalizeWhitespace` for any input (whitespace-run collapse first, then CRLF — verified equivalent because a `\r\n` pair is never inside a `[ \t]` run).

- [ ] **Step 4:** `bun test src/features/ai-panel/services/vendor/tools/edit-diff.test.ts` → PASS. Also run the neighboring suites: `bun test src/features/ai-panel/services/write-approval-gate.test.ts` (it imports `applyEdits`).
- [ ] **Step 5: Commit** `fix(ai): fuzzy edit matching maps spans exactly — tab/space mismatch no longer deletes to EOF`

---

### Task 2: repeat-call guard honors rejected writes (finding 15)

**Files:**
- Modify: `editor/src/features/ai-panel/services/tool-guards.ts`
- Test: `editor/src/features/ai-panel/services/tool-guards.test.ts`

**Interfaces:** Consumes `isRejectedWrite` from `./write-approval-gate` (Bun-safe module, no cycle: write-approval-gate does not import tool-guards).

- [ ] **Step 1: Write failing tests** (append to the existing suite; reuse its fake-tool helpers/style):

```ts
it('a rejected write does not count as already-made — the identical retry executes', async () => {
  resetRepeatCallGuard();
  let calls = 0;
  const tool = withRepeatCallGuard({
    name: 'write', label: 'write', description: '', parameters: {} as never,
    execute: async () => {
      calls++;
      return calls === 1
        ? ({ content: [{ type: 'text', text: 'User rejected this edit' }], rejected: true } as never)
        : { content: [{ type: 'text', text: 'Successfully wrote file' }] };
    },
  });
  const params = { path: '/ws/Assets/A.cs', content: 'x' };
  await tool.execute('1', params);
  const second = await tool.execute('2', params);
  expect(calls).toBe(2); // not suppressed
  expect(second.content[0]).toEqual({ type: 'text', text: 'Successfully wrote file' });
});

it('a rejected write does not arm the post-write read exemption', async () => {
  resetRepeatCallGuard();
  let reads = 0;
  const write = withRepeatCallGuard({
    name: 'write', label: 'write', description: '', parameters: {} as never,
    execute: async () =>
      ({ content: [{ type: 'text', text: 'User rejected this edit' }], rejected: true } as never),
  });
  const read = withRepeatCallGuard({
    name: 'read', label: 'read', description: '', parameters: {} as never,
    execute: async () => { reads++; return { content: [{ type: 'text', text: 'data' }] }; },
  });
  await read.execute('1', { path: '/ws/Assets/A.cs' });
  await write.execute('2', { path: '/ws/Assets/A.cs', content: 'x' });
  await read.execute('3', { path: '/ws/Assets/A.cs' }); // no successful write happened
  expect(reads).toBe(1); // second read suppressed
});
```

- [ ] **Step 2:** Run the suite — both FAIL.
- [ ] **Step 3: Implement.** Add `import { isRejectedWrite } from './write-approval-gate';`. In `execute`, replace the post-execute block:

```ts
      callCounts.set(key, seenCount + 1);
      const result = await tool.execute(id, params, signal, onUpdate);

      if (tool.name === 'write' || tool.name === 'edit') {
        if (isRejectedWrite(result)) {
          // Nothing touched disk. The rejection text tells the model to ask
          // before retrying — when the user then SAYS YES, the byte-identical
          // re-issue must execute, not get answered with a synthetic "the
          // result would be identical".
          callCounts.set(key, seenCount);
        } else if (path !== undefined) {
          writtenSincePaths.add(path);
        }
      }

      return result;
```

- [ ] **Step 4:** `bun test src/features/ai-panel/services/tool-guards.test.ts` → PASS.
- [ ] **Step 5: Commit** `fix(ai): repeat-call guard lets a user-approved retry of a rejected write execute`

---

### Task 3: approval gate never silently delegates an unpreviewable edit (finding 5)

**Files:**
- Modify: `editor/src/features/ai-panel/services/write-approval-gate.ts`
- Test: `editor/src/features/ai-panel/services/write-approval-gate.test.ts`

- [ ] **Step 1: Write failing tests** (existing suite has fake `deps`; follow its fixtures):

```ts
it('approve mode: an edit whose search text does not match refuses without executing or prompting', async () => {
  const calls: string[] = [];
  const tool = withWriteApproval(fakeTool('edit', () => { calls.push('exec'); }), '/ws', {
    deps: {
      readFile: async () => 'actual file content',
      requestApproval: async () => { calls.push('prompt'); return 'apply'; },
      getApplyMode: () => 'approve',
      getAlwaysApproveUnityAssets: () => true,
    },
  });
  const res = await tool.execute('1', { path: 'A.cs', edits: [{ oldText: 'NOPE', newText: 'x' }] });
  expect(calls).toEqual([]); // neither prompted nor executed
  expect((res.content[0] as { text: string }).text).toContain('NOT applied');
});

it('serialized asset in auto mode: unreadable pre-read refuses instead of writing unprompted', async () => {
  const calls: string[] = [];
  const tool = withWriteApproval(fakeTool('edit', () => { calls.push('exec'); }), '/ws', {
    deps: {
      readFile: async () => null,
      requestApproval: async () => { calls.push('prompt'); return 'apply'; },
      getApplyMode: () => 'auto',
      getAlwaysApproveUnityAssets: () => true,
    },
  });
  const res = await tool.execute('1', { path: 'Scene.unity', edits: [{ oldText: 'a', newText: 'b' }] });
  expect(calls).toEqual([]);
  expect((res.content[0] as { text: string }).text).toContain('could not be read');
});
```

(Adapt `fakeTool` to whatever helper the suite already uses; if any existing test pins the old delegate-on-null behavior, update it to the new refusal contract.)

- [ ] **Step 2:** Run — FAIL (both currently delegate to `tool.execute`).
- [ ] **Step 3: Implement.** At the top of `execute`, keep the current out-of-root delegate. Then replace the null-`newText` delegate (lines ~301–309) with a refusal:

```ts
      const currentContent = await deps.readFile(absPath);
      const newText = await computePendingNewText(tool, params, currentContent ?? '');
      if (newText === null) {
        // A prompt is REQUIRED on this path (approve mode / serialized Unity
        // asset), but no diff could be computed — the file was unreadable, or
        // the edit's search text doesn't match the content we read. The old
        // behavior delegated on the assumption the tool would "fail
        // deterministically"; the tool re-reads the file itself, so an
        // external change (Unity reimport, git checkout) could make it
        // SUCCEED — an unprompted write to an always-prompt path. Refuse.
        return {
          content: [{
            type: 'text',
            text:
              `Error: could not preview this ${tool.name} to ${absPath} for approval` +
              (currentContent === null
                ? ' (the file could not be read).'
                : " (the edit's search text does not match the file's current content).") +
              ' The change was NOT applied. Re-read the file and retry with matching text.',
          }],
        };
      }
```

Also update the module-header paragraph "Computing the pending diff without writing" to describe the refusal (the old text documents the unsound assumption).

- [ ] **Step 4:** `bun test src/features/ai-panel/services/write-approval-gate.test.ts` → PASS (fix any pinned old-behavior tests per their intent).
- [ ] **Step 5: Commit** `fix(ai): approval gate refuses unpreviewable edits instead of delegating unprompted`

---

### Task 4: sandbox for every workspace shape (finding 2)

**Files:**
- Create: `editor/src/features/ai-panel/services/sandbox-roots.ts`
- Test (new): `editor/src/features/ai-panel/services/sandbox-roots.test.ts`
- Modify: `editor/src/features/ai-panel/services/agent-service.ts` (lines ~153–164)

**Interfaces:** Produces `computeAllowedRoots(workspacePath: string, isUnity: boolean, assetsRootPath: string | null): readonly string[]` — consumed by `createToolsForPromptMode`. Empty array = deny-all (established `resolveWithinRoot` semantics).

- [ ] **Step 1: Write failing tests** (`sandbox-roots.test.ts`):

```ts
import { describe, it, expect } from 'bun:test';
import { computeAllowedRoots } from './sandbox-roots';

describe('computeAllowedRoots', () => {
  it('Unity: Assets first (bash cwd), then .arcane, then Packages', () => {
    expect(computeAllowedRoots('/p', true, '/p/Assets')).toEqual([
      '/p/Assets', '/p/.arcane', '/p/Packages',
    ]);
  });
  it('non-Unity: the workspace itself (was: NO sandbox at all)', () => {
    expect(computeAllowedRoots('/p', false, null)).toEqual(['/p']);
  });
  it('Unity without a resolved Assets root falls back to the workspace', () => {
    expect(computeAllowedRoots('/p', true, null)).toEqual(['/p']);
  });
  it('no workspace open denies all file tools', () => {
    expect(computeAllowedRoots('/', false, null)).toEqual([]);
    expect(computeAllowedRoots('', false, null)).toEqual([]);
  });
});
```

- [ ] **Step 2:** FAIL (module doesn't exist).
- [ ] **Step 3: Implement** `sandbox-roots.ts` (pure, no imports):

```ts
/**
 * Tool-sandbox roots for a workspace. Non-Unity workspaces used to get NO
 * sandbox at all (allowedRoot null ⇒ resolveWithinRoot passes any absolute
 * path through, and auto apply-mode wrote it unprompted). Unity keeps
 * Assets/ FIRST (primaryRoot is bash's default cwd and list's scan root),
 * plus .arcane/ (plan files) and Packages/ — prompts/agent.ts explicitly
 * allows manifest.json edits after confirming, which the old
 * [Assets, .arcane] list refused. '/' is the no-workspace placeholder
 * (getCurrentWorkspacePath's fallback): deny-all rather than sandbox-to-root.
 */
export function computeAllowedRoots(
  workspacePath: string,
  isUnity: boolean,
  assetsRootPath: string | null,
): readonly string[] {
  if (!workspacePath || workspacePath === '/') return [];
  if (isUnity && assetsRootPath) {
    return [assetsRootPath, `${workspacePath}/.arcane`, `${workspacePath}/Packages`];
  }
  return [workspacePath];
}
```

In `agent-service.ts`, replace the two lines computing `assetsRoot`/`allowedRoot` with:

```ts
  const allowedRoot = computeAllowedRoots(
    workspacePath,
    isUnity,
    isUnity ? (useWorkspaceStore.getState().assetsRootPath ?? null) : null,
  );
```

(keep the existing comment block, updated to point at `sandbox-roots.ts`), and add the import. The `AllowedRoots` type accepts `readonly string[]` already.

- [ ] **Step 4:** `bun test src/features/ai-panel/services/sandbox-roots.test.ts` → PASS; `bun run build`-level type check comes with the final verify (tsc).
- [ ] **Step 5: Commit** `fix(ai): every workspace gets a real tool sandbox; Unity sandbox admits Packages/`

---

### Task 5: checkpoint turn lifecycle (finding 10)

**Files:**
- Modify: `editor/src/stores/checkpoints.ts`
- Test: `editor/src/stores/checkpoints.test.ts`

**Interfaces:** Produces `endTurn(): void` + `activeTurnId: string | null` on the store. Task 8 wires `endTurn` into `sendMessage`'s finally.

- [ ] **Step 1: Write failing tests:**

```ts
it('recordPreWrite outside an open turn is discarded — never appended to a previous turn', () => {
  const s = useCheckpointsStore.getState();
  s.reset();
  s.beginTurn('sess', 'msg1');
  s.recordPreWrite('/a.cs', 'old1');
  s.endTurn();
  s.recordPreWrite('/b.cs', 'oldB'); // e.g. checkpoints enabled mid-turn on the NEXT send
  const turns = useCheckpointsStore.getState().turns;
  expect(turns).toHaveLength(1);
  expect(turns[0].entries.map((e) => e.path)).toEqual(['/a.cs']);
});

it('recordPreWrite with no turn ever opened is a no-op', () => {
  const s = useCheckpointsStore.getState();
  s.reset();
  s.recordPreWrite('/a.cs', 'x');
  expect(useCheckpointsStore.getState().turns).toHaveLength(0);
});
```

- [ ] **Step 2:** First test FAILS (entry lands on the closed turn).
- [ ] **Step 3: Implement.**
  - State: add `activeTurnId: string | null` (initial `null`) to `CheckpointsState` + the store object, and `endTurn: () => void` to the interface with doc: `/** Close the current send's turn. recordPreWrite calls outside an open turn are discarded — a mid-turn settings flip must not attach pre-images to a PREVIOUS turn (whose restore plan would then roll files back past accepted work). */`
  - `beginTurn`: include the generated `turnId` in the returned state as `activeTurnId`.
  - `endTurn: () => set({ activeTurnId: null }),`
  - `recordPreWrite`: replace the `turns.length === 0` guard with:

```ts
      if (!s.activeTurnId) return s; // no turn open for THIS send — discard
      const last = s.turns[s.turns.length - 1];
      if (!last || last.turnId !== s.activeTurnId) return s;
```

  - `reset` and `loadForSession`: set `activeTurnId: null` in their `set` calls.
- [ ] **Step 4:** `bun test src/stores/checkpoints.test.ts` → PASS (update any existing test that relied on recordPreWrite appending without beginTurn/endTurn bookkeeping — add `beginTurn` calls to them, matching real wiring).
- [ ] **Step 5: Commit** `fix(ai): checkpoint pre-writes only attach to the turn opened for the current send`

---

### Task 6: agent-loop crash keeps the turn (finding 3)

**Files:**
- Modify: `editor/src/features/ai-panel/services/vendor/agent-loop.ts`
- Modify: `editor/src/features/ai-panel/services/vendor/compaction.ts` (null-guards only; token estimate is Task 7)
- Test: `editor/src/features/ai-panel/services/vendor/agent-loop.test.ts`

- [ ] **Step 1: Write failing test** (reuse the suite's existing config/stream fakes):

```ts
it('a loop crash preserves the prompt and appends an error tail instead of rolling back the turn', async () => {
  const state = { systemPrompt: '', messages: [], tools: [] };
  const config = {
    model: { id: 'm', name: 'm', provider: 'p' },
    streamFn: (() => { throw new Error('unused'); }) as never,
    convertToLlm: () => { throw new Error('boom in convert'); },
  };
  const events: AgentEvent[] = [];
  for await (const e of agentLoop(config as never, state, [
    { role: 'user', content: 'hello', timestamp: 1 },
  ])) events.push(e);
  const end = events.findLast((e) => e.type === 'agent_end') as { messages: AgentMessage[] };
  expect(end.messages.some((m) => m.role === 'user' && m.content === 'hello')).toBe(true);
  const tail = end.messages[end.messages.length - 1];
  expect(tail.role).toBe('assistant');
  expect((tail as AssistantMessage).stopReason).toBe('error');
  expect(state.messages).toBe(end.messages); // state advanced, not the pre-turn snapshot
});
```

- [ ] **Step 2:** FAIL (agent_end carries `[]`, prompt lost).
- [ ] **Step 3: Implement.** In `runLoop`, wrap the `while (true)` loop in try/catch; always finish with the accumulated messages:

```ts
  try {
    while (true) {
      // ...existing body unchanged...
    }
  } catch (error) {
    // A crash anywhere in the loop (compaction, convertToLlm, a decorator
    // throwing outside executeToolBounded) must not roll the turn out of
    // history: the old handler emitted agent_end with the PRE-turn snapshot,
    // deleting the user's prompt from LLM history while the UI kept showing
    // it — and Retry then truncated the PREVIOUS exchange. Append an error
    // tail in the same shape a streamFn error produces and finish normally.
    const message = error instanceof Error ? error.message : String(error);
    const crashTail: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: `Agent loop crashed: ${message}`,
      timestamp: Date.now(),
    };
    allMessages.push(crashTail);
    newMessages.push(crashTail);
    stream.push({ type: 'message_start', message: crashTail });
    stream.push({ type: 'message_end', message: crashTail });
    stream.push({ type: 'turn_end' });
  }

  state.messages = allMessages;
  stream.push({ type: 'agent_end', messages: allMessages });
```

Keep `agentLoop`'s outer `.catch` as the last-resort backstop (unchanged).

In `compaction.ts`, harden the counters against the documented null-content carriers (openai-format.ts: aborted/restored turns):

```ts
function contentChars(content: string | (TextContent | ImageContent)[] | null | undefined): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  return content.reduce((n, b) => n + blockChars(b), 0);
}
```

and in `messageChars`'s assistant branch use `(m.content ?? []).reduce(...)`.

- [ ] **Step 4:** `bun test src/features/ai-panel/services/vendor/agent-loop.test.ts src/features/ai-panel/services/vendor/agent.test.ts` → PASS.
- [ ] **Step 5: Commit** `fix(ai): loop crash appends an error tail instead of deleting the turn from history`

---

### Task 7: compaction image token estimate (finding 12)

**Files:**
- Modify: `editor/src/features/ai-panel/services/vendor/compaction.ts`
- Test (new): `editor/src/features/ai-panel/services/vendor/compaction.test.ts`

- [ ] **Step 1: Write failing tests:**

```ts
import { describe, it, expect } from 'bun:test';
import { estimateTokens, compactMessages } from './compaction';

describe('image token estimate', () => {
  it('one pasted screenshot does not pin the conversation above the trigger', () => {
    const big = 'A'.repeat(683_000); // ~500KB image as base64
    const messages = [
      { role: 'user' as const, content: [
        { type: 'text' as const, text: 'what is this?' },
        { type: 'image' as const, data: big, mimeType: 'image/png' },
      ], timestamp: 1 },
    ];
    expect(estimateTokens(messages as never)).toBeLessThan(10_000);
    const out = compactMessages(messages as never, { contextWindow: 32768 });
    expect(out).toBe(messages as never); // below trigger — returned unchanged
  });

  it('null message content does not throw (aborted/restored turns)', () => {
    expect(estimateTokens([{ role: 'user', content: null, timestamp: 1 }] as never)).toBe(0);
  });

  it('old non-read tool results still get cleared above the trigger', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }], timestamp: 1 },
      { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: 'X'.repeat(200_000), isError: false, timestamp: 2 },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }], timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }], timestamp: 4 },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }], timestamp: 5 },
      { role: 'assistant', content: [{ type: 'text', text: 'd' }], timestamp: 6 },
    ];
    const out = compactMessages(msgs as never, { contextWindow: 32768 });
    expect(out[1].content).toBe('[Tool result cleared to save context]');
  });
});
```

- [ ] **Step 2:** First test FAILS (~195k estimated tokens).
- [ ] **Step 3: Implement:**

```ts
/**
 * Flat char-equivalent for an image block. Counting the base64 payload as
 * text overshot real vision token cost ~1000x — one pasted screenshot pinned
 * every later send above the compaction trigger, and since compaction only
 * elides tool results (never the image) the model lost its own bash/compile
 * outputs for the rest of the session. Vision models bill an image at
 * roughly 1–2k tokens; 2k tokens × CHARS_PER_TOKEN is a safe over-estimate.
 */
const IMAGE_CHARS_ESTIMATE = 2000 * CHARS_PER_TOKEN;

function blockChars(b: TextContent | ImageContent): number {
  return b.type === 'text' ? b.text.length : IMAGE_CHARS_ESTIMATE;
}
```

- [ ] **Step 4:** `bun test src/features/ai-panel/services/vendor/compaction.test.ts` → PASS.
- [ ] **Step 5: Commit** `fix(ai): images estimate at real vision token cost, not base64 length`

---

### Task 8: Stop actually stops the send (finding 9) + endTurn wiring

**Files:**
- Modify: `editor/src/features/ai-panel/services/agent-service.ts`

No Bun test can load this module (monaco chain); covered by tsc, the existing suites of everything it wires, and the guards mirroring the already-shipped `maybeDistillMemory` pattern.

- [ ] **Step 1: Restructure `sendMessage`:** add `private sendInFlight = false;` next to `abortRequested`. New shape:

```ts
  async sendMessage(text: string, opts: SendMessageOptions): Promise<void> {
    // Serialize whole SENDS, not just the vendor loop: agent.isRunning goes
    // false while turn A's post-loop (grounding lint / verified pass, up to
    // ~10s) is still running, and a quick follow-up send used to clear
    // abortRequested + reset the governor/telemetry UNDER turn A — making a
    // deliberate Stop post a spurious red error block.
    if (this.agent.isRunning || this.sendInFlight) {
      useAiStore.getState().setError('Agent is already processing a message.');
      return;
    }

    const auth = useAuthStore.getState();
    if (!auth.loggedIn || !auth.token) {
      if (auth.loggedIn && !auth.token) {
        await auth.logout().catch(() => {});
      }
      useAiStore.getState().setError('Sign in to use AI.');
      return;
    }

    // Fresh per-send abort tracking — AFTER the guards, so entering while a
    // prior send is mid-post-loop can never clear ITS abort flag.
    this.abortRequested = false;
    lastSend = { text, opts };
    this.sendInFlight = true;
    try {
      await this.runSend(text, opts);
    } finally {
      this.sendInFlight = false;
      // Close the checkpoint turn opened below — recordPreWrite calls landing
      // after this send (mid-turn settings flips, stragglers) must not attach
      // to it (see stores/checkpoints.ts).
      useCheckpointsStore.getState().endTurn();
    }
  }

  private async runSend(text: string, opts: SendMessageOptions): Promise<void> {
    // ...the ENTIRE former body from the `sessionIdForTurn` block onward,
    // unchanged except the edits in Step 2...
  }
```

- [ ] **Step 2: Abort-guard the post-loop:** first line of `runGroundingLint` and (after its promptMode check) `runVerifiedPassIfNeeded`:

```ts
    // A user Stop can leave an 'error'/'toolUse' tail instead of 'aborted'
    // (abort mid-tool never reaches 'aborted') — the stopReason check below
    // misses it, and this method then fired a fresh BILLED revise turn /
    // a live Unity recompile for a cancelled send. Same guard
    // maybeDistillMemory already has.
    if (this.abortRequested) return;
```

- [ ] **Step 3:** `bun test src` (whole editor suite) — green; tsc via final verify.
- [ ] **Step 4: Commit** `fix(ai): Stop suppresses the post-loop (lint revise, verified pass) and sends serialize fully`

---

### Task 9: workspace switch kills the old agent (finding 4)

**Files:**
- Modify: `editor/src/App.tsx` (~line 505 subscriber)
- Modify: `editor/src/features/ai-panel/services/session-restore.ts`
- Check: `editor/src/features/ai-panel/index.ts` exports `resetAgentService` (add if missing)

- [ ] **Step 1: App.tsx** — in the workspace subscriber, before `resetConversation()`:

```ts
      // Kill the OLD workspace's agent first: a still-running turn kept
      // writing the old project's files while its events streamed into the
      // new project's blank transcript (dispose aborts the loop and
      // unsubscribes its store feed). resetConversation alone never touches
      // the agent — and even sets isAgentRunning:false while it still runs.
      resetAgentService();
```

Import `resetAgentService` from `./features/ai-panel` (barrel).

- [ ] **Step 2: session-restore.ts** — re-check the workspace after the async load:

```ts
  const data = await loadLatestSession(workspacePath);
  if (!data) return false;

  // The load is async: the user may have switched workspaces while it ran.
  // Without this, A's transcript loads under B and the next save stamps it
  // workspacePath:B — permanently migrating the session between projects.
  if (useWorkspaceStore.getState().workspacePath !== workspacePath) return false;
```

Import `useWorkspaceStore` from `../../../stores/workspace`.

- [ ] **Step 3:** `bun test src` green (no suite loads these; tsc + module-boundary check in final verify).
- [ ] **Step 4: Commit** `fix(ai): workspace switch disposes the running agent; stale session loads are dropped`

---

### Task 10: AiChatPanel hook order + right-sidebar error boundary (finding 11)

**Files:**
- Modify: `editor/src/features/ai-panel/components/AiChatPanel.tsx`
- Modify: `editor/src/features/app-shell/components/RightSidebarPanel.tsx`
- Check: `editor/src/App.tsx:1772` second `<AiChatPanel />` mount — wrap the same way

- [ ] **Step 1: Reorder AiChatPanel** so ALL hooks run before any return: move `function handleNewChat()` and the new-chat/history `useEffect` (currently below the two gates) up, directly after the first `useEffect`. Add above the `if (!loggedIn)` return:

```tsx
  // HOOKS END HERE. The two gates below are conditional RETURNS — any hook
  // added after them changes the hook count when loggedIn /
  // verificationRequired flips while the panel is mounted, and React 19
  // throws ("Rendered more/fewer hooks") on the first-sign-in mainline flow.
```

- [ ] **Step 2: Boundary.** In `RightSidebarPanel.tsx`, wrap every returned panel body (read the file first; it returns `<AiChatPanel />` from three branches) with the shared boundary, matching `SidebarPanel.tsx`'s pattern:

```tsx
import { ErrorBoundary } from '../../../components/ErrorBoundary';
// each return site:
<ErrorBoundary fallback={<div className="sidebar-empty">This panel crashed — close and reopen it to retry.</div>}>
  <AiChatPanel />
</ErrorBoundary>
```

Do the same for the `App.tsx:1772` mount (maximized overlay) so a panel crash never replaces the whole editor.

- [ ] **Step 3:** `bun test src` green; visual behavior verified by the final `bun run verify` (tsc) — no DOM test infra exists.
- [ ] **Step 4: Commit** `fix(ai): panel hooks precede auth gates; right sidebar gets a local error boundary`

---

### Task 11: no-[DONE] stream end is an error, not a clean stop (finding 13)

**Files:**
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts` (lines ~635–666)
- Test: `editor/src/features/ai-panel/services/arcane-stream.test.ts`

- [ ] **Step 1: Write failing test** (reuse the suite's SSE-body fixtures):

```ts
it('a stream that dies without [DONE] after text surfaces an error, not a complete answer', async () => {
  // body: a few text deltas, then EOF — no [DONE], no error event
  const events = await collectEvents(sseBody([
    'data: {"type":"text","content":"Half an ans"}',
  ]));
  const last = events[events.length - 1];
  expect(last.type).toBe('error');
  expect((last as { partial: AssistantMessage }).partial.stopReason).toBe('error');
});
```

(Adapt to the suite's actual helper names; an existing test may pin the old `'stop'` finalization for text-only truncation — update it, the old behavior is the bug.)

- [ ] **Step 2:** FAIL (`done` with stopReason `'stop'`).
- [ ] **Step 3: Implement.** Replace the tool-call-only truncation guard so ANY content (or a dangling partial line) makes the no-[DONE] end an error:

```ts
  // The server ALWAYS terminates a stream with [DONE] (or an error event) —
  // reaching here means the connection died mid-response (worker eviction,
  // proxy close). Half-streamed tool calls were already rescued; a text-only
  // tail was labeled 'stop' and rendered as a complete answer with no error
  // and no Retry. Treat any partial content — or unparsed bytes left in the
  // buffer — as truncation. A zero-content cutoff still falls through to the
  // empty 'stop' finalizer, which the send-level empty-response detection
  // already turns into an actionable error.
  if (contentBlocks.length > 0 || buffer.trim().length > 0) {
    const message = 'Stream ended unexpectedly mid-response';
    stream.push({
      type: 'error',
      error: new Error(message),
      partial: {
        role: 'assistant',
        content: contentBlocks,
        stopReason: 'error',
        errorMessage: message,
        timestamp: Date.now(),
      },
    });
    return;
  }
```

- [ ] **Step 4:** `bun test src/features/ai-panel/services/arcane-stream.test.ts src/features/ai-panel/services/stream-retry.test.ts src/features/ai-panel/services/stream-error-guard.test.ts` → PASS.
- [ ] **Step 5: Commit** `fix(ai): truncated streams surface as errors with Retry instead of fake clean answers`

---

### Task 12: plan revise/persist/resume repairs (finding 14)

**Files:**
- Create: `editor/src/features/ai-panel/services/plan-revise.ts`
- Test (new): `editor/src/features/ai-panel/services/plan-revise.test.ts`
- Modify: `editor/src/features/ai-panel/services/plan-controller.ts`

**Interfaces:** Produces `buildReviseNotesPrompt(planPath: string, planContent: string, notes: PlanNote[]): string` (pure; `import type { PlanNote } from '../../markdown-preview'` — type-only, Bun-safe).

- [ ] **Step 1: Write failing tests** (`plan-revise.test.ts`):

```ts
import { describe, it, expect } from 'bun:test';
import { buildReviseNotesPrompt } from './plan-revise';

describe('buildReviseNotesPrompt', () => {
  const note = { headingPath: 'Phase 1', quotedText: 'do X', body: 'why not Y?', anchored: true };
  it('embeds the full current plan (the planning toolset has no read guarantee on .arcane)', () => {
    const p = buildReviseNotesPrompt('/ws/.arcane/plans/p.md', '# Plan\n- [ ] step', [note as never]);
    expect(p).toContain('# Plan\n- [ ] step');
    expect(p).toContain('/ws/.arcane/plans/p.md');
  });
  it('asks for the FULL plan as the reply — never an instruction to write files', () => {
    const p = buildReviseNotesPrompt('/p.md', 'plan', [note as never]);
    expect(p).toContain('Reply with the FULL revised plan');
    expect(p).not.toContain('write the full revised plan back');
  });
  it('marks unanchored notes as general feedback', () => {
    const p = buildReviseNotesPrompt('/p.md', 'plan', [{ ...note, anchored: false } as never]);
    expect(p).toContain('no longer in the plan');
  });
});
```

- [ ] **Step 2:** FAIL (module doesn't exist).
- [ ] **Step 3: Implement `plan-revise.ts`:**

```ts
/**
 * Prompt builder for plan revision (PlanDocumentView's pinned suggestions).
 * plan-planning's toolset is read-only BY DESIGN — the model cannot write the
 * plan file, so the prompt must ask for the full revised plan as the REPLY
 * text; plan-controller persists it (same division of labor startPlanning
 * uses for the initial draft). The old prompt ordered the model to "write the
 * plan back", which silently discarded every pinned note.
 */
import type { PlanNote } from '../../markdown-preview';

export function buildReviseNotesPrompt(
  planPath: string,
  planContent: string,
  notes: PlanNote[],
): string {
  const body = notes
    .map((n, i) => {
      const where = n.anchored
        ? `under "${n.headingPath}"`
        : `under "${n.headingPath}" (this text is no longer in the plan — treat as general feedback)`;
      return `${i + 1}. ${where}\n   > ${n.quotedText}\n   ${n.body}`;
    })
    .join('\n\n');

  return (
    `Revise the plan below to address these suggestions. Reply with the FULL ` +
    `revised plan in the same markdown format — your reply becomes the new ` +
    `content of ${planPath}, so include every part of the plan (updated), ` +
    `with no commentary before or after it.\n\n` +
    `Suggestions:\n${body}\n\n--- Current plan (${planPath}) ---\n${planContent}`
  );
}
```

- [ ] **Step 4: Rewire `plan-controller.ts`:**
  1. `runExecution`'s two dead-end branches (readPlan failure, empty plan) additionally clear the plan state so the next composer message starts fresh instead of resuming the same failure forever:

```ts
    store.setActivePlanPath(null);
    store.setPlanPhase('idle');
```

  (append `— plan cleared; send a message to plan again.` to both error strings).
  2. `runExecution` records which plan is running (a follow-up message resumes THIS plan, not a stale `activePlanPath`): after `store.setPlanPhase('executing');` add `store.setActivePlanPath(planPath);`.
  3. `startPlanning`: wrap the `sendMessage` await in try/catch — a throw used to strand `planPhase: 'planning'` forever:

```ts
  try {
    await getAgentService().sendMessage(opts.sendText ?? prompt, { ... });
  } catch (err) {
    useAiStore.getState().setPlanPhase('idle');
    useAiStore.getState().setError(`Planning failed: ${formatErr(err)}`);
    return;
  }
```

  4. Rewrite `reviseWithNotes` (persist the revision; drop the bogus `planExecution` arg):

```ts
async function reviseWithNotes(planPath: string, notes: PlanNote[]): Promise<void> {
  const store = useAiStore.getState();
  if (notes.length === 0) return;
  if (store.isAgentRunning) return;

  let planContent: string;
  try {
    planContent = await readPlan(planPath);
  } catch (err) {
    store.setError(`Could not read plan file: ${formatErr(err)}`);
    return;
  }

  store.setPlanPhase('planning');
  store.setActivePlanPath(planPath);
  try {
    await getAgentService().sendMessage(buildReviseNotesPrompt(planPath, planContent, notes), {
      mode: 'plan',
      effort: store.effort,
      promptMode: 'plan-planning',
    });

    // plan-planning is read-only — the model replies with the revised plan;
    // WE persist it, exactly as startPlanning does for the initial draft.
    const after = useAiStore.getState();
    let revised = '';
    for (let i = after.messages.length - 1; i >= 0; i--) {
      const m = after.messages[i];
      if (m.role === 'assistant') {
        revised = extractPlanMarkdown(m.content);
        if (revised) break;
      }
    }
    if (!revised) {
      after.setError('Revision did not produce a plan — the file was left unchanged.');
      return;
    }
    try {
      await writePlan(planPath, revised);
      openPlanInEditor(planPath);
    } catch (err) {
      after.setError(`Failed to write revised plan: ${formatErr(err)}`);
    }
  } finally {
    useAiStore.getState().setPlanPhase('awaiting-execute');
  }
}
```

  Import `buildReviseNotesPrompt` from `./plan-revise`.
- [ ] **Step 5:** `bun test src/features/ai-panel/services/plan-revise.test.ts src/features/ai-panel/services/plan-route.test.ts src/features/ai-panel/services/plan-regen.test.ts` → PASS.
- [ ] **Step 6: Commit** `fix(ai): plan revise persists the revision; dead plans clear; execute pins the active plan`

---

### Task 13: server — Stop propagates upstream; error/abort turns are metered (findings 7, 8)

**Files:**
- Modify: `arcane-server/src/services/llm-router.ts` (`streamCompletion` signature)
- Modify: `arcane-server/src/routes/chat.ts` (both lanes)
- Test: `arcane-server/test/llm-router.test.ts`, plus a route-level metering regression in a new `arcane-server/test/chat-metering.test.ts`

- [ ] **Step 1: Write failing tests.**

`llm-router.test.ts` (follow its existing fake-`streamTextImpl` pattern):

```ts
it('forwards the abort signal to streamText so a client Stop cancels the provider call', async () => {
    let seen: AbortSignal | undefined;
    const fake = ((opts: { abortSignal?: AbortSignal }) => {
        seen = opts.abortSignal;
        return { fullStream: (async function* () {})() };
    }) as never;
    const ctl = new AbortController();
    for await (const _ of streamCompletion(minimalReq(), fakeEnv(), fake, ctl.signal)) { /* drain */ }
    expect(seen).toBe(ctl.signal);
});
```

`chat-metering.test.ts` (billing-gate.test.ts harness style — seeded user with credits, no AI binding so the provider call fails):

```ts
import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';

describe('chat metering on the error lane', () => {
    it('a non-streaming request that errors still writes a request_logs row', async () => {
        const user = await seedPasswordUser('meter-err@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan = 'pro', plan_credits_micro = 5000000, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(user.id).run();
        const token = await tokenFor(user);
        const res = await SELF.fetch('https://example.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(res.status).toBe(500);
        const row = await env.arcane_db.prepare(
            'SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ?'
        ).bind(user.id).first<{ n: number }>();
        expect(row!.n).toBe(1); // was 0: the throw jumped past logUsage entirely
    });
});
```

(If `waitUntil` promises don't settle before assertions under `cloudflare:test`, use the non-streaming lane's plain `await` metering — see Step 3 — which is why that lane keeps `await` and only the streaming lane uses `waitUntil`.)

- [ ] **Step 2:** Run `cd arcane-server && bun run test` — both FAIL.
- [ ] **Step 3: Implement.**

`llm-router.ts`:

```ts
export async function* streamCompletion(
    req: ChatCompletionRequest, env: LlmEnv, streamTextImpl: StreamTextFn = streamText,
    signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
```

and add `...(signal ? { abortSignal: signal } : {}),` to the `streamTextImpl({...})` options.

`chat.ts` — non-streaming lane: hoist the accumulators above the `try`, add `let sawUsage = false; let streamedChars = 0;` (`+= event.content.length` on text, `+= event.arguments.length` on tool_call, `sawUsage = true` on usage), delete the in-try `await logUsage(...)` call, and add a `finally`:

```ts
        } finally {
            // Provider errors used to jump past logUsage entirely — real spend
            // recorded as NOTHING, invisible to the $1/hr cap. When no usage
            // event arrived, estimate from what actually streamed.
            if (!sawUsage && streamedChars > 0) {
                outputTokens = Math.ceil(streamedChars / 4);
                inputTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
            }
            const durationMs = Date.now() - startTime;
            await logUsage(env.arcane_db, user, body.model, inputTokens, outputTokens, durationMs, {
                /* same extras object as before */
            });
        }
```

`chat.ts` — streaming lane:

```ts
    return streamSSE(c, async (stream) => {
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedInputTokens = 0;
        let sawUsage = false;
        let streamedChars = 0;
        // Client Stop/disconnect aborts this signal; forwarding it cancels the
        // provider call instead of draining (and billing) the full generation.
        const clientSignal = c.req.raw.signal;

        try {
            for await (const event of streamCompletion(body, env, undefined, clientSignal)) {
                if (event.type === 'text') streamedChars += event.content.length;
                if (event.type === 'tool_call') streamedChars += event.arguments.length;
                if (event.type === 'usage') { /* existing assignments */ sawUsage = true; }
                if (event.type === 'error') logChatError(errCtx, 'chat.stream.forward', event.message);
                if (clientSignal.aborted) break; // dead writer — stop pulling upstream
                await stream.writeSSE({ data: JSON.stringify(event) });
            }
            await stream.writeSSE({ data: '[DONE]' });
        } catch (err) {
            if (!clientSignal.aborted) {
                const message = err instanceof Error ? err.message : String(err);
                logChatError(errCtx, 'chat.stream.catch', message);
                await stream.writeSSE({ data: JSON.stringify({ type: 'error', code: 'server_error', message }) });
            }
        } finally {
            if (!sawUsage && streamedChars > 0) {
                outputTokens = Math.ceil(streamedChars / 4);
                inputTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
            }
            const durationMs = Date.now() - startTime;
            // waitUntil: on client disconnect the runtime can tear this handler
            // down — the debit and the request_logs row feeding the hourly cap
            // must survive it (same pattern auth-email.ts uses).
            c.executionCtx.waitUntil(logUsage(env.arcane_db, user, body.model, inputTokens, outputTokens, durationMs, {
                /* same extras object as before */
            }));
        }
    });
```

Check other `streamCompletion` call sites (`grep -rn "streamCompletion(" arcane-server/src`) still compile with the new optional 4th param.

- [ ] **Step 4:** `cd arcane-server && bun run test` → all green.
- [ ] **Step 5: Commit** `fix(server): client Stop aborts the provider; error/abort turns are metered, not free`

---

### Task 14: free-tier reset settles overshoot debt (finding 6, unpinned parts)

**Files:**
- Modify: `arcane-server/src/lib/db.ts` (`resetFreePlanCredits`)
- Test: `arcane-server/test/credits.test.ts`

- [ ] **Step 1: Write failing tests** (use the suite's `setBalances` helper; trigger via `checkAiBudget`/`refreshAndGetBalance` with an expired period):

```ts
it('monthly reset settles a negative top-up (overshoot debt) from the new grant', async () => {
    const user = await seedPasswordUser('debt@test.dev', 'password123');
    await setBalances(user.id, 'free', 0, -350_000, '2000-01-01T00:00:00.000Z');
    await refreshAndGetBalance(env.arcane_db, user.id);
    const r = await getUserBillingRow(env.arcane_db, user.id);
    expect(r!.topup_credits_micro).toBe(0);
    expect(r!.plan_credits_micro).toBe(tierGrantMicro('free') - 350_000);
});

it('debt larger than the grant carries the remainder instead of vanishing or compounding', async () => {
    const user = await seedPasswordUser('debt2@test.dev', 'password123');
    const grant = tierGrantMicro('free');
    await setBalances(user.id, 'free', 0, -(grant + 500_000), '2000-01-01T00:00:00.000Z');
    await refreshAndGetBalance(env.arcane_db, user.id);
    const r = await getUserBillingRow(env.arcane_db, user.id);
    expect(r!.plan_credits_micro).toBe(0);
    expect(r!.topup_credits_micro).toBe(-500_000);
});

it('a positive top-up is untouched by the reset', async () => {
    const user = await seedPasswordUser('debt3@test.dev', 'password123');
    await setBalances(user.id, 'free', 0, 100_000, '2000-01-01T00:00:00.000Z');
    await refreshAndGetBalance(env.arcane_db, user.id);
    const r = await getUserBillingRow(env.arcane_db, user.id);
    expect(r!.plan_credits_micro).toBe(tierGrantMicro('free'));
    expect(r!.topup_credits_micro).toBe(100_000);
});
```

- [ ] **Step 2:** First two FAIL (topup stays negative forever).
- [ ] **Step 3: Implement:**

```ts
/** Free-tier monthly reset: SET (never add) the plan bucket and re-anchor the
 *  period. Outstanding overshoot debt (a NEGATIVE top-up — see debitCredits'
 *  final-request overspend note) is settled from the new grant here instead
 *  of surviving every reset as a permanent tax on the monthly allotment (it
 *  was only ever cleared when a purchased top-up silently paid it off).
 *  Idempotent under races once the debt is settled; a same-instant double
 *  reset with debt LARGER than the grant can double-settle — accepted, the
 *  period re-anchor makes that window one request wide. */
export async function resetFreePlanCredits(
    db: D1Database, userId: number, grantMicro: number, periodEnd: string,
): Promise<void> {
    await db.prepare(`
        UPDATE users SET
            plan_credits_micro  = MAX(0, ?1 + MIN(0, topup_credits_micro)),
            topup_credits_micro = MAX(0, topup_credits_micro) + MIN(0, ?1 + MIN(0, topup_credits_micro)),
            plan_period_end     = ?2
        WHERE id = ?3
    `).bind(grantMicro, periodEnd, userId).run();
}
```

- [ ] **Step 4:** `cd arcane-server && bun run test` → green (`credits.test.ts`, `billing-gate.test.ts`, `gating.test.ts` all touch this path).
- [ ] **Step 5: Commit** `fix(server): free-tier reset settles overshoot debt instead of taxing every future month`

---

### Task 15: full verification + wrap-up

- [ ] `cd editor && bun run verify` — tsc, module-boundary, JS suite, Rust suite, `verify:intellisense` (SKIPPED ≠ pass; report honestly if skipped).
- [ ] `cd arcane-server && bun run test` — full vitest suite.
- [ ] Re-read the diff (`git diff dev...HEAD`) against each finding; confirm every task's finding is actually closed by its change.
- [ ] Update the review memory file: mark the 15 as fixed-on-branch, reservation ledger explicitly deferred.

## Self-Review (done at planning time)

- Spec coverage: findings 1→T1, 2→T4, 3→T6, 4→T9, 5→T3, 6→T14 (+deferral note), 7/8→T13, 9→T8, 10→T5+T8, 11→T10, 12→T7, 13→T11, 14→T12, 15→T2. ✓
- Placeholder scan: all steps carry real code; the two "adapt to suite helpers" notes are instructions to reuse named existing fixtures, not gaps. ✓
- Type consistency: `computeAllowedRoots` returns `readonly string[]` (satisfies `AllowedRoots`); `endTurn`/`activeTurnId` names match between T5 and T8; `buildReviseNotesPrompt` signature matches its T12 call site; `streamCompletion`'s 4th param matches both T13 edits. ✓
