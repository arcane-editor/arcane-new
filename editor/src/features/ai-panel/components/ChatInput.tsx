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
 * The toolbar's left side hosts the UnityIDE ModeSelector + EffortSelector — or,
 * when an external agent is selected, that agent's OWN advertised settings via
 * AgentConfigBar. The two are mutually exclusive: mode and effort configure the
 * UnityIDE loop, and an external agent neither reads them nor has an equivalent.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useAiStore, selectPendingQuestion } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getChatBackend, sendChatMessage } from '../services/chat-backend';
import { getAgentService } from '../services/agent-service';
import { planController } from '../services/plan-controller';
import { agentModeController } from '../services/preplan-controller';
import { shouldRouteToQuestion } from '../services/question-routing';
import { composerPlaceholder } from '../data/composer-copy';
import LexicalChatInput, { type LexicalChatInputHandle } from './LexicalChatInput';
import ModeSelector from './ModeSelector';
import EffortSelector from './EffortSelector';
import AgentConfigBar from './AgentConfigBar';
import AttachmentBar from './AttachmentBar';
import ImageAttachButton from './ImageAttachButton';

function ChatInput() {
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const mode = useAiStore((s) => s.mode);
  const effort = useAiStore((s) => s.effort);
  const selectedAgent = useAiStore((s) => s.selectedAgent);
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

  function handleStop() {
    getChatBackend().abort();
  }

  // Extended so the pending-question path is send-able even though the agent
  // (and its blocked ask_user tool call) is still running — normally sending
  // is blocked mid-run, but answering the question is exactly what unblocks it.
  const canSend = !!workspacePath && hasText && (!isAgentRunning || !!pendingQuestion);

  const planResumePending =
    mode === 'plan' && !!activePlanPath && (planPhase === 'awaiting-execute' || planPhase === 'executing');
  // The placeholder is a promise about what Enter does, so it has to know who
  // is receiving the message — `mode` is UnityIDE's and an external agent never
  // reads it. See `data/composer-copy.ts`.
  const placeholder = composerPlaceholder({
    agent: selectedAgent,
    mode,
    planResumePending,
    pendingQuestion: !!pendingQuestion,
  });

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
            {selectedAgent === 'hosted' ? (
              <>
                <ModeSelector />
                <EffortSelector />
              </>
            ) : (
              <AgentConfigBar />
            )}
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
