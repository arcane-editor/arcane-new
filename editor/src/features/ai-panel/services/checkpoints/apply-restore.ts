// Restore application (P5.2 review fix) — the pure-ish, Bun-testable layer
// between `computeRestorePlan`'s plan and the real disk/git side effects
// `stores/checkpoints.ts` runs. Split out so failure handling is directly
// testable without pulling in the Bun-unsafe Tauri/workspace import chain
// that file's header documents.
//
// Finding: the store's old `applyRestorePlan` swallowed per-entry failures
// (`console.warn` only, no signal to the caller), and `refreshAfterRestore`
// was handed the FULL plan regardless of what actually landed on disk — so a
// failed delete still closed that file's open tab as if the restore had
// succeeded. Now every failure is collected into `failed`, and callers MUST
// filter the plan down to the applied subset (`filterAppliedRestoreEntries`)
// before running any side effect (like closing a tab) that assumes the
// restore actually happened.

import type { RestorePlanEntry } from './restore-plan';

export interface ApplyRestoreDeps {
  deletePath: (path: string) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
  /** Best-effort side channel (co-deleting sidecar meta) — its own failures never affect applied/failed accounting. */
  coDeleteMeta: (path: string) => Promise<void>;
}

export interface ApplyRestoreOutcome {
  /** Paths successfully written or deleted. */
  applied: string[];
  /** Paths whose restore operation threw — logged via console.warn, not surfaced individually beyond this list. */
  failed: string[];
}

/** Applies every entry in `plan`, continuing past individual failures. */
export async function runRestorePlan(
  plan: RestorePlanEntry[],
  deps: ApplyRestoreDeps,
): Promise<ApplyRestoreOutcome> {
  const applied: string[] = [];
  const failed: string[] = [];

  for (const restoreEntry of plan) {
    try {
      if (restoreEntry.action === 'delete') {
        await deps.deletePath(restoreEntry.path);
        await deps.coDeleteMeta(restoreEntry.path).catch(() => {});
      } else {
        await deps.writeFile(restoreEntry.path, restoreEntry.content ?? '');
      }
      applied.push(restoreEntry.path);
    } catch (err) {
      console.warn(`[checkpoints] failed to restore ${restoreEntry.path}:`, err);
      failed.push(restoreEntry.path);
    }
  }

  return { applied, failed };
}

/**
 * Restrict a restore plan to only the entries that actually applied — for
 * callers (`refreshAfterRestore`) that must not treat a failed entry as if
 * it had happened (e.g. closing a tab for a delete that never occurred).
 */
export function filterAppliedRestoreEntries(
  plan: RestorePlanEntry[],
  applied: string[],
): RestorePlanEntry[] {
  const appliedSet = new Set(applied);
  return plan.filter((e) => appliedSet.has(e.path));
}
