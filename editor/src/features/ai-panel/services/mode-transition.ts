/**
 * Pure guarded transition for UnityIDE's `ChatMode` pill (ask/agent/plan).
 *
 * Separate from `stores/ai.ts` (not Bun-importable, see `plan-route.ts`'s
 * header for the same split) so the guard itself stays directly tested. The
 * store's `setMode` is the only caller; the existing UI disables
 * (`ModeSelector.tsx`, `App.tsx`'s `cycleAiMode`) are UX affordances layered
 * on top — this function is the actual enforcement point.
 *
 * The problem this closes: nothing used to clear or park a plan when the user
 * flipped from plan mode to ask/agent mid-run. An `awaiting-execute` plan was
 * orphaned — its Execute card could linger under an agent composer that has
 * no idea what `planPhase` means — and a plan interrupted by a crash/cap had
 * nowhere honest to go at all.
 */

import type { PlanPhase } from '../../../stores/ai';
import type { ChatMode } from './types';

export interface ModeTransitionInput {
  from: ChatMode;
  to: ChatMode;
  planPhase: PlanPhase;
  activePlanPath: string | null;
  isAgentRunning: boolean;
}

export type ModeTransition =
  | { kind: 'blocked'; reason: 'running' }
  | { kind: 'noop' }
  | { kind: 'switch'; mode: ChatMode; planPhase: PlanPhase; activePlanPath: string | null; notice?: string };

/**
 * Shown when a plan with a live phase (`awaiting-execute` or `interrupted`)
 * is left behind by a switch away from plan mode. The phase and path are kept
 * (not reset to idle) so switching back to plan mode finds the card exactly
 * where it was.
 */
export const PLAN_PARKED_NOTICE = 'Plan parked. Switch back to Plan mode to execute or resume it.';

/**
 * Reconciles a persisted `planPhase`/`activePlanPath` pair against whether an
 * agent is actually running right now, for the moment a mode switch (or any
 * other live read) needs an honest answer rather than the last value a dead
 * run happened to leave behind.
 *
 * - No path ⇒ `idle`. A phase with nothing to point at is not resumable.
 * - `planning` while not running ⇒ `idle` + null path. The run died before
 *   the plan file was ever written, so there is nothing to park or resume.
 * - `executing` while not running ⇒ `interrupted`, path kept. The run died
 *   with the process; the plan file's `[x]` ticks carry the progress and
 *   `interrupted` is what makes that resumable (see `plan-route.ts`).
 * - Anything else (including every case while an agent IS running) is
 *   already honest as stored — unchanged.
 */
export function normalizeLivePlanState(
  phase: PlanPhase,
  path: string | null,
  isAgentRunning: boolean,
): { planPhase: PlanPhase; activePlanPath: string | null } {
  if (!path) return { planPhase: 'idle', activePlanPath: null };
  if (phase === 'planning' && !isAgentRunning) return { planPhase: 'idle', activePlanPath: null };
  if (phase === 'executing' && !isAgentRunning) return { planPhase: 'interrupted', activePlanPath: path };
  return { planPhase: phase, activePlanPath: path };
}

/**
 * Decides what a `mode` switch does to plan state. See the module doc for
 * why this exists, and the class doc comment on `PlanPhase` in `stores/ai.ts`
 * for phase meanings.
 *
 * - `isAgentRunning` blocks every switch, whatever the phase — swapping the
 *   toolset/system prompt out from under a live turn is never safe. Checked
 *   before `from === to` so a same-mode click while running still reports
 *   why nothing happened rather than a silent noop.
 * - `from === to` is a noop — nothing to reconcile.
 * - Otherwise the live phase is normalized (`normalizeLivePlanState`, with
 *   `isAgentRunning` already known false here). A normalized `idle` (or a
 *   phase with no path) switches mode with plan state reset to idle/null.
 *   A normalized `awaiting-execute`/`interrupted` WITH a path is parked:
 *   switching to `plan` keeps it with no notice (the card is right there);
 *   switching to `ask`/`agent` keeps it too, but with `PLAN_PARKED_NOTICE` so
 *   the user knows where it went.
 */
export function planModeTransition(input: ModeTransitionInput): ModeTransition {
  const { from, to, isAgentRunning } = input;
  if (isAgentRunning) return { kind: 'blocked', reason: 'running' };
  if (from === to) return { kind: 'noop' };

  const live = normalizeLivePlanState(input.planPhase, input.activePlanPath, isAgentRunning);

  if (live.planPhase === 'idle' || !live.activePlanPath) {
    return { kind: 'switch', mode: to, planPhase: 'idle', activePlanPath: null };
  }

  // Only `awaiting-execute` and `interrupted` survive normalization with a
  // path intact — both are a plan the user can still act on.
  if (to === 'plan') {
    return { kind: 'switch', mode: to, planPhase: live.planPhase, activePlanPath: live.activePlanPath };
  }
  return {
    kind: 'switch',
    mode: to,
    planPhase: live.planPhase,
    activePlanPath: live.activePlanPath,
    notice: PLAN_PARKED_NOTICE,
  };
}
