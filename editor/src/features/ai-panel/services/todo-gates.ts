/**
 * Pure inclusion rules for the `todo_update` tool and its retrospective nudge
 * (Task 11), extracted out of `agent-service.ts` so the decisions are
 * directly Bun-testable: `agent-service.ts` itself pulls in the Tauri-coupled
 * `tool-operations.ts` → `stores/workspace.ts` → `stores/ai.ts` chain (the
 * same DOM-touching import graph `arcane-stream.test.ts`'s header documents
 * for `stores/ai` alone), so it cannot be imported directly under plain
 * `bun test`. `createToolsForPromptMode` and the nudge gate in
 * `agent-service.ts`'s `runSend` both call into this module rather than
 * inlining the condition, so the rule has exactly one definition.
 */
import type { PromptMode } from './prompts';
import type { Effort } from './types';

/**
 * Whether `createTodoTool()` joins the toolset for this (mode, effort) combo.
 * - `'preplanning'`: always — its one required final action IS a `todo_update` call.
 * - `'plan-execution'`: always, any effort — mirrors the approved plan's checkboxes.
 * - `'agent'`: every tier EXCEPT `'low'` — Standard has no todo machinery, guaranteed.
 * - `'ask'` / `'plan-planning'`: never — read-only conversations with nothing to track.
 */
export function includesTodoTool(mode: PromptMode, effort: Effort): boolean {
  if (mode === 'ask' || mode === 'plan-planning') return false;
  if (mode === 'agent') return effort !== 'low';
  return true; // 'preplanning' | 'plan-execution'
}

/**
 * Whether the retrospective `TODO_NUDGE_TEXT` reminder may fire for this
 * send. Gated the same way as `includesTodoTool`'s 'agent' rule: at 'low' the
 * todo tool isn't even registered, so nudging the model to call it would be
 * nonsensical.
 */
export function nudgeEligible(effort: Effort): boolean {
  return effort !== 'low';
}
