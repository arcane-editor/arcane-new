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
import { lintAnswer, buildReviseMessage } from '../../src/features/ai-panel/services/grounding-lint';
import { buildFixtureFacts, buildFixtureGroundingContext } from './fixture-facts';
import { createRecordingApiClient, createReplayApiClient } from './api-recordings';
import { runChecks } from './checks';
import { withEvalAnalyzerGate } from './eval-gates';
import type { EvalTask, TaskResult } from './eval-types';
import type { UsageTotals, EvalRequestState } from './eval-stream';

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

// Mirrors production's per-task-type output ceiling (`arcane-stream.ts`'s
// `maxTokensByTask`: chat 16384 / plan 24576 / edit 24576). The eval only has
// two task modes (`ask` | `agent` — see `eval-types.ts`), so this collapses
// prod's three-way split to two: `ask` maps to prod's chat/Q&A cap, `agent`
// (which covers both plan-shaped and edit-shaped agentic work here) maps to
// prod's higher agentic cap.
export const ASK_MAX_TOKENS = 16384;
export const AGENT_MAX_TOKENS = 24576;

export function maxTokensForMode(mode: EvalTask['mode']): number {
  return mode === 'ask' ? ASK_MAX_TOKENS : AGENT_MAX_TOKENS;
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
  // Analyzer gate (eval analog of prod's F-5.3 `withUnityAnalyzerGate` /
  // `wrapCs` in `agent-service.ts`) wraps write/edit only — same tools prod
  // wraps, in the same order (gate applied first, closest to the raw tool).
  const write = withEvalAnalyzerGate(
    createWriteTool(workDir, { operations: localWriteOperations }),
    workDir,
  );
  const edit = withEvalAnalyzerGate(
    createEditTool(workDir, { operations: localEditOperations }),
    workDir,
  );
  return [
    read,
    list,
    ...unityTools,
    write,
    edit,
    createBashTool(workDir, { operations: localBashOperations }),
  ];
}

export async function runTask(
  task: EvalTask,
  streamFn: StreamFn,
  usage: UsageTotals,
  opts?: { keepWorkDir?: boolean; grounding?: GroundingConfig; requestState?: EvalRequestState },
): Promise<TaskResult> {
  // Thread this task's prod-aligned max_tokens cap into the (possibly
  // long-lived, shared-across-tasks) stream fn's mutable request state —
  // see `EvalRequestState`'s doc comment in `eval-stream.ts`.
  if (opts?.requestState) opts.requestState.maxTokens = maxTokensForMode(task.mode);

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
  // Chronological tool names for the whole run, backing the
  // `tool_called`/`tool_not_called` checks (`checks.ts`). Recorded on
  // `tool_execution_start` — i.e. at actual execution, not merely when the
  // model *requests* a tool call (a request that errors out before dispatch,
  // e.g. a schema-invalid call, would never reach execution) — so this list
  // reflects tools that genuinely ran.
  const toolCalls: string[] = [];
  // Soft cap: turn_start fires and the next LLM call dispatches in the same
  // tick, while this abort lands asynchronously via the event listener — so
  // the loop may execute one extra turn before it actually stops. The
  // `turns > maxTurns` check below the run is what makes the overrun fail.
  agent.subscribe((event) => {
    if (event.type === 'turn_start') {
      turns++;
      if (turns > maxTurns) agent.abort();
    } else if (event.type === 'tool_execution_start') {
      toolCalls.push(event.toolName);
    }
  });

  const started = Date.now();
  let error: string | undefined;
  let finalAnswer = '';
  let groundingLintHits = 0;
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

    // Eval parity for production's ask-mode grounding linter (P2.2's
    // agent-service.ts `runGroundingLint` hook): same `lintAnswer` /
    // `buildReviseMessage`, same facts source (`buildFixtureGroundingContext`,
    // already computed above as `groundingCtx` — the eval's analog of
    // production's `getUnityGroundingContext()`), same "exactly one forced
    // revise turn" cap. Skips a run that already errored or was aborted
    // (maxTurns) — nothing sound to lint, and prompting again would just
    // extend an already-failed run.
    if (!error && task.mode === 'ask' && lastAssistant?.stopReason !== 'aborted') {
      const violations = lintAnswer(finalAnswer, {
        renderPipeline: groundingCtx.renderPipeline,
        inputSystem: groundingCtx.inputSystem,
      });
      if (violations.length > 0) {
        groundingLintHits = 1;
        const reviseMessages = await agent.prompt(buildReviseMessage(violations));
        const revisedAssistant = [...reviseMessages].reverse().find((m) => m.role === 'assistant');
        if (revisedAssistant && revisedAssistant.role === 'assistant') {
          finalAnswer = revisedAssistant.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
          if (revisedAssistant.stopReason === 'error') {
            error = revisedAssistant.errorMessage ?? 'model error';
          }
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = Date.now() - started;

  if (!error && turns > maxTurns) {
    error = `max turns exceeded (${turns} > ${maxTurns})`;
  }

  const checks = await runChecks(task.checks, { workDir, finalAnswer, toolCalls });
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
    recordFailures: 'recordFailures' in apiClient ? apiClient.recordFailures : 0,
    groundingLintHits,
    toolCalls,
  };
}
