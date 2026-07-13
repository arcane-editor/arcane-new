// Edit-review pure core (T6) — the correctness core for Cursor-style
// auto-apply + Accept/Reject review. This module is intentionally free of
// zustand/react/Tauri imports: pure operations on a
// `Record<string, PendingReviewEntry>` (keyed by absolute path), Bun-testable
// without any runtime. Nothing consumes this module yet — the review STORE
// (state + persistence wiring) and the `withEditReview` decorator that
// registers entries are later tasks (T7); this task only builds and tests the
// pure core in isolation.
//
// A `PendingReviewEntry` represents one file with an unreviewed auto-applied
// change, anchored to the checkpoint turn whose pre-image is the "reject"
// target (`turnId`/`userMessageId` — see `checkpoints/restore-plan.ts` and
// `checkpoints/checkpoint-selection.ts`, which this module deliberately does
// NOT import: turn *selection* is a checkpoint-store concern, this module
// only tracks which paths are pending and which tool calls touched them).
//
// Dedupe rule (mirrors `stores/checkpoints.ts`'s `recordPreWrite` and
// `restore-plan.ts`'s earliest-at-or-after rule): the FIRST pre-image for a
// path is the one "reject" must restore to, so re-registering an already
// pending path keeps the ORIGINAL `turnId`/`userMessageId`/`firstChangeAt` —
// only the toolCallIds list (deduped) and `lastChangeAt` move forward, and
// any previous `lastRejectFailed` flag is cleared (a fresh change supersedes
// a stale failed-reject notice).

export interface PendingReviewEntry {
  /** Absolute path. */
  path: string;
  /** Checkpoint turn id the pre-image (the "reject" target) lives in. */
  turnId: string;
  userMessageId: string;
  /** Every tool call that touched this path while it's been pending, in order first-seen. */
  toolCallIds: string[];
  firstChangeAt: number;
  lastChangeAt: number;
  /** Set when the most recent reject attempt for this path failed (e.g. restore I/O error). */
  lastRejectFailed?: boolean;
}

export interface RegisterReviewEntryInput {
  path: string;
  turnId: string;
  userMessageId: string;
  toolCallId: string;
  now: number;
}

/** Immutable update: register (or update) a pending review entry for `input.path`. */
export function registerReviewEntry(
  entries: Record<string, PendingReviewEntry>,
  input: RegisterReviewEntryInput,
): Record<string, PendingReviewEntry> {
  const { path, turnId, userMessageId, toolCallId, now } = input;
  const existing = entries[path];

  const next: PendingReviewEntry = existing
    ? {
        path,
        turnId: existing.turnId,
        userMessageId: existing.userMessageId,
        toolCallIds: existing.toolCallIds.includes(toolCallId)
          ? existing.toolCallIds
          : [...existing.toolCallIds, toolCallId],
        firstChangeAt: existing.firstChangeAt,
        lastChangeAt: now,
        // lastRejectFailed intentionally omitted — clears any prior failure.
      }
    : {
        path,
        turnId,
        userMessageId,
        toolCallIds: [toolCallId],
        firstChangeAt: now,
        lastChangeAt: now,
      };

  return { ...entries, [path]: next };
}

/** Immutable update: remove the listed paths from the pending set. */
export function clearReviewPaths(
  entries: Record<string, PendingReviewEntry>,
  paths: string[],
): Record<string, PendingReviewEntry> {
  if (paths.length === 0) return entries;
  const toRemove = new Set(paths);
  const next: Record<string, PendingReviewEntry> = {};
  for (const [path, entry] of Object.entries(entries)) {
    if (!toRemove.has(path)) next[path] = entry;
  }
  return next;
}

export function pendingCount(entries: Record<string, PendingReviewEntry>): number {
  return Object.keys(entries).length;
}

/** Stable order: by `firstChangeAt` ascending, tie-broken by path — deterministic UI list order. */
export function listPending(entries: Record<string, PendingReviewEntry>): PendingReviewEntry[] {
  return Object.values(entries).sort(
    (a, b) => a.firstChangeAt - b.firstChangeAt || a.path.localeCompare(b.path),
  );
}

// ---- T7 additions ----
//
// `stores/edit-review.ts`'s zustand actions reach this module through a
// dynamic `import()` of the `ai-panel` barrel (Bun-safety — see that store's
// header), which means the actions THEMSELVES can't be exercised directly
// from a Bun test without crashing on that import (same limitation
// `stores/checkpoints.ts` already has, and why it has no direct test file).
// The two functions below extract the store's nontrivial branching — "no
// active turn is a no-op", "anchor to the LAST (current) turn", and "flag a
// failed reject" — so THAT logic stays independently Bun-testable, same
// spirit as `registerReviewEntry`/`clearReviewPaths` above.

/** Register a review entry anchored to the LAST turn in `turns` (the currently-open checkpoint turn). */
export function registerForActiveTurn(
  entries: Record<string, PendingReviewEntry>,
  turns: { turnId: string; userMessageId: string }[],
  path: string,
  toolCallId: string,
  now: number,
): Record<string, PendingReviewEntry> {
  if (turns.length === 0) return entries; // no active turn — no pre-image captured, nothing to reject back to
  const { turnId, userMessageId } = turns[turns.length - 1];
  return registerReviewEntry(entries, { path, turnId, userMessageId, toolCallId, now });
}

/**
 * Immutable update: flag `path`'s pending entry as having just failed a
 * reject attempt (e.g. `restoreFile` I/O error) — a fresh successful
 * register (see `registerReviewEntry`'s dedupe rule above) clears this flag
 * again. No-op (returns the SAME record reference) if `path` isn't pending.
 */
export function markRejectFailed(
  entries: Record<string, PendingReviewEntry>,
  path: string,
): Record<string, PendingReviewEntry> {
  const existing = entries[path];
  if (!existing) return entries;
  return { ...entries, [path]: { ...existing, lastRejectFailed: true } };
}
