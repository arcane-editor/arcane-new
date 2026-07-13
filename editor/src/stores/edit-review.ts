/**
 * Edit-review store (T7) — Cursor-style auto-apply + Accept/Reject review:
 * tracks which files have an unreviewed auto-applied change pending, backed
 * by `~/.arcane/reviews/<sessionId>.json` (mirrors `stores/checkpoints.ts`'s
 * per-session JSON file + 600ms debounced persist, right down to the
 * flush/reset shape).
 *
 * All decision logic (what a pending entry looks like, dedupe, ordering) is
 * pure and lives in `features/ai-panel/services/edit-review/review-core.ts`
 * (T6/T7) — this store is state + wiring: which entries are pending for the
 * CURRENT session, and the cross-store call to `useCheckpointsStore` needed
 * to actually reject a change back to its pre-image.
 *
 * "Reject" reuses `stores/checkpoints.ts`'s `restoreFile` — the single
 * source of truth for restoring a path. On a SUCCESSFUL reject, the pending
 * entry is cleared not here but from `stores/checkpoints.ts`'s `restoreTurn`/
 * `restoreFile` themselves (see their header): every restore — whether
 * triggered from a checkpoint turn's "Restore" or from this store's
 * "Reject" — clears the same pending-review state for whatever paths
 * actually landed, from one choke point rather than two call sites that
 * could drift. On a FAILED reject, this store is the one place that sets
 * `lastRejectFailed`.
 *
 * Bun-safety EXACTLY like `stores/checkpoints.ts` (see that file's header for
 * the full "why"): top-level imports are limited to zustand + a TYPE-ONLY
 * `ai-panel` barrel import (erased at compile time, never evaluates the
 * barrel) + the `checkpoints` sibling store (itself Bun-safe). A *value*
 * import of the `ai-panel` barrel eventually reaches `stores/theme.ts`'s
 * module-scope `document` access and crashes under Bun's DOM-less test
 * runtime — every such import below is deferred behind a dynamic
 * `await import()` inside the action that needs it, never at module scope.
 * This matters here specifically because `edit-review-decorator.ts` imports
 * `useEditReviewStore` at MODULE scope, and its own test
 * (`edit-review-decorator.test.ts`) must survive a bare import of this file.
 *
 * Bun-test note: because `register`/`accept`/`acceptAll`/`clearForPaths`/
 * `reject`/`rejectAll`/`loadForSession` all reach the barrel via a dynamic
 * import the moment they're actually INVOKED (not merely imported), none of
 * them can be exercised end-to-end from a Bun test against the REAL barrel
 * without crashing the same way a bare *value* import would —
 * `stores/checkpoints.ts` has the identical limitation and has no direct
 * test file of its own. The nontrivial branching each of these actions
 * relies on (turn-anchoring, dedupe, the reject-failure flag) is extracted
 * into `review-core.ts` and tested there (`registerForActiveTurn`,
 * `markRejectFailed`, plus the pre-existing `clearReviewPaths`/`listPending`
 * coverage); `register`'s own decision logic is exercised end-to-end via
 * `edit-review-decorator.test.ts` (through a DI seam, not this real store).
 * `stores/edit-review.test.ts` covers the branches that return before the
 * dynamic import fires, plus the register→sessionId-adoption→persist glue
 * by substituting the barrel with Bun's `mock.module` (which intercepts
 * dynamic imports too); the remaining glue (real disk round-trip, the
 * cross-store `restoreFile` call) is manual/e2e verification, same as
 * `stores/checkpoints.ts`.
 */

import { create } from 'zustand';
import type { PendingReviewEntry, RevertOutcome } from '../features/ai-panel';
import { useCheckpointsStore } from './checkpoints';

interface EditReviewState {
  /** Pending review entries, keyed by absolute path. */
  entries: Record<string, PendingReviewEntry>;
  sessionId: string | null;

  /**
   * Register `path` as pending review, anchored to the CURRENT (last)
   * checkpoint turn. No-op if no turn is active. Also adopts the checkpoints
   * store's live sessionId (stamped by `beginTurn` at send start) so a fresh
   * conversation — which never calls `loadForSession` — still persists.
   */
  register: (path: string, toolCallId: string) => void;
  /** Accept keeps the change — removes the path from the pending set only. */
  accept: (path: string) => void;
  acceptAll: () => void;
  /** Restores `path` to its pre-image via the checkpoints store; returns the outcome. */
  reject: (path: string) => Promise<RevertOutcome>;
  /** Sequential reject over every pending entry; collects which paths succeeded vs. failed. */
  rejectAll: () => Promise<{ rejected: string[]; failed: string[] }>;
  clearForPaths: (paths: string[]) => void;
  /** Load a session's persisted pending reviews (e.g. on session resume). */
  loadForSession: (sessionId: string) => Promise<void>;
  /** Force an immediate persist, bypassing the debounce (used on app close — mirrors `flushCheckpointsNow`). */
  flushNow: () => Promise<void>;
  reset: () => void;
}

// ---- Persistence (debounced, mirrors stores/checkpoints.ts) ----

const PERSIST_DEBOUNCE_MS = 600;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function persistNow(): Promise<void> {
  const { entries, sessionId } = useEditReviewStore.getState();
  if (!sessionId) return;
  const { saveReviews } = await import('../features/ai-panel');
  await saveReviews(sessionId, entries).catch(() => {});
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

/** Bypasses the debounce and persists immediately — mirrors `stores/checkpoints.ts`'s `flushCheckpointsNow`. */
function flushPersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return persistNow();
}

// ---- Async action bodies (module-level so the synchronous action wrappers
// below can stay `void`-returning per the public interface while this work
// happens off the synchronous call stack) ----

async function registerAsync(
  path: string,
  toolCallId: string,
  turns: { turnId: string; userMessageId: string }[],
  checkpointSessionId: string | null,
): Promise<void> {
  const { registerForActiveTurn } = await import('../features/ai-panel');
  useEditReviewStore.setState((s) => ({
    entries: registerForActiveTurn(s.entries, turns, path, toolCallId, Date.now()),
    // Fresh-session fix (T7 review): a brand-new chat never calls
    // loadForSession — this store's sessionId would stay null and
    // persistNow's guard would skip every save for the whole conversation.
    // Adopt the live session id `beginTurn` authoritatively stamped on the
    // checkpoints store at send start (register only ever fires inside a
    // turn, and the two stores are 1:1 by construction), set together with
    // the entries update. The null-fallback branch is defensive only: an
    // active turn without a checkpoints sessionId can't happen (`beginTurn`
    // sets both together, `reset` clears both together).
    sessionId: checkpointSessionId ?? s.sessionId,
  }));
  schedulePersist();
}

async function clearPathsAsync(paths: string[]): Promise<void> {
  const { clearReviewPaths } = await import('../features/ai-panel');
  useEditReviewStore.setState((s) => ({ entries: clearReviewPaths(s.entries, paths) }));
  schedulePersist();
}

export const useEditReviewStore = create<EditReviewState>((set, get) => ({
  entries: {},
  sessionId: null,

  register: (path, toolCallId) => {
    // No active turn → no pre-image was ever captured for this write, so a
    // "Reject" would have nothing to restore back to. Checked BEFORE the
    // dynamic import below so this exact branch stays Bun-test-safe (see
    // this file's header). `sessionId` is snapshotted in the SAME getState()
    // as `turns` so registerAsync adopts a consistent pair — see its
    // fresh-session comment for why adoption happens on register at all.
    const { turns, sessionId: checkpointSessionId } = useCheckpointsStore.getState();
    if (turns.length === 0) return;
    void registerAsync(path, toolCallId, turns, checkpointSessionId);
  },

  accept: (path) => {
    void clearPathsAsync([path]);
  },

  acceptAll: () => {
    void clearPathsAsync(Object.keys(get().entries));
  },

  reject: async (path) => {
    const entry = get().entries[path];
    if (!entry) return 'failed'; // nothing pending for this path — defensively treat as failed, same as decideRevertOutcome's own fallback
    const result = await useCheckpointsStore.getState().restoreFile(entry.turnId, path);
    const { decideRevertOutcome, markRejectFailed } = await import('../features/ai-panel');
    const outcome = decideRevertOutcome(result, path);
    if (outcome === 'failed') {
      set((s) => ({ entries: markRejectFailed(s.entries, path) }));
      schedulePersist();
    }
    // On success, `restoreFile` itself clears this path's pending entry via
    // `clearForPaths` (single source of truth — see this file's header and
    // `stores/checkpoints.ts`'s restore methods). Do not double-clear here.
    return outcome;
  },

  rejectAll: async () => {
    const { listPending } = await import('../features/ai-panel');
    const pending = listPending(get().entries);
    const rejected: string[] = [];
    const failed: string[] = [];
    for (const entry of pending) {
      const outcome = await get().reject(entry.path);
      if (outcome === 'reverted') rejected.push(entry.path);
      else failed.push(entry.path);
    }
    return { rejected, failed };
  },

  clearForPaths: (paths) => {
    if (paths.length === 0) return;
    void clearPathsAsync(paths);
  },

  loadForSession: async (sessionId) => {
    const { loadReviews } = await import('../features/ai-panel');
    const entries = await loadReviews(sessionId).catch(() => ({}));
    set({ entries, sessionId });
  },

  flushNow: () => flushPersist(),

  reset: () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    set({ entries: {}, sessionId: null });
  },
}));
