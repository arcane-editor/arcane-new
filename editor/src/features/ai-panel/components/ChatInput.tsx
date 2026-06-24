/**
 * ChatInput — unified composer shell.
 *
 * Layout (single bordered box):
 *   ┌─ AttachmentBar (collapsed when empty) ─────────────┐
 *   │ [LexicalChatInput — large editable surface]        │
 *   │                                                     │
 *   │ ┌─ Toolbar ────────────────────────────────────┐   │
 *   │ │ [Mode pill] [Effort bars]  [📎] [↑/■]        │   │
 *   │ └──────────────────────────────────────────────┘   │
 *   └────────────────────────────────────────────────────┘
 *
 * The toolbar's left side swaps based on which agent is selected:
 *   - Arcane: ModeSelector + EffortSelector
 *   - Claude: ClaudeModelPicker + ClaudePermissionModePicker + ClaudeEffortPicker
 */

import { useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getAgentService } from '../services/agent-service';
import { getClaudeAgentService } from '../services/claude-agent-service';
import { planController } from '../services/plan-controller';
import LexicalChatInput, { type LexicalChatInputHandle } from './LexicalChatInput';
import ModeSelector from './ModeSelector';
import EffortSelector from './EffortSelector';
import ClaudeModelPicker from './ClaudeModelPicker';
import ClaudePermissionModePicker from './ClaudePermissionModePicker';
import ClaudeEffortPicker from './ClaudeEffortPicker';
import AttachmentBar from './AttachmentBar';
import ImageAttachButton from './ImageAttachButton';

function ChatInput() {
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const selectedAgent = useAiStore((s) => s.selectedAgent);
  const mode = useAiStore((s) => s.mode);
  const effort = useAiStore((s) => s.effort);
  const addUserMessage = useAiStore((s) => s.addUserMessage);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const attachmentCount = useAiStore((s) => s.attachments.length);

  const editorRef = useRef<LexicalChatInputHandle>(null);
  const [hasText, setHasText] = useState(false);

  function handleSubmit(text: string) {
    if (!workspacePath) return;
    const attachments = useAiStore.getState().attachments;
    addUserMessage(text, attachments);
    useAiStore.getState().clearAttachments();

    if (selectedAgent === 'claude') {
      // Claude path: ACP bridge. @-context + images are converted to ACP
      // content blocks inside the service (buildPromptBlocks).
      void getClaudeAgentService().sendPrompt(text, attachments);
      return;
    }

    if (mode === 'plan') {
      planController.startPlanning(text, attachments);
    } else {
      getAgentService().sendMessage(text, { mode, effort, attachments });
    }
  }

  function handleStop() {
    if (selectedAgent === 'claude') {
      void getClaudeAgentService().cancel();
    } else {
      getAgentService().abort();
    }
  }

  const canSend = !!workspacePath && hasText && !isAgentRunning;

  const placeholder =
    selectedAgent === 'claude'
      ? 'Talk to your local Claude Code. @ for context, ⏎ to send.'
      : mode === 'ask'
        ? 'Ask a question about your Unity project. @ for context, ⏎ to send.'
        : mode === 'plan'
          ? 'Describe what you want to build. @ for context, ⏎ to plan.'
          : 'Plan, build, edit. @ for context, ⏎ to send.';

  return (
    <div className="ai-panel-input-area">
      <div
        className={`ai-panel-composer ${isAgentRunning ? 'is-running' : ''} ${!workspacePath ? 'is-disabled' : ''}`}
      >
        {attachmentCount > 0 && <AttachmentBar />}

        <div className="ai-panel-composer-body">
          <LexicalChatInput
            ref={editorRef}
            placeholder={placeholder}
            disabled={!workspacePath}
            onTextChange={setHasText}
            onSubmit={handleSubmit}
          />
        </div>

        <div className="ai-panel-composer-toolbar">
          <div className="ai-panel-composer-toolbar-left">
            {selectedAgent === 'claude' ? (
              <>
                <ClaudeModelPicker />
                <ClaudePermissionModePicker />
                <ClaudeEffortPicker />
              </>
            ) : (
              <>
                <ModeSelector />
                <EffortSelector />
              </>
            )}
          </div>
          <div className="ai-panel-composer-toolbar-right">
            <ImageAttachButton />
            {isAgentRunning ? (
              <button
                type="button"
                className="ai-panel-send is-stop"
                onClick={handleStop}
                title="Stop generation"
                aria-label="Stop generation"
              >
                <Square size={12} fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button
                type="button"
                className="ai-panel-send"
                onClick={() => editorRef.current?.submit()}
                disabled={!canSend}
                title="Send message"
                aria-label="Send message"
              >
                <ArrowUp size={15} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatInput;
