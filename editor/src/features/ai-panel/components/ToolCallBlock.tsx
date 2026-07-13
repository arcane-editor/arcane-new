/**
 * ToolCallBlock — collapsible block showing a tool invocation with args and result.
 *
 * P5.1: the header now shows a humanized title (`humanize-tool-call.ts`,
 * passed the workspace root so an absolute `args.path` displays relative —
 * review finding) instead of the raw tool name + `JSON.stringify(arguments)`
 * dump — raw args are still available behind a "Show raw" sub-toggle. When
 * the tool result carries structured `diffs` (see `diff-decorator.ts` for how
 * the Arcane path populates that field; the Claude/ACP path already did), the
 * block auto-expands and each diff gets an "Open file" affordance.
 *
 * T8: with `ai.edits.applyMode` now defaulting to `'auto'`, most diffs arrive
 * with a pending `stores/edit-review.ts` entry for their path — those render
 * Cursor-style Accept/Reject buttons instead of the legacy Revert button
 * (`DiffWithActions`'s `reviewEntry` branch). Once a path is accepted,
 * rejected, or never entered review at all (legacy approve-mode writes, or
 * sessions from before T7), it falls through to the original "Open file" +
 * per-file "Revert" pair backed by P5.2's checkpoint store — its outcome is
 * decided by `checkpoints/revert-outcome.ts` (review finding: `restoreFile`
 * never throws, so success/failure must be read out of its `RestoreResult`,
 * not assumed). That legacy lookup now prefers the exact toolCallId match
 * (`findCheckpointTurnForToolCall`, T6) over the old path-only fallback.
 */

import { useState, useEffect } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Terminal,
  Loader,
  Loader2,
  Check,
  X,
  FileText,
  RotateCcw,
} from 'lucide-react';
import type { ToolCall } from '../services/vendor/types';
import type { ToolCallStatus } from '../../../stores/ai';
import { useAiStore } from '../../../stores/ai';
import { humanizeToolCall } from '../services/humanize-tool-call';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { useEditReviewStore } from '../../../stores/edit-review';
import { findCheckpointTurnForToolCall } from '../services/checkpoints/checkpoint-selection';
import { decideRevertOutcome } from '../services/checkpoints/revert-outcome';
import DiffBlock from './DiffBlock';

interface ToolCallBlockProps {
  toolCall: ToolCall;
  status?: ToolCallStatus;
  /** The user message that started this turn — see `AssistantMessage`'s prop doc. */
  turnUserMessageId: string | null;
}

function StatusIcon({ status }: { status?: ToolCallStatus['status'] }) {
  switch (status) {
    case 'running':
      return <Loader size={12} className="ai-spin" />;
    case 'complete':
      return <Check size={12} className="ai-status-success" />;
    case 'error':
      return <X size={12} className="ai-status-error" />;
    default:
      return <Loader size={12} className="ai-status-pending" />;
  }
}

interface DiffEntry {
  path: string;
  oldText: string;
  newText: string;
}

/**
 * "Open file" + per-file review affordances wrapped around an (untouched)
 * DiffBlock. Two mutually exclusive UIs (T8):
 *  - A pending `stores/edit-review.ts` entry for `diff.path` → Accept/Reject
 *    (Cursor-style auto-apply review).
 *  - No pending entry (legacy approve-mode write, already accepted/rejected,
 *    or a pre-T7 session) → the original per-file Revert button.
 */
function DiffWithActions({
  diff,
  turnUserMessageId,
  toolCallId,
}: {
  diff: DiffEntry;
  turnUserMessageId: string | null;
  toolCallId: string;
}) {
  const turns = useCheckpointsStore((s) => s.turns);
  const restoreFile = useCheckpointsStore((s) => s.restoreFile);
  const reviewEntry = useEditReviewStore((s) => s.entries[diff.path]);
  const accept = useEditReviewStore((s) => s.accept);
  const reject = useEditReviewStore((s) => s.reject);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const [busy, setBusy] = useState(false);
  const [reverted, setReverted] = useState(false);
  const [revertFailed, setRevertFailed] = useState(false);

  const matchedTurn = turnUserMessageId
    ? findCheckpointTurnForToolCall(turns, toolCallId, turnUserMessageId, diff.path)
    : null;

  function openFile() {
    const name = diff.path.split('/').pop() ?? diff.path;
    void useWorkspaceStore.getState().openFile(diff.path, name);
  }

  // Review fix: `restoreFile` resolves a `RestoreResult` (restored/failed/
  // skippedTooLarge) and never throws, so a failed or skipped restore must be
  // read out of the result — awaiting it alone is not "it worked". On failure
  // the button stays active (not `reverted`) and shows an inline error state
  // instead of silently claiming success.
  async function revert() {
    if (!matchedTurn || busy || reverted) return;
    setBusy(true);
    try {
      const result = await restoreFile(matchedTurn.turnId, diff.path);
      if (decideRevertOutcome(result, diff.path) === 'reverted') {
        setReverted(true);
        setRevertFailed(false);
      } else {
        setRevertFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }

  // Reject reuses the SAME `restoreFile`-backed flow via the edit-review
  // store's `reject` action — its returned outcome (and any failure) is
  // tracked on the store entry itself (`lastRejectFailed`), not local state,
  // so this button reflects the true persisted state even across remounts.
  async function handleReject() {
    if (busy) return;
    setBusy(true);
    try {
      await reject(diff.path);
    } finally {
      setBusy(false);
    }
  }

  if (reviewEntry) {
    return (
      <div className="ai-diff-actions-wrap">
        <div className="ai-diff-actions">
          <button type="button" className="ai-diff-action-btn" onClick={openFile}>
            <FileText size={11} />
            Open file
          </button>
          <button type="button" className="ai-diff-action-btn" onClick={() => accept(diff.path)}>
            <Check size={11} />
            Accept
          </button>
          <button
            type="button"
            className={`ai-diff-action-btn${reviewEntry.lastRejectFailed ? ' is-error' : ''}`}
            onClick={() => void handleReject()}
            disabled={isAgentRunning || busy}
            title={
              reviewEntry.lastRejectFailed
                ? 'Reject failed — see console for details. Click to retry.'
                : undefined
            }
          >
            {busy ? (
              <Loader2 size={11} className="ai-checkpoint-spinner" />
            ) : (
              <>
                <X size={11} />
                {reviewEntry.lastRejectFailed ? 'Reject failed' : 'Reject'}
              </>
            )}
          </button>
        </div>
        <DiffBlock path={diff.path} oldText={diff.oldText} newText={diff.newText} />
      </div>
    );
  }

  return (
    <div className="ai-diff-actions-wrap">
      <div className="ai-diff-actions">
        <button type="button" className="ai-diff-action-btn" onClick={openFile}>
          <FileText size={11} />
          Open file
        </button>
        <button
          type="button"
          className={`ai-diff-action-btn${revertFailed ? ' is-error' : ''}`}
          onClick={() => void revert()}
          disabled={!matchedTurn || busy || reverted}
          title={
            !matchedTurn
              ? 'No checkpoint recorded for this file/turn'
              : revertFailed
                ? 'Revert failed — see console for details. Click to retry.'
                : undefined
          }
        >
          {busy ? (
            <Loader2 size={11} className="ai-checkpoint-spinner" />
          ) : (
            <>
              <RotateCcw size={11} />
              {reverted ? 'Reverted' : revertFailed ? 'Revert failed' : 'Revert'}
            </>
          )}
        </button>
      </div>
      <DiffBlock path={diff.path} oldText={diff.oldText} newText={diff.newText} />
    </div>
  );
}

function ToolCallBlock({ toolCall, status, turnUserMessageId }: ToolCallBlockProps) {
  const hasDiffs = (status?.diffs?.length ?? 0) > 0;
  const [expanded, setExpanded] = useState(hasDiffs);
  const [showRaw, setShowRaw] = useState(false);
  // Review fix (Finding 4): write/edit/list schemas allow absolute paths, and
  // the tools echo them back verbatim, so `args.path` isn't always
  // workspace-relative. Pass the workspace root down so `humanizeToolCall`
  // can relativize it instead of rendering a full filesystem path.
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Auto-expand the moment diffs arrive (the Arcane path only attaches them
  // once the write/edit call finishes — the block is already mounted and
  // collapsed by then), without fighting a user who deliberately collapses
  // it afterward (the effect only re-fires when `hasDiffs` itself flips).
  useEffect(() => {
    if (hasDiffs) setExpanded(true);
  }, [hasDiffs]);

  const humanized = humanizeToolCall(
    toolCall.name,
    toolCall.arguments,
    status,
    workspacePath ?? undefined,
  );

  return (
    <div className="ai-tool-call">
      <button
        className="ai-tool-call-header"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Terminal size={12} />
        <span className="ai-tool-call-name">{humanized.title}</span>
        <span className="ai-tool-call-status">
          <StatusIcon status={status?.status} />
        </span>
      </button>

      {expanded && (
        <div className="ai-tool-call-body">
          {humanized.subtitle && (
            <div className="ai-tool-call-subtitle">{humanized.subtitle}</div>
          )}

          <button
            type="button"
            className="ai-tool-call-raw-toggle"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? 'Hide raw arguments' : 'Show raw arguments'}
          </button>
          {showRaw && (
            <>
              <div className="ai-tool-call-body-label">Arguments</div>
              <pre className="ai-tool-call-code">
                {JSON.stringify(toolCall.arguments, null, 2)}
              </pre>
            </>
          )}

          {status?.diffs && status.diffs.length > 0 && (
            <>
              <div className="ai-tool-call-body-label">Changes</div>
              {status.diffs.map((d, i) => (
                <DiffWithActions
                  key={`${d.path}-${i}`}
                  diff={d}
                  turnUserMessageId={turnUserMessageId}
                  toolCallId={toolCall.id}
                />
              ))}
            </>
          )}

          {status?.result != null && status.result !== '' && (
            <>
              <div className={`ai-tool-call-body-label ${status.isError ? 'ai-tool-call-error-label' : ''}`}>
                {status.isError ? 'Error' : 'Result'}
              </div>
              <pre className={`ai-tool-call-code ${status.isError ? 'ai-tool-call-code-error' : ''}`}>
                {status.result}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ToolCallBlock;
