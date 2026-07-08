/**
 * MessageList — scrollable container that renders the conversation messages
 * and auto-scrolls to the bottom on new content.
 */

import { useRef, useEffect } from 'react';
import { useAiStore } from '../../../stores/ai';
import UserMessage from './UserMessage';
import AssistantMessage from './AssistantMessage';
import PlanActions from './PlanActions';
import ClaudePlanList from './ClaudePlanList';
import PermissionRequestBlock from './PermissionRequestBlock';
import VerifiedCard from './VerifiedCard';

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

  return (
    <div className="ai-panel-messages" ref={scrollRef}>
      {messages.map((msg, idx) => {
        const node = (() => {
          switch (msg.role) {
            case 'user':
              return <UserMessage key={msg.id} message={msg} />;
            case 'assistant':
              return (
                <AssistantMessage
                  key={msg.id}
                  message={msg}
                  toolCalls={toolCalls}
                />
              );
            case 'permissionRequest':
              return <PermissionRequestBlock key={msg.id} message={msg} />;
            case 'verifiedPass':
              return <VerifiedCard key={msg.id} message={msg} />;
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
      <ClaudePlanList />
      <div ref={bottomRef} />
    </div>
  );
}

export default MessageList;
