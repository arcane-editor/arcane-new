import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '../../src/features/ai-panel/services/vendor/event-stream';
import type { StreamFn, AssistantMessage } from '../../src/features/ai-panel/services/vendor/types';
import type { UnityApiClient } from '../../src/features/ai-panel/services/unity-tools/api-search-tool';
import { runTask, buildTools, maxTokensForMode, ASK_MAX_TOKENS, AGENT_MAX_TOKENS } from './run-task';
import type { EvalTask } from './eval-types';
import type { EvalRequestState } from './eval-stream';

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

  it('records executed tool names on toolCalls, in order, and scores tool_called/tool_not_called against them', async () => {
    const streamFn = scriptedStreamFn([
      [
        { type: 'text', text: 'Reading the manifest first.' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'Packages/manifest.json' } },
      ],
      [
        {
          type: 'toolCall', id: 'c2', name: 'write',
          arguments: { path: 'Assets/Scripts/Pickup.cs', content: 'public class Pickup {}' },
        },
      ],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const usage = { input: 0, output: 0, requests: 0 };
    const toolCallTask = {
      ...task,
      checks: [
        { type: 'tool_called' as const, tool: 'read' },
        { type: 'tool_called' as const, tool: 'write' },
        { type: 'tool_not_called' as const, tool: 'unity_api_search' },
      ],
    };
    const result = await runTask(toolCallTask, streamFn, usage);
    expect(result.toolCalls).toEqual(['read', 'write']);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  it('threads the prod-aligned max_tokens value for the task mode into a shared requestState', async () => {
    const streamFn = scriptedStreamFn([[{ type: 'text', text: 'no tools needed' }]]);
    const usage = { input: 0, output: 0, requests: 0 };
    const requestState: EvalRequestState = { maxTokens: 1 };
    await runTask({ ...task, mode: 'ask' }, streamFn, usage, { requestState });
    expect(requestState.maxTokens).toBe(ASK_MAX_TOKENS);

    const agentStreamFn = scriptedStreamFn([[{ type: 'text', text: 'no tools needed' }]]);
    await runTask({ ...task, mode: 'agent', maxTurns: 1 }, agentStreamFn, usage, { requestState });
    expect(requestState.maxTokens).toBe(AGENT_MAX_TOKENS);
  });
});

describe('maxTokensForMode', () => {
  it('maps ask mode to the prod chat cap and agent mode to the prod agentic cap', () => {
    expect(maxTokensForMode('ask')).toBe(ASK_MAX_TOKENS);
    expect(maxTokensForMode('agent')).toBe(AGENT_MAX_TOKENS);
    expect(ASK_MAX_TOKENS).toBe(16384);
    expect(AGENT_MAX_TOKENS).toBe(24576);
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

  it('wraps agent-mode write/edit with the analyzer gate (F-5.3 parity, wrapCs equivalent)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-buildtools-'));
    try {
      const tools = buildTools({ ...task, mode: 'agent' }, dir, fakeGroundingClient, '2022.3.45f1');
      const write = tools.find((t) => t.name === 'write')!;
      const result = await write.execute('c1', {
        path: 'Assets/Bad.cs',
        content: 'using UnityEngine;\nusing UnityEditor;\npublic class Bad : MonoBehaviour { }',
      });
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('[Unity analyzers]');
      expect(text).toContain('UNITY0305');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
