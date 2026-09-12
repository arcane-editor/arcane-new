/**
 * StoppedBlock — inline card rendered for a `role: 'stopped'` message (T4:
 * `detectTurnOutcome`'s rule 0, abort wins over whatever shape the tail was
 * left in). Structurally the neutral sibling of `ErrorBlock`: header row
 * (icon + title), a one-line detail, and a single action button — no
 * expandable raw section, since there is nothing to inspect when the user
 * stopped the agent on purpose.
 */

import { Square } from 'lucide-react';
import { useAiStore, type AiMessage } from '../../../stores/ai';
import { dispatchComposerSend } from '../services/composer-dispatch';

interface Props {
  message: AiMessage;
}

function StoppedBlock({ message }: Props) {
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  // Resume is latest-turn-only, same reasoning (and the same cheap selector)
  // as ErrorBlock's Retry: an older Stop marker isn't the point resuming
  // would continue from once later messages exist.
  const isLatest = useAiStore((s) => s.messages[s.messages.length - 1]?.id === message.id);
  if (!message.stopped) return null;

  function handleResume() {
    dispatchComposerSend('continue', []);
  }

  return (
    <div className="ai-message-stopped">
      <div className="ai-message-stopped-header">
        <Square size={11} strokeWidth={2} />
        <span className="ai-message-stopped-title">Stopped</span>
      </div>

      <div className="ai-message-stopped-detail">
        You stopped the agent here. Resume to continue from this point.
      </div>

      <div className="ai-message-stopped-actions">
        <button
          type="button"
          className="ai-message-stopped-resume"
          onClick={handleResume}
          disabled={isAgentRunning || !isLatest}
          title={isLatest ? 'Resume' : 'Only the most recent turn can be resumed'}
        >
          Resume
        </button>
      </div>
    </div>
  );
}

export default StoppedBlock;
