/**
 * ErrorBlock — inline card rendered for a `role: 'error'` message (T5's
 * outcome-detection choke point in `agent-service.ts`). Modeled after
 * `PermissionRequestBlock`'s structure/CSS discipline: header row (icon +
 * title), an optional one-line `detail` guidance string, a collapsed-by-
 * default expandable raw section (same expand/collapse pattern as
 * `ThinkingBlock`), and a Retry button when the error is retriable.
 */

import { useState } from 'react';
import { AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react';
import { useAiStore, type AiMessage } from '../../../stores/ai';
import { retryFailedTurn } from '../services/retry-turn';

interface Props {
  message: AiMessage;
}

function ErrorBlock({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  // Retry is latest-turn-only (see retry-turn.ts's header): an older error
  // block's replay inputs (getLastSend / rewindToLastUserPrompt) are gone,
  // so its Retry button stays disabled. Cheap selector — compares only the
  // last message's id.
  const isLatest = useAiStore((s) => s.messages[s.messages.length - 1]?.id === message.id);
  const turnError = message.turnError;
  if (!turnError) return null;

  function handleRetry() {
    // Last-resort net (same pattern ChatInput uses): retryFailedTurn's replay
    // path (resolveAttachments/syncForPromptMode) can throw outside
    // sendMessage's own try/catch, which would otherwise become an unhandled
    // rejection instead of a visible error banner.
    void retryFailedTurn(message.id).catch((e) => useAiStore.getState().setError(String(e)));
  }

  return (
    <div className="ai-message-error">
      <div className="ai-message-error-header">
        <AlertTriangle size={12} strokeWidth={2} />
        <span className="ai-message-error-title">{turnError.title}</span>
      </div>

      {turnError.detail && <div className="ai-message-error-detail">{turnError.detail}</div>}

      <button
        type="button"
        className="ai-message-error-raw-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>Details</span>
      </button>
      {expanded && <div className="ai-message-error-raw">{turnError.raw}</div>}

      {turnError.retriable && (
        <div className="ai-message-error-actions">
          <button
            type="button"
            className="ai-message-error-retry"
            onClick={handleRetry}
            disabled={isAgentRunning || !isLatest}
            title={isLatest ? 'Retry' : 'Only the most recent turn can be retried'}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

export default ErrorBlock;
