// Inline approval gate for the Arcane vendor loop. Two request shapes share
// ONE pending-map/resolution flow, both rendered via the same permission-
// request UI (`PermissionRequestBlock.tsx`):
//
//  - Engine-mutate approvals (F-5.6 tier 3): Unity tools that mutate the live
//    editor (play/stop/refresh/run_tests/execute_menu_item) block inside their
//    own execute() on an explicit per-action user approval. Because the agent
//    loop executes tool calls SEQUENTIALLY (vendor/agent-loop.ts), each such
//    call blocks the loop on its own approval — so engine mutations are
//    "always individually approved, never batched" for free.
//  - File-write approvals (P5.3): the pre-apply gate for write/edit tool
//    calls (see `write-approval-gate.ts`), carrying a `diff` for
//    `PermissionRequestBlock` to render via `DiffBlock`, with a third option
//    ("Apply all this session") alongside Apply/Reject.
//
// Both requests resolve through the SAME `pending` map + `resolvePendingApproval`
// — the map holds a plain `(optionId: string) => void` per toolCallId, and
// each request-side function (`requestEngineApproval`/`requestFileWriteApproval`)
// maps the raw optionId to its own decision type when it resolves its promise.

import { useAiStore } from '../../../stores/ai';

type EngineDecision = 'approve' | 'reject';

/** The three choices offered on a pending file-write approval. */
export type WriteDecision = 'apply' | 'apply-all' | 'reject';

/** A pending (not-yet-applied) file diff, rendered via `DiffBlock` in the permission UI. */
export interface PendingWriteDiff {
  path: string;
  oldText: string;
  newText: string;
}

const pending = new Map<string, (optionId: string) => void>();

/**
 * Render an inline approval request for an engine-mutating action and resolve
 * once the user clicks Allow/Reject (or the run aborts → reject).
 */
export function requestEngineApproval(
  toolCallId: string,
  toolName: string,
  summary: string,
  signal?: AbortSignal,
): Promise<EngineDecision> {
  useAiStore.getState().addPermissionRequest(
    toolCallId,
    toolName,
    [
      { optionId: 'approve', name: summary ? `Allow: ${summary}` : 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    summary || undefined,
  );
  return new Promise<EngineDecision>((resolve) => {
    pending.set(toolCallId, (optionId) => resolve(optionId === 'approve' ? 'approve' : 'reject'));
    signal?.addEventListener('abort', () => {
      if (pending.delete(toolCallId)) resolve('reject');
    });
  });
}

/**
 * Render an inline pre-apply approval request for a pending file write/edit
 * (P5.3), with the diff attached so `PermissionRequestBlock` can render it via
 * `DiffBlock`. `toolName` is the raw vendor tool name ('write'|'edit') so the
 * UI can reuse `humanizeToolCall` for the "+N −M" header. Resolves once the
 * user picks Apply / Apply all this session / Reject, or the run aborts
 * (→ reject, same convention as `requestEngineApproval`).
 */
export function requestFileWriteApproval(
  toolCallId: string,
  toolName: string,
  diff: PendingWriteDiff,
  signal?: AbortSignal,
): Promise<WriteDecision> {
  useAiStore.getState().addPermissionRequest(
    toolCallId,
    toolName,
    [
      { optionId: 'apply', name: 'Apply', kind: 'allow_once' },
      { optionId: 'apply-all', name: 'Apply all this session', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    undefined,
    diff,
  );
  return new Promise<WriteDecision>((resolve) => {
    pending.set(toolCallId, (optionId) => {
      if (optionId === 'apply' || optionId === 'apply-all') resolve(optionId);
      else resolve('reject');
    });
    signal?.addEventListener('abort', () => {
      if (pending.delete(toolCallId)) resolve('reject');
    });
  });
}

/** Resolve a pending approval — engine-mutate or file-write (called from the permission-request UI). */
export function resolvePendingApproval(toolCallId: string, optionId: string): void {
  const r = pending.get(toolCallId);
  if (!r) return;
  pending.delete(toolCallId);
  useAiStore.getState().resolvePermissionRequest(toolCallId, optionId); // lock the buttons
  r(optionId);
}
