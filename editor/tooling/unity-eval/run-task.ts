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
import { createUnityApiSearchTool } from '../../src/features/ai-panel/services/unity-tools/api-search-tool';
import type { UnityApiClient } from '../../src/features/ai-panel/services/unity-tools/api-search-tool';
import { createGetUnityDocsTool } from '../../src/features/ai-panel/services/unity-tools/docs-tool';
import {
  localReadOperations,
  localWriteOperations,
  localEditOperations,
  localBashOperations,
  localListOperations,
} from './local-operations';
import { buildFixtureFacts, buildFixtureGroundingContext } from './fixture-facts';
import { createRecordingApiClient, createReplayApiClient } from './api-recordings';
import { runChecks } from './checks';
import type { EvalTask, TaskResult } from './eval-types';
import type { UsageTotals } from './eval-stream';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url).pathname;
const DEFAULT_MAX_TURNS = 12;

// Committed replay recordings live here by default; `--record` may point
// elsewhere via `--recordings-dir` (see `run-eval.ts`).
export const DEFAULT_RECORDINGS_DIR = new URL('./fixtures/api-recordings/', import.meta.url).pathname;

/**
 * Grounding client wiring for a task run. Defaults to replay (the offline,
 * committed-fixture path every eval run uses); `record` switches to the live
 * `--record` client (`run-eval.ts --record`), which always requires the
 * eval's existing chat auth mechanism's token, reused here as the
 * arcane-server bearer token.
 */
export interface GroundingConfig {
  recordingsDir?: string;
  record?: { serverUrl: string; token: string };
}

export function buildTools(
  task: EvalTask,
  workDir: string,
  groundingClient: UnityApiClient,
  unityVersion: string | null,
): AgentTool[] {
  const read = createReadTool(workDir, { operations: localReadOperations });
  const list = createListTool(workDir, { operations: localListOperations });
  // Unity read tools join every mode, matching prod's mode→tool map
  // (`agent-service.ts` — unity read tools are available in 'ask' too).
  const unityTools: AgentTool[] = [
    createUnityApiSearchTool(groundingClient),
    createGetUnityDocsTool(() => unityVersion),
  ];
  if (task.mode === 'ask') return [read, list, ...unityTools];
  return [
    read,
    list,
    ...unityTools,
    createWriteTool(workDir, { operations: localWriteOperations }),
    createEditTool(workDir, { operations: localEditOperations }),
    createBashTool(workDir, { operations: localBashOperations }),
  ];
}

export async function runTask(
  task: EvalTask,
  streamFn: StreamFn,
  usage: UsageTotals,
  opts?: { keepWorkDir?: boolean; grounding?: GroundingConfig },
): Promise<TaskResult> {
  const workDir = await mkdtemp(join(tmpdir(), `unity-eval-${task.id}-`));
  await cp(join(FIXTURES_DIR, task.fixture), workDir, { recursive: true });

  const base = task.mode === 'ask' ? buildAskPrompt(workDir) : buildAgentPrompt(workDir);
  const facts = await buildFixtureFacts(workDir);
  const systemPrompt = `${base}\n\n${facts}`;

  const groundingCtx = await buildFixtureGroundingContext(workDir);
  const recordingsDir = opts?.grounding?.recordingsDir ?? DEFAULT_RECORDINGS_DIR;
  const fixtureCtx = { fixture: task.fixture, ...groundingCtx };
  const apiClient = opts?.grounding?.record
    ? createRecordingApiClient(
        opts.grounding.record.serverUrl,
        opts.grounding.record.token,
        recordingsDir,
        fixtureCtx,
      )
    : createReplayApiClient(recordingsDir, fixtureCtx);

  const usageBefore = { ...usage };
  const agent = new Agent({
    systemPrompt,
    model: { id: 'eval', name: 'eval', provider: 'eval' },
    tools: buildTools(task, workDir, apiClient, groundingCtx.unityVersion),
    streamFn,
    convertToLlm,
    contextWindow: 131072,
  });

  const maxTurns = task.maxTurns ?? DEFAULT_MAX_TURNS;
  let turns = 0;
  // Soft cap: turn_start fires and the next LLM call dispatches in the same
  // tick, while this abort lands asynchronously via the event listener — so
  // the loop may execute one extra turn before it actually stops. The
  // `turns > maxTurns` check below the run is what makes the overrun fail.
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

  if (!error && turns > maxTurns) {
    error = `max turns exceeded (${turns} > ${maxTurns})`;
  }

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
    groundingCacheMisses: 'misses' in apiClient ? apiClient.misses : 0,
  };
}
