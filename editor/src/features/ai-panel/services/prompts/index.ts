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
import { buildUiDesignPrompt, type UiDesignPromptArgs } from './ui-design';
import type { ChatMode, Effort } from '../types';
import { buildGraphSnapshot, graphSnapshotBudget } from '../../../graphify';
import { useGraphifyStore } from '../../../../stores/graphify';
import { useAsmdefStore } from '../../../../stores/asmdef';
import { useWorkspaceStore } from '../../../../stores/workspace';
import { getMemoryDigestSync } from '../memory/memory-cache';
import { getUnityFactsBlock } from './unity-facts';
import type { Subsystem } from './subsystem-facts';
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
 *
 * **`codeContext: false` drops the last two blocks**, and design mode is the
 * one caller that sets it. Both blocks are C#-only by construction — the
 * graphify graph is built with `includeExt: ['.cs']`, so its god nodes can only
 * ever be scripts — and the context pack renders them under the heading
 * "Key files (structurally central — **read these first**)". A design turn was
 * therefore opening with a literal instruction to go read up to twelve C#
 * files, which is most of why it kept doing exactly that. The facts block
 * stays: it is where the project's USS variables and PanelSettings live.
 *
 * Filtering happens HERE rather than in `captureDecoration` on purpose — the
 * frozen blocks stay byte-identical whatever mode reads them, so
 * `graphChangedSinceFreeze`'s drift comparison keeps working and a conversation
 * that switches modes cannot invalidate its own prefix cache.
 */
function decorate(
  base: string,
  effort: Effort,
  conversationId?: string | null,
  opts?: { codeContext?: boolean; forceSubsystems?: readonly Subsystem[] },
): string {
  const blocks = getFrozenDecoration(conversationId, () =>
    captureDecoration(effort, { forceSubsystems: opts?.forceSubsystems }),
  );
  const codeContext = opts?.codeContext ?? true;

  const parts: string[] = [base];
  if (blocks.factsBlock) parts.push(blocks.factsBlock);
  if (codeContext && blocks.contextPack) parts.push(blocks.contextPack);
  if (codeContext && blocks.graphSnapshot) parts.push(blocks.graphSnapshot);
  return parts.join('\n\n');
}

/**
 * Live capture of the decoration blocks. Exported for agent-service.ts's
 * drift detection (`graphChangedSinceFreeze` compares a fresh capture's
 * snapshot against the frozen one).
 */
export function captureDecoration(
  effort: Effort,
  opts?: { forceSubsystems?: readonly Subsystem[] },
): FrozenBlocks {
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
    factsBlock: getUnityFactsBlock({ forceSubsystems: opts?.forceSubsystems }),
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
export type PromptMode =
  | 'ask'
  | 'agent'
  | 'preplanning'
  | 'plan-planning'
  | 'plan-execution'
  | 'ui-design';

export interface BuildSystemPromptOpts {
  /** Drives the graph-snapshot char budget. Defaults to 'mid'. */
  effort?: Effort;
  /** Required when mode === 'plan-execution'. */
  planExecution?: Omit<PlanExecutionPromptArgs, 'workspacePath'>;
  /**
   * Required when mode === 'ui-design'. Names the one document that session is
   * scoped to — the prompt is written around it, so there is no useful
   * document-less form of this mode.
   */
  uiDesign?: UiDesignPromptArgs;
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
      return decorate(
        buildPlanPlanningPrompt(workspacePath, { difficultyTags: effort === 'high' }),
        effort,
        conversationId,
      );
    case 'plan-execution':
      if (!opts?.planExecution) {
        throw new Error('plan-execution prompt requires planPath and planContent');
      }
      return decorate(
        buildPlanExecutionPrompt({ workspacePath, ...opts.planExecution }),
        effort,
        conversationId,
      );
    case 'ui-design':
      if (!opts?.uiDesign) {
        throw new Error('ui-design prompt requires the document it is scoped to');
      }
      return decorate(buildUiDesignPrompt(workspacePath, opts.uiDesign), effort, conversationId, {
        codeContext: false,
        // The session IS a `.uxml`, so the subsystem is known without guessing
        // from whichever tab happened to be focused when the decoration froze.
        forceSubsystems: ['uiToolkit'],
      });
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
    case 'design':
      return 'ui-design';
  }
}
