import { describe, it, expect, afterAll, mock } from 'bun:test';

/**
 * REAL-EXECUTION test for `stores/workspace.ts`'s `openFileInBackground` —
 * the action Task 10 wires up so a search excerpt's first edit joins
 * `openFiles` (dirty state, save, the close guard and LSP sync all apply)
 * without stealing focus from the results tab mid-keystroke.
 *
 * Deliberately `.exec.ts`, not `.test.ts` — same reason as the sibling
 * `search-invalidation.exec.ts` (see that file's header): `mock.module`
 * mutates Bun's module registry for the rest of whatever process runs it, so
 * this needs its own process via `bun run test:isolated`, not `bun test src`.
 */
import * as realCore from '@tauri-apps/api/core';
import * as realWebviewWindow from '@tauri-apps/api/webviewWindow';
import * as realWindow from '@tauri-apps/api/window';

mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  // `openFileInBackground` itself never invokes anything — it's a pure
  // `set()` — but `stores/workspace.ts` reaches other invoke calls at
  // module scope / via other actions this file never calls, so this stub
  // just fails loudly if something unexpected reaches it.
  invoke: async (cmd: string) => {
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
});
