/**
 * Large-task detection for agent mode (owner flow decision 2026-08-15):
 * a BIG agent-mode request gets a proactive "todos first" instruction
 * prepended to the prompt — plan the steps with todo_update, then execute.
 * No extra phase, no model involvement (model choice is entirely server-side
 * in arcane-server config/routing.ts); small requests are untouched.
 *
 * Deliberately conservative pure heuristics: 'large' needs at least TWO
 * independent signals, so the default experience stays exactly as before.
 */

export type TaskSize = 'normal' | 'large';

/** Prompt length that suggests a substantial brief. */
const LARGE_CHARS = 600;

/** Verbs that usually announce multi-step build/change work. */
const MULTI_STEP_VERBS =
  /\b(implement|build|create|refactor|migrate|redesign|rewrite|integrate|overhaul|set\s*up)\b/i;

/** Enumerated sub-tasks: numbered/bulleted lists or chained "and then". */
const ENUMERATION = /(^|\n)\s*(\d+[.)]\s|[-*]\s)|\b(and then|after that|followed by)\b/i;

/** Mentions of several files/systems in one breath. */
const MULTI_TARGET = /\b(all|multiple|several|every|across)\b.*\b(files?|scripts?|scenes?|prefabs?|systems?|components?|classes?)\b/i;

export function assessTaskSize(text: string, attachmentCount = 0): TaskSize {
  let signals = 0;
  if (text.length > LARGE_CHARS) signals++;
  if (MULTI_STEP_VERBS.test(text)) signals++;
  if (ENUMERATION.test(text)) signals++;
  if (MULTI_TARGET.test(text)) signals++;
  if (attachmentCount >= 2) signals++;
  return signals >= 2 ? 'large' : 'normal';
}

/**
 * Prepended to the outgoing prompt (same mechanism as TODO_NUDGE_TEXT) when
 * a large agent-mode task is detected — the proactive sibling of the
 * retrospective todo nudge.
 */
export const TODO_FIRST_TEXT =
  '[This looks like a multi-step task: FIRST break it into concrete steps with todo_update, ' +
  'then execute them one at a time, marking each in_progress and done as you go.]\n\n';
