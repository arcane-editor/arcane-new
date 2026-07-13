/**
 * MessageList — scrollable container that renders the conversation messages
 * and auto-scrolls to the bottom on new content.
 */

import { useRef, useEffect } from 'react';
import { useAiStore } from '../../../stores/ai';
import UserMessage from './UserMessage';
import AssistantMessage from './AssistantMessage';
import PlanActions from './PlanActions';
import PlanList from './PlanList';
import PermissionRequestBlock from './PermissionRequestBlock';
import VerifiedCard from './VerifiedCard';
import CheckpointRow from './CheckpointRow';
import ErrorBlock from './ErrorBlock';

function MessageList() {
  const messages = useAiStore((s) => s.messages);
  const toolCalls = useAiStore((s) => s.toolCalls);
  const planPhase = useAiStore((s) => s.planPhase);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, planPhase]);

  // Find the index of the last assistant message so we can render PlanActions
  // immediately after it when we're awaiting user approval.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  const showPlanActions = planPhase === 'awaiting-execute';

  // P5.1: track the most recent preceding user message id so ToolCallBlock's
  // per-file Revert can look up the right checkpoint turn
  // (`findCheckpointTurnForPath` matches by (userMessageId, path) — see that
  // function's header for why toolCallId isn't available instead).
  let currentUserMessageId: string | null = null;

  return (
    <div className="ai-panel-messages" ref={scrollRef}>
      {messages.map((msg, idx) => {
        if (msg.role === 'user') currentUserMessageId = msg.id;

        const node = (() => {
          switch (msg.role) {
            case 'user':
              return (
                <div key={msg.id}>
                  <UserMessage message={msg} />
                  <CheckpointRow userMessageId={msg.id} />
                </div>
              );
            case 'assistant':
              return (
                <AssistantMessage
                  key={msg.id}
                  message={msg}
                  toolCalls={toolCalls}
                  turnUserMessageId={currentUserMessageId}
                />
              );
            case 'permissionRequest':
              return <PermissionRequestBlock key={msg.id} message={msg} />;
            case 'verifiedPass':
              return <VerifiedCard key={msg.id} message={msg} />;
            case 'error':
              return <ErrorBlock key={msg.id} message={msg} />;
            case 'system':
              return (
                <div key={msg.id} className="ai-panel-system-message">
                  {msg.text}
                </div>
              );
            // toolResult messages are rendered inline via ToolCallBlock
            default:
              return null;
          }
        })();

        if (idx === lastAssistantIdx && showPlanActions) {
          return (
            <div key={msg.id}>
              {node}
              <PlanActions />
            </div>
          );
        }
        return node;
      })}
      <PlanList />
      <div ref={bottomRef} />
    </div>
  );
}

export default MessageList;
