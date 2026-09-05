/**
 * When the design dock may take over the live conversation, and what it should
 * do when it does.
 *
 * Pure, and separate from `design-session.ts`, for the reason `todo-gates.ts`
 * gives about its own split: the service reaches `stores/ai.ts` and the
 * `ai-panel` barrel, and both drag in DOM-bound modules that do not load under
 * Bun at all. The decisions are the part worth testing, so they live where they
 * can be.
 */

/** Compare workspace-relative document paths the way the session record stores them. */
export function sameDocument(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

export type PreAdoption =
  /** This document's thread is ALREADY the live conversation; do nothing. */
  | 'ready'
  /** No project open — there is nothing to design in. */
  | 'no-workspace'
  /**
   * A turn is running. Swapping the session out from under it leaves its
   * in-flight gate promise unresolvable and the agent stuck on "already
   * processing" — the same guard `SessionHistory.openSession` keeps, and for
   * the same reason.
   */
  | 'busy'
  /** Safe to look for (or start) this document's thread. */
  | 'proceed';

export function preAdoptionCheck(input: {
  documentPath: string;
  workspacePath: string | null;
  designDocument: string | null;
  sessionId: string | null;
  isAgentRunning: boolean;
  /**
   * The document whose thread the user deliberately started fresh, if any.
   *
   * Without this, "New chat" is undone by the next send. A fresh thread has no
   * `sessionId` until the first message mints one, so the check below would
   * fall through to `proceed`, `adoptDesignSession` would find the document's
   * PREVIOUS saved thread, and the user would watch the transcript they just
   * cleared come back with their new message appended to it.
   *
   * Carries the document rather than a bare boolean so that leaving the tab
   * and returning still resumes the saved thread — the intent was "a new
   * thread for THIS screen", not "never open a saved one again".
   */
  freshThread: string | null;
}): PreAdoption {
  if (!input.workspacePath) return 'no-workspace';
  // Already live is checked BEFORE busy: continuing your own running turn from
  // the dock is a normal thing to do, and refusing it would be wrong.
  const isLive =
    sameDocument(input.designDocument, input.documentPath) &&
    (!!input.sessionId || sameDocument(input.freshThread, input.documentPath));
  if (isLive) return 'ready';
  if (input.isAgentRunning) return 'busy';
  return 'proceed';
}

/**
 * Every design thread for one document, newest first.
 *
 * Scoped to the document on purpose. The dock is bound to the screen behind it
 * — `withDesignScope` refuses a `.uxml` write to anything else — so offering
 * another document's thread here would put the agent in a conversation about a
 * screen the canvas is not showing and whose first write would be refused.
 */
export function designThreadsFor<T extends { designDocument: string | null; updatedAt: number }>(
  sessions: readonly T[],
  documentPath: string,
): T[] {
  return sessions
    .filter((s) => sameDocument(s.designDocument, documentPath))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The most recent design session for a document, or `null`.
 *
 * Newest wins: a document accumulates threads over time and the one you mean is
 * the one you were last in.
 */
export function pickDesignSession<T extends { designDocument: string | null; updatedAt: number }>(
  sessions: readonly T[],
  documentPath: string,
): T | null {
  let best: T | null = null;
  for (const s of sessions) {
    if (!sameDocument(s.designDocument, documentPath)) continue;
    if (!best || s.updatedAt > best.updatedAt) best = s;
  }
  return best;
}
