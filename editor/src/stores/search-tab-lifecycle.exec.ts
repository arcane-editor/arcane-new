import { describe, it, expect, afterAll, mock } from 'bun:test';

/**
 * REAL-EXECUTION companion to `search-tab-lifecycle.test.ts` — this file
 * imports and actually calls `openSearchTab`, `closeFile`, `setActiveFile`,
 * `deletePath`, `syncActiveSearchSession` (indirectly), and `useSearchStore`'s
 * `ensureSession`/`closeSession`. It is deliberately named `.exec.ts`, NOT
 * `.test.ts`/`.spec.ts` (or `_test.`/`_spec.`), so `bun test src` — which
 * auto-collects only `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*` — never
 * picks it up. Run it explicitly via `bun run test:isolated`
 * (`bun test src/stores/search-tab-lifecycle.exec.ts`), its own process.
 *
 * Why a separate process: this file mocks the Tauri SDK boundary and the
 * `features/editor` barrel via `mock.module`, which mutates Bun's module
 * registry for the rest of whatever process runs it. An earlier version of
 * this file, named to match `bun test src`'s glob, got picked up alongside
 * every other test file in ONE shared process and — even restricted to the
 * minimum mock set plus `mock.restore()` in `afterAll` — caused an unrelated,
 * fully deterministic pure-function test elsewhere in the suite
 * (`review-core.test.ts`) to fail. Removing that file from the glob (moving
 * it here) removes it from that shared process entirely: `bun test
 * src/stores/search-tab-lifecycle.exec.ts` starts its own Bun process, so
 * nothing it mocks can leak into `bun test src`'s process, or vice versa.
 * `search-tab-lifecycle.test.ts` (the structural file) still carries the
 * always-collected, zero-risk coverage; this file adds real execution on top
 * without the cross-file blast radius.
 */
import * as realCore from '@tauri-apps/api/core';
import * as realWebviewWindow from '@tauri-apps/api/webviewWindow';
import * as realWindow from '@tauri-apps/api/window';

mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  // Only the commands the actions under test actually reach: `deletePath`
  // calls `delete_path`, and (with no workspace ever set in this file)
  // `refreshTree`'s `read_directory` call is never reached because it
  // early-returns when both `workspacePath`/`assetsRootPath` are null.
  // Anything else is a sign a test reached further than intended.
  invoke: async (cmd: string) => {
    if (cmd === 'delete_path') return undefined;
    throw new Error(`unexpected invoke('${cmd}') call in search-tab-lifecycle.exec`);
  },
}));
// Every real named export of this module must be present — `mock.module`
// replaces the specifier's entire export surface for the rest of THIS
// process, and other real modules import `WebviewWindow`/
// `getAllWebviewWindows` from it for real (same lesson `auth.test.ts`
// documents for `@tauri-apps/api/event`).
mock.module('@tauri-apps/api/webviewWindow', () => ({
  ...realWebviewWindow,
  getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
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
// Same shape of problem one barrel over. `stores/ai` imports the
// `features/ai-panel` barrel, which reaches `LexicalChatInput` ->
// `@lexical/react`. Replacing a module makes bun re-evaluate its dependents,
// and on bun >=1.3 re-entering `@lexical/react` throws `Cannot access
// 'HISTORY_MERGE_TAG' before initialization` (bun 1.2 tolerates it, which is
// why this only ever broke in CI, where setup-bun takes the latest release).
//
// Mocked at this leaf rather than at the barrel deliberately: `mock.module`
// replaces a module wholesale, so stubbing the barrel would mean mirroring
// every one of its runtime exports and re-mirroring them on every change.
// This file is the only real importer and `default` is its only runtime
// export, so one stub cuts the entire Lexical subtree out of the graph.
mock.module('../features/ai-panel/components/LexicalChatInput', () => ({
  default: () => null,
}));

// Minimal DOM stub for the theme store's module-scope FOUC bootstrap
// (`applyCssVariables` at import time) and its `window.localStorage` use.
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

const { useWorkspaceStore } = await import('./workspace');
const { useSearchStore } = await import('./search');

function fabricateTab(path: string, name: string): void {
  useWorkspaceStore.setState((state) => ({
    openFiles: [...state.openFiles, { path, name, content: '', isDirty: false }],
  }));
}

describe('search:// tab lifecycle — REAL execution (own process, see file header)', () => {
  it('allocates search://1 then search://2, each with its own session', () => {
    const path1 = useWorkspaceStore.getState().openSearchTab();
    const path2 = useWorkspaceStore.getState().openSearchTab();
    expect(path1).toBe('search://1');
    expect(path2).toBe('search://2');
    expect(useSearchStore.getState().sessions[path1]).toBeDefined();
    expect(useSearchStore.getState().sessions[path2]).toBeDefined();

    useWorkspaceStore.getState().closeFile(path1);
    useWorkspaceStore.getState().closeFile(path2);
  });

  it('the collision loop skips a still-open id rather than colliding with it', () => {
    // Exactly the scenario Finding-1's review flagged: tabs 1, 2, 3 open,
    // close tab 2. Without the collision loop, `used` (now 2, counting tabs
    // 1 and 3) + 1 would hand out `search://3` again — the tab that's
    // STILL open. The real loop must skip past it.
    const path1 = useWorkspaceStore.getState().openSearchTab();
    const path2 = useWorkspaceStore.getState().openSearchTab();
    const path3 = useWorkspaceStore.getState().openSearchTab();
    useWorkspaceStore.getState().closeFile(path2);

    const path4 = useWorkspaceStore.getState().openSearchTab();
    expect(path4).not.toBe(path3); // must not collide with the still-open tab
    expect(useWorkspaceStore.getState().openFiles.filter((f) => f.path === path4)).toHaveLength(1);
    expect(useSearchStore.getState().sessions[path4]).toBeDefined();

    useWorkspaceStore.getState().closeFile(path1);
    useWorkspaceStore.getState().closeFile(path3);
    useWorkspaceStore.getState().closeFile(path4);
  });

  it('seeds the query and activates both the tab and its session', () => {
    const path = useWorkspaceStore.getState().openSearchTab({ query: 'todo' });
    const ws = useWorkspaceStore.getState();
    expect(ws.activeFilePath).toBe(path);
    expect(ws.openFiles.find((f) => f.path === path)?.name).toBe('Search');
    expect(useSearchStore.getState().sessions[path]?.query).toBe('todo');
    expect(useSearchStore.getState().activeSessionId).toBe(path);

    useWorkspaceStore.getState().closeFile(path);
  });

  it("an unseeded call does not touch an already-open tab's session fields", () => {
    const path1 = useWorkspaceStore.getState().openSearchTab({ query: 'keep-me' });
    const path2 = useWorkspaceStore.getState().openSearchTab(); // unseeded
    expect(useSearchStore.getState().sessions[path1]?.query).toBe('keep-me');
    expect(useSearchStore.getState().sessions[path2]?.query).toBe('');

    useWorkspaceStore.getState().closeFile(path1);
    useWorkspaceStore.getState().closeFile(path2);
  });

  it('ensureSession does not overwrite an existing session (called directly, twice)', () => {
    const search = useSearchStore.getState();
    search.ensureSession('search://exec-probe');
    search.update('search://exec-probe', { query: 'first-call' });
    expect(useSearchStore.getState().sessions['search://exec-probe']?.query).toBe('first-call');

    // Second ensureSession on the SAME id must be a no-op — this is the
    // property `openSearchTab` relies on never mattering in practice
    // (freshly-computed ids don't collide with a live session), but the
    // store-level guarantee itself is real and checked directly here.
    search.ensureSession('search://exec-probe');
    expect(useSearchStore.getState().sessions['search://exec-probe']?.query).toBe('first-call');

    search.closeSession('search://exec-probe');
  });

  it('closeFile removes a non-last search tab from openFiles and deletes its session', () => {
    const path1 = useWorkspaceStore.getState().openSearchTab();
    const path2 = useWorkspaceStore.getState().openSearchTab();
    const path3 = useWorkspaceStore.getState().openSearchTab();

    expect(() => useWorkspaceStore.getState().closeFile(path2)).not.toThrow();
    expect(useWorkspaceStore.getState().openFiles.some((f) => f.path === path2)).toBe(false);
    expect(useSearchStore.getState().sessions[path2]).toBeUndefined();
    expect(useSearchStore.getState().sessions[path1]).toBeDefined();
    expect(useSearchStore.getState().sessions[path3]).toBeDefined();

    useWorkspaceStore.getState().closeFile(path1);
    useWorkspaceStore.getState().closeFile(path3);
  });

  it('setActiveFile clicking a different open search tab retargets activeSessionId', () => {
    const path1 = useWorkspaceStore.getState().openSearchTab();
    const path2 = useWorkspaceStore.getState().openSearchTab();
    expect(useSearchStore.getState().activeSessionId).toBe(path2);

    useWorkspaceStore.getState().setActiveFile(path1);
    expect(useSearchStore.getState().activeSessionId).toBe(path1);
    useWorkspaceStore.getState().setActiveFile(path2);
    expect(useSearchStore.getState().activeSessionId).toBe(path2);

    useWorkspaceStore.getState().closeFile(path1);
    useWorkspaceStore.getState().closeFile(path2);
  });

  it('setActiveFile on a non-search tab leaves activeSessionId alone', () => {
    const searchPath = useWorkspaceStore.getState().openSearchTab();
    expect(useSearchStore.getState().activeSessionId).toBe(searchPath);

    fabricateTab('/tmp/plain.txt', 'plain.txt');
    useWorkspaceStore.getState().setActiveFile('/tmp/plain.txt');
    expect(useWorkspaceStore.getState().activeFilePath).toBe('/tmp/plain.txt');
    expect(useSearchStore.getState().activeSessionId).toBe(searchPath);

    useWorkspaceStore.getState().closeFile('/tmp/plain.txt');
    useWorkspaceStore.getState().closeFile(searchPath);
  });

  it('closeFile falling back to a remaining search tab retargets activeSessionId', () => {
    const searchPath = useWorkspaceStore.getState().openSearchTab();
    fabricateTab('/tmp/plain2.txt', 'plain2.txt');
    useWorkspaceStore.setState({ activeFilePath: '/tmp/plain2.txt' });
    useSearchStore.getState().setActiveSession('some-other-id-that-is-not-open');

    expect(() => useWorkspaceStore.getState().closeFile('/tmp/plain2.txt')).not.toThrow();
    expect(useWorkspaceStore.getState().activeFilePath).toBe(searchPath);
    expect(useSearchStore.getState().activeSessionId).toBe(searchPath);

    useWorkspaceStore.getState().closeFile(searchPath);
  });

  it('deletePath falling back to a remaining search tab retargets activeSessionId (Fix round 2, Item 1)', async () => {
    const searchPath = useWorkspaceStore.getState().openSearchTab();
    fabricateTab('/tmp/to-delete.txt', 'to-delete.txt');
    useWorkspaceStore.setState({ activeFilePath: '/tmp/to-delete.txt' });
    useSearchStore.getState().setActiveSession('some-other-id-that-is-not-open');

    await useWorkspaceStore.getState().deletePath('/tmp/to-delete.txt');

    expect(useWorkspaceStore.getState().openFiles.some((f) => f.path === '/tmp/to-delete.txt')).toBe(false);
    expect(useWorkspaceStore.getState().activeFilePath).toBe(searchPath);
    expect(useSearchStore.getState().activeSessionId).toBe(searchPath);

    useWorkspaceStore.getState().closeFile(searchPath);
  });
});
