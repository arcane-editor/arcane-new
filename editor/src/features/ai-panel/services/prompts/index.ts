/**
 * System prompt selection by mode.
 *
 * Each function returns the full system prompt string given the workspace path
 * (and any extra args required by that mode). All prompts include the shared
 * Unity context block from unity-context.ts.
 */

import { buildAskPrompt } from './ask';
import { buildAgentPrompt } from './agent';
import { buildPreplanningPrompt } from './preplanning';
import { buildPlanPlanningPrompt } from './plan-planning';
import {
  buildPlanExecutionPrompt,
  type PlanExecutionPromptArgs,
} from './plan-execution';
import type { ChatMode, Effort } from '../types';
import { buildGraphSnapshot, graphSnapshotBudget } from '../../../graphify';
import { useGraphifyStore } from '../../../../stores/graphify';
import { useAsmdefStore } from '../../../../stores/asmdef';
import { useWorkspaceStore } from '../../../../stores/workspace';
import { getMemoryDigestSync } from '../memory/memory-cache';
import { getUnityFactsBlock } from './unity-facts';
import { getFrozenDecoration, type FrozenBlocks } from './frozen-context';
import { buildContextPackText, CONTEXT_PACK_BUDGETS } from './context-pack';

/**
 * Common decorators applied to every mode's base prompt:
 *   [STABLE: base prompt incl. static Unity context crib]
 *   [FROZEN PER CONVERSATION: Unity project facts + context pack + graph snapshot]
 *
 * The trailing blocks are captured from live stores the FIRST time a
 * conversation builds its prompt and then frozen for the conversation's
 * lifetime (frozen-context.ts) — a byte-stable system prompt is what lets
 * provider prefix caches keep the whole conversation history cached. Drift
 * (graph rebuilds, facts changes) is surfaced at the message tail instead,
 * by agent-service.ts.
 *
 * The graph snapshot's char budget scales with the effort of the send that
 * captures it (see graphSnapshotBudget).
 */
function decorate(base: string, effort: Effort, conversationId?: string | null): string {
  const blocks = getFrozenDecoration(conversationId, () => captureDecoration(effort));

  const parts: string[] = [base];
  if (blocks.factsBlock) parts.push(blocks.factsBlock);
  if (blocks.contextPack) parts.push(blocks.contextPack);
  if (blocks.graphSnapshot) parts.push(blocks.graphSnapshot);
  return parts.join('\n\n');
}

/**
 * Live capture of the decoration blocks. Exported for agent-service.ts's
 * drift detection (`graphChangedSinceFreeze` compares a fresh capture's
 * snapshot against the frozen one).
 */
export function captureDecoration(effort: Effort): FrozenBlocks {
  // Context pack inputs (spec §3): the asmdef graph and graphify god-node
  // files the editor already maintains, condensed deterministically.
  const assemblies = useAsmdefStore.getState().graph.map((n) => ({
    name: n.name,
    references: n.references ?? [],
    isEditorOnly: n.is_editor_only,
  }));
  const keyFiles = (useGraphifyStore.getState().summary?.god_nodes ?? [])
    .map((g) => g.source_file)
    .filter((f): f is string => !!f);

  const workspacePath = useWorkspaceStore.getState().workspacePath ?? '';

  return {
    factsBlock: getUnityFactsBlock(),
    contextPack: buildContextPackText(
      { assemblies, keyFiles, memoryDigest: getMemoryDigestSync(workspacePath) },
      CONTEXT_PACK_BUDGETS[effort],
    ),
    graphSnapshot: buildGraphSnapshot({ maxChars: graphSnapshotBudget(effort) }),
  };
}

/**
 * Internal mode resolution — Plan mode has two phases that need different
 * system prompts. Callers outside the agent service shouldn't need to think
 * about this; they pass `mode` (ask/agent/plan), and the agent service maps
 * to the right phase based on planPhase state.
 */
export type PromptMode = 'ask' | 'agent' | 'preplanning' | 'plan-planning' | 'plan-execution';

export interface BuildSystemPromptOpts {
  /** Drives the graph-snapshot char budget. Defaults to 'mid'. */
  effort?: Effort;
  /** Required when mode === 'plan-execution'. */
  planExecution?: Omit<PlanExecutionPromptArgs, 'workspacePath'>;
  /**
   * The conversation (ai-store session) id. When set, the volatile decoration
   * blocks are frozen per conversation (see frozen-context.ts) so the system
   * prompt stays byte-identical across sends and provider prefix caches hold.
   */
  conversationId?: string | null;
}

export function buildSystemPrompt(
  mode: PromptMode,
  workspacePath: string,
  opts?: BuildSystemPromptOpts,
): string {
  const effort = opts?.effort ?? 'mid';
  const conversationId = opts?.conversationId;
  switch (mode) {
    case 'ask':
      return decorate(buildAskPrompt(workspacePath), effort, conversationId);
    case 'agent':
      return decorate(buildAgentPrompt(workspacePath), effort, conversationId);
    case 'preplanning':
      return decorate(
        buildPreplanningPrompt(workspacePath, { difficultyTags: effort === 'high' }),
        effort,
        conversationId,
      );
    case 'plan-planning':
      return decorate(buildPlanPlanningPrompt(workspacePath), effort, conversationId);
    case 'plan-execution':
      if (!opts?.planExecution) {
        throw new Error('plan-execution prompt requires planPath and planContent');
      }
      return decorate(
        buildPlanExecutionPrompt({ workspacePath, ...opts.planExecution }),
        effort,
        conversationId,
      );
  }
}

/**
 * Convenience: pick the prompt mode from a chat mode (without plan-phase awareness).
 * Plan mode defaults to planning prompt; the agent service overrides this with
 * plan-execution when actually executing.
 */
export function defaultPromptModeFor(mode: ChatMode): PromptMode {
  switch (mode) {
    case 'ask':
      return 'ask';
    case 'agent':
      return 'agent';
    case 'plan':
      return 'plan-planning';
  }
}
