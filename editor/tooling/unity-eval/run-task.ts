/**
 * Run one eval task: copy the fixture to a temp dir, drive the REAL vendor
 * agent loop with local (non-Tauri) tool operations, then score the end state.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../../src/features/ai-panel/services/vendor/agent';
import { convertToLlm } from '../../src/features/ai-panel/services/vendor/messages';
import { createReadTool } from '../../src/features/ai-panel/services/vendor/tools/read';
import { createListTool } from '../../src/features/ai-panel/services/vendor/tools/list';
import { createWriteTool } from '../../src/features/ai-panel/services/vendor/tools/write';
import { createEditTool } from '../../src/features/ai-panel/services/vendor/tools/edit';
import { createBashTool } from '../../src/features/ai-panel/services/vendor/tools/bash';
import type { AgentTool, StreamFn } from '../../src/features/ai-panel/services/vendor/types';
import { buildAskPrompt } from '../../src/features/ai-panel/services/prompts/ask';
import { buildAgentPrompt } from '../../src/features/ai-panel/services/prompts/agent';
import {
  localReadOperations,
  localWriteOperations,
  localEditOperations,
  localBashOperations,
  localListOperations,
} from './local-operations';
import { buildFixtureFacts } from './fixture-facts';
import { runChecks } from './checks';
import type { EvalTask, TaskResult } from './eval-types';
import type { UsageTotals } from './eval-stream';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url).pathname;
const DEFAULT_MAX_TURNS = 12;

function buildTools(task: EvalTask, workDir: string): AgentTool[] {
  const read = createReadTool(workDir, { operations: localReadOperations });
  const list = createListTool(workDir, { operations: localListOperations });
  if (task.mode === 'ask') return [read, list];
  return [
    read,
    list,
    createWriteTool(workDir, { operations: localWriteOperations }),
    createEditTool(workDir, { operations: localEditOperations }),
    createBashTool(workDir, { operations: localBashOperations }),
  ];
}

export async function runTask(
  task: EvalTask,
  streamFn: StreamFn,
  usage: UsageTotals,
  opts?: { keepWorkDir?: boolean },
): Promise<TaskResult> {
  const workDir = await mkdtemp(join(tmpdir(), `unity-eval-${task.id}-`));
  await cp(join(FIXTURES_DIR, task.fixture), workDir, { recursive: true });

  const base = task.mode === 'ask' ? buildAskPrompt(workDir) : buildAgentPrompt(workDir);
  const facts = await buildFixtureFacts(workDir);
  const systemPrompt = `${base}\n\n${facts}`;

  const usageBefore = { ...usage };
  const agent = new Agent({
    systemPrompt,
    model: { id: 'eval', name: 'eval', provider: 'eval' },
    tools: buildTools(task, workDir),
    streamFn,
    convertToLlm,
    contextWindow: 131072,
  });

  const maxTurns = task.maxTurns ?? DEFAULT_MAX_TURNS;
  let turns = 0;
  agent.subscribe((event) => {
    if (event.type === 'turn_start') {
      turns++;
      if (turns > maxTurns) agent.abort();
    }
  });

  const started = Date.now();
  let error: string | undefined;
  let finalAnswer = '';
  try {
    const messages = await agent.prompt(task.prompt);
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && lastAssistant.role === 'assistant') {
      finalAnswer = lastAssistant.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      if (lastAssistant.stopReason === 'error') error = lastAssistant.errorMessage ?? 'model error';
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = Date.now() - started;

  const checks = await runChecks(task.checks, { workDir, finalAnswer });
  if (!opts?.keepWorkDir) await rm(workDir, { recursive: true, force: true });

  return {
    taskId: task.id,
    family: task.family,
    pass: !error && checks.every((c) => c.pass),
    checks: checks.map((c) => ({ spec: c.spec, pass: c.pass, detail: c.detail })),
    turns,
    wallMs,
    inputTokens: usage.input - usageBefore.input,
    outputTokens: usage.output - usageBefore.output,
    error,
  };
}
