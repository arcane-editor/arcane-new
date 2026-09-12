import { describe, it, expect } from 'bun:test';
import {
  designThreadsFor,
  preAdoptionCheck,
  pickDesignSession,
  sameDocument,
} from './design-session-policy';

const DOC = 'Assets/UI/MainMenu.uxml';

function input(over: Partial<Parameters<typeof preAdoptionCheck>[0]> = {}) {
  return {
    documentPath: DOC,
    workspacePath: '/proj',
    designDocument: null,
    sessionId: null,
    isAgentRunning: false,
    freshThread: null,
    ...over,
  };
}

describe('preAdoptionCheck', () => {
  it('proceeds when nothing is live and nothing is running', () => {
    expect(preAdoptionCheck(input())).toBe('proceed');
  });

  it('is already ready when this document’s thread is the live one', () => {
    expect(preAdoptionCheck(input({ designDocument: DOC, sessionId: 's1' }))).toBe('ready');
  });

  it('refuses to swap a session out from under a running turn', () => {
    // The guard SessionHistory.openSession keeps: swapping mid-turn leaves the
    // in-flight gate promise unresolvable and the agent stuck.
    expect(preAdoptionCheck(input({ isAgentRunning: true }))).toBe('busy');
  });

  it('still lets you continue your OWN running turn from the dock', () => {
    // Nothing is being swapped in that case, so there is nothing to protect.
    expect(
      preAdoptionCheck(input({ designDocument: DOC, sessionId: 's1', isAgentRunning: true })),
    ).toBe('ready');
  });

  it('does not treat a design document with no session yet as live', () => {
    expect(preAdoptionCheck(input({ designDocument: DOC, sessionId: null }))).toBe('proceed');
  });

  it('says so when there is no project open', () => {
    expect(preAdoptionCheck(input({ workspacePath: null }))).toBe('no-workspace');
  });

  it('checks the workspace before anything else, even mid-turn', () => {
    expect(preAdoptionCheck(input({ workspacePath: null, isAgentRunning: true }))).toBe(
      'no-workspace',
    );
  });
});

describe('pickDesignSession', () => {
  const sessions = [
    { id: 'a', designDocument: DOC, updatedAt: 10 },
    { id: 'b', designDocument: DOC, updatedAt: 30 },
    { id: 'c', designDocument: 'Assets/UI/Hud.uxml', updatedAt: 90 },
    { id: 'd', designDocument: null, updatedAt: 99 },
  ];

  it('takes the most recent thread for this document', () => {
    expect(pickDesignSession(sessions, DOC)?.id).toBe('b');
  });

  it('never picks another document’s thread, however recent', () => {
    expect(pickDesignSession(sessions, 'Assets/UI/Settings.uxml')).toBeNull();
  });

  it('ignores ordinary chats, which carry no document', () => {
    expect(pickDesignSession([{ id: 'd', designDocument: null, updatedAt: 99 }], DOC)).toBeNull();
  });
});

describe('sameDocument', () => {
  it('matches case-insensitively, the way the session record is written', () => {
    expect(sameDocument('assets/ui/mainmenu.uxml', DOC)).toBe(true);
  });

  it('never matches a missing document against anything', () => {
    expect(sameDocument(null, DOC)).toBe(false);
    expect(sameDocument('', DOC)).toBe(false);
  });
});


describe('preAdoptionCheck — a deliberately fresh thread', () => {
  it('treats a fresh thread as already live, though it has no session id yet', () => {
    // Otherwise the send right after "New chat" falls through to `proceed`,
    // finds the document's PREVIOUS saved thread, and puts the transcript the
    // user just cleared back on screen with their new message appended.
    expect(preAdoptionCheck(input({ designDocument: DOC, freshThread: DOC }))).toBe('ready');
  });

  it('does not carry that intent to another document', () => {
    // "A new thread for THIS screen", not "never open a saved one again".
    expect(preAdoptionCheck(input({ freshThread: 'Assets/UI/HUD.uxml' }))).toBe('proceed');
  });

  it('still refuses while a turn is running', () => {
    expect(preAdoptionCheck(input({ freshThread: DOC, isAgentRunning: true }))).toBe('busy');
  });
});

describe('designThreadsFor', () => {
  const sessions = [
    { id: 'a', designDocument: DOC, updatedAt: 100 },
    { id: 'b', designDocument: 'Assets/UI/HUD.uxml', updatedAt: 300 },
    { id: 'c', designDocument: DOC, updatedAt: 200 },
    { id: 'd', designDocument: null, updatedAt: 400 },
  ];

  it('returns this document’s threads, newest first', () => {
    expect(designThreadsFor(sessions, DOC).map((s) => s.id)).toEqual(['c', 'a']);
  });

  it('never offers another document’s thread', () => {
    // The dock is bound to the screen behind it — `withDesignScope` refuses a
    // `.uxml` write to anything else — so opening HUD's thread here would put
    // the agent in a conversation whose first write gets refused.
    expect(designThreadsFor(sessions, DOC).map((s) => s.id)).not.toContain('b');
  });

  it('never offers an ordinary chat', () => {
    expect(designThreadsFor(sessions, DOC).map((s) => s.id)).not.toContain('d');
  });

  it('matches the document case-insensitively, like every other path compare here', () => {
    expect(designThreadsFor(sessions, DOC.toUpperCase()).map((s) => s.id)).toEqual(['c', 'a']);
  });

  it('is empty for a document that has never been designed in', () => {
    expect(designThreadsFor(sessions, 'Assets/UI/Nope.uxml')).toEqual([]);
  });
});
