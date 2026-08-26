// Inline approval gate. Three request shapes share ONE pending-map/resolution
// flow, all rendered via the same permission-request UI
// (`PermissionRequestBlock.tsx`):
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
//  - External-agent approvals (ACP `session/request_permission`): an agent
//    such as Claude Code asks before running one of ITS tools. The options are
//    whatever the agent offers, so unlike the two above they are not a fixed
//    list. Routing them through this same map is what lets
//    `PermissionRequestBlock` and `useAiStore.resolvePermissionRequest` serve
//    external agents with no branch of their own.
//
// All three resolve through the SAME `pending` map + `resolvePendingApproval`
// — the map holds a plain `(optionId: string) => void` per toolCallId, and
// each request-side function maps the raw optionId to its own decision type
// when it resolves its promise.

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
 * `addEventListener('abort', …)` never fires for a signal that was ALREADY
 * aborted before registration, so a request that reaches this module after a
 * Stop click would push a permission card, register a listener nothing will
 * trigger, and leave its promise pending forever — hanging the vendor loop
 * behind a card whose buttons no longer resolve anything.
 *
 * `question-gate.ts` and `write-approval-gate.ts` both guard this explicitly;
 * this module was the one that didn't. Checked before rendering anything, so
 * no card is pushed for a run that's already dead.
 */
function isAlreadyAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

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
  if (isAlreadyAborted(signal)) return Promise.resolve('reject');
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
      // T8 fix (abort-stale approval UI): an aborted run used to resolve the
      // pending promise here without ever telling `PermissionRequestBlock`
      // — its buttons stayed live and un-resolved even though the tool call
      // this approval belonged to was already dead. Mirror
      // `resolvePendingApproval`'s own "lock the buttons" call so the UI
      // reflects the same rejected outcome the resolved promise carries.
      if (pending.delete(toolCallId)) {
        useAiStore.getState().resolvePermissionRequest(toolCallId, 'reject');
        resolve('reject');
      }
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
  if (isAlreadyAborted(signal)) return Promise.resolve('reject');
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
      // T8 fix (abort-stale approval UI, mirrors `requestEngineApproval`
      // above) — pre-apply prompts still fire in 'approve' mode and always
      // for Unity serialized assets, so an aborted run must lock THIS
      // button UI too, not just resolve the promise.
      if (pending.delete(toolCallId)) {
        useAiStore.getState().resolvePermissionRequest(toolCallId, 'reject');
        resolve('reject');
      }
    });
  });
}

/**
 * Cancellers for in-flight external approvals.
 *
 * Kept separate from `pending` because cancelling is NOT the same as choosing a
 * rejection: ACP distinguishes `{outcome: 'cancelled'}` from
 * `{outcome: 'selected', optionId: <a reject option>}`, and an agent that is
 * told "rejected" when the user actually hit Stop will apologise and try
 * something else instead of stopping.
 */
const externalCancellers = new Map<string, () => void>();

/** One choice an external agent offers. Mirrors ACP's `PermissionOption`. */
export interface ExternalPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/**
 * Render an approval request on behalf of an external agent and resolve with
 * the option the user picked, or `null` if the request was cancelled (the turn
 * was stopped, or the agent died before the user answered).
 *
 * Unlike the two UnityIDE paths, the options come from the agent. They are
 * passed through untouched — inventing or reordering choices here would
 * misrepresent what the user is actually agreeing to.
 */
export function requestExternalAgentPermission(
  toolCallId: string,
  toolName: string | undefined,
  options: ExternalPermissionOption[],
  detail?: string,
  diff?: PendingWriteDiff,
): Promise<string | null> {
  useAiStore.getState().addPermissionRequest(toolCallId, toolName, options, detail, diff);
  return new Promise<string | null>((resolve) => {
    pending.set(toolCallId, (optionId) => resolve(optionId));
    externalCancellers.set(toolCallId, () => resolve(null));
  });
}

/**
 * Cancel every in-flight external approval — on turn cancel, or when the agent
 * process dies. Also locks the rendered buttons, so no card is left live with
 * nothing behind it.
 */
export function cancelExternalAgentApprovals(): void {
  for (const [toolCallId, cancel] of externalCancellers) {
    pending.delete(toolCallId);
    useAiStore.getState().resolvePermissionRequest(toolCallId, 'cancelled');
    cancel();
  }
  externalCancellers.clear();
}

/** Resolve a pending approval — engine-mutate or file-write (called from the permission-request UI). */
export function resolvePendingApproval(toolCallId: string, optionId: string): void {
  const r = pending.get(toolCallId);
  if (!r) return;
  pending.delete(toolCallId);
  externalCancellers.delete(toolCallId);
  useAiStore.getState().resolvePermissionRequest(toolCallId, optionId); // lock the buttons
  r(optionId);
}
