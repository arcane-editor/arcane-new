/**
 * ToolCallBlock — collapsible block showing a tool invocation with args and result.
 *
 * P5.1: the header now shows a humanized title (`humanize-tool-call.ts`)
 * instead of the raw tool name + `JSON.stringify(arguments)` dump — raw args
 * are still available behind a "Show raw" sub-toggle. When the tool result
 * carries structured `diffs` (see `diff-decorator.ts` for how the Arcane path
 * populates that field; the Claude/ACP path already did), the block
 * auto-expands and each diff gets an "Open file" affordance plus a per-file
 * "Revert" button backed by P5.2's checkpoint store.
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
import { humanizeToolCall } from '../services/humanize-tool-call';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { findCheckpointTurnForPath } from '../services/checkpoints/checkpoint-selection';
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

/** "Open file" + per-file "Revert" affordances wrapped around an (untouched) DiffBlock. */
function DiffWithActions({
  diff,
  turnUserMessageId,
}: {
  diff: DiffEntry;
  turnUserMessageId: string | null;
}) {
  const turns = useCheckpointsStore((s) => s.turns);
  const restoreFile = useCheckpointsStore((s) => s.restoreFile);
  const [busy, setBusy] = useState(false);
  const [reverted, setReverted] = useState(false);

  const matchedTurn = turnUserMessageId
    ? findCheckpointTurnForPath(turns, turnUserMessageId, diff.path)
    : undefined;

  function openFile() {
    const name = diff.path.split('/').pop() ?? diff.path;
    void useWorkspaceStore.getState().openFile(diff.path, name);
  }

  async function revert() {
    if (!matchedTurn || busy || reverted) return;
    setBusy(true);
    try {
      await restoreFile(matchedTurn.turnId, diff.path);
      setReverted(true);
    } finally {
      setBusy(false);
    }
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
          className="ai-diff-action-btn"
          onClick={() => void revert()}
          disabled={!matchedTurn || busy || reverted}
          title={!matchedTurn ? 'No checkpoint recorded for this file/turn' : undefined}
        >
          {busy ? (
            <Loader2 size={11} className="ai-checkpoint-spinner" />
          ) : (
            <>
              <RotateCcw size={11} />
              {reverted ? 'Reverted' : 'Revert'}
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

  // Auto-expand the moment diffs arrive (the Arcane path only attaches them
  // once the write/edit call finishes — the block is already mounted and
  // collapsed by then), without fighting a user who deliberately collapses
  // it afterward (the effect only re-fires when `hasDiffs` itself flips).
  useEffect(() => {
    if (hasDiffs) setExpanded(true);
  }, [hasDiffs]);

  const humanized = humanizeToolCall(toolCall.name, toolCall.arguments, status);

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
