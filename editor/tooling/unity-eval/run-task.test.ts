import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '../../src/features/ai-panel/services/vendor/event-stream';
import type { Context, StreamFn, AssistantMessage } from '../../src/features/ai-panel/services/vendor/types';
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
 * A model that never stops VOLUNTARILY — as long as tools are offered, it
 * always issues another tool call (re-reading a fixture file that always
 * exists) instead of answering. Once the turn governor (P3.2) strips
 * `tools` from the request at the cap, a real model literally can't emit a
 * function call anymore — this fake mirrors that by checking
 * `context.tools.length`, so it exercises the actual "stops because tools
 * are gone" mechanism instead of a canned response that ignores the
 * request it was given.
 */
function runawayStreamFn(): { streamFn: StreamFn; lastContext: () => Context | undefined } {
  let call = 0;
  let lastContext: Context | undefined;
  const streamFn: StreamFn = (context) => {
    lastContext = context;
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'start' });
    if (context.tools.length === 0) {
      stream.push({
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Wrapping up as asked.' }],
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      });
    } else {
      const id = `runaway-${call++}`;
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
    }
    return stream;
  };
  return { streamFn, lastContext: () => lastContext };
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

  it('ends gracefully at the turn-governor cap for an agent that never stops on its own — fails on CHECKS, not a max-turns error', async () => {
    const runawayTask: EvalTask = { ...task, maxTurns: 3 };
    const usage = { input: 0, output: 0, requests: 0 };
    const { streamFn, lastContext } = runawayStreamFn();
    const result = await runTask(runawayTask, streamFn, usage);

    expect(result.error).toBeUndefined();
    expect(result.turns).toBe(3);
    expect(result.pass).toBe(false); // no file was ever written — fails on checks
    expect(result.checks.some((c) => !c.pass)).toBe(true);

    // The final request had tools stripped and carried the one-shot wrap-up
    // message (P3.2's `withTurnGovernor`), which is what let the loop end
    // naturally instead of needing an abort.
    const finalRequest = lastContext();
    expect(finalRequest?.tools).toEqual([]);
    expect(
      finalRequest?.messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('one response left'),
      ),
    ).toBe(true);
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

describe('runTask — grounding linter parity (P2.2)', () => {
  const groundingAskTask: EvalTask = {
    id: 'mock-ground-001',
    family: 'grounding',
    fixture: 'urp-newinput', // URP + New Input System
    mode: 'ask',
    prompt: 'How do I tint this material red?',
    checks: [],
  };

  /** Wraps a scripted StreamFn with a call counter so tests can assert exact LLM-call counts. */
  function countingStreamFn(script: AssistantMessage['content'][]): { streamFn: StreamFn; calls: () => number } {
    const inner = scriptedStreamFn(script);
    let calls = 0;
    const streamFn: StreamFn = (ctx, opts) => {
      calls++;
      return inner(ctx, opts);
    };
    return { streamFn, calls: () => calls };
  }

  it('a violating first answer triggers exactly one revise cycle and grades the revised (clean) answer', async () => {
    const { streamFn, calls } = countingStreamFn([
      [
        {
          type: 'text',
          text: ['Here you go:', '', '```csharp', 'material.SetColor("_Color", Color.red);', '```'].join('\n'),
        },
      ],
      [{ type: 'text', text: ['```csharp', 'material.SetColor("_BaseColor", Color.red);', '```'].join('\n') }],
    ]);
    const usage = { input: 0, output: 0, requests: 0 };
    const result = await runTask(
      {
        ...groundingAskTask,
        checks: [
          { type: 'answer_matches', pattern: '_BaseColor' },
          { type: 'answer_not_matches', pattern: '"_Color"' },
        ],
      },
      streamFn,
      usage,
    );
    expect(result.groundingLintHits).toBe(1);
    expect(calls()).toBe(2);
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(result.pass).toBe(true);
  });

  it('a clean first answer never triggers a revise cycle (single LLM call)', async () => {
    const { streamFn, calls } = countingStreamFn([
      [{ type: 'text', text: ['```csharp', 'material.SetColor("_BaseColor", Color.red);', '```'].join('\n') }],
    ]);
    const usage = { input: 0, output: 0, requests: 0 };
    const result = await runTask(
      { ...groundingAskTask, checks: [{ type: 'answer_matches', pattern: '_BaseColor' }] },
      streamFn,
      usage,
    );
    expect(result.groundingLintHits).toBe(0);
    expect(calls()).toBe(1);
    expect(result.pass).toBe(true);
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
