/**
 * System prompt selection by mode.
 *
 * Each function returns the full system prompt string given the workspace path
 * (and any extra args required by that mode). All prompts include the shared
 * Unity context block from unity-context.ts.
 */

import { buildAskPrompt } from './ask';
import { buildAgentPrompt } from './agent';
import { buildPlanPlanningPrompt } from './plan-planning';
import {
  buildPlanExecutionPrompt,
  type PlanExecutionPromptArgs,
} from './plan-execution';
import type { ChatMode } from '../types';
import { buildGraphSnapshot } from '../../../graphify';
import { useWorkspaceStore } from '../../../../stores/workspace';
import { getUnityFactsBlock } from './unity-facts';

/** Append the codebase graph snapshot to a base system prompt, when one exists. */
function withGraphSnapshot(base: string): string {
  const activeFilePath = useWorkspaceStore.getState().activeFilePath;
  const snapshot = buildGraphSnapshot(activeFilePath);
  if (!snapshot) return base;
  return `${base}\n\n${snapshot}`;
}

/** Prepend the Unity project-facts block (Unity projects only). */
function withUnityFacts(base: string): string {
  const facts = getUnityFactsBlock();
  if (!facts) return base;
  return `${facts}\n\n${base}`;
}

/** Common decorators applied to every mode's base prompt. */
function decorate(base: string): string {
  return withUnityFacts(withGraphSnapshot(base));
}

/**
 * Internal mode resolution — Plan mode has two phases that need different
 * system prompts. Callers outside the agent service shouldn't need to think
 * about this; they pass `mode` (ask/agent/plan), and the agent service maps
 * to the right phase based on planPhase state.
 */
export type PromptMode = 'ask' | 'agent' | 'plan-planning' | 'plan-execution';

export function buildSystemPrompt(
  mode: 'ask' | 'agent' | 'plan-planning',
  workspacePath: string,
): string;
export function buildSystemPrompt(
  mode: 'plan-execution',
  workspacePath: string,
  args: Omit<PlanExecutionPromptArgs, 'workspacePath'>,
): string;
export function buildSystemPrompt(
  mode: PromptMode,
  workspacePath: string,
  args?: Omit<PlanExecutionPromptArgs, 'workspacePath'>,
): string {
  switch (mode) {
    case 'ask':
      return decorate(buildAskPrompt(workspacePath));
    case 'agent':
      return decorate(buildAgentPrompt(workspacePath));
    case 'plan-planning':
      return decorate(buildPlanPlanningPrompt(workspacePath));
    case 'plan-execution':
      if (!args) {
        throw new Error('plan-execution prompt requires planPath and planContent');
      }
      return decorate(buildPlanExecutionPrompt({ workspacePath, ...args }));
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
