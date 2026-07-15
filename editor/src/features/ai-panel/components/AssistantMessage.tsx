/**
 * AssistantMessage — renders assistant content blocks: text (as markdown),
 * thinking, and tool calls.
 */

import { memo } from 'react';
import { Sparkles } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiMessage } from '../../../stores/ai';
import type { TextContent, ThinkingContent, ToolCall } from '../services/vendor/types';
import { hasRenderableContent } from '../services/turn-errors';
import ThinkingBlock from './ThinkingBlock';
import ToolCallBlock from './ToolCallBlock';
import StreamingIndicator from './StreamingIndicator';

// R2-T4: module-level constant so the plugins array is referentially stable
// across renders — react-markdown otherwise sees a "new" remarkPlugins array
// every render, which its own internal memoization can't see through.
const REMARK_PLUGINS = [remarkGfm];

// R2-T4: isolate each text block's markdown parse behind its own memo so a
// sibling block re-rendering (or the parent AssistantMessage re-rendering
// for an unrelated reason) doesn't re-parse markdown that hasn't changed.
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return <Markdown remarkPlugins={REMARK_PLUGINS}>{text}</Markdown>;
});

interface AssistantMessageProps {
  message: AiMessage;
  /**
   * The id of the user message that started this turn (P5.1) — threaded down
   * to `ToolCallBlock` so its per-file Revert button can find the matching
   * checkpoint turn. `null` when there's no preceding user message (shouldn't
   * normally happen, but session-restore edge cases are defensive here).
   */
  turnUserMessageId: string | null;
}

function AssistantMessage({ message, turnUserMessageId }: AssistantMessageProps) {
  // T5/R2-T3: a turn with no renderable content (no text/thinking/tool call —
  // just the bare stopReason/errorMessage T4 preserves) would otherwise
  // render as an empty bubble. This covers both an error tail (the
  // ErrorBlock that follows it in the timeline, T5's outcome-detection choke
  // point, carries the actual message) AND a 'stop'/'length' tail with
  // nothing to show — e.g. R2-T3's empty-response outcome rule classifies
  // THAT as an error too (surfaced via its own ErrorBlock), but even a
  // legitimate "silence after acting" empty stop (tool calls happened, model
  // just didn't add closing text) has nothing to render either way. A turn
  // with SOME partial content before the error/stop still renders normally
  // here.
  if (
    !hasRenderableContent(message.content) &&
    (message.stopReason === 'error' || message.stopReason === 'stop' || message.stopReason === 'length')
  )
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
              return <MarkdownBlock key={i} text={(block as TextContent).text} />;
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

export default memo(AssistantMessage);
