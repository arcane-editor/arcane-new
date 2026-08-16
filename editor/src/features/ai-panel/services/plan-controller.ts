/**
 * Plan-mode controller — orchestrates the two-phase plan workflow.
 *
 * Phase A (planning):
 *   - Send the user prompt with the plan-planning system prompt + read-only
 *     tool subset.
 *   - On agent_end, extract the assistant's last text content (the markdown
 *     plan), write it to .arcane/plans/<ts>-<slug>.md, open in Monaco.
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
import {
  buildPlanPath,
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

  await getAgentService().sendMessage(opts.sendText ?? prompt, {
    mode: 'plan',
    effort: store.effort,
    promptMode: 'plan-planning',
    attachments,
  });

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

  const planPath = buildPlanPath(workspacePath, prompt);
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
    store.setError(`Could not read plan file: ${formatErr(err)}`);
    return;
  }
  if (!planContent.trim()) {
    store.setError('Plan file is empty.');
    return;
  }

  store.setPlanPhase('executing');
  setPlanRefStatus(planPath, 'executing');

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
 * Each note is presented as its quoted text under the heading it was pinned
 * to, so the model knows exactly which part of its own plan is being
 * questioned — that targeting is the whole reason notes are anchored rather
 * than collected as free text.
 *
 * Notes whose text no longer appears (the plan moved on) are still sent, but
 * marked, so the model treats them as general feedback rather than hunting for
 * a passage that is gone.
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

  const body = notes
    .map((n, i) => {
      const where = n.anchored
        ? `under "${n.headingPath}"`
        : `under "${n.headingPath}" (this text is no longer in the plan — treat as general feedback)`;
      return `${i + 1}. ${where}\n   > ${n.quotedText}\n   ${n.body}`;
    })
    .join('\n\n');

  const prompt =
    `Revise the plan at ${planPath} to address these suggestions, then write the ` +
    `full revised plan back to that file in the same format.\n\n${body}`;

  store.setPlanPhase('planning');
  await getAgentService().sendMessage(prompt, {
    mode: 'plan',
    effort: store.effort,
    promptMode: 'plan-planning',
    planExecution: { planPath, planContent },
  });
  useAiStore.getState().setPlanPhase('awaiting-execute');
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
