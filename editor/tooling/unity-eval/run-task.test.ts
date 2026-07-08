import { describe, it, expect } from 'bun:test';
import { AssistantMessageEventStream } from '../../src/features/ai-panel/services/vendor/event-stream';
import type { StreamFn, AssistantMessage } from '../../src/features/ai-panel/services/vendor/types';
import type { UnityApiClient } from '../../src/features/ai-panel/services/unity-tools/api-search-tool';
import { runTask, buildTools } from './run-task';
import type { EvalTask } from './eval-types';

const fakeGroundingClient: UnityApiClient = {
  search: async () => ({ ok: true, data: [] }),
  lookup: async () => ({ ok: true, data: [] }),
};

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

/**
 * A model that never stops on its own: every call issues another tool call
 * (re-reading a fixture file that always exists), so the loop only ends via
 * the maxTurns abort — never naturally.
 */
function runawayStreamFn(): StreamFn {
  let call = 0;
  return () => {
    const stream = new AssistantMessageEventStream();
    const id = `runaway-${call++}`;
    stream.push({ type: 'start' });
    stream.push({
      type: 'done',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id, name: 'read', arguments: { path: 'Packages/manifest.json' } },
        ],
        stopReason: 'toolUse',
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

  it('fails a runaway agent that never stops on its own, once maxTurns is exceeded', async () => {
    const runawayTask: EvalTask = { ...task, maxTurns: 3 };
    const usage = { input: 0, output: 0, requests: 0 };
    const result = await runTask(runawayTask, runawayStreamFn(), usage);
    expect(result.pass).toBe(false);
    expect(result.error).toContain('max turns exceeded');
    expect(result.turns).toBeLessThanOrEqual(runawayTask.maxTurns! + 1);
  });

  it('surfaces groundingCacheMisses on the result (0 when the grounding tool is never called)', async () => {
    const streamFn = scriptedStreamFn([[{ type: 'text', text: 'no tools needed' }]]);
    const usage = { input: 0, output: 0, requests: 0 };
    const result = await runTask({ ...task, mode: 'ask' }, streamFn, usage);
    expect(result.groundingCacheMisses).toBe(0);
  });
});

describe('buildTools', () => {
  it('includes unity_api_search and get_unity_docs in ask mode (matching prod\'s mode→tool map)', () => {
    const tools = buildTools(task, '/tmp/unused', fakeGroundingClient, '2022.3.45f1');
    const names = tools.map((t) => t.name);
    expect(names).toContain('unity_api_search');
    expect(names).toContain('get_unity_docs');
  });

  it('includes unity_api_search and get_unity_docs in agent mode too, alongside write/edit/bash', () => {
    const tools = buildTools({ ...task, mode: 'agent' }, '/tmp/unused', fakeGroundingClient, '2022.3.45f1');
    const names = tools.map((t) => t.name);
    expect(names).toContain('unity_api_search');
    expect(names).toContain('get_unity_docs');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
  });

  it('excludes write/edit/bash in ask mode', () => {
    const tools = buildTools({ ...task, mode: 'ask' }, '/tmp/unused', fakeGroundingClient, '2022.3.45f1');
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('bash');
  });
});
