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

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useAiStore, selectPendingQuestion } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getAgentService } from '../services/agent-service';
import { planController } from '../services/plan-controller';
import { shouldRouteToQuestion } from '../services/question-routing';
import LexicalChatInput, { type LexicalChatInputHandle } from './LexicalChatInput';
import ModeSelector from './ModeSelector';
import EffortSelector from './EffortSelector';
import AttachmentBar from './AttachmentBar';
import ImageAttachButton from './ImageAttachButton';

function ChatInput() {
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const mode = useAiStore((s) => s.mode);
  const effort = useAiStore((s) => s.effort);
  const planPhase = useAiStore((s) => s.planPhase);
  const activePlanPath = useAiStore((s) => s.activePlanPath);
  const addUserMessage = useAiStore((s) => s.addUserMessage);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const attachmentCount = useAiStore((s) => s.attachments.length);
  const pendingQuestion = useAiStore(selectPendingQuestion);

  const editorRef = useRef<LexicalChatInputHandle>(null);
  const [hasText, setHasText] = useState(false);

  // Starter prompts from the empty state land here. Deliberately fills the
  // composer instead of sending: the user gets to read and edit the request
  // before it costs them a turn.
  useEffect(() => {
    function onPrefill(e: Event) {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text === 'string' && text) editorRef.current?.setText(text);
    }
    window.addEventListener('ai-compose-prefill', onPrefill);
    return () => window.removeEventListener('ai-compose-prefill', onPrefill);
  }, []);

  function handleSubmit(text: string) {
    // Answer-mode routing FIRST: while a question is pending, typed text
    // answers the question instead of sending a normal message — no
    // `addUserMessage` (the answer shows in the locked QuestionBlock, not as
    // a user bubble) and no `clearAttachments` (staged attachments are
    // unrelated to the question and must survive to the next real send).
    if (shouldRouteToQuestion({ pendingQuestion: !!pendingQuestion, text })) {
      useAiStore.getState().resolveQuestionRequest(pendingQuestion!.toolCallId, { answer: text.trim() });
      return;
    }

    if (!workspacePath) return;
    const attachments = useAiStore.getState().attachments;
    addUserMessage(text, attachments);
    useAiStore.getState().clearAttachments();

    if (mode === 'plan') {
      // Phase-aware: with a plan awaiting execution (or stuck 'executing'),
      // typed text RESUMES the remaining steps instead of re-planning — the
      // old unconditional startPlanning() here re-created the plan on any
      // message, with the write tools stripped so the model couldn't resume.
      // Last-resort net (T5): agent-service/plan-controller already surface
      // their own errors via the store, but a bug that throws before that
      // point would otherwise become an unhandled rejection.
      void planController
        .sendPlanModeMessage(text, attachments)
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

  // Extended so the pending-question path is send-able even though the agent
  // (and its blocked ask_user tool call) is still running — normally sending
  // is blocked mid-run, but answering the question is exactly what unblocks it.
  const canSend = !!workspacePath && hasText && (!isAgentRunning || !!pendingQuestion);

  const planResumePending =
    mode === 'plan' && !!activePlanPath && (planPhase === 'awaiting-execute' || planPhase === 'executing');
  const placeholder = pendingQuestion
    ? "Answer the agent's question — or click an option above."
    : mode === 'ask'
      ? 'Ask a question about your Unity project. @ for context, ⏎ to send.'
      : mode === 'plan'
        ? planResumePending
          ? 'Message continues the current plan — Regenerate to re-plan. ⏎ to send.'
          : 'Describe what you want to build. @ for context, ⏎ to plan.'
        : 'Plan, build, edit. @ for context, ⏎ to send.';

  return (
    <div className="ai-panel-input-area">
      <div
        className={`ai-panel-composer ${isAgentRunning ? 'is-running' : ''} ${!workspacePath ? 'is-disabled' : ''}`}
        data-mode={mode}
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
            {/*
              Stop and Send are not strictly either/or while a question is
              pending: the agent is still `isAgentRunning` (Stop must stay
              reachable — abort cancels the pending question via the tool's
              abort signal) but the composer is also send-able again (Send
              answers the question). Outside answer mode this collapses back
              to the original either/or (Stop while running, else Send).
            */}
            {isAgentRunning && (
              <button
                type="button"
                className="ai-panel-send is-stop"
                onClick={handleStop}
                title="Stop generation"
                aria-label="Stop generation"
              >
                <Square size={12} fill="currentColor" strokeWidth={0} />
              </button>
            )}
            {(!isAgentRunning || !!pendingQuestion) && (
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
