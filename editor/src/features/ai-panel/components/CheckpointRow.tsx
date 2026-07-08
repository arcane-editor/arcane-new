/**
 * CheckpointRow — compact divider rendered under a user message that has an
 * associated checkpoint turn (P5.2). Shows "Checkpoint · N file(s) — Restore"
 * and, on click, an inline "Restore N file(s)?" confirm (second click
 * commits) — the simplest honest rule, since we don't try to detect whether
 * disk content still matches what the turn produced.
 *
 * Renders nothing when there's no non-empty checkpoint turn for this user
 * message (either nothing was written that turn, or `ai.checkpoints.enabled`
 * was off when it ran). Per-file revert buttons on diffs are NOT part of this
 * component — P5.1 adds those directly on the diff blocks.
 *
 * Plan execution (review fix): `plan-controller.ts`'s `executePlan()` sends
 * the execution turn without a fresh `addUserMessage`, so it shares its
 * userMessageId with the earlier (always-empty) plan-planning turn. A single
 * `turns.find(...)` used to hit that empty turn and render nothing — every
 * plan-execution's checkpoints were recorded but unreachable. Instead we
 * select EVERY non-empty turn for this message (`selectCheckpointTurnsForMessage`)
 * and render one row per turn, in chronological order — with no attempt to
 * label "planning" vs "execution" (not cheaply inferable from a
 * `CheckpointTurn` alone, and usually there's only one non-empty turn anyway).
 */

import { useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { useCheckpointsStore, type RestoreResult } from '../../../stores/checkpoints';
import { selectCheckpointTurnsForMessage } from '../services/checkpoints/checkpoint-selection';
import type { CheckpointTurn } from '../services/checkpoints/restore-plan';

interface Props {
  userMessageId: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Review fix: surface partial-restore failures instead of silently dropping them. */
function formatRestoreResult({ restored, skippedTooLarge, failed }: RestoreResult): string {
  const parts = [`Restored ${plural(restored.length, 'file')}`];
  if (failed.length > 0) parts.push(`${failed.length} failed (see console)`);
  if (skippedTooLarge.length > 0) parts.push(`skipped ${plural(skippedTooLarge.length, 'file')} (too large)`);
  return parts.join(' · ');
}

function CheckpointRow({ userMessageId }: Props) {
  const turns = useCheckpointsStore((s) => s.turns);
  const matching = selectCheckpointTurnsForMessage(turns, userMessageId);

  if (matching.length === 0) return null;

  return (
    <>
      {matching.map((turn) => (
        <CheckpointRowEntry key={turn.turnId} turn={turn} />
      ))}
    </>
  );
}

function CheckpointRowEntry({ turn }: { turn: CheckpointTurn }) {
  const restoreTurn = useCheckpointsStore((s) => s.restoreTurn);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const count = turn.entries.length;

  async function handleClick() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      const outcome = await restoreTurn(turn.turnId);
      setResult(formatRestoreResult(outcome));
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
