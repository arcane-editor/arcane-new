/**
 * AssistantMessage — renders assistant content blocks: text (as markdown),
 * thinking, and tool calls.
 */

import { Sparkles } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiMessage, ToolCallStatus } from '../../../stores/ai';
import type { TextContent, ThinkingContent, ToolCall } from '../services/vendor/types';
import { hasRenderableContent } from '../services/turn-errors';
import ThinkingBlock from './ThinkingBlock';
import ToolCallBlock from './ToolCallBlock';
import StreamingIndicator from './StreamingIndicator';

interface AssistantMessageProps {
  message: AiMessage;
  toolCalls: Map<string, ToolCallStatus>;
  /**
   * The id of the user message that started this turn (P5.1) — threaded down
   * to `ToolCallBlock` so its per-file Revert button can find the matching
   * checkpoint turn. `null` when there's no preceding user message (shouldn't
   * normally happen, but session-restore edge cases are defensive here).
   */
  turnUserMessageId: string | null;
}

function AssistantMessage({ message, toolCalls, turnUserMessageId }: AssistantMessageProps) {
  // T5/R2-T3: a turn with no renderable content (no text/thinking/tool call —
  // just the bare stopReason/errorMessage T4 preserves) would otherwise
  // render as an empty bubble. This covers both an error tail (the
  // ErrorBlock that follows it in the timeline, T5's outcome-detection choke
  // point, carries the actual message) AND a 'stop' tail with nothing to
  // show — e.g. R2-T3's empty-response outcome rule classifies THAT as an
  // error too (surfaced via its own ErrorBlock), but even a legitimate
  // "silence after acting" empty stop (tool calls happened, model just
  // didn't add closing text) has nothing to render either way. A turn with
  // SOME partial content before the error/stop still renders normally here.
  if (!hasRenderableContent(message.content) && (message.stopReason === 'error' || message.stopReason === 'stop'))
    return null;

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
                  turnUserMessageId={turnUserMessageId}
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
