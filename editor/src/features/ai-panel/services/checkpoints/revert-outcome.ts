// Per-diff revert outcome (P5.1 review fix — Finding 2): pure decision logic
// extracted out of `ToolCallBlock.tsx`'s `DiffWithActions.revert()`.
//
// Finding: `revert()` used to `await restoreFile(...)` and then unconditionally
// call `setReverted(true)` — but `restoreFile` (`stores/checkpoints.ts`)
// resolves a `RestoreResult` with `restored`/`skippedTooLarge`/`failed` path
// arrays and never throws on a partial or total failure. A revert that failed
// (e.g. the write-back errored) or was skipped (pre-image too large) still
// rendered "Reverted" to the user, with no way to tell the file hadn't
// actually changed.
//
// This helper is the single source of truth for "did THIS path come back":
// success requires `path` to appear in `result.restored`. Anything else
// (`failed`, `skippedTooLarge`, or — defensively — appearing in neither, which
// shouldn't happen given `restore-plan.ts`'s contract that every requested
// path lands in exactly one bucket) is treated as `'failed'`, so the caller
// keeps the Revert button active and can surface an inline error instead of
// a false "Reverted".
import type { RestoreResult } from '../../../../stores/checkpoints';

export type RevertOutcome = 'reverted' | 'failed';

export function decideRevertOutcome(result: RestoreResult, path: string): RevertOutcome {
  return result.restored.includes(path) ? 'reverted' : 'failed';
}
