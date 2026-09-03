/**
 * Composer dispatch — the routing body of a composer submit, extracted out of
 * `ChatInput.handleSubmit` (T4) so `StoppedBlock`'s Resume button can share it
 * instead of re-implementing (or drifting from) the same send logic.
 *
 * Pure move: this is exactly the tail of `handleSubmit` that ran AFTER the
 * pending-question routing (which stays in `ChatInput` — answering a pending
 * question is not a normal send, and never reaches this function). No routing
 * semantics changed.
 */

import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { sendChatMessage } from './chat-backend';
import { getAgentService } from './agent-service';
import { planController } from './plan-controller';
import { agentModeController } from './preplan-controller';
import type { Attachment } from './types';

/**
 * Adds the user bubble, clears staged attachments, then routes the send by
 * selected agent / mode: non-hosted agents go through `sendChatMessage`; plan
 * mode through `planController.sendPlanModeMessage`; agent mode through
 * `agentModeController.sendAgentModeMessage`; everything else (ask mode)
 * through `getAgentService().sendMessage`.
 *
 * No-ops if there is no open workspace, same as the composer being disabled
 * with none open.
 */
export function dispatchComposerSend(text: string, attachments: Attachment[]): void {
  const workspacePath = useWorkspaceStore.getState().workspacePath;
  if (!workspacePath) return;

  const { mode, effort, selectedAgent, addUserMessage, clearAttachments } = useAiStore.getState();
  addUserMessage(text, attachments);
  clearAttachments();

  // The ONE place the panel branches on which agent is selected. An external
  // agent runs its own loop and exposes its own modes (plan, accept-edits, …)
  // as session config options, so UnityIDE's plan controller — which writes
  // .unityide/plans/*.aplan and swaps prompt modes on the vendor loop — has no
  // meaning for it and is skipped entirely.
  if (selectedAgent !== 'hosted') {
    void sendChatMessage(text, { mode, effort, attachments }).catch((e) =>
      useAiStore.getState().setError(String(e)),
    );
    return;
  }

  if (mode === 'plan') {
    // Phase-aware — `plan-route.ts` owns the decision. With a plan written
    // but not started, typed text REVISES it; only a run already under way
    // takes it as guidance. (Two bugs live in this one branch's history: an
    // unconditional startPlanning() that re-created the plan on any message,
    // then a resume that handed the model the write tools when all the user
    // had done was comment on a plan they were still reading.)
    // Last-resort net (T5): agent-service/plan-controller already surface
    // their own errors via the store, but a bug that throws before that
    // point would otherwise become an unhandled rejection.
    void planController
      .sendPlanModeMessage(text, attachments)
      .catch((e) => useAiStore.getState().setError(String(e)));
  } else if (mode === 'agent') {
    // Preplanning flow (Task 11): on tiers with it enabled and no live todo
    // list, this runs a read-only context-gathering pass first, then
    // chains into execution — see preplan-controller.ts.
    void agentModeController
      .sendAgentModeMessage(text, attachments)
      .catch((e) => useAiStore.getState().setError(String(e)));
  } else {
    void getAgentService()
      .sendMessage(text, { mode, effort, attachments })
      .catch((e) => useAiStore.getState().setError(String(e)));
  }
}
