import { describe, it, expect, afterAll, mock } from 'bun:test';

/**
 * REAL-EXECUTION test for `stores/search.ts`'s `search` action clearing
 * `activeExcerptId` at the start of a new search (Fix round 1, Finding 2 on
 * the excerpt-expansion task). That field names an excerpt from the PREVIOUS
 * result set by id (`path:startLine`); a new search can produce an excerpt
 * that reuses one of those ids for entirely different content (same file,
 * same start line, different surrounding matches), so without this reset
 * `activeExcerptId` would point at an excerpt that no longer exists.
 *
 * Also covers `applyToSession` (`stores/search.ts`) — the module-private
 * function that routes an incoming `search-results-batch`/`search-complete`
 * event to whichever session's `activeSearchId` matches the event's
 * `searchId`, via `sessionForSearchId`. It is the one link in the
 * multi-tab/multi-session invariant this repo's other search tests don't
 * reach: everything else either drives the pure reducers directly
 * (`search-model.test.ts`) or drives the store's own actions
 * (`search()`/`clearResults()`), but nothing else feeds a REAL event through
 * the REAL listener registered by `ensureListeners()` and checks it lands on
 * the right session — or no session at all.
 *
 * Deliberately `.exec.ts`, not `.test.ts` — same reason as the sibling
 * `search-tab-lifecycle.exec.ts` (see that file's header): `mock.module`
 * mutates Bun's module registry for the rest of whatever process runs it, so
 * this needs its own process via `bun run test:isolated`, not `bun test src`.
 */
import * as realCore from '@tauri-apps/api/core';
import * as realWebviewWindow from '@tauri-apps/api/webviewWindow';
import * as realWindow from '@tauri-apps/api/window';

mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  // `search()` reaches exactly one command here: `start_content_search`.
  // Batches/completion arrive over events (mocked below), never through the
  // invoke's return value, so resolving with `undefined` is enough for the
  // state transitions this test asserts on.
  invoke: async (cmd: string) => {
    if (cmd === 'start_content_search') return undefined;
    throw new Error(`unexpected invoke('${cmd}') call in search-invalidation.exec`);
  },
}));

/** Handlers `listenScoped` (`utils/tauri-listener.ts`) registered via the
 *  mocked `listen()` below, keyed by event name — lets the tests drive
 *  `applyToSession` through the REAL listener callback `ensureListeners()`
 *  installs, by calling this instead of needing a real Tauri backend. */
const capturedHandlers = new Map<string, Array<(event: { payload: unknown }) => void>>();

function emit<T>(event: string, payload: T): void {
  for (const handler of capturedHandlers.get(event) ?? []) {
    handler({ payload });
  }
}

// Every real named export of this module must be present — `mock.module`
// replaces the specifier's entire export surface for the rest of THIS
// process, and other real modules import from it for real.
mock.module('@tauri-apps/api/webviewWindow', () => ({
  ...realWebviewWindow,
  getCurrentWebviewWindow: () => ({
    listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
      const handlers = capturedHandlers.get(event) ?? [];
      handlers.push(handler);
      capturedHandlers.set(event, handlers);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
  }),
}));
mock.module('@tauri-apps/api/window', () => ({
  ...realWindow,
  getCurrentWindow: () => ({ setBackgroundColor: async () => {} }),
}));
// `features/editor`'s barrel re-exports `EditorPanel`, which statically
// imports `@monaco-editor/react` -> `monaco-editor`; that package runs
// browser-only code at module-eval time and crashes under plain `bun test`.
// None of it is exercised by anything under test here.
mock.module('../features/editor', () => ({
  initMonaco: async () => {},
  getMonaco: () => null,
  setupWorkspaceIntelliSense: async () => {},
  teardownWorkspaceIntelliSense: () => {},
  disposeModelForPath: () => {},
  getDocumentInfo: () => null,
  configureTypeScriptDefaults: () => {},
  loadWorkspaceFiles: async () => {},
  loadTypeDefinitions: async () => {},
  updateExtraLib: () => {},
  disposeExtraLibs: () => {},
  loadMonacoWorkers: async () => {},
  EditorPanel: () => null,
  EditorErrorBoundary: ({ children }: { children?: unknown }) => children ?? null,
  Breadcrumbs: () => null,
}));

// Minimal DOM stub for the theme store's module-scope FOUC bootstrap
// (`applyCssVariables` at import time) and its `window.localStorage` use —
// `stores/search.ts` pulls in `stores/workspace.ts`, which reaches it.
const hadDocument = 'document' in globalThis;
const hadWindow = 'window' in globalThis;
if (!hadDocument) {
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      setAttribute: () => {},
      style: { setProperty: () => {}, backgroundColor: '' },
    },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (!hadWindow) {
  const localStorageData = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => localStorageData.get(k) ?? null,
      setItem: (k: string, v: string) => localStorageData.set(k, v),
      removeItem: (k: string) => localStorageData.delete(k),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
}

afterAll(() => {
  mock.restore();
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const { useSearchStore } = await import('./search');

describe('search() invalidation — REAL execution (own process, see file header)', () => {
  it('clears activeExcerptId when a new search actually starts (Fix round 1, Finding 2)', async () => {
    const id = 'search://invalidation-probe';
    const search = useSearchStore.getState();
    search.ensureSession(id);
    search.update(id, {
      query: 'todo',
      activeExcerptId: 'some/file.ts:10',
    });
    expect(useSearchStore.getState().sessions[id]?.activeExcerptId).toBe('some/file.ts:10');

    await useSearchStore.getState().search(id, '/tmp/workspace');

    const after = useSearchStore.getState().sessions[id];
    expect(after?.activeExcerptId).toBeNull();

    search.closeSession(id);
  });
});

describe('applyToSession — cross-session batch/complete routing (C3)', () => {
  it('a search-results-batch event for session B does not touch session A', async () => {
    const idA = 'search://cross-session-a';
    const idB = 'search://cross-session-b';
    const search = useSearchStore.getState();
    search.ensureSession(idA);
    search.ensureSession(idB);
    search.update(idA, { query: 'alpha' });
    search.update(idB, { query: 'beta' });

    // Real `search()` calls, not hand-set state: this is what actually gives
    // each session a real, backend-shaped `activeSearchId` for
    // `sessionForSearchId` to match against, and it's what registers the
    // REAL listener under test via `ensureListeners()`.
    await useSearchStore.getState().search(idA, '/tmp/workspace');
    await useSearchStore.getState().search(idB, '/tmp/workspace');

    const searchIdA = useSearchStore.getState().sessions[idA]?.activeSearchId;
    const searchIdB = useSearchStore.getState().sessions[idB]?.activeSearchId;
    expect(searchIdA).not.toBeNull();
    expect(searchIdB).not.toBeNull();
    expect(searchIdA).not.toBe(searchIdB); // distinct ids, or this test proves nothing

    const beforeA = useSearchStore.getState().sessions[idA];

    emit('search-results-batch', {
      searchId: searchIdB,
      results: [
        {
          path: '/tmp/b.ts',
          matches: [{ lineNumber: 1, lineContent: 'beta', matchStart: 0, matchEnd: 4 }],
        },
      ],
    });

    // Reference-identical, not just value-equal: session A's slot in the
    // `sessions` map must never have been re-set at all.
    expect(useSearchStore.getState().sessions[idA]).toBe(beforeA);
    expect(useSearchStore.getState().sessions[idA]?.results).toEqual([]);
    expect(useSearchStore.getState().sessions[idA]?.receivedFirstBatch).toBe(false);

    const afterB = useSearchStore.getState().sessions[idB];
    expect(afterB?.results.map((r) => r.path)).toEqual(['/tmp/b.ts']);
    expect(afterB?.receivedFirstBatch).toBe(true);

    search.closeSession(idA);
    search.closeSession(idB);
  });

  it('a batch/complete event for an id no session is tracking is dropped, not misrouted', async () => {
    const id = 'search://cross-session-orphan';
    const search = useSearchStore.getState();
    search.ensureSession(id);
    search.update(id, { query: 'gamma' });
    await useSearchStore.getState().search(id, '/tmp/workspace');

    const before = useSearchStore.getState().sessions;
    // No session's `activeSearchId` is ever this large in one test process
    // (the generator starts at 0 and increments by 1 per search/cancel).
    const untrackedId = 999_999_999;

    emit('search-results-batch', {
      searchId: untrackedId,
      results: [{ path: '/tmp/orphan.ts', matches: [] }],
    });
    emit('search-complete', {
      searchId: untrackedId,
      totalMatches: 1,
      fileCount: 1,
      truncated: false,
      cancelled: false,
      elapsedMs: 1,
    });

    // `sessionForSearchId` found nothing to route to, so `applyToSession`'s
    // `if (!session) return current` must have short-circuited BOTH events
    // before any `setState` write — not just left the tracked session's own
    // fields unchanged, but never touched the `sessions` map at all.
    expect(useSearchStore.getState().sessions).toBe(before);

    search.closeSession(id);
  });
});
