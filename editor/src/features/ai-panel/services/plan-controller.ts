/**
 * Plan-mode controller — orchestrates the two-phase plan workflow.
 *
 * Phase A (planning):
 *   - Send the user prompt with the plan-planning system prompt + read-only
 *     tool subset.
 *   - On agent_end, extract the assistant's last text content (the markdown
 *     plan), write it to .unityide/plans/<ts>-<slug>.aplan, open it in the
 *     plan view (PlanDocumentView, not Monaco — a plan is edited in place).
 *   - Set planPhase='awaiting-execute' and stash pendingPrompt + lastAttachments.
 *
 * Phase B (execution):
 *   - Re-read the plan file from disk (so user edits are honored).
 *   - Send with the plan-execution system prompt + full toolset.
 *   - On agent_end, planPhase returns to 'idle'.
 *
 * Regenerate just calls startPlanning again with the stashed prompt.
 */

import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getAgentService } from './agent-service';
import { routePlanSend } from './plan-route';
import { buildRegeneratePrompt, type PriorPlan } from './plan-regen';
import { buildReviseNotesPrompt } from './plan-revise';
import { parsePlanTodos, planTodosToArcanePlan } from './plan-todos';
import {
  reservePlanPath,
  openPlanInEditor,
  readPlan,
  writePlan,
} from './plan-files';
import type { TextContent, ThinkingContent, ToolCall } from './vendor/types';
import type { Attachment } from './types';
import type { PlanNote } from '../../markdown-preview';
import { planStepsOf } from '../../markdown-preview';

function getCurrentWorkspacePath(): string | null {
  return useWorkspaceStore.getState().workspacePath;
}

/** Pull the assistant's last text content from a planning conversation. */
function extractPlanMarkdown(
  content: (TextContent | ThinkingContent | ToolCall)[] | undefined,
): string {
  if (!content) return '';
  // Concatenate every text block in order — the planning prompt asks for one,
  // but be defensive in case the model emits multiple.
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n\n')
    .trim();
}

async function startPlanning(
  prompt: string,
  attachments: Attachment[],
  opts: {
    /**
     * Overrides the text actually sent to the model (regenerate uses this to
     * attach the previous plan's progress marks). The plan file name, session
     * title and `pendingPrompt` always come from `prompt`, so a regenerate
     * doesn't pollute them with the embedded prior plan.
     */
    sendText?: string;
  } = {},
): Promise<void> {
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) {
    useAiStore.getState().setError('Open a workspace before planning.');
    return;
  }

  const store = useAiStore.getState();
  store.setPlanPhase('planning');
  store.setPendingPrompt(prompt);
  store.setLastAttachments(attachments);

  try {
    await getAgentService().sendMessage(opts.sendText ?? prompt, {
      mode: 'plan',
      effort: store.effort,
      promptMode: 'plan-planning',
      attachments,
    });
  } catch (err) {
    // Without this, a throw stranded planPhase at 'planning' forever and the
    // composer had no way back to a working plan mode.
    useAiStore.getState().setPlanPhase('idle');
    useAiStore.getState().setError(`Planning failed: ${formatErr(err)}`);
    return;
  }

  // Pull the freshest state after the agent loop completes.
  const after = useAiStore.getState();
  // Find the most recent assistant message that has text content.
  let planMarkdown = '';
  for (let i = after.messages.length - 1; i >= 0; i--) {
    const m = after.messages[i];
    if (m.role === 'assistant') {
      planMarkdown = extractPlanMarkdown(m.content);
      if (planMarkdown) break;
    }
  }

  if (!planMarkdown) {
    after.setPlanPhase('idle');
    after.setError('Planning did not produce any output.');
    return;
  }

  const planPath = await reservePlanPath(workspacePath, prompt);
  try {
    await writePlan(planPath, planMarkdown);
  } catch (err) {
    after.setPlanPhase('idle');
    after.setError(`Failed to write plan file: ${formatErr(err)}`);
    return;
  }

  openPlanInEditor(planPath);
  after.setActivePlanPath(planPath);
  // Attach the plan to this session so it is reachable later from chat
  // history, rather than only from the conversation that produced it.
  after.addSessionPlan({
    path: planPath,
    title: prompt.slice(0, 80),
    createdAt: Date.now(),
    status: 'draft',
  });
  after.setPlanPhase('awaiting-execute');
}

/** Set the session `PlanRef.status` for `planPath`, keeping the existing ref's identity fields. */
function setPlanRefStatus(planPath: string, status: 'draft' | 'executing' | 'done' | 'failed'): void {
  const store = useAiStore.getState();
  const existing = store.sessionPlans.find((p) => p.path === planPath);
  store.addSessionPlan(
    existing
      ? { ...existing, status }
      : { path: planPath, title: planPath.split('/').pop() ?? 'plan', createdAt: Date.now(), status },
  );
}

/**
 * Shared execution runner — Execute sends the canonical pointer text,
 * resume sends the USER'S text (the plan pointer/body prefix is injected by
 * agent-service from `planExecution`, so the user's words ride along as
 * guidance for the remaining steps).
 */
async function runExecution(planPath: string, sendText: string): Promise<void> {
  const store = useAiStore.getState();

  // Dirty-tab guard: if the plan tab has unsaved edits, ask user to save first.
  const openFile = useWorkspaceStore
    .getState()
    .openFiles.find((f) => f.path === planPath);
  if (openFile?.isDirty) {
    store.setError('Save the plan file (Cmd+S) before executing.');
    return;
  }

  let planContent: string;
  try {
    planContent = await readPlan(planPath);
  } catch (err) {
    // Clear the plan state, or every subsequent plan-mode message routes to
    // 'resume' and dead-ends on this same unreadable file forever.
    store.setActivePlanPath(null);
    store.setPlanPhase('idle');
    store.setError(
      `Could not read plan file: ${formatErr(err)} — plan cleared; send a message to plan again.`,
    );
    return;
  }
  if (!planContent.trim()) {
    store.setActivePlanPath(null);
    store.setPlanPhase('idle');
    store.setError('Plan file is empty — plan cleared; send a message to plan again.');
    return;
  }

  store.setPlanPhase('executing');
  // Pin the plan being run: a follow-up composer message resumes THIS plan,
  // not whatever stale activePlanPath an earlier planning run left behind.
  store.setActivePlanPath(planPath);
  setPlanRefStatus(planPath, 'executing');

  // Seed arcanePlan from the plan file's current Todos/checkbox state BEFORE
  // the send below, so the FIRST plan-execution request already carries the
  // current todo's difficulty — the metadata resolver (difficulty.ts's
  // difficultyForRequest) reads arcanePlan off the store, and without this
  // seed the first send would go out untagged until the model's own first
  // todo_update call caught up. The todo-tool merge (mergeTodoDifficulty)
  // keeps these tags authoritative for every send after this one.
  store.setArcanePlan(planTodosToArcanePlan(parsePlanTodos(planContent)));

  try {
    await getAgentService().sendMessage(sendText, {
      mode: 'plan',
      effort: store.effort,
      promptMode: 'plan-execution',
      planExecution: { planPath, planContent },
    });
  } finally {
    // Whatever happened — clean finish, abort, turn cap, or a REJECTED send —
    // return to 'awaiting-execute' so the user can resume/re-execute. Without
    // the finally, a rejection left the phase stuck at 'executing' and the
    // composer routed every message into a fresh planning run.
    useAiStore.getState().setPlanPhase('awaiting-execute');

    // The file's own [x] ticks are the progress record: all ticked ⇒ done.
    try {
      const after = await readPlan(planPath);
      const steps = planStepsOf(after);
      if (steps.length > 0 && steps.every((s) => s.done)) {
        setPlanRefStatus(planPath, 'done');
      }
    } catch {
      /* status stays 'executing' (= started, not finished) */
    }
  }
}

async function executePlan(planPath: string): Promise<void> {
  await runExecution(planPath, `Execute the plan at ${planPath}.`);
}

/** Continue the active plan's remaining steps, with the user's text as guidance. */
async function resumeExecution(text: string): Promise<void> {
  const store = useAiStore.getState();
  const planPath = store.activePlanPath;
  if (!planPath) {
    store.setError('No active plan to resume.');
    return;
  }
  await runExecution(planPath, text);
}

/**
 * Route a composer message sent while the panel is in plan mode. With a plan
 * pending (or a phase stuck at 'executing'), typed text RESUMES execution —
 * it does not re-plan; Regenerate and Revise are the explicit re-plan paths.
 */
async function sendPlanModeMessage(text: string, attachments: Attachment[]): Promise<void> {
  const store = useAiStore.getState();
  if (routePlanSend(store.planPhase, store.activePlanPath) === 'resume') {
    await resumeExecution(text);
  } else {
    await startPlanning(text, attachments);
  }
}

async function regenerate(): Promise<void> {
  const store = useAiStore.getState();
  if (!store.pendingPrompt) {
    store.setError('No previous prompt to regenerate from.');
    return;
  }
  // Attach the previous plan (its `- [x]` marks are the progress record) so
  // the planner carries completed steps forward pre-checked instead of
  // re-planning them unchecked — which reset every done todo on execute.
  let priorPlan: PriorPlan | null = null;
  if (store.activePlanPath) {
    try {
      priorPlan = { path: store.activePlanPath, content: await readPlan(store.activePlanPath) };
    } catch {
      /* plan file gone — regenerate from the prompt alone */
    }
  }
  await startPlanning(store.pendingPrompt, store.lastAttachments, {
    sendText: buildRegeneratePrompt(store.pendingPrompt, priorPlan),
  });
}

/**
 * Send the user's pinned suggestions back to the model and rewrite the plan.
 *
 * The revise prompt (see plan-revise.ts) asks for the full revised plan as
 * the REPLY — plan-planning's toolset is read-only, so the model cannot
 * write the file itself; the old prompt ordered it to anyway, which silently
 * discarded every note. WE persist the reply here, exactly as startPlanning
 * persists the initial draft.
 */
async function reviseWithNotes(planPath: string, notes: PlanNote[]): Promise<void> {
  const store = useAiStore.getState();
  if (notes.length === 0) return;
  if (store.isAgentRunning) return;

  let planContent: string;
  try {
    planContent = await readPlan(planPath);
  } catch (err) {
    store.setError(`Could not read plan file: ${formatErr(err)}`);
    return;
  }

  store.setPlanPhase('planning');
  // Pin the plan being revised — same reason runExecution pins it.
  store.setActivePlanPath(planPath);
  try {
    await getAgentService().sendMessage(buildReviseNotesPrompt(planPath, planContent, notes), {
      mode: 'plan',
      effort: store.effort,
      promptMode: 'plan-planning',
    });

    const after = useAiStore.getState();
    let revised = '';
    for (let i = after.messages.length - 1; i >= 0; i--) {
      const m = after.messages[i];
      if (m.role === 'assistant') {
        revised = extractPlanMarkdown(m.content);
        if (revised) break;
      }
    }
    if (!revised) {
      after.setError('Revision did not produce a plan — the file was left unchanged.');
      return;
    }
    try {
      await writePlan(planPath, revised);
      openPlanInEditor(planPath);
    } catch (err) {
      after.setError(`Failed to write revised plan: ${formatErr(err)}`);
    }
  } finally {
    useAiStore.getState().setPlanPhase('awaiting-execute');
  }
}

function abortExecution(): void {
  getAgentService().abort();
  // Agent loop will set isAgentRunning=false; we restore planPhase here too.
  useAiStore.getState().setPlanPhase('awaiting-execute');
}

function openPlanTab(planPath: string): void {
  openPlanInEditor(planPath);
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const planController = {
  startPlanning,
  executePlan,
  resumeExecution,
  sendPlanModeMessage,
  reviseWithNotes,
  regenerate,
  abortExecution,
  openPlanTab,
};
