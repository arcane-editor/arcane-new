/**
 * AssistantMessage — renders assistant content blocks: text (as markdown),
 * thinking, and tool calls.
 */

import { Sparkles } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiMessage, ToolCallStatus } from '../../../stores/ai';
import type { TextContent, ThinkingContent, ToolCall } from '../services/vendor/types';
import ThinkingBlock from './ThinkingBlock';
import ToolCallBlock from './ToolCallBlock';
import StreamingIndicator from './StreamingIndicator';

interface AssistantMessageProps {
  message: AiMessage;
  toolCalls: Map<string, ToolCallStatus>;
}

function AssistantMessage({ message, toolCalls }: AssistantMessageProps) {
  const blocks = message.content ?? [];

  return (
    <div className="ai-message assistant">
      <div className="ai-message-avatar">
        <Sparkles size={14} />
      </div>
      <div className="ai-message-content">
        {blocks.map((block, i) => {
          switch (block.type) {
            case 'text':
              return (
                <Markdown key={i} remarkPlugins={[remarkGfm]}>
                  {(block as TextContent).text}
                </Markdown>
              );
            case 'thinking':
              return (
                <ThinkingBlock
                  key={i}
                  thinking={(block as ThinkingContent).thinking}
                />
              );
            case 'toolCall': {
              const tc = block as ToolCall;
              return (
                <ToolCallBlock
                  key={tc.id}
                  toolCall={tc}
                  status={toolCalls.get(tc.id)}
                />
              );
            }
            default:
              return null;
          }
        })}
        {message.isStreaming && <StreamingIndicator />}
      </div>
    </div>
  );
}

export default AssistantMessage;
