/**
 * Auto-rebuild the codebase graph after the AI agent finishes a turn that
 * mutated files. Observes the ai store; doesn't touch vendor tools.
 *
 * Behavior:
 *   - Marks "dirty" the first time a write/edit/bash tool call completes.
 *   - On the falling edge of `isAgentRunning` (turn end), if dirty and a graph
 *     already exists, schedules a rebuild after a short debounce.
 *   - If the agent starts a new turn before the timer fires, the pending
 *     rebuild is cancelled; the next turn-end reschedules.
 *   - Never auto-builds for users who never opted in to indexing (status
 *     'absent') — they'd be surprised by sudden background work.
 */

import { useAiStore } from '../../../stores/ai';
import { useGraphifyStore } from '../../../stores/graphify';
import { useWorkspaceStore } from '../../../stores/workspace';
import { computeBuildOpts } from './build-opts';

const MUTATING_TOOLS = new Set(['write', 'edit', 'bash']);
const DEBOUNCE_MS = 3000;

export function startGraphifyAutoRebuild(): () => void {
  let dirty = false;
  const seenToolIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  const unsubscribe = useAiStore.subscribe((state, prev) => {
    // Track newly-completed mutating tool calls.
    for (const [id, tc] of state.toolCalls) {
      if (seenToolIds.has(id)) continue;
      if (tc.status === 'complete' && MUTATING_TOOLS.has(tc.name)) {
        seenToolIds.add(id);
        dirty = true;
      }
    }

    // Falling edge of isAgentRunning → consider rebuild.
    if (prev.isAgentRunning && !state.isAgentRunning && dirty) {
      const path = useWorkspaceStore.getState().workspacePath;
      const graph = useGraphifyStore.getState();
      const eligible =
        !!path &&
        graph.sidecarAvailable !== false &&
        (graph.status === 'present' || graph.status === 'stale');

      if (eligible && path) {
        cancel();
        timer = setTimeout(() => {
          timer = null;
          dirty = false;
          void useGraphifyStore.getState().build(path, computeBuildOpts());
        }, DEBOUNCE_MS);
      } else {
        // Not eligible — drop the dirty flag silently so we don't accumulate.
        dirty = false;
      }
    }

    // New turn starts while a rebuild is queued → cancel; the next turn-end
    // will reschedule with the latest set of changes.
    if (!prev.isAgentRunning && state.isAgentRunning && timer) {
      cancel();
    }
  });

  return () => {
    cancel();
    unsubscribe();
  };
}
