/**
 * Checkpoints store (P5.2) — per-turn content snapshots + restore timeline.
 *
 * Every agent write/edit that actually proceeds is preceded by a snapshot of
 * the file's content immediately before the write (`recordPreWrite`, wired
 * from `checkpoint-gate.ts` for the Arcane path). Snapshots are grouped per user
 * turn (`beginTurn`) so "Restore" undoes everything a turn — and every turn
 * after it — did to a file. This is CONTENT SNAPSHOTS, not shadow git (the
 * approved P5.2 plan): the pre-image is already in memory at the hook points,
 * a git stash would pollute the user's repo state, and only text flows
 * through the tools anyway.
 *
 * All restore-PLANNING logic (which files to write/delete, the
 * earliest-at-or-after-N rule) lives in the pure, Bun-testable
 * `features/ai-panel/services/checkpoints/restore-plan.ts` — this store stays
 * thin: state + dedupe + wiring to disk I/O and the workspace/git stores.
 *
 * Known limitation: bash-tool mutations are not checkpointed (same scope as
 * the write/edit-only gates — analyzer-gate.ts, compile-gate.ts,
 * verified-pass.ts).
 *
 * Bun-test note: this file's top-level imports are deliberately limited to
 * zustand + `@tauri-apps/api/core` + a TYPE-ONLY import from the `ai-panel`
 * barrel (erased at compile time, so it never actually evaluates the barrel).
 * A *value* import of that barrel, or of `stores/workspace.ts` / `stores/git.ts`
 * / the `explorer` feature, eventually reaches `stores/theme.ts`'s
 * `document.documentElement` module-scope side effect and crashes under
 * Bun's DOM-less test runtime (the same chain `attachments.ts` and
 * `verified-pass.ts` document in their own headers). `checkpoint-gate.test.ts`
 * imports this store indirectly via `checkpoint-gate.ts`, so this file must
 * survive a bare import — every such chain below is deferred behind a dynamic
 * `import()` inside the action that needs it (`restoreTurn`/`restoreFile`/
 * `loadForSession`), never at module scope.
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { CheckpointEntry, CheckpointTurn, RestorePlanEntry } from '../features/ai-panel';

/** Pre-image snapshots over this size are recorded as `{ tooLarge: true }` instead of content. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024; // 2MB

/** FIFO cap on turns retained per session (oldest dropped first). */
const MAX_TURNS_PER_SESSION = 200;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function generateTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface RestoreResult {
  /** Paths successfully written or deleted. */
  restored: string[];
  /** Paths skipped because their pre-image exceeded the snapshot size cap. */
  skippedTooLarge: string[];
  /** Paths whose restore operation failed (logged via console.warn — see `applyRestorePlan`). */
  failed: string[];
}

interface CheckpointsState {
  turns: CheckpointTurn[];
  sessionId: string | null;

  /** Start a new checkpoint turn for a user send. Subsequent `recordPreWrite` calls append to it. */
  beginTurn: (sessionId: string, userMessageId: string) => void;
  /** Snapshot a path's content immediately before a write. `null` = the file didn't exist. */
  recordPreWrite: (path: string, beforeContent: string | null) => void;
  /** Restore every path touched by `turnId` (and every turn after it) to its pre-turn-N state. */
  restoreTurn: (turnId: string) => Promise<RestoreResult>;
  /** Same as `restoreTurn`, scoped to a single path. */
  restoreFile: (turnId: string, path: string) => Promise<RestoreResult>;
  /** Load a session's persisted checkpoint turns (e.g. on session resume). */
  loadForSession: (sessionId: string) => Promise<void>;
  /** Force an immediate persist, bypassing the debounce (used on app close — mirrors `flushSessionNow`). */
  flushCheckpointsNow: () => Promise<void>;
  reset: () => void;
}

// ---- Persistence (debounced, mirrors stores/ai.ts's session-save pattern) ----

const PERSIST_DEBOUNCE_MS = 600;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function persistNow(): Promise<void> {
  const { turns, sessionId } = useCheckpointsStore.getState();
  if (!sessionId) return;
  const { saveCheckpoints } = await import('../features/ai-panel');
  await saveCheckpoints(sessionId, turns).catch(() => {});
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

/** Bypasses the debounce and persists immediately — mirrors `stores/ai.ts`'s `flushSave`. */
function flushPersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return persistNow();
}

// ---- Restore side effects (workspace/git — dynamic import, see header) ----

async function applyRestorePlan(
  plan: RestorePlanEntry[],
): Promise<{ applied: string[]; failed: string[] }> {
  const { coDeleteMeta } = await import('../features/explorer');
  const { runRestorePlan } = await import('../features/ai-panel');
  return runRestorePlan(plan, {
    deletePath: (path) => invoke('delete_path', { path }),
    writeFile: (path, contents) => invoke('write_file', { path, contents }),
    coDeleteMeta,
  });
}

/** `plan` must already be restricted to the APPLIED subset (see `filterAppliedRestoreEntries`)
 *  — a failed delete must never close its tab as if the restore had happened. */
async function refreshAfterRestore(plan: RestorePlanEntry[]): Promise<void> {
  const { useWorkspaceStore } = await import('./workspace');
  const ws = useWorkspaceStore.getState();

  for (const restoreEntry of plan) {
    if (!ws.openFiles.some((f) => f.path === restoreEntry.path)) continue;
    if (restoreEntry.action === 'delete') {
      ws.closeFile(restoreEntry.path);
    } else {
      await ws.reloadFileFromDisk(restoreEntry.path);
    }
  }

  await ws.refreshTree();

  if (ws.workspacePath) {
    const { useGitStore } = await import('./git');
    await useGitStore.getState().refreshStatus(ws.workspacePath).catch(() => {});
  }
}

export const useCheckpointsStore = create<CheckpointsState>((set, get) => ({
  turns: [],
  sessionId: null,

  beginTurn: (sessionId, userMessageId) => {
    set((s) => {
      const turn: CheckpointTurn = {
        turnId: generateTurnId(),
        sessionId,
        userMessageId,
        timestamp: Date.now(),
        entries: [],
      };
      const turns = [...s.turns, turn];
      const capped =
        turns.length > MAX_TURNS_PER_SESSION ? turns.slice(turns.length - MAX_TURNS_PER_SESSION) : turns;
      return { turns: capped, sessionId };
    });
    schedulePersist();
  },

  recordPreWrite: (path, beforeContent) => {
    set((s) => {
      if (s.turns.length === 0) return s; // no active turn — nothing wired beginTurn first, no-op
      const last = s.turns[s.turns.length - 1];
      if (last.entries.some((e) => e.path === path)) return s; // dedupe: first snapshot per path per turn wins

      const entry: CheckpointEntry =
        beforeContent === null
          ? { path, kind: 'created', timestamp: Date.now() }
          : byteLength(beforeContent) > MAX_SNAPSHOT_BYTES
            ? { path, kind: 'modified', tooLarge: true, timestamp: Date.now() }
            : { path, kind: 'modified', beforeContent, timestamp: Date.now() };

      const updatedTurn: CheckpointTurn = { ...last, entries: [...last.entries, entry] };
      return { turns: [...s.turns.slice(0, -1), updatedTurn] };
    });
    schedulePersist();
  },

  restoreTurn: async (turnId) => {
    const { computeRestorePlan, getSkippedTooLargePaths, filterAppliedRestoreEntries } =
      await import('../features/ai-panel');
    const { turns } = get();
    const plan = computeRestorePlan(turns, turnId);
    const skippedTooLarge = getSkippedTooLargePaths(turns, turnId);
    const { applied, failed } = await applyRestorePlan(plan);
    await refreshAfterRestore(filterAppliedRestoreEntries(plan, applied));
    return { restored: applied, skippedTooLarge, failed };
  },

  restoreFile: async (turnId, path) => {
    const { computeRestorePlan, getSkippedTooLargePaths, filterAppliedRestoreEntries } =
      await import('../features/ai-panel');
    const { turns } = get();
    const plan = computeRestorePlan(turns, turnId).filter((e) => e.path === path);
    const skippedTooLarge = getSkippedTooLargePaths(turns, turnId).filter((p) => p === path);
    const { applied, failed } = await applyRestorePlan(plan);
    await refreshAfterRestore(filterAppliedRestoreEntries(plan, applied));
    return { restored: applied, skippedTooLarge, failed };
  },

  loadForSession: async (sessionId) => {
    const { loadCheckpoints } = await import('../features/ai-panel');
    const turns = await loadCheckpoints(sessionId).catch(() => []);
    // Apply the same FIFO cap `beginTurn` enforces, in case a persisted file
    // (e.g. hand-edited or from an older build) exceeds it.
    const capped =
      turns.length > MAX_TURNS_PER_SESSION ? turns.slice(turns.length - MAX_TURNS_PER_SESSION) : turns;
    set({ turns: capped, sessionId });
  },

  flushCheckpointsNow: () => flushPersist(),

  reset: () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    set({ turns: [], sessionId: null });
  },
}));
