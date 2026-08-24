/**
 * PermissionRequestBlock — inline approval UI rendered in the message list
 * when an Arcane Unity engine-mutate tool asks before touching the live
 * editor (F-5.6), or Arcane's write/edit tools ask before touching a file
 * (P5.3, `write-approval-gate.ts`). After the user picks, the buttons lock
 * and show the chosen option.
 *
 * P5.3: when `req.diff` is present (the file-write approval path), the diff
 * renders EXPANDED above the buttons via `DiffBlock`, with a humanized header
 * (`humanizeToolCall`, reused from P5.1's tool-call rendering for the exact
 * same "+N −M" counting) and an "Open file" affordance (P5.1's
 * `ToolCallBlock` pattern) — no "Revert" button here, since a pending/
 * rejected write was never checkpointed.
 */

import { Shield, Check, X, FileText } from 'lucide-react';
import { type AiMessage } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { resolvePendingApproval } from '../services/approval-gate';
import { humanizeToolCall } from '../services/humanize-tool-call';
import DiffBlock from './DiffBlock';

interface Props {
  message: AiMessage;
}

const KIND_TO_ICON: Record<string, typeof Check> = {
  allow_once: Check,
  allow_always: Check,
  reject_once: X,
  reject_always: X,
};

function PermissionRequestBlock({ message }: Props) {
  const req = message.permissionRequest;
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  if (!req) return null;

  const resolved = !!req.resolvedOptionId;
  const selectedOption = req.options.find((o) => o.optionId === req.resolvedOptionId);
  const diff = req.diff;
  const humanized = diff
    ? humanizeToolCall(req.toolName ?? 'write', { path: diff.path }, { diffs: [diff] }, workspacePath ?? undefined)
    : null;

  function pick(optionId: string) {
    if (resolved) return;
    // The Arcane vendor loop (engine-mutate approvals AND P5.3's file-write
    // approvals) uses the shared approval-gate pending-map flow, which resolves
    // the pending promise and locks the buttons.
    resolvePendingApproval(req!.toolCallId, optionId);
  }

  function openFile() {
    if (!diff) return;
    const name = diff.path.split('/').pop() ?? diff.path;
    void useWorkspaceStore.getState().openFile(diff.path, name);
  }

  return (
    <div className={`ai-panel-permission ${resolved ? 'is-resolved' : ''}`}>
      <div className="ai-panel-permission-header">
        <Shield size={12} strokeWidth={2} />
        <span className="ai-panel-permission-title">
          {diff
            ? 'Approve this file change?'
            : req.toolName
              ? `Allow ${req.toolName}?`
              : 'Allow this action?'}
        </span>
      </div>

      {req.detail && <div className="ai-panel-permission-detail">{req.detail}</div>}

      {diff && (
        <div className="ai-panel-permission-diff">
          {humanized && <div className="ai-tool-call-body-label">{humanized.title}</div>}
          <div className="ai-diff-actions">
            <button type="button" className="ai-diff-action-btn" onClick={openFile}>
              <FileText size={11} />
              Open file
            </button>
          </div>
          <DiffBlock path={diff.path} oldText={diff.oldText} newText={diff.newText} />
        </div>
      )}

      <div className="ai-panel-permission-actions">
        {req.options.map((opt) => {
          const Icon = KIND_TO_ICON[opt.kind] ?? Check;
          const isSelected = req.resolvedOptionId === opt.optionId;
          const isReject = opt.kind === 'reject_once' || opt.kind === 'reject_always';
          return (
            <button
              key={opt.optionId}
              type="button"
              className={`ai-panel-permission-btn ${isReject ? 'is-reject' : 'is-allow'} ${
                isSelected ? 'is-selected' : ''
              }`}
              onClick={() => pick(opt.optionId)}
              disabled={resolved}
              title={opt.name}
            >
              <Icon size={11} strokeWidth={2.5} />
              <span>{opt.name}</span>
            </button>
          );
        })}
      </div>

      {resolved && !selectedOption && (
        <div className="ai-panel-permission-chosen">
          Expired — this request ended when the app restarted.
        </div>
      )}
      {resolved && selectedOption && (
        <div className="ai-panel-permission-resolved">
          Chosen: {selectedOption.name}
        </div>
      )}
    </div>
  );
}

export default PermissionRequestBlock;
