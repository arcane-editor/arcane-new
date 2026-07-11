/**
 * Session restore — re-opens the most recent chat for a workspace on startup
 * (and on workspace switch) so chat history survives an app restart.
 *
 * Mirrors the load+resume sequence in SessionHistory.openSession: load the
 * latest session for the workspace, rehydrate the store, then re-attach the
 * Arcane agent by replaying its history.
 */

import { useAiStore } from '../../../stores/ai';
import { loadLatestSession } from './session-persistence';
import { getAgentService } from './agent-service';

/**
 * Restore the latest saved session for `workspacePath` into the live store and
 * resume its agent. No-op (returns false) when a conversation is already loaded
 * or the agent is running, so it never clobbers in-flight or restored chats.
 */
export async function restoreLatestSessionForWorkspace(
  workspacePath: string | null,
): Promise<boolean> {
  const state = useAiStore.getState();
  if (state.isAgentRunning || state.messages.length > 0) return false;

  const data = await loadLatestSession(workspacePath);
  if (!data) return false;

  // Guard again — an async gap may have let a message land or restore re-run.
  const after = useAiStore.getState();
  if (after.isAgentRunning || after.messages.length > 0) return false;

  after.loadSessionIntoStore(data);
  getAgentService().resume(data.messages);
  return true;
}
