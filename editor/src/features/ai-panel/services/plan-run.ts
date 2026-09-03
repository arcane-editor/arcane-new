/**
 * Plan-mode execution core (Task 6) — the deps-injected sibling of
 * `plan-controller.ts`'s `runExecution`, split out for the same reason
 * `preplan-controller.ts:11-27` documents: `plan-controller.ts` imports
 * `stores/ai` and `agent-service.ts` at module scope, both of which pull in a
 * DOM-touching import graph `bun test` cannot load, so that file has never had
 * a test of its own. `runPlanExecution` below takes its three collaborators
 * (ai-store slice, agent service, plan-file I/O) as `deps` instead of reaching
 * for the live singletons directly, so it — and the pure `resolvePostExecutionPhase`
 * rule it ends on — can be exercised under plain `bun test` with fakes. The
 * exported `liveDeps()` is the thin production wrapper: it dynamic-imports the
 * real store/service/plan-file modules only when actually called, which is
 * what keeps this file itself Bun-importable (no runtime import of `stores/ai`
 * or `agent-service.ts` at module scope — only type-only imports, erased at
 * compile time). `plan-controller.ts`'s `runExecution` becomes a one-liner
 * over these two exports.
 *
 * The post-run phase rule (`resolvePostExecutionPhase`) replaces the old
 * `finally`, which unconditionally set `planPhase` back to `'awaiting-execute'`
 * whatever happened to the run — a clean finish, an abort, a turn cap, or a
 * crash all looked identical to the user, and a capped/aborted/errored run
 * papered over its own interruption instead of landing on Task 5's
 * `'interrupted'` phase, where `plan-route.ts` routes the composer's next
 * "continue" to `resumeExecution` instead of silently starting a fresh
 * planning run. Task 4 already stopped `plan-controller.abortExecution` from
 * pre-deciding the phase (it now only calls `getAgentService().abort()`) —
 * this is the promised "a later task decides the phase from that outcome".
 */

import type { HostedPlanEntry, PlanPhase } from '../../../stores/ai';
import type { PlanRef } from './session-persistence';
import type { Effort } from './types';
import { parsePlanTodos, planTodosToHostedPlan } from './plan-todos';

/** Minimal seam onto the ai store's live state `runPlanExecution` needs. */
export interface PlanRunAiState {
  effort: Effort;
  /** Only `role` is read (the error-tail chain-guard) — kept structural so a
   *  fake in tests never needs the store's full `AiMessage` shape. */
  messages: ReadonlyArray<{ role: string }>;
  setPlanPhase(p: PlanPhase): void;
  setActivePlanPath(p: string | null): void;
  setHostedPlan(plan: HostedPlanEntry[] | null): void;
  setError(e: string | null): void;
  sessionPlans: ReadonlyArray<PlanRef>;
  addSessionPlan(ref: PlanRef): void;
  /** Set the session `PlanRef.status` for `path`, keeping the existing ref's
   *  identity fields (or minting one) — what `plan-controller.ts`'s old
   *  module-local `setPlanRefStatus` free function did directly against the
   *  store; `liveDeps()` below synthesizes it from `sessionPlans`/`addSessionPlan`. */
  setPlanRefStatus(path: string, status: PlanRef['status']): void;
}

/** Minimal seam onto `AgentService` this core needs. */
export interface PlanRunAgentService {
  sendMessage(
    text: string,
    opts: {
      mode: 'plan';
      effort: Effort;
      promptMode: 'plan-execution';
      planExecution: { planPath: string; planContent: string };
    },
  ): Promise<void>;
  /** Persisted `abortRequested` flag — true iff the USER stopped the most recent send. */
  wasLastSendAborted(): boolean;
  /** True iff the turn governor's cap was reached on the most recent send (Task 3). */
  wasLastSendCapped(): boolean;
}

export interface PlanRunDeps {
  getAiState(): PlanRunAiState;
  getAgentService(): PlanRunAgentService;
  readPlan(path: string): Promise<string>;
  isPlanTabDirty(path: string): boolean;
  /** `note-anchor.ts`'s `planStepsOf` (re-exported off the `markdown-preview`
   *  barrel) — injected rather than imported at module scope because the
   *  barrel also carries `PlanDocumentView`'s React/DOM import graph. */
  planStepsOf(markdown: string): ReadonlyArray<{ done: boolean }>;
}

export type PostExecutionInput = {
  aborted: boolean;
  capped: boolean;
  errored: boolean;
  /** The executed plan file's steps as of just after the send, or `null` if
   *  it could not be re-read (deleted, permissions, etc). */
  steps: ReadonlyArray<{ done: boolean }> | null;
};

/**
 * The phase/ref-status a plan execution run lands on once its send has
 * settled (clean, aborted, capped, or thrown — `runPlanExecution`'s `finally`
 * calls this unconditionally).
 *
 * In order:
 *   1. Steps known, non-empty, and every one done ⇒ the plan finished ⇒
 *      `awaiting-execute` (ready to re-run) / `done`.
 *   2. Steps known and some remain ⇒ regardless of why the send stopped, work
 *      is left ⇒ `interrupted` / `executing` (not finished — the ref status
 *      most recently set at the top of the run stands: nothing here revises
 *      it to `done`, only the `awaiting-execute`/`done` case below does).
 *   3. Steps unknown (file unreadable) or empty (no checkboxes in the plan at
 *      all) ⇒ trust the send's own outcome: `interrupted` if it aborted,
 *      capped, or ended on an error tail, else a clean finish reads as
 *      `awaiting-execute`.
 */
export function resolvePostExecutionPhase(
  i: PostExecutionInput,
): { planPhase: 'awaiting-execute' | 'interrupted'; refStatus: 'done' | 'executing' } {
  if (i.steps && i.steps.length > 0) {
    return i.steps.every((s) => s.done)
      ? { planPhase: 'awaiting-execute', refStatus: 'done' }
      : { planPhase: 'interrupted', refStatus: 'executing' };
  }
  const stopped = i.aborted || i.capped || i.errored;
  return stopped
    ? { planPhase: 'interrupted', refStatus: 'executing' }
    : { planPhase: 'awaiting-execute', refStatus: 'executing' };
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared execution runner, deps-injected (see the module header). Moved
 * verbatim from `plan-controller.ts:204-276` except the `finally`, which now
 * ends on `resolvePostExecutionPhase` instead of unconditionally landing back
 * on `'awaiting-execute'`.
 *
 * Execute sends the canonical pointer text, resume sends the USER'S text (the
 * plan pointer/body prefix is injected by agent-service from `planExecution`,
 * so the user's words ride along as guidance for the remaining steps).
 */
export async function runPlanExecution(
  deps: PlanRunDeps,
  planPath: string,
  sendText: string,
): Promise<void> {
  const state = deps.getAiState();

  // Dirty-tab guard: if the plan tab has unsaved edits, ask user to save first.
  if (deps.isPlanTabDirty(planPath)) {
    state.setError('Save the plan file (Cmd+S) before executing.');
    return;
  }

  let planContent: string;
  try {
    planContent = await deps.readPlan(planPath);
  } catch (err) {
    // Clear the plan state, or every subsequent plan-mode message routes to
    // 'resume' and dead-ends on this same unreadable file forever.
    state.setActivePlanPath(null);
    state.setPlanPhase('idle');
    state.setError(
      `Could not read plan file: ${formatErr(err)} — plan cleared; send a message to plan again.`,
    );
    return;
  }
  if (!planContent.trim()) {
    state.setActivePlanPath(null);
    state.setPlanPhase('idle');
    state.setError('Plan file is empty — plan cleared; send a message to plan again.');
    return;
  }

  state.setPlanPhase('executing');
  // Pin the plan being run: a follow-up composer message resumes THIS plan,
  // not whatever stale activePlanPath an earlier planning run left behind.
  state.setActivePlanPath(planPath);
  state.setPlanRefStatus(planPath, 'executing');

  // Seed hostedPlan from the plan file's current Todos/checkbox state BEFORE
  // the send below, so the FIRST plan-execution request already carries the
  // current todo's difficulty — the metadata resolver (difficulty.ts's
  // difficultyForRequest) reads hostedPlan off the store, and without this
  // seed the first send would go out untagged until the model's own first
  // todo_update call caught up. The todo-tool merge (mergeTodoDifficulty)
  // keeps these tags authoritative for every send after this one.
  state.setHostedPlan(planTodosToHostedPlan(parsePlanTodos(planContent)));

  const agentService = deps.getAgentService();
  try {
    await agentService.sendMessage(sendText, {
      mode: 'plan',
      effort: state.effort,
      promptMode: 'plan-execution',
      planExecution: { planPath, planContent },
    });
  } finally {
    // Whatever happened — clean finish, abort, turn cap, or a REJECTED send —
    // the file's own [x] ticks are the progress record. Re-read it fresh
    // (a `null` read — file gone, permissions — falls through to the send's
    // own outcome in `resolvePostExecutionPhase`, same as an empty/unknown
    // step list).
    let after: string | null;
    try {
      after = await deps.readPlan(planPath);
    } catch {
      after = null;
    }
    const steps = after !== null ? deps.planStepsOf(after) : null;

    // Pull the freshest state — the send may have appended messages (an
    // error tail) since `state` was captured above.
    const freshState = deps.getAiState();
    const lastMessage = freshState.messages[freshState.messages.length - 1];

    const { planPhase, refStatus } = resolvePostExecutionPhase({
      aborted: agentService.wasLastSendAborted(),
      capped: agentService.wasLastSendCapped(),
      errored: lastMessage?.role === 'error',
      steps,
    });

    freshState.setPlanPhase(planPhase);
    if (refStatus === 'done') {
      freshState.setPlanRefStatus(planPath, 'done');
    }
  }
}

/**
 * The thin production wrapper (see the module header): dynamic-imports the
 * real store/service/plan-file modules only when actually called, so this
 * module stays Bun-importable at the top level. `plan-controller.ts`'s
 * `runExecution` is a one-liner over this and `runPlanExecution`.
 */
export async function liveDeps(): Promise<PlanRunDeps> {
  const [{ useAiStore }, { useWorkspaceStore }, { getAgentService }, { readPlan }, { planStepsOf }] =
    await Promise.all([
      import('../../../stores/ai'),
      import('../../../stores/workspace'),
      import('./agent-service'),
      import('./plan-files'),
      import('../../markdown-preview'),
    ]);

  return {
    getAiState: () => {
      const s = useAiStore.getState();
      return {
        effort: s.effort,
        messages: s.messages,
        setPlanPhase: s.setPlanPhase,
        setActivePlanPath: s.setActivePlanPath,
        setHostedPlan: s.setHostedPlan,
        setError: s.setError,
        sessionPlans: s.sessionPlans,
        addSessionPlan: s.addSessionPlan,
        setPlanRefStatus: (path: string, status: PlanRef['status']) => {
          const existing = s.sessionPlans.find((p) => p.path === path);
          s.addSessionPlan(
            existing
              ? { ...existing, status }
              : { path, title: path.split('/').pop() ?? 'plan', createdAt: Date.now(), status },
          );
        },
      };
    },
    getAgentService: () => getAgentService(),
    readPlan,
    isPlanTabDirty: (path: string) =>
      useWorkspaceStore.getState().openFiles.find((f) => f.path === path)?.isDirty ?? false,
    planStepsOf,
  };
}
