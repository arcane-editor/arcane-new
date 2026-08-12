import { describe, it, expect, afterAll, mock } from 'bun:test';

/**
 * REAL-EXECUTION test for `stores/search.ts`'s `search` action clearing
 * `expanded` and `activeExcerptId` at the start of a new search (Fix round 1,
 * Finding 2 on the excerpt-expansion task). Both fields name an excerpt from
 * the PREVIOUS result set by id (`path:startLine`); a new search can produce
 * an excerpt that reuses one of those ids for entirely different content
 * (same file, same start line, different surrounding matches), so without
 * this reset a fresh excerpt would silently inherit stale up/down expansion
 * counts and render pre-expanded, or `activeExcerptId` would point at an
 * excerpt that no longer exists.
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
// Every real named export of this module must be present — `mock.module`
// replaces the specifier's entire export surface for the rest of THIS
// process, and other real modules import from it for real.
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
  it('clears expanded and activeExcerptId when a new search actually starts (Fix round 1, Finding 2)', async () => {
    const id = 'search://invalidation-probe';
    const search = useSearchStore.getState();
    search.ensureSession(id);
    search.update(id, {
      query: 'todo',
      expanded: { 'some/file.ts:10': { up: 5, down: 10 } },
      activeExcerptId: 'some/file.ts:10',
    });
    expect(useSearchStore.getState().sessions[id]?.expanded).toEqual({
      'some/file.ts:10': { up: 5, down: 10 },
    });
    expect(useSearchStore.getState().sessions[id]?.activeExcerptId).toBe('some/file.ts:10');

    await useSearchStore.getState().search(id, '/tmp/workspace');

    const after = useSearchStore.getState().sessions[id];
    expect(after?.expanded).toEqual({});
    expect(after?.activeExcerptId).toBeNull();

    search.closeSession(id);
  });
});
