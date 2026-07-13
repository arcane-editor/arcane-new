// Edit-review decorator (T7) — the write/edit-side hook that enters an
// auto-applied write into the Cursor-style post-hoc Accept/Reject review
// queue (`stores/edit-review.ts`).
//
// Mechanism: delegate to the inner tool unconditionally, then for each
// `result.diffs[i].path` (structured diffs are attached ONLY when the file's
// on-disk content actually changed — see `diff-decorator.ts`'s header for
// why that single check already covers both "no-op write" and "the write
// failed"), ask `review-registration.ts`'s `shouldRegisterReview` whether
// THIS write should enter review, and if so register it under the execute
// call's own `id` (the tool-call id T6 threads through to checkpoint
// entries). The result is returned BY REFERENCE, untouched — this decorator
// only observes the result, it never rewrites it (contrast
// `diff-decorator.ts`, which does need to attach a new field).
//
// Ordering (agent-service.ts's `createToolsForPromptMode`):
//   - MUST wrap OUTSIDE `withResultDiffs` — it reads `result.diffs`, the
//     field only `withResultDiffs` attaches; wrapping inside it would always
//     see a result with no `diffs` yet.
//   - MUST stay INSIDE `withRepeatCallGuard` (the trailing
//     `.map(withRepeatCallGuard)`) — a suppressed repeat call's synthesized
//     result never carries `diffs` (the real write/edit tool, and therefore
//     `withResultDiffs`'s pre/post reads, never run for it), but even so a
//     repeat call must never register a SECOND review entry for a write
//     that already registered on its first (real) call.
//
// Mutually exclusive with the pre-apply prompt path (`write-approval-gate.ts`):
// `shouldRegisterReview` already encodes that distinction (approve-mode
// writes, and Unity-asset writes with `alwaysApproveUnityAssets` on, never
// register here) — see `review-registration.ts`'s header for the full
// rationale. `write-approval-gate.ts` itself is untouched by this decorator.

import type { AgentTool } from '../vendor/types';
import { shouldRegisterReview, type ShouldRegisterReviewOptions } from './review-registration';
import { useSettingsStore } from '../../../../stores/settings';
import { useEditReviewStore } from '../../../../stores/edit-review';

export interface EditReviewDecoratorDeps {
  /** A fresh settings snapshot, read once per `execute` call. */
  settingsSnapshot: () => ShouldRegisterReviewOptions;
  /** Register `path` as pending review, anchored to `toolCallId` (the execute call's own id). */
  register: (path: string, toolCallId: string) => void;
}

function defaultSettingsSnapshot(): ShouldRegisterReviewOptions {
  const settings = useSettingsStore.getState();
  return {
    applyMode: settings.getSetting('ai.edits.applyMode'),
    alwaysApproveUnityAssets: settings.getSetting('ai.edits.alwaysApproveUnityAssets'),
    checkpointsEnabled: settings.getSetting('ai.checkpoints.enabled') !== false,
  };
}

function defaultRegister(path: string, toolCallId: string): void {
  useEditReviewStore.getState().register(path, toolCallId);
}

const DEFAULT_DEPS: EditReviewDecoratorDeps = {
  settingsSnapshot: defaultSettingsSnapshot,
  register: defaultRegister,
};

/** Wrap a write/edit-shaped tool so a qualifying auto-applied write enters the review queue. */
export function withEditReview(tool: AgentTool, deps: EditReviewDecoratorDeps = DEFAULT_DEPS): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const result = await tool.execute(id, params, signal, onUpdate);

      if (result.diffs && result.diffs.length > 0) {
        const settings = deps.settingsSnapshot();
        for (const diff of result.diffs) {
          if (shouldRegisterReview(diff.path, settings)) {
            deps.register(diff.path, id);
          }
        }
      }

      return result;
    },
  };
}
