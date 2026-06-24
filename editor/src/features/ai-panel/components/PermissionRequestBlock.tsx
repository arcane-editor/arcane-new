/**
 * PermissionRequestBlock — inline approval UI rendered in the message list
 * when Claude (via ACP `session/request_permission`) asks before running a
 * tool. After the user picks, the buttons lock and show the chosen option.
 */

import { Shield, Check, X } from 'lucide-react';
import { useAiStore, type AiMessage } from '../../../stores/ai';
import { getClaudeAgentService } from '../services/claude-agent-service';
import { resolveEngineApproval } from '../services/approval-gate';

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
  if (!req) return null;

  const resolved = !!req.resolvedOptionId;
  const selectedOption = req.options.find((o) => o.optionId === req.resolvedOptionId);

  function pick(optionId: string) {
    if (resolved) return;
    // Route to the right backend: Claude uses ACP; the Arcane vendor loop uses
    // the engine-approval gate (F-5.6). Both converge on resolvePermissionRequest
    // to lock the buttons.
    if (useAiStore.getState().selectedAgent === 'claude') {
      getClaudeAgentService().resolvePermission(req!.toolCallId, optionId);
    } else {
      resolveEngineApproval(req!.toolCallId, optionId);
    }
  }

  return (
    <div className={`ai-panel-permission ${resolved ? 'is-resolved' : ''}`}>
      <div className="ai-panel-permission-header">
        <Shield size={12} strokeWidth={2} />
        <span className="ai-panel-permission-title">
          {req.toolName ? `Allow ${req.toolName}?` : 'Allow this action?'}
        </span>
      </div>

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

      {resolved && selectedOption && (
        <div className="ai-panel-permission-resolved">
          Chosen: {selectedOption.name}
        </div>
      )}
    </div>
  );
}

export default PermissionRequestBlock;
