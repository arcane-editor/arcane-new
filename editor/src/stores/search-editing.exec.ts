import { describe, it, expect, afterAll, mock } from 'bun:test';

/**
 * REAL-EXECUTION test for `stores/workspace.ts`'s `openFileInBackground` —
 * the action Task 10 wires up so a search excerpt's first edit joins
 * `openFiles` (dirty state, save, the close guard and LSP sync all apply)
 * without stealing focus from the results tab mid-keystroke — and (Task 11)
 * `stores/search.ts`'s `saveAllEdited`, the action behind a results tab's
 * `mod+s`: save every file THIS session's `editedPaths` names, and only
 * those, leaving a path in the list if (and only if) its save failed
 * (fix round 1, Finding 1).
 *
 * Deliberately `.exec.ts`, not `.test.ts` — same reason as the sibling
 * `search-invalidation.exec.ts` (see that file's header): `mock.module`
 * mutates Bun's module registry for the rest of whatever process runs it, so
 * this needs its own process via `bun run test:isolated`, not `bun test src`.
 */
import * as realCore from '@tauri-apps/api/core';
import * as realWebviewWindow from '@tauri-apps/api/webviewWindow';
import * as realWindow from '@tauri-apps/api/window';

/** `saveFile` (`stores/workspace.ts`) writes through this — captured here so
 *  the `saveAllEdited` tests below can assert exactly which paths were
 *  written to disk and with what contents, without a real filesystem. */
const writeFileCalls: Array<{ path: string; contents: string }> = [];

/** Paths in this set make the mocked `write_file` reject instead of
 *  succeeding — the harness for fix round 1's Finding 2 (a save that fails
 *  must stay in `editedPaths`, not just one that never runs). Tests add a
 *  path before calling `saveAllEdited` and remove it in a `finally`, so a
 *  failure in one test can't leak into the next. */
const failingWritePaths = new Set<string>();

mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  // `openFileInBackground` itself never invokes anything — it's a pure
  // `set()`. `saveFile` (exercised below via `saveAllEdited`) invokes
  // `write_file` and nothing else, since none of these tests ever set a
  // `workspacePath`, which is what would additionally reach
  // `refreshStatus`/`refreshOpenDiffTabs` (git store, unrelated to this
  // file). Anything else is a sign a test reached further than intended.
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'write_file') {
      const path = args?.path as string;
      if (failingWritePaths.has(path)) {
        throw new Error(`simulated write failure for ${path}`);
      }
      writeFileCalls.push({
        path,
        contents: args?.contents as string,
      });
      return undefined;
    }
    throw new Error(`unexpected invoke('${cmd}') call in search-editing.exec`);
  },
}));

mock.module('@tauri-apps/api/webviewWindow', () => ({
  ...realWebviewWindow,
  getCurrentWebviewWindow: () => ({
    listen: async () => () => {},
  }),
}));
mock.module('@tauri-apps/api/window', () => ({
  ...realWindow,
  getCurrentWindow: () => ({ setBackgroundColor: async () => {} }),
}));
// `features/editor`'s barrel re-exports `EditorPanel`, which statically
// imports `@monaco-editor/react` -> `monaco-editor`; that package runs
// browser-only code (`window.location`, animation-frame scheduling) at
// module-eval time and crashes under plain `bun test`. None of it is
// exercised by anything under test here.
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
// Keeps `@lexical/react` out of the graph: `stores/ai` pulls the
// `features/ai-panel` barrel, which reaches this leaf, and on bun >=1.3
// re-evaluating it after a `mock.module` call throws `Cannot access
// 'HISTORY_MERGE_TAG' before initialization`. See the long note in
// `search-tab-lifecycle.exec.ts` for why the leaf and not the barrel.
mock.module('../features/ai-panel/components/LexicalChatInput', () => ({
  default: () => null,
}));

// Minimal DOM stub for the theme store's module-scope FOUC bootstrap
// (`applyCssVariables` at import time) and its `window.localStorage` use —
// `stores/workspace.ts` reaches it transitively.
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

describe('openFileInBackground — REAL execution (own process, see file header)', () => {
  it('adds the file to openFiles without changing the active tab', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    const before = useWorkspaceStore.getState().activeFilePath;
    useWorkspaceStore.getState().openFileInBackground('/w/a.cs', 'edited');
    const state = useWorkspaceStore.getState();
    expect(state.openFiles.some((f) => f.path === '/w/a.cs')).toBe(true);
    expect(state.activeFilePath).toBe(before);
  });

  it('marks it dirty, so mod+s and the close guard both see it', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    useWorkspaceStore.getState().openFileInBackground('/w/b.cs', 'edited');
    expect(useWorkspaceStore.getState().openFiles.find((f) => f.path === '/w/b.cs')?.isDirty).toBe(true);
  });

  it('is a no-op for a file that already has a tab, preserving its content', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    useWorkspaceStore.getState().openFileInBackground('/w/c.cs', 'first');
    useWorkspaceStore.getState().openFileInBackground('/w/c.cs', 'second');
    const matches = useWorkspaceStore.getState().openFiles.filter((f) => f.path === '/w/c.cs');
    expect(matches).toHaveLength(1);
    expect(matches[0].content).toBe('first');
  });

  // Fix round 1, Finding 2: `openFileInBackground` must send `didOpen`, or
  // every later `didChange`/`didSave` for that file is silently dropped by
  // `document-sync.ts`'s `openCounts` guard forever. Exercising this for
  // real (rather than asserting on a mock) means getting `ensureLspForFile`
  // (private to `workspace.ts`) to see a "running" client without spawning a
  // real server — `lspManager`/`document-sync.ts` are NOT mocked anywhere in
  // this file (unlike the Tauri/editor modules above), so this reaches into
  // the one real `LspClient` instance the store itself will look up for a
  // `.cs` file and flips its private `running` flag directly. That's real
  // execution of `document-sync.ts`'s actual `openCounts` map, not a
  // simulation of it — the thing Finding 2 asked to be confirmed.
  it('sends didOpen so a later edit/save is not silently dropped by the LSP openCounts guard', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    const { lspManager, getOpenDocumentUris } = await import('../features/lsp');

    const client = lspManager.client('csharp');
    (client as unknown as { running: boolean }).running = true;
    const notified: Array<{ method: string; params: unknown }> = [];
    client.notify = (method: string, params: unknown) => {
      notified.push({ method, params });
    };

    useWorkspaceStore.getState().openFileInBackground('/w/d.cs', 'background content');
    // The didOpen dispatch is fire-and-forget, scheduled after the
    // synchronous `openFiles` write (see the comment in `workspace.ts`) —
    // give its microtask a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notified.some((n) => n.method === 'textDocument/didOpen')).toBe(true);
    expect(getOpenDocumentUris().has('file:///w/d.cs')).toBe(true);

    // Confirms the actual claim in Finding 2: `openCounts.has(path)` is now
    // true, so `syncDocumentChange` no longer early-returns for this path.
    useWorkspaceStore.getState().updateFileContent('/w/d.cs', 'background content v2');
    expect(notified.some((n) => n.method === 'textDocument/didChange')).toBe(true);
  });
});

// `.txt` paths throughout (not `.cs`, unlike the suite above): `detectLanguage`
// gives these no `lspServerKey`, so `saveFile`'s `getRunningClientForFile`
// lookup is a guaranteed no-op — these tests are about `saveAllEdited`'s own
// save/clear/isolation behaviour, not LSP sync, and the suite above already
// leaves the shared `lspManager` csharp client's `running` flag flipped true
// from an earlier test in this same process.
describe('saveAllEdited — REAL execution (own process, see file header)', () => {
  it('saves every path in editedPaths, in order, and clears the list', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    const { useSearchStore } = await import('./search');
    const id = 'search://save-all-basic';
    useSearchStore.getState().ensureSession(id);

    useWorkspaceStore.getState().openFileInBackground('/w/save-a.txt', 'content a');
    useWorkspaceStore.getState().openFileInBackground('/w/save-b.txt', 'content b');
    useSearchStore.getState().update(id, {
      editedPaths: ['/w/save-a.txt', '/w/save-b.txt'],
    });

    const before = writeFileCalls.length;
    // `saveAllEdited` now genuinely resolves once every save has settled
    // (fix round 1, Finding 1 — it used to clear `editedPaths` synchronously
    // right after firing the saves, before any of them finished), so
    // awaiting it directly is both correct and sufficient — no more
    // `setTimeout(0)` guess at how many microtasks the writes need.
    await useSearchStore.getState().saveAllEdited(id);

    const written = writeFileCalls.slice(before);
    expect(written).toEqual([
      { path: '/w/save-a.txt', contents: 'content a' },
      { path: '/w/save-b.txt', contents: 'content b' },
    ]);

    const state = useWorkspaceStore.getState();
    expect(state.openFiles.find((f) => f.path === '/w/save-a.txt')?.isDirty).toBe(false);
    expect(state.openFiles.find((f) => f.path === '/w/save-b.txt')?.isDirty).toBe(false);
    expect(useSearchStore.getState().sessions[id]?.editedPaths).toEqual([]);

    useSearchStore.getState().closeSession(id);
  });

  it('reads editedPaths fresh at call time, not a value captured earlier', async () => {
    // NOTE (fix round 1 review): this test is weaker than its name claims.
    // `saveAllEdited(id)` reads `editedPaths` via `get()` INSIDE the action
    // by construction — there is no parameter for a caller to capture a
    // stale value into in the first place, so this cannot fail even if a
    // future edit accidentally reintroduced a captured-array bug elsewhere.
    // The actual risk the brief was worried about — `ExcerptList`'s
    // `useEffect` closing over a stale `editedPaths` at LISTENER
    // REGISTRATION time — lives in a React component this repo's test
    // harness cannot mount (no RTL, and it transitively needs a live
    // Monaco instance), so that risk stays genuinely untested by automation.
    // Kept as a regression guard on `saveAllEdited`'s own contract (it must
    // still pick up an edit added between two calls), not as proof of the
    // closure property.
    const { useWorkspaceStore } = await import('./workspace');
    const { useSearchStore } = await import('./search');
    const id = 'search://save-all-live-read';
    useSearchStore.getState().ensureSession(id);

    useWorkspaceStore.getState().openFileInBackground('/w/save-live-1.txt', 'v1');
    useSearchStore.getState().update(id, { editedPaths: ['/w/save-live-1.txt'] });

    // Time passes; a second excerpt is edited after whatever "registered"
    // this session's listener would have already captured.
    useWorkspaceStore.getState().openFileInBackground('/w/save-live-2.txt', 'v2');
    useSearchStore.getState().update(id, {
      editedPaths: ['/w/save-live-1.txt', '/w/save-live-2.txt'],
    });

    const before = writeFileCalls.length;
    await useSearchStore.getState().saveAllEdited(id);

    const writtenPaths = writeFileCalls.slice(before).map((c) => c.path);
    expect(writtenPaths).toContain('/w/save-live-1.txt');
    expect(writtenPaths).toContain('/w/save-live-2.txt');

    useSearchStore.getState().closeSession(id);
  });

  it('does not touch a file left dirty in another tab for unrelated reasons', async () => {
    // The one rule that matters most for Task 11: save-all saves ONLY
    // `editedPaths`, never sweeps in other dirty tabs.
    const { useWorkspaceStore } = await import('./workspace');
    const { useSearchStore } = await import('./search');
    const id = 'search://save-all-isolation';
    useSearchStore.getState().ensureSession(id);

    // Dirty for an unrelated reason — never added to this session's
    // editedPaths, so it must survive save-all untouched.
    useWorkspaceStore.getState().openFileInBackground('/w/unrelated.txt', 'unrelated edit');
    useWorkspaceStore.getState().openFileInBackground('/w/save-only-this.txt', 'only this');
    useSearchStore.getState().update(id, { editedPaths: ['/w/save-only-this.txt'] });

    const before = writeFileCalls.length;
    await useSearchStore.getState().saveAllEdited(id);

    const writtenPaths = writeFileCalls.slice(before).map((c) => c.path);
    expect(writtenPaths).toEqual(['/w/save-only-this.txt']);

    const state = useWorkspaceStore.getState();
    expect(state.openFiles.find((f) => f.path === '/w/unrelated.txt')?.isDirty).toBe(true);
    expect(state.openFiles.find((f) => f.path === '/w/save-only-this.txt')?.isDirty).toBe(false);

    useSearchStore.getState().closeSession(id);
  });

  it('is a no-op — no writes, no throw — for a session with no edits', async () => {
    const { useSearchStore } = await import('./search');
    const id = 'search://save-all-empty';
    useSearchStore.getState().ensureSession(id);

    const before = writeFileCalls.length;
    await expect(useSearchStore.getState().saveAllEdited(id)).resolves.toBeUndefined();

    expect(writeFileCalls.length).toBe(before);
    expect(useSearchStore.getState().sessions[id]?.editedPaths).toEqual([]);

    useSearchStore.getState().closeSession(id);
  });

  // Fix round 1, Finding 1 & Finding 2: a REJECTED save (disk full,
  // permissions, the file locked by Unity) must leave its path in
  // `editedPaths` — the modified-count badge is the one signal that
  // something still needs saving, and the old unconditional clear destroyed
  // it exactly when it mattered most. One unwritable file must also not
  // block the others in the same batch from saving.
  it('leaves a failed save in editedPaths, saves the rest anyway, and produces no unhandled rejection', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    const { useSearchStore } = await import('./search');
    const id = 'search://save-all-partial-failure';
    useSearchStore.getState().ensureSession(id);

    useWorkspaceStore.getState().openFileInBackground('/w/save-fail.txt', 'will fail');
    useWorkspaceStore.getState().openFileInBackground('/w/save-ok.txt', 'will succeed');
    useSearchStore.getState().update(id, {
      editedPaths: ['/w/save-fail.txt', '/w/save-ok.txt'],
    });

    // Detects the exact regression Finding 1 called out: `void saveFile(...)`
    // with nothing awaiting or `.catch`ing it left each rejection unhandled,
    // which `main.tsx`'s global `unhandledrejection` listener turned into a
    // SECOND, generic toast stacked on top of `saveFile`'s own. Node/Bun
    // fire `unhandledRejection` on a microtask AFTER the promise settles, so
    // this listener has to stay registered past the `await` below, not just
    // during it.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    failingWritePaths.add('/w/save-fail.txt');
    try {
      await useSearchStore.getState().saveAllEdited(id);
      // One more tick for a same-turn `unhandledRejection` to have fired,
      // if the fix regressed and one of the saves went unhandled again.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      failingWritePaths.delete('/w/save-fail.txt');
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(useSearchStore.getState().sessions[id]?.editedPaths).toEqual(['/w/save-fail.txt']);
    expect(unhandled).toEqual([]);

    const state = useWorkspaceStore.getState();
    // The failed file is still dirty — nothing pretends it saved.
    expect(state.openFiles.find((f) => f.path === '/w/save-fail.txt')?.isDirty).toBe(true);
    // The other file in the same batch was not blocked by the failure.
    expect(state.openFiles.find((f) => f.path === '/w/save-ok.txt')?.isDirty).toBe(false);
    expect(
      writeFileCalls.some((c) => c.path === '/w/save-ok.txt' && c.contents === 'will succeed'),
    ).toBe(true);
    expect(writeFileCalls.some((c) => c.path === '/w/save-fail.txt')).toBe(false);

    useSearchStore.getState().closeSession(id);
  });
});
