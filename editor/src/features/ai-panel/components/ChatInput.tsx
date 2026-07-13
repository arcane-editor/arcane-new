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
 * The toolbar's left side hosts the Arcane ModeSelector + EffortSelector.
 */

import { useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getAgentService } from '../services/agent-service';
import { planController } from '../services/plan-controller';
import LexicalChatInput, { type LexicalChatInputHandle } from './LexicalChatInput';
import ModeSelector from './ModeSelector';
import EffortSelector from './EffortSelector';
import AttachmentBar from './AttachmentBar';
import ImageAttachButton from './ImageAttachButton';

function ChatInput() {
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
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

    if (mode === 'plan') {
      // Last-resort net (T5): agent-service/plan-controller already surface
      // their own errors via the store, but a bug that throws before that
      // point would otherwise become an unhandled rejection.
      void planController
        .startPlanning(text, attachments)
        .catch((e) => useAiStore.getState().setError(String(e)));
    } else {
      void getAgentService()
        .sendMessage(text, { mode, effort, attachments })
        .catch((e) => useAiStore.getState().setError(String(e)));
    }
  }

  function handleStop() {
    getAgentService().abort();
  }

  const canSend = !!workspacePath && hasText && !isAgentRunning;

  const placeholder =
    mode === 'ask'
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
            <ModeSelector />
            <EffortSelector />
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
