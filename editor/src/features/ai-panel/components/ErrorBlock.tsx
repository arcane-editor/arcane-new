/**
 * ErrorBlock — inline card rendered for a `role: 'error'` message (T5's
 * outcome-detection choke point in `agent-service.ts`). Modeled after
 * `PermissionRequestBlock`'s structure/CSS discipline: header row (icon +
 * title), an optional one-line `detail` guidance string, a collapsed-by-
 * default expandable raw section (same expand/collapse pattern as
 * `ThinkingBlock`), and a Retry button when the error is retriable.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react';
import { useAiStore, type AiMessage } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { retryFailedTurn } from '../services/retry-turn';
import { formatRetryCountdown, resolveErrorDetail, retryUnlocked } from '../services/retry-countdown';

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
  const retryAt = turnError?.retryAt;
  const [now, setNow] = useState(() => Date.now());
  const locked = retryAt !== undefined && !retryUnlocked(retryAt, now);

  // Ticks `now` once a second ONLY while locked, so the countdown below
  // stays live and the Retry button self-enables the moment it unlocks —
  // with no remount, since `locked` (derived from `now` every render) is
  // what the disabled prop reads. Cleared on unmount and the instant the
  // lockout clears (the effect re-runs when `locked` flips to false and, on
  // that run, `retryUnlocked` is already true, so no new interval is armed).
  useEffect(() => {
    if (retryAt === undefined || retryUnlocked(retryAt, now)) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is deliberately excluded: it's the effect's OWN output (via setNow), not an input that should restart the interval.
  }, [retryAt, locked]);

  if (!turnError) return null;

  // `detail` may carry a literal `{countdown}` placeholder (turn-errors.ts's
  // hourly_cap/rate_limit copy) — filled in with the live countdown so the
  // classification stays pure/deterministic and only the render layer knows
  // about wall-clock time. Once the lockout has elapsed (or a restored session
  // brings back a `retryAt` already in the past) the countdown sentence is
  // dropped instead of rendering "Retry unlocks in 0:00."
  const detail = resolveErrorDetail(turnError.detail, retryAt, now);

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

      {detail && <div className="ai-message-error-detail">{detail}</div>}

      <button
        type="button"
        className="ai-message-error-raw-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>Details</span>
      </button>
      {expanded && <div className="ai-message-error-raw">{turnError.raw}</div>}

      {(turnError.retriable || turnError.kind === 'credits' || turnError.kind === 'tier_gated') && (
        <div className="ai-message-error-actions">
          {turnError.retriable && (
            <button
              type="button"
              className="ai-message-error-retry"
              onClick={handleRetry}
              disabled={isAgentRunning || !isLatest || locked}
              title={
                locked && retryAt !== undefined
                  ? `Retry unlocks in ${formatRetryCountdown(retryAt, now)}`
                  : isLatest
                    ? 'Retry'
                    : 'Only the most recent turn can be retried'
              }
            >
              Retry
            </button>
          )}
          {turnError.kind === 'credits' && (
            <button
              type="button"
              className="ai-message-error-retry"
              onClick={() => {
                void useAuthStore.getState().openBilling();
              }}
            >
              Manage plan & credits
            </button>
          )}
          {turnError.kind === 'tier_gated' && (
            <button
              type="button"
              className="ai-message-error-retry"
              onClick={() => {
                void useAuthStore.getState().openBilling();
              }}
            >
              Upgrade plan
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default ErrorBlock;
