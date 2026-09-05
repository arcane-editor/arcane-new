import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source-greps, for the reason `agent-service-wiring.test.ts` gives about
// itself: `design-session.ts` reaches `stores/ai.ts` and the `ai-panel` barrel,
// and `DesignChatDock.tsx` is React — either takes Bun's DOM-less runtime down
// on import alone. The DECISIONS are pure and tested in
// `design-session-policy.test.ts`; these pin the wiring around them.
const HERE = new URL('.', import.meta.url).pathname;
const SERVICE = readFileSync(join(HERE, 'design-session.ts'), 'utf8');
const DOCK = readFileSync(join(HERE, '../components/DesignChatDock.tsx'), 'utf8');

describe('starting a new design thread', () => {
  it('refuses while a turn is running, like every other session swap here', () => {
    // Clearing the conversation under a live loop leaves its in-flight gate
    // promise unresolvable and the agent stuck on "already processing".
    const fn = SERVICE.slice(SERVICE.indexOf('export function startDesignThread'));
    expect(fn.slice(0, fn.indexOf('return { kind: \'ready\' }'))).toContain('ai.isAgentRunning');
  });

  it('marks the thread fresh, so the next send cannot resurrect the old one', () => {
    expect(SERVICE).toContain('dock.setFreshThread(documentPath)');
  });

  it('does not delete the thread it replaces', () => {
    // A document is allowed more than one thread — that is what makes the
    // history list worth having, and `pickDesignSession` has always assumed it.
    expect(SERVICE).not.toMatch(/deleteSession/);
  });

  it('drops the render, which belonged to the thread being left', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('export function startDesignThread'));
    expect(fn.slice(0, fn.indexOf('export async function'))).toContain('dock.clearRender()');
  });
});

describe('opening a saved design thread', () => {
  it('re-checks for a running turn after the await', () => {
    // `loadSession` awaits, and a turn can start in that window — the same
    // second check `adoptDesignSession` keeps.
    const fn = SERVICE.slice(SERVICE.indexOf('export async function openDesignThread'));
    expect(fn).toContain('useAiStore.getState().isAgentRunning');
  });

  it('resumes the agent, not just the store', () => {
    // `loadSessionIntoStore` alone repaints the transcript and leaves the agent
    // holding the previous conversation.
    const fn = SERVICE.slice(SERVICE.indexOf('export async function openDesignThread'));
    expect(fn).toContain('getAgentService().resume(data.messages)');
  });

  it('clears the fresh-thread marker it may be replacing', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('export async function openDesignThread'));
    expect(fn).toContain('dock.setFreshThread(null)');
  });
});

describe('the dock’s controls', () => {
  it('disables New thread while a turn is running and when there is nothing to clear', () => {
    expect(DOCK).toContain('disabled={!canStartNew || isAgentRunning}');
  });

  it('gives the history list room by expanding a collapsed dock', () => {
    // `.design-dock` sets `overflow: hidden`, so the list has nowhere to go
    // while collapsed.
    expect(DOCK).toContain('if (!historyOpen && collapsed) setCollapsed(false);');
  });

  it('scopes the history list to the document on the canvas', () => {
    // `withDesignScope` refuses a `.uxml` write to any other document, so
    // another screen's thread would open into a conversation whose first write
    // gets refused.
    expect(DOCK).toContain('documentPath={documentPath}');
    expect(SERVICE).toContain('designThreadsFor(sessions, documentPath)');
  });

  it('marks the live thread so it is not offered as a destination', () => {
    expect(DOCK).toContain('activeId={live ? sessionId : null}');
  });
});
