// Edit-review registration gate (T6) — the pure decision of "does this
// auto-applied write enter the post-hoc Accept/Reject review queue". This is
// the write-side counterpart to `write-approval-gate.ts`'s pre-apply prompt:
// the two are mutually exclusive per write, never both.
//
// Rationale for each term of the decision:
//   - `applyMode === 'auto'`: approve-mode is the legacy pre-apply-prompt
//     flow (`write-approval-gate.ts`) — there is no post-hoc review layer to
//     enter in that mode at all; every write already got an explicit human
//     decision before it landed.
//   - NOT (`alwaysApproveUnityAssets` AND a serialized Unity asset path):
//     scene/prefab/material writes keep the pre-apply prompt even in auto
//     mode (`write-approval-gate.ts`'s own `mustPrompt` check) — a write the
//     user already interactively approved must not ALSO double-enter post-hoc
//     review, since there both a "still needs approval" and "already
//     approved" state would exist for the same write.
//   - `checkpointsEnabled`: review's "Reject" is a restore-to-pre-image
//     operation backed entirely by checkpoint data (`stores/checkpoints.ts`).
//     With checkpoints off there is no pre-image captured for this write at
//     all, so entering review would offer a Reject button with nothing to
//     reject back to.
import { isSerializedUnityAssetPath } from '../write-approval-gate';

export interface ShouldRegisterReviewOptions {
  applyMode: 'approve' | 'auto';
  alwaysApproveUnityAssets: boolean;
  checkpointsEnabled: boolean;
}

export function shouldRegisterReview(path: string, opts: ShouldRegisterReviewOptions): boolean {
  if (opts.applyMode !== 'auto') return false;
  if (!opts.checkpointsEnabled) return false;
  if (opts.alwaysApproveUnityAssets && isSerializedUnityAssetPath(path)) return false;
  return true;
}
