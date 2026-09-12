/**
 * Adopting the design thread for a document.
 *
 * The design dock has its own conversation, one document at a time, and there
 * is exactly ONE agent runtime for it to run in. So "its own thread" is
 * implemented as a session SWAP, not a second agent: the thread for this
 * document is loaded into the live conversation the same way the history panel
 * loads any saved session, and the AI panel — which is a view onto that same
 * conversation — follows it there.
 *
 * A second concurrent agent would be a much larger change than it looks:
 * `approval-gate.ts`, `stores/checkpoints.ts`, `turn-governor.ts`,
 * `guid-verify.ts` and `verified-pass.ts` are all module-level singletons keyed
 * on nothing, and two loops writing through them at once would interleave one
 * turn's approvals, pre-images and budgets into another's.
 *
 * Everything here is guarded by `isAgentRunning`, for the reason
 * `SessionHistory.openSession` documents: swapping the session out from under a
 * live turn leaves its in-flight gate promise unresolvable, and the agent stuck
 * on "already processing" until New Chat.
 */

import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useDesignChatStore } from '../../../stores/design-chat';
import { listSessions, loadSession, type SessionSummary } from '../../ai-panel';
import { getAgentService } from '../../ai-panel';
import {
  designThreadsFor,
  pickDesignSession,
  preAdoptionCheck,
  sameDocument,
} from './design-session-policy';

/** Why a swap did not happen, in the words the dock shows the user. */
export type AdoptOutcome =
  | { kind: 'ready' }
  | { kind: 'busy'; message: string }
  | { kind: 'no-workspace'; message: string };

const BUSY_MESSAGE = 'Finishing a turn — send when it’s done.';

/**
 * The most recent saved design session for this document in this workspace, or
 * `null` when the document has never been designed in.
 *
 * Newest wins: a document can accumulate threads over months, and the one you
 * mean is the one you were last in.
 */
export async function findDesignSession(
  documentPath: string,
  workspacePath: string | null,
): Promise<SessionSummary | null> {
  const sessions = await listSessions(workspacePath).catch(() => [] as SessionSummary[]);
  return pickDesignSession(sessions, documentPath);
}

/**
 * Make this document's design thread the live conversation.
 *
 * Three outcomes, and each is a fact the caller has to be able to state:
 * already live (nothing happens), swapped in (an existing thread, or a fresh
 * one), or refused because a turn is running somewhere.
 */
export async function adoptDesignSession(documentPath: string): Promise<AdoptOutcome> {
  const ai = useAiStore.getState();
  const workspacePath = useWorkspaceStore.getState().workspacePath;

  const pre = preAdoptionCheck({
    documentPath,
    workspacePath,
    designDocument: ai.designDocument,
    sessionId: ai.sessionId,
    isAgentRunning: ai.isAgentRunning,
    freshThread: useDesignChatStore.getState().freshThread,
  });
  if (pre === 'no-workspace') {
    return { kind: 'no-workspace', message: 'Open a Unity project to design in it.' };
  }
  if (pre === 'ready') return { kind: 'ready' };
  if (pre === 'busy') return { kind: 'busy', message: BUSY_MESSAGE };

  const existing = await findDesignSession(documentPath, workspacePath);
  if (existing) {
    const data = await loadSession(existing.id).catch(() => null);
    if (data) {
      // Re-check: `loadSession` awaits, and a turn can start in that window.
      if (useAiStore.getState().isAgentRunning) return { kind: 'busy', message: BUSY_MESSAGE };
      ai.loadSessionIntoStore(data);
      getAgentService().resume(data.messages);
      useAiStore.getState().setMode('design');
      // A saved thread is now live, so there is no pending fresh one.
      useDesignChatStore.getState().setFreshThread(null);
      return { kind: 'ready' };
    }
    // The summary listed a file we then could not read. Fall through to a
    // fresh thread rather than failing the send — but do not pretend the old
    // one was resumed.
  }

  // A new thread for this document. `resetConversation` clears the agent's own
  // history too (via `reset()`), so nothing from the previous conversation
  // leaks into the design one.
  ai.resetConversation();
  getAgentService().reset();
  const store = useAiStore.getState();
  // No session id is minted here: `addUserMessage` mints one on the first send,
  // and an id with no messages behind it would write an empty session file.
  // `designDocument` has to be set BEFORE that first send, though, or the
  // session saves without the one field that makes it findable again.
  store.setDesignDocument(documentPath);
  store.setMode('design');
  return { kind: 'ready' };
}

/**
 * Start a new, empty design thread for this document.
 *
 * The previous thread is not deleted — it is already saved, and
 * `listDesignThreads` will offer it back. That is the whole reason a document
 * is allowed more than one: `pickDesignSession` has always taken the newest,
 * anticipating exactly this.
 *
 * Synchronous, unlike the other two: nothing is read from disk to clear a
 * conversation, and making the user's most immediate control await a listing
 * would be a delay with nothing behind it.
 */
export function startDesignThread(documentPath: string): AdoptOutcome {
  const ai = useAiStore.getState();
  if (!useWorkspaceStore.getState().workspacePath) {
    return { kind: 'no-workspace', message: 'Open a Unity project to design in it.' };
  }
  // Same guard as every other swap: clearing the conversation under a live turn
  // leaves its in-flight gate promise unresolvable and the agent stuck on
  // "already processing" (see this module's header).
  if (ai.isAgentRunning) return { kind: 'busy', message: BUSY_MESSAGE };

  ai.resetConversation();
  getAgentService().reset();
  const store = useAiStore.getState();
  // No session id is minted here, for the reason `adoptDesignSession` gives:
  // an id with no messages behind it writes an empty session file. The marker
  // below is what stops the next send resurrecting the thread just cleared.
  store.setDesignDocument(documentPath);
  store.setMode('design');
  const dock = useDesignChatStore.getState();
  dock.setFreshThread(documentPath);
  dock.clearRender();
  return { kind: 'ready' };
}

/** Every saved design thread for this document, newest first. */
export async function listDesignThreads(documentPath: string): Promise<SessionSummary[]> {
  const workspacePath = useWorkspaceStore.getState().workspacePath;
  const sessions = await listSessions(workspacePath).catch(() => [] as SessionSummary[]);
  return designThreadsFor(sessions, documentPath);
}

/**
 * Make a specific saved thread the live conversation.
 *
 * The same swap `adoptDesignSession` performs, addressed by id instead of by
 * document — this is what the history list clicks into. It deliberately does
 * NOT check that the thread belongs to the open document: the list it is driven
 * from is already scoped to that document, and re-deriving the check here would
 * only add a way for the two to disagree.
 */
export async function openDesignThread(id: string): Promise<AdoptOutcome> {
  const ai = useAiStore.getState();
  if (!useWorkspaceStore.getState().workspacePath) {
    return { kind: 'no-workspace', message: 'Open a Unity project to design in it.' };
  }
  if (ai.isAgentRunning) return { kind: 'busy', message: BUSY_MESSAGE };

  const data = await loadSession(id).catch(() => null);
  if (!data) return { kind: 'busy', message: 'That thread could not be read.' };
  // Re-check: `loadSession` awaits, and a turn can start in that window.
  if (useAiStore.getState().isAgentRunning) return { kind: 'busy', message: BUSY_MESSAGE };

  ai.loadSessionIntoStore(data);
  getAgentService().resume(data.messages);
  useAiStore.getState().setMode('design');
  const dock = useDesignChatStore.getState();
  dock.setFreshThread(null);
  // Renders are not persisted with a session, so the one on screen belongs to
  // the thread being left, not the one being opened.
  dock.clearRender();
  return { kind: 'ready' };
}

/** True when the live conversation IS this document's design thread. */
export function isDesignSessionLive(documentPath: string): boolean {
  const ai = useAiStore.getState();
  return sameDocument(ai.designDocument, documentPath) && ai.mode === 'design';
}
