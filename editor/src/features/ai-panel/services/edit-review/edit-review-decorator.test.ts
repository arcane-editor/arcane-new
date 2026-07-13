import { describe, it, expect } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { withEditReview, type EditReviewDecoratorDeps } from './edit-review-decorator';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import type { ShouldRegisterReviewOptions } from './review-registration';

const AUTO_SETTINGS: ShouldRegisterReviewOptions = {
  applyMode: 'auto',
  alwaysApproveUnityAssets: true,
  checkpointsEnabled: true,
};

const APPROVE_SETTINGS: ShouldRegisterReviewOptions = {
  ...AUTO_SETTINGS,
  applyMode: 'approve',
};

function fakeTool(result: AgentToolResult): AgentTool {
  return {
    name: 'write',
    label: 'write',
    description: 'fake write tool',
    parameters: Type.Object({}),
    async execute() {
      return result;
    },
  };
}

function fakeDeps(settings: ShouldRegisterReviewOptions): {
  deps: EditReviewDecoratorDeps;
  registered: Array<{ path: string; toolCallId: string }>;
} {
  const registered: Array<{ path: string; toolCallId: string }> = [];
  return {
    registered,
    deps: {
      settingsSnapshot: () => settings,
      register: (path, toolCallId) => registered.push({ path, toolCallId }),
    },
  };
}

describe('withEditReview', () => {
  it('registers once per diff path with the execute id', async () => {
    const result: AgentToolResult = {
      content: [{ type: 'text', text: 'ok' }],
      diffs: [{ path: '/proj/Foo.cs', oldText: 'a', newText: 'b' }],
    };
    const { deps, registered } = fakeDeps(AUTO_SETTINGS);
    const tool = withEditReview(fakeTool(result), deps);

    await tool.execute('call-1', { path: 'Foo.cs' });

    expect(registered).toEqual([{ path: '/proj/Foo.cs', toolCallId: 'call-1' }]);
  });

  it('no `diffs` on the result → no registration', async () => {
    const result: AgentToolResult = { content: [{ type: 'text', text: 'ok' }] };
    const { deps, registered } = fakeDeps(AUTO_SETTINGS);
    const tool = withEditReview(fakeTool(result), deps);

    await tool.execute('call-1', { path: 'Foo.cs' });

    expect(registered).toEqual([]);
  });

  it('an empty `diffs` array → no registration', async () => {
    const result: AgentToolResult = { content: [{ type: 'text', text: 'ok' }], diffs: [] };
    const { deps, registered } = fakeDeps(AUTO_SETTINGS);
    const tool = withEditReview(fakeTool(result), deps);

    await tool.execute('call-1', { path: 'Foo.cs' });

    expect(registered).toEqual([]);
  });

  it('returns the inner result BY REFERENCE, untouched', async () => {
    const result: AgentToolResult = {
      content: [{ type: 'text', text: 'ok' }],
      diffs: [{ path: '/proj/Foo.cs', oldText: 'a', newText: 'b' }],
    };
    const { deps } = fakeDeps(AUTO_SETTINGS);
    const tool = withEditReview(fakeTool(result), deps);

    const out = await tool.execute('call-1', { path: 'Foo.cs' });

    expect(out).toBe(result);
  });

  it('settings=approve → no registration even with diffs present', async () => {
    const result: AgentToolResult = {
      content: [{ type: 'text', text: 'ok' }],
      diffs: [{ path: '/proj/Foo.cs', oldText: 'a', newText: 'b' }],
    };
    const { deps, registered } = fakeDeps(APPROVE_SETTINGS);
    const tool = withEditReview(fakeTool(result), deps);

    await tool.execute('call-1', { path: 'Foo.cs' });

    expect(registered).toEqual([]);
  });

  it('multiple diffs → multiple registrations, all with the same execute id', async () => {
    const result: AgentToolResult = {
      content: [{ type: 'text', text: 'ok' }],
      diffs: [
        { path: '/proj/A.cs', oldText: '', newText: 'a' },
        { path: '/proj/B.cs', oldText: '', newText: 'b' },
      ],
    };
    const { deps, registered } = fakeDeps(AUTO_SETTINGS);
    const tool = withEditReview(fakeTool(result), deps);

    await tool.execute('call-1', { path: 'A.cs' });

    expect(registered).toEqual([
      { path: '/proj/A.cs', toolCallId: 'call-1' },
      { path: '/proj/B.cs', toolCallId: 'call-1' },
    ]);
  });

  it('an inner-tool error result without diffs → no registration', async () => {
    const result: AgentToolResult = { content: [{ type: 'text', text: 'Error: disk full' }] };
    const { deps, registered } = fakeDeps(AUTO_SETTINGS);
    const tool = withEditReview(fakeTool(result), deps);

    await tool.execute('call-1', { path: 'Foo.cs' });

    expect(registered).toEqual([]);
  });

  it('a Unity asset path with alwaysApproveUnityAssets=true → no registration even in auto mode', async () => {
    const result: AgentToolResult = {
      content: [{ type: 'text', text: 'ok' }],
      diffs: [{ path: '/proj/Assets/Player.prefab', oldText: 'a', newText: 'b' }],
    };
    const { deps, registered } = fakeDeps(AUTO_SETTINGS);
    const tool = withEditReview(fakeTool(result), deps);

    await tool.execute('call-1', { path: 'Assets/Player.prefab' });

    expect(registered).toEqual([]);
  });
});
