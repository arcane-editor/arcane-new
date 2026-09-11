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
import { captureSendCancellation } from './send-cancellation';
import type { Attachment } from './types';

/**
 * Adds the user bubble, clears staged attachments, then routes the send by
 * selected agent / mode: non-hosted agents go through `sendChatMessage`; plan
 * mode through `planController.sendPlanModeMessage`; agent mode through
 * `agentModeController.sendAgentModeMessage`; design mode straight to
 * `sendMessage` with the `ui-design` prompt mode and the document it is scoped
 * to; everything else (ask mode) through `getAgentService().sendMessage`.
 *
 * No-ops if there is no open workspace, same as the composer being disabled
 * with none open.
 */
export function dispatchComposerSend(text: string, attachments: Attachment[]): boolean {
  const workspacePath = useWorkspaceStore.getState().workspacePath;
  const state = useAiStore.getState();
  if (!workspacePath || !text.trim() || state.isAgentRunning || state.isSubmitting) return false;
  const { mode, effort, selectedAgent, conversationGeneration } = state;
  const documentPath = state.designDocument;
  if (selectedAgent === 'hosted' && mode === 'design' && !documentPath) {
    state.setError('No document is open for this design session.');
    return false;
  }
  const ownsConversation = () => useAiStore.getState().conversationGeneration === conversationGeneration
    && useWorkspaceStore.getState().workspacePath === workspacePath;
  const cancelled = captureSendCancellation();
  const current = () => ownsConversation() && !cancelled();
  // Claim synchronously, before imports, connection setup or preplanning can
  // yield. The same guard serves Enter, the button and Resume.
  useAiStore.setState({ isSubmitting: true });
  state.addUserMessage(text, attachments);
  state.clearAttachments();
  void (async () => {
    if (selectedAgent !== 'hosted') await sendChatMessage(text, { mode, effort, attachments });
    else if (mode === 'plan') await planController.sendPlanModeMessage(text, attachments);
    else if (mode === 'design') await getAgentService().sendMessage(text, {
      mode, effort, attachments, promptMode: 'ui-design',
      uiDesign: { documentPath: documentPath!, documentName: documentPath!.split('/').pop() ?? documentPath! },
    });
    else if (mode === 'agent') await agentModeController.sendAgentModeMessage(text, attachments, current);
    else await getAgentService().sendMessage(text, { mode, effort, attachments });
  })().catch((e) => { if (current()) useAiStore.getState().setError(String(e)); })
    .finally(() => { if (ownsConversation()) useAiStore.setState({ isSubmitting: false }); });
  return true;
}
