// Restore-plan (P5.2) — the pure, Bun-testable correctness core of per-turn
// checkpoints. Content snapshots, NOT shadow git (approved plan): the
// pre-image is already in memory at the write/edit hook points, and a git
// stash would pollute the user's repo state — only text flows through the
// tools anyway.
//
// Restore-to-before-turn-N rule: for every path touched in any turn at or
// after N (turns are chronological — array order), apply the EARLIEST
// snapshot at-or-after N. That snapshot is either:
//   - the very first write/edit this path saw in the qualifying range, or
//   - if that first touch created the file (it didn't exist before), the
//     correct "restore" is to delete it.
// This one rule handles every case: restoring turn N itself undoes N (its own
// snapshot IS "before N"); restoring an earlier turn M < N (when the path
// wasn't touched in M) still finds the earliest later touch, which is
// unaffected by M since nothing changed the path before it.
//
// Dedupe: within a single turn, only the FIRST snapshot per path is ever
// recorded (see `recordPreWrite` in `stores/checkpoints.ts`) — but this module
// stays defensive and picks the first entry per path regardless of how many a
// turn happens to carry, so a turn with an (unexpected) duplicate still
// resolves the same way dedupe would have.
//
// Size cap: a snapshot whose pre-image exceeded the 2MB cap is recorded with
// `tooLarge: true` instead of content (see `stores/checkpoints.ts`). Such
// paths are left out of the restore plan entirely (nothing to write, and
// deleting a file whose "before" we never captured would be destructive) —
// `getSkippedTooLargePaths` surfaces them separately so the caller can show a
// notice.

export interface CheckpointEntry {
  /** Absolute path. */
  path: string;
  /** 'created' = the file didn't exist before this write; 'modified' = it did. */
  kind: 'modified' | 'created';
  /**
   * Content immediately before the write. Undefined for 'created' entries
   * (nothing to restore to but "doesn't exist") and for oversized 'modified'
   * snapshots (see `tooLarge`).
   */
  beforeContent?: string;
  /** Set when the pre-image exceeded the snapshot size cap — content wasn't stored. */
  tooLarge?: true;
  /** The tool call that triggered this snapshot, if known (future per-file revert UI). */
  toolCallId?: string;
  timestamp: number;
}

export interface CheckpointTurn {
  turnId: string;
  sessionId: string;
  /** AiMessage id of the user message that started this turn — UI anchor for CheckpointRow. */
  userMessageId: string;
  timestamp: number;
  /** Chronological within the turn. */
  entries: CheckpointEntry[];
}

export interface RestorePlanEntry {
  path: string;
  action: 'write' | 'delete';
  /** Present only for action: 'write'. */
  content?: string;
}

function indexOfTurn(turns: CheckpointTurn[], turnId: string): number {
  return turns.findIndex((t) => t.turnId === turnId);
}

/** First entry per path across `turns[fromIndex..]`, in chronological (turn, then within-turn) order. */
function resolveEarliestEntries(
  turns: CheckpointTurn[],
  fromIndex: number,
): Map<string, CheckpointEntry> {
  const earliest = new Map<string, CheckpointEntry>();
  for (let i = fromIndex; i < turns.length; i++) {
    for (const entry of turns[i].entries) {
      if (!earliest.has(entry.path)) earliest.set(entry.path, entry);
    }
  }
  return earliest;
}

/**
 * Compute the restore plan for "undo turn `turnId` and everything after it."
 * Returns `[]` if `turnId` isn't in `turns` (nothing to restore).
 */
export function computeRestorePlan(turns: CheckpointTurn[], turnId: string): RestorePlanEntry[] {
  const fromIndex = indexOfTurn(turns, turnId);
  if (fromIndex === -1) return [];

  const plan: RestorePlanEntry[] = [];
  for (const entry of resolveEarliestEntries(turns, fromIndex).values()) {
    if (entry.kind === 'created') {
      plan.push({ path: entry.path, action: 'delete' });
    } else if (entry.tooLarge) {
      continue; // skipped — see getSkippedTooLargePaths
    } else {
      plan.push({ path: entry.path, action: 'write', content: entry.beforeContent ?? '' });
    }
  }
  return plan;
}

/**
 * Paths whose restore was skipped because their pre-image exceeded the
 * snapshot size cap — for a "N file(s) skipped, too large" notice.
 */
export function getSkippedTooLargePaths(turns: CheckpointTurn[], turnId: string): string[] {
  const fromIndex = indexOfTurn(turns, turnId);
  if (fromIndex === -1) return [];
  return Array.from(resolveEarliestEntries(turns, fromIndex).values())
    .filter((e) => e.tooLarge)
    .map((e) => e.path);
}
