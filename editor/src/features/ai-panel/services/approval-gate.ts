// Engine-mutate approval gate for the Arcane vendor loop (F-5.6 tier 3).
//
// Engine-mutating Unity tools (play/stop/refresh/run_tests/execute_menu_item)
// block inside their own execute() on an explicit per-action user approval,
// rendered inline in the chat via the existing permission-request UI. Because
// the agent loop executes tool calls SEQUENTIALLY (vendor/agent-loop.ts), each
// such call blocks the loop on its own approval — so engine mutations are
// "always individually approved, never batched" for free.

import { useAiStore } from '../../../stores/ai';

type Decision = 'approve' | 'reject';

const pending = new Map<string, (d: Decision) => void>();

/**
 * Render an inline approval request for an engine-mutating action and resolve
 * once the user clicks Allow/Reject (or the run aborts → reject).
 */
export function requestEngineApproval(
  toolCallId: string,
  toolName: string,
  summary: string,
  signal?: AbortSignal,
): Promise<Decision> {
  useAiStore.getState().addPermissionRequest(
    toolCallId,
    toolName,
    [
      { optionId: 'approve', name: summary ? `Allow: ${summary}` : 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    summary || undefined,
  );
  return new Promise<Decision>((resolve) => {
    pending.set(toolCallId, resolve);
    signal?.addEventListener('abort', () => {
      if (pending.delete(toolCallId)) resolve('reject');
    });
  });
}

/** Resolve a pending engine-approval (called from the permission-request UI). */
export function resolveEngineApproval(toolCallId: string, optionId: string): void {
  const r = pending.get(toolCallId);
  if (!r) return;
  pending.delete(toolCallId);
  useAiStore.getState().resolvePermissionRequest(toolCallId, optionId); // lock the buttons
  r(optionId === 'approve' ? 'approve' : 'reject');
}
