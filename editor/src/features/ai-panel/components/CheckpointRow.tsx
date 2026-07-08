/**
 * CheckpointRow — compact divider rendered under a user message that has an
 * associated checkpoint turn (P5.2). Shows "Checkpoint · N file(s) — Restore"
 * and, on click, an inline "Restore N file(s)?" confirm (second click
 * commits) — the simplest honest rule, since we don't try to detect whether
 * disk content still matches what the turn produced.
 *
 * Renders nothing when there's no checkpoint turn for this user message
 * (either nothing was written that turn, or `ai.checkpoints.enabled` was off
 * when it ran). Per-file revert buttons on diffs are NOT part of this
 * component — P5.1 adds those directly on the diff blocks.
 */

import { useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { useCheckpointsStore } from '../../../stores/checkpoints';

interface Props {
  userMessageId: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function CheckpointRow({ userMessageId }: Props) {
  const turn = useCheckpointsStore((s) => s.turns.find((t) => t.userMessageId === userMessageId));
  const restoreTurn = useCheckpointsStore((s) => s.restoreTurn);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!turn || turn.entries.length === 0) return null;

  const count = turn.entries.length;

  async function handleClick() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      const { restored, skippedTooLarge } = await restoreTurn(turn!.turnId);
      setResult(
        skippedTooLarge.length > 0
          ? `Restored ${plural(restored.length, 'file')} — skipped ${plural(skippedTooLarge.length, 'file')} (too large)`
          : `Restored ${plural(restored.length, 'file')}`,
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="ai-checkpoint-row">
      <History size={12} className="ai-checkpoint-icon" />
      <span className="ai-checkpoint-label">Checkpoint · {plural(count, 'file')}</span>
      {result ? (
        <span className="ai-checkpoint-result">{result}</span>
      ) : (
        <button
          type="button"
          className={`ai-checkpoint-btn${confirming ? ' is-confirming' : ''}`}
          onClick={handleClick}
          disabled={busy}
        >
          {busy ? (
            <Loader2 size={11} className="ai-checkpoint-spinner" />
          ) : confirming ? (
            `Restore ${plural(count, 'file')}?`
          ) : (
            'Restore'
          )}
        </button>
      )}
    </div>
  );
}

export default CheckpointRow;
