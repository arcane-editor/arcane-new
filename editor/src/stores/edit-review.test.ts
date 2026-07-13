import { describe, it, expect, mock } from 'bun:test';
import { useEditReviewStore } from './edit-review';
import { useCheckpointsStore } from './checkpoints';
import type { CheckpointTurn, PendingReviewEntry } from '../features/ai-panel';

// This store's actions reach `features/ai-panel`'s barrel through a dynamic
// `import()` the moment they're actually invoked (Bun-safety — see
// `edit-review.ts`'s header): a REAL evaluation of that barrel crashes under
// Bun's DOM-less runtime (stores/theme.ts's module-scope `document` access).
// To exercise the register→persist glue anyway, the barrel is replaced here
// with `mock.module` — Bun intercepts dynamic imports too — providing (a) a
// minimal stand-in for `registerForActiveTurn` mirroring the real pure
// function's last-turn anchoring (the REAL one is fully covered by
// review-core.test.ts; this file tests the store's glue around it, not the
// pure logic again) and (b) a `saveReviews` spy so the persistence guard is
// observable. Module mocks persist for the whole `bun test` process, which
// is safe here: no other test file imports the ai-panel barrel (it would
// crash under Bun if it tried).
const saveReviewsCalls: Array<{ sessionId: string; paths: string[] }> = [];

mock.module('../features/ai-panel', () => ({
  registerForActiveTurn: (
    entries: Record<string, PendingReviewEntry>,
    turns: { turnId: string; userMessageId: string }[],
    path: string,
    toolCallId: string,
    now: number,
  ): Record<string, PendingReviewEntry> => {
    if (turns.length === 0) return entries;
    const { turnId, userMessageId } = turns[turns.length - 1];
    return {
      ...entries,
      [path]: { path, turnId, userMessageId, toolCallIds: [toolCallId], firstChangeAt: now, lastChangeAt: now },
    };
  },
  saveReviews: (sessionId: string, entries: Record<string, PendingReviewEntry>) => {
    saveReviewsCalls.push({ sessionId, paths: Object.keys(entries) });
    return Promise.resolve(true);
  },
}));

/** Bounded wait for the fire-and-forget async action bodies to land. */
async function waitFor(predicate: () => boolean, maxMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function resetBothStores(): void {
  useEditReviewStore.getState().reset();
  useCheckpointsStore.getState().reset();
  saveReviewsCalls.length = 0;
}

const LIVE_TURN: CheckpointTurn = {
  turnId: 't1',
  sessionId: 'sess-live',
  userMessageId: 'msg-1',
  timestamp: 1,
  entries: [],
};

describe('useEditReviewStore', () => {
  it('starts with no pending entries and no session', () => {
    resetBothStores();
    expect(useEditReviewStore.getState().entries).toEqual({});
    expect(useEditReviewStore.getState().sessionId).toBeNull();
  });

  // Invariant this relies on: there is never an active checkpoint turn
  // without a checkpoints sessionId — `beginTurn` stamps `turns` and
  // `sessionId` together, and `reset` clears both together. So "both
  // sessionIds null" implies "no turns", and register's no-active-turn
  // guard fires before anything else (no entry, no adoption, no persist).
  it('register no-ops when there is no active checkpoint turn (both sessionIds null — no pre-image to reject back to)', async () => {
    resetBothStores();
    expect(useCheckpointsStore.getState().turns).toEqual([]);
    expect(useCheckpointsStore.getState().sessionId).toBeNull();

    useEditReviewStore.getState().register('/Foo.cs', 'call-1');
    await new Promise((r) => setTimeout(r, 10)); // give any (wrongly) fired async body time to land

    expect(useEditReviewStore.getState().entries).toEqual({});
    expect(useEditReviewStore.getState().sessionId).toBeNull();
  });

  // T7 fix wave (fresh-session persistence): a brand-new chat never calls
  // loadForSession — the first send's `beginTurn` stamps the checkpoints
  // store with the live session id, and register must ADOPT it, or
  // persistNow's `if (!sessionId) return` guard skips every save for the
  // whole conversation.
  it('register adopts the checkpoints sessionId for a fresh session (edit-review sessionId null) and registers the entry', async () => {
    resetBothStores();
    useCheckpointsStore.setState({ sessionId: 'sess-live', turns: [LIVE_TURN] });

    useEditReviewStore.getState().register('/proj/Foo.cs', 'call-1');
    await waitFor(() => '/proj/Foo.cs' in useEditReviewStore.getState().entries);

    const state = useEditReviewStore.getState();
    expect(state.entries['/proj/Foo.cs']?.turnId).toBe('t1');
    expect(state.entries['/proj/Foo.cs']?.toolCallIds).toEqual(['call-1']);
    expect(state.sessionId).toBe('sess-live');

    // With the adopted sessionId, the persist path actually writes now
    // (flushNow bypasses the 600ms debounce; same persistNow guard).
    saveReviewsCalls.length = 0;
    await useEditReviewStore.getState().flushNow();
    expect(saveReviewsCalls).toEqual([{ sessionId: 'sess-live', paths: ['/proj/Foo.cs'] }]);

    resetBothStores(); // clear the debounce timer register scheduled
  });

  it('clearForPaths([]) is a no-op', () => {
    resetBothStores();
    useEditReviewStore.setState({
      entries: {
        '/Foo.cs': {
          path: '/Foo.cs',
          turnId: 't1',
          userMessageId: 'msg-1',
          toolCallIds: ['call-1'],
          firstChangeAt: 1000,
          lastChangeAt: 1000,
        },
      },
    });

    useEditReviewStore.getState().clearForPaths([]);

    expect(Object.keys(useEditReviewStore.getState().entries)).toEqual(['/Foo.cs']);
  });

  it('reset() clears entries and sessionId', () => {
    useEditReviewStore.setState({
      sessionId: 'sess-1',
      entries: {
        '/Foo.cs': {
          path: '/Foo.cs',
          turnId: 't1',
          userMessageId: 'msg-1',
          toolCallIds: ['call-1'],
          firstChangeAt: 1000,
          lastChangeAt: 1000,
        },
      },
    });

    useEditReviewStore.getState().reset();

    expect(useEditReviewStore.getState().entries).toEqual({});
    expect(useEditReviewStore.getState().sessionId).toBeNull();
  });
});
