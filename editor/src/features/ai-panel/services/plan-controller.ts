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
import {
  buildPlanPath,
  openPlanInEditor,
  readPlan,
  writePlan,
} from './plan-files';
import type { TextContent, ThinkingContent, ToolCall } from './vendor/types';
import type { Attachment } from './types';

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

  await getAgentService().sendMessage(prompt, {
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
  after.setPlanPhase('awaiting-execute');
}

async function executePlan(planPath: string): Promise<void> {
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

  await getAgentService().sendMessage(`Execute the plan at ${planPath}.`, {
    mode: 'plan',
    effort: store.effort,
    promptMode: 'plan-execution',
    planExecution: { planPath, planContent },
  });

  // After execution (whether it completed cleanly or was aborted), return to
  // 'awaiting-execute' so the user can re-execute, regenerate, or just keep
  // the plan visible. The plan file on disk reflects whatever progress was
  // made (the AI marks `[x]` as it goes).
  useAiStore.getState().setPlanPhase('awaiting-execute');
}

async function regenerate(): Promise<void> {
  const store = useAiStore.getState();
  if (!store.pendingPrompt) {
    store.setError('No previous prompt to regenerate from.');
    return;
  }
  await startPlanning(store.pendingPrompt, store.lastAttachments);
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
  regenerate,
  abortExecution,
  openPlanTab,
};
