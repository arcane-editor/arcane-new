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
