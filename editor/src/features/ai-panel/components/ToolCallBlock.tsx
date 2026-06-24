/**
 * ToolCallBlock — collapsible block showing a tool invocation with args and result.
 */

import { useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Terminal,
  Loader,
  Check,
  X,
} from 'lucide-react';
import type { ToolCall } from '../services/vendor/types';
import type { ToolCallStatus } from '../../../stores/ai';
import DiffBlock from './DiffBlock';

interface ToolCallBlockProps {
  toolCall: ToolCall;
  status?: ToolCallStatus;
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

function ToolCallBlock({ toolCall, status }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ai-tool-call">
      <button
        className="ai-tool-call-header"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Terminal size={12} />
        <span className="ai-tool-call-name">{toolCall.name}</span>
        <span className="ai-tool-call-status">
          <StatusIcon status={status?.status} />
        </span>
      </button>

      {expanded && (
        <div className="ai-tool-call-body">
          <div className="ai-tool-call-body-label">Arguments</div>
          <pre className="ai-tool-call-code">
            {JSON.stringify(toolCall.arguments, null, 2)}
          </pre>

          {status?.diffs && status.diffs.length > 0 && (
            <>
              <div className="ai-tool-call-body-label">Changes</div>
              {status.diffs.map((d, i) => (
                <DiffBlock
                  key={`${d.path}-${i}`}
                  path={d.path}
                  oldText={d.oldText}
                  newText={d.newText}
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
