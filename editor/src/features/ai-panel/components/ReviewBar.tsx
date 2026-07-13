/**
 * ReviewBar — Cursor-style review bar (T8) for auto-applied file edits
 * pending Accept/Reject, backed by `stores/edit-review.ts` (T7). Hidden
 * entirely when nothing is pending.
 *
 * Header: "N file(s) changed" + an expand/collapse chevron, plus
 * bar-level "Accept all" / "Reject all" (the latter using the SAME
 * two-click confirm pattern as `CheckpointRow`'s "Restore" button — both
 * disabled while the agent is running, since mutating files mid-turn would
 * fight the agent).
 *
 * Expanded: one row per pending file — basename + directory hint
 * (`review-row.ts`), an "Open file" affordance (the same pattern
 * `ToolCallBlock`'s `DiffWithActions` uses), and per-file Accept/Reject.
 * A failed reject persists on the entry itself (`lastRejectFailed`) so a
 * row's Reject button reflects it even across remounts — same convention
 * `DiffWithActions` uses for its own Accept/Reject pair.
 *
 * Mounted in `AiChatPanel.tsx` between `<MessageList />` and `<ChatInput />`.
 */

import { useState } from 'react';
import { ChevronRight, ChevronDown, Check, X, FileText, Loader2 } from 'lucide-react';
import { useEditReviewStore } from '../../../stores/edit-review';
import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { listPending, type PendingReviewEntry } from '../services/edit-review/review-core';
import { formatReviewRowLabel } from '../services/edit-review/review-row';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function ReviewBarRow({
  entry,
  isAgentRunning,
}: {
  entry: PendingReviewEntry;
  isAgentRunning: boolean;
}) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const accept = useEditReviewStore((s) => s.accept);
  const reject = useEditReviewStore((s) => s.reject);
  const [busy, setBusy] = useState(false);

  const { name, dirHint } = formatReviewRowLabel(entry.path, workspacePath);

  function openFile() {
    void useWorkspaceStore.getState().openFile(entry.path, name);
  }

  async function handleReject() {
    if (busy) return;
    setBusy(true);
    try {
      await reject(entry.path);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-review-bar-row">
      <div className="ai-review-bar-row-name" title={entry.path}>
        <span className="ai-review-bar-row-basename">{name}</span>
        {dirHint && <span className="ai-review-bar-row-dir">{dirHint}</span>}
      </div>
      <div className="ai-review-bar-row-actions">
        <button type="button" className="ai-diff-action-btn" onClick={openFile}>
          <FileText size={11} />
          Open file
        </button>
        <button type="button" className="ai-diff-action-btn" onClick={() => accept(entry.path)}>
          <Check size={11} />
          Accept
        </button>
        <button
          type="button"
          className={`ai-diff-action-btn${entry.lastRejectFailed ? ' is-error' : ''}`}
          onClick={() => void handleReject()}
          disabled={isAgentRunning || busy}
          title={
            entry.lastRejectFailed
              ? 'Reject failed — see console for details. Click to retry.'
              : undefined
          }
        >
          {busy ? (
            <Loader2 size={11} className="ai-checkpoint-spinner" />
          ) : (
            <>
              <X size={11} />
              {entry.lastRejectFailed ? 'Reject failed' : 'Reject'}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function ReviewBar() {
  const entries = useEditReviewStore((s) => s.entries);
  const acceptAll = useEditReviewStore((s) => s.acceptAll);
  const rejectAll = useEditReviewStore((s) => s.rejectAll);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const [expanded, setExpanded] = useState(false);
  const [confirmingRejectAll, setConfirmingRejectAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);

  const pending = listPending(entries);
  const count = pending.length;

  if (count === 0) return null;

  const failedCount = pending.filter((e) => e.lastRejectFailed).length;

  async function handleRejectAll() {
    if (!confirmingRejectAll) {
      setConfirmingRejectAll(true);
      return;
    }
    setBusyAll(true);
    try {
      await rejectAll();
    } finally {
      setBusyAll(false);
      setConfirmingRejectAll(false);
    }
  }

  return (
    <div className="ai-review-bar">
      <div className="ai-review-bar-header">
        <button
          type="button"
          className="ai-review-bar-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{plural(count, 'file')} changed</span>
        </button>
        <div className="ai-review-bar-actions">
          <button
            type="button"
            className="ai-checkpoint-btn"
            onClick={() => acceptAll()}
            disabled={isAgentRunning}
          >
            <Check size={11} />
            Accept all
          </button>
          <button
            type="button"
            className={`ai-checkpoint-btn${confirmingRejectAll ? ' is-confirming' : ''}`}
            onClick={() => void handleRejectAll()}
            disabled={isAgentRunning || busyAll}
          >
            {busyAll ? (
              <Loader2 size={11} className="ai-checkpoint-spinner" />
            ) : confirmingRejectAll ? (
              `Confirm reject ${plural(count, 'file')}`
            ) : (
              <>
                <X size={11} />
                Reject all
              </>
            )}
          </button>
        </div>
      </div>

      {failedCount > 0 && (
        <div className="ai-review-bar-error">
          {plural(failedCount, 'file')} failed to reject (see console)
        </div>
      )}

      {expanded && (
        <div className="ai-review-bar-list">
          {pending.map((entry) => (
            <ReviewBarRow key={entry.path} entry={entry} isAgentRunning={isAgentRunning} />
          ))}
        </div>
      )}
    </div>
  );
}

export default ReviewBar;
