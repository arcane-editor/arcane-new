import { describe, it, expect, beforeEach } from 'bun:test';
import { Type } from '@sinclair/typebox';
import {
  withWriteApproval,
  resetWriteApprovalSession,
  isRejectedWrite,
  type WriteApprovalDeps,
  type WriteApprovalDecision,
  type PendingWriteDiff,
} from './write-approval-gate';
import { applyEdits, type Edit } from './vendor/tools/edit-diff';
import type { AgentTool, AgentToolResult } from './vendor/types';

const CWD = '/proj';

function fakeWriteTool(name: 'write' | 'edit' = 'write'): {
  tool: AgentTool;
  calls: () => number;
} {
  let calls = 0;
  const tool: AgentTool = {
    name,
    label: name,
    description: 'fake',
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult> {
      calls++;
      return { content: [{ type: 'text', text: `Successfully ${name === 'write' ? 'wrote' : 'edited'} 1 bytes (1 lines) to /proj/Foo.cs` }] };
    },
  };
  return { tool, calls: () => calls };
}

interface FakeApprovalRequest {
  toolCallId: string;
  toolName: string;
  diff: PendingWriteDiff;
  signal?: AbortSignal;
}

/** Records every approval request and resolves with a preset decision (or a per-call queue). */
function fakeApprovalDeps(
  decisions: WriteApprovalDecision | WriteApprovalDecision[],
  overrides: Partial<WriteApprovalDeps> = {},
): { deps: WriteApprovalDeps; requests: FakeApprovalRequest[] } {
  const requests: FakeApprovalRequest[] = [];
  const queue = Array.isArray(decisions) ? [...decisions] : [decisions];
  const deps: WriteApprovalDeps = {
    readFile: async () => null,
    getApplyMode: () => 'approve',
    getAlwaysApproveUnityAssets: () => true,
    requestApproval: async (toolCallId, toolName, diff, signal) => {
      requests.push({ toolCallId, toolName, diff, signal });
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    ...overrides,
  };
  return { deps, requests };
}

describe('withWriteApproval', () => {
  beforeEach(() => {
    resetWriteApprovalSession();
  });

  it('approve → prompts once, then delegates to the inner tool exactly once', async () => {
    const { tool, calls } = fakeWriteTool('write');
    const { deps, requests } = fakeApprovalDeps('apply', {
      readFile: async () => 'old content\n',
    });
    const gate = withWriteApproval(tool, CWD, { deps });

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'new content\n' });

    expect(requests).toHaveLength(1);
    expect(requests[0].diff).toEqual({ path: '/proj/Foo.cs', oldText: 'old content\n', newText: 'new content\n' });
    expect(calls()).toBe(1);
    expect(res.content[0]).toMatchObject({ text: expect.stringContaining('Successfully wrote') });
  });

  it('reject → the inner tool is never called, and the result carries the rejection text + marker', async () => {
    const { tool, calls } = fakeWriteTool('write');
    const { deps } = fakeApprovalDeps('reject', { readFile: async () => 'old\n' });
    const gate = withWriteApproval(tool, CWD, { deps });

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'new\n' });

    expect(calls()).toBe(0);
    expect(res.content[0]).toMatchObject({
      text: 'User rejected this edit to /proj/Foo.cs. Ask before retrying or take a different approach.',
    });
    expect(isRejectedWrite(res)).toBe(true);
  });

  it('reject makes a downstream gate inert (fake gate composed OUTSIDE this one, mirroring the real cs-gate wiring)', async () => {
    const { tool } = fakeWriteTool('write');
    const { deps } = fakeApprovalDeps('reject', { readFile: async () => 'old\n' });
    const approvalGated = withWriteApproval(tool, CWD, { deps });

    let fakeGateRan = false;
    const outerGate: AgentTool = {
      ...approvalGated,
      async execute(id, params, signal, onUpdate) {
        const res = await approvalGated.execute(id, params, signal, onUpdate);
        if (isRejectedWrite(res)) return res; // the early-out under test
        fakeGateRan = true;
        return { content: [...res.content, { type: 'text', text: '[fake gate] ran' }] };
      },
    };

    const res = await outerGate.execute('call-1', { path: 'Foo.cs', content: 'new\n' });

    expect(fakeGateRan).toBe(false);
    expect(res.content.some((c) => c.type === 'text' && c.text.includes('[fake gate] ran'))).toBe(false);
  });

  it('abort (already aborted by the time the diff is ready) → treated as reject, never even asks for approval', async () => {
    // The pre-approval work (readFile, diff-compute) is genuinely async, so an
    // abort can land before `requestApproval` is ever called — this must
    // resolve to reject WITHOUT depending on a signal 'abort' listener that
    // wouldn't fire for an already-aborted signal (a real hang risk: see this
    // module's comment on the check ahead of `deps.requestApproval`).
    const { tool, calls } = fakeWriteTool('write');
    const controller = new AbortController();
    controller.abort();
    let requestApprovalCalled = false;
    const { deps } = fakeApprovalDeps('apply', {
      readFile: async () => 'old\n',
      requestApproval: async () => {
        requestApprovalCalled = true;
        return 'apply';
      },
    });
    const gate = withWriteApproval(tool, CWD, { deps });

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'new\n' }, controller.signal);

    expect(requestApprovalCalled).toBe(false);
    expect(calls()).toBe(0);
    expect(isRejectedWrite(res)).toBe(true);
  });

  it('session-allow ("apply all this session") → the SECOND write for a different file skips the prompt entirely', async () => {
    const { tool: tool1 } = fakeWriteTool('write');
    const { tool: tool2, calls: calls2 } = fakeWriteTool('write');
    const { deps, requests } = fakeApprovalDeps('apply-all', { readFile: async () => 'old\n' });

    const gate1 = withWriteApproval(tool1, CWD, { deps });
    await gate1.execute('call-1', { path: 'Foo.cs', content: 'new\n' });
    expect(requests).toHaveLength(1);

    // A second, independently-constructed gate instance still consults the
    // SAME module-level session flag.
    const gate2 = withWriteApproval(tool2, CWD, { deps });
    await gate2.execute('call-2', { path: 'Bar.cs', content: 'new\n' });

    expect(requests).toHaveLength(1); // no second prompt
    expect(calls2()).toBe(1); // but the write still happened
  });

  it("auto mode → immediate delegate, no prompt at all", async () => {
    const { tool, calls } = fakeWriteTool('write');
    const { deps, requests } = fakeApprovalDeps('reject', {
      getApplyMode: () => 'auto',
      readFile: async () => {
        throw new Error('should never be read in the immediate-delegate path');
      },
    });
    const gate = withWriteApproval(tool, CWD, { deps });

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'new\n' });

    expect(requests).toHaveLength(0);
    expect(calls()).toBe(1);
    expect(res.content[0]).toMatchObject({ text: expect.stringContaining('Successfully wrote') });
  });

  it('auto mode + a serialized Unity asset (.prefab) → still prompts', async () => {
    const { tool, calls } = fakeWriteTool('write');
    const { deps, requests } = fakeApprovalDeps('apply', {
      getApplyMode: () => 'auto',
      readFile: async () => 'old\n',
    });
    const gate = withWriteApproval(tool, CWD, { deps });

    await gate.execute('call-1', { path: 'Assets/Player.prefab', content: 'new\n' });

    expect(requests).toHaveLength(1);
    expect(calls()).toBe(1);
  });

  it('alwaysApproveUnityAssets=false + auto mode + .prefab → no prompt', async () => {
    const { tool, calls } = fakeWriteTool('write');
    const { deps, requests } = fakeApprovalDeps('reject', {
      getApplyMode: () => 'auto',
      getAlwaysApproveUnityAssets: () => false,
    });
    const gate = withWriteApproval(tool, CWD, { deps });

    await gate.execute('call-1', { path: 'Assets/Player.prefab', content: 'new\n' });

    expect(requests).toHaveLength(0);
    expect(calls()).toBe(1);
  });

  it('a serialized Unity asset still prompts even with the session-allow flag already set', async () => {
    const { tool: unityTool } = fakeWriteTool('write');
    const { tool: prefabTool } = fakeWriteTool('write');
    const { deps, requests } = fakeApprovalDeps('apply-all', { readFile: async () => 'old\n' });

    // First write sets the session-allow flag.
    await withWriteApproval(unityTool, CWD, { deps }).execute('call-1', { path: 'Foo.cs', content: 'new\n' });
    expect(requests).toHaveLength(1);

    // A .prefab write afterward must STILL prompt, despite session-allow being set.
    await withWriteApproval(prefabTool, CWD, { deps }).execute('call-2', {
      path: 'Assets/Player.prefab',
      content: 'new\n',
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].diff.path).toBe('/proj/Assets/Player.prefab');
  });

  it('no path param → delegates immediately, never reads or prompts', async () => {
    const { tool, calls } = fakeWriteTool('write');
    let readCalled = false;
    const { deps, requests } = fakeApprovalDeps('reject', {
      readFile: async () => {
        readCalled = true;
        return null;
      },
    });
    const gate = withWriteApproval(tool, CWD, { deps });

    await gate.execute('call-1', {});

    expect(readCalled).toBe(false);
    expect(requests).toHaveLength(0);
    expect(calls()).toBe(1);
  });

  it('a path outside allowedRoot delegates immediately (the inner tool rejects it itself)', async () => {
    const { tool, calls } = fakeWriteTool('write');
    let readCalled = false;
    const { deps, requests } = fakeApprovalDeps('reject', {
      readFile: async () => {
        readCalled = true;
        return null;
      },
    });
    const gate = withWriteApproval(tool, CWD, { allowedRoot: '/proj/Assets', deps });

    await gate.execute('call-1', { path: 'Secrets.cs', content: 'x' });

    expect(readCalled).toBe(false);
    expect(requests).toHaveLength(0);
    expect(calls()).toBe(1);
  });

  describe('pending-diff computation', () => {
    it('write: diff is current disk content (or "") vs params.content', async () => {
      const { tool } = fakeWriteTool('write');
      const { deps, requests } = fakeApprovalDeps('apply', { readFile: async () => null });
      await withWriteApproval(tool, CWD, { deps }).execute('call-1', { path: 'New.cs', content: 'brand new\n' });

      expect(requests[0].diff).toEqual({ path: '/proj/New.cs', oldText: '', newText: 'brand new\n' });
    });

    it('edit: computed newText has EXACT parity with applyEdits — the same pure function vendor/tools/edit.ts uses', async () => {
      const { tool } = fakeWriteTool('edit');
      const current = 'function Foo() {\n  return 1;\n}\n';
      const edits: Edit[] = [{ oldText: 'return 1;', newText: 'return 2;' }];
      const { deps, requests } = fakeApprovalDeps('apply', { readFile: async () => current });

      await withWriteApproval(tool, CWD, { deps }).execute('call-1', { path: 'Foo.cs', edits });

      const expected = applyEdits(current, edits);
      expect(expected.applied).toBe(true);
      expect(requests[0].diff).toEqual({ path: '/proj/Foo.cs', oldText: current, newText: expected.content });
    });

    it('edit: when applyEdits cannot find the search text, skip the prompt and let the real tool fail naturally', async () => {
      let delegated = false;
      const tool: AgentTool = {
        name: 'edit',
        label: 'edit',
        description: 'fake',
        parameters: Type.Object({}),
        async execute(): Promise<AgentToolResult> {
          delegated = true;
          // Mirrors the real edit.ts's error text for an unmatched search string.
          return { content: [{ type: 'text', text: 'Edit 1: Could not find text to replace:\n"does not exist"' }] };
        },
      };
      const current = 'no match here\n';
      const edits: Edit[] = [{ oldText: 'does not exist', newText: 'replacement' }];
      const { deps, requests } = fakeApprovalDeps('reject', { readFile: async () => current });

      const res = await withWriteApproval(tool, CWD, { deps }).execute('call-1', { path: 'Foo.cs', edits });

      expect(requests).toHaveLength(0); // no prompt over an impossible edit
      expect(delegated).toBe(true); // delegated straight through instead
      expect(res.content[0]).toMatchObject({ text: expect.stringContaining('Could not find text to replace') });
    });
  });
});
