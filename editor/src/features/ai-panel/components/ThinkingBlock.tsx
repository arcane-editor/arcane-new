/**
 * ThinkingBlock — collapsible block that displays the model's chain-of-thought reasoning.
 */

import { useState, memo } from 'react';
import { Brain, ChevronRight, ChevronDown } from 'lucide-react';

interface ThinkingBlockProps {
  thinking: string;
}

function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ai-thinking">
      <button
        className="ai-thinking-header"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        <span>Thinking...</span>
      </button>

      {expanded && (
        <div className="ai-thinking-body">{thinking}</div>
      )}
    </div>
  );
}

export default memo(ThinkingBlock);
