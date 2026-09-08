import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

/**
 * REAL-EXECUTION test for format-on-save, in `saveFile`.
 *
 * Named `.exec.ts` for the same reason as `search-tab-lifecycle.exec.ts`:
 * `bun test src` collects only `*.test.*`, and this file mocks the Tauri SDK
 * boundary with `mock.module`, which mutates Bun's module registry for the rest
 * of the process. Run explicitly by `bun run test:isolated`, in its own process.
 *
 * What it is actually guarding: `saveFile` snapshots the buffer into `written`
 * before invoking `write_file`, and formatting mutates that buffer. If the
 * snapshot is taken from the stale closure value instead of re-read from the
 * store, the formatter runs and its result is then thrown away — a silent
 * "format on save does nothing", or worse, a write of pre-format text over a
 * post-format model. A unit test of the formatter alone cannot see that.
 */
import * as realCore from '@tauri-apps/api/core';
import * as realWebviewWindow from '@tauri-apps/api/webviewWindow';
import * as realWindow from '@tauri-apps/api/window';

let writes: Array<{ path: string; contents: string }> = [];
const FILE = '/ws/Player.cs';
const ORIGINAL = 'class Player{void Update(){}}';
const FORMATTED = 'class Player\n{\n    void Update() { }\n}';

mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_file_checked') return { text: ORIGINAL, isBinary: false, size: ORIGINAL.length };
    if (cmd === 'write_file') {
      writes.push(args as { path: string; contents: string });
      return undefined;
    }
    // saveFile pings git and Unity afterwards; neither is under test.
    return undefined;
  },
}));
mock.module('@tauri-apps/api/webviewWindow', () => ({
  ...realWebviewWindow,
  getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
}));
mock.module('@tauri-apps/api/window', () => ({
  ...realWindow,
  getCurrentWindow: () => ({ setBackgroundColor: async () => {} }),
}));

// `features/editor`'s barrel statically imports monaco-editor, which runs
// browser-only code at module-eval time and crashes under plain `bun test`.
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
mock.module('../features/ai-panel/components/LexicalChatInput', () => ({
  default: () => null,
}));

// Mocked at the LEAF, not at the `features/lsp` barrel: replacing a module
// makes bun re-evaluate its dependents, so the barrel picks these up and
// `workspace.ts`'s barrel import sees them — without having to mirror the
// barrel's ~40 other exports (and re-mirror them on every change).
// `isRunning: true` is what makes `getRunningClientForFile` hand back a client
// at all — without it the format branch is skipped and every case below passes
// vacuously. The document-sync calls around the save reach `notify`/`request`
// on the same object, so the fake has to answer those too.
mock.module('../features/lsp/services/manager', () => ({
  lspManager: {
    client: () => ({
      isRunning: () => true,
      notify: () => {},
      request: async () => null,
    }),
  },
  LspManager: class {},
}));

/** What the fake formatter does on the next save. */
let formatResult: string | null | (() => never) = null;
mock.module('../features/lsp/services/format-on-save', () => ({
  formatDocumentBeforeSave: async () => {
    if (typeof formatResult === 'function') formatResult();
    return formatResult;
  },
}));

// Minimal DOM stub for the theme store's module-scope FOUC bootstrap.
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
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

const { useWorkspaceStore } = await import('./workspace');
const { useSettingsStore } = await import('./settings');

afterAll(() => {
  mock.restore();
});

async function openTheFile(): Promise<void> {
  useWorkspaceStore.setState({ openFiles: [], activeFilePath: null });
  await useWorkspaceStore.getState().openFile(FILE, 'Player.cs');
}

describe('format on save', () => {
  beforeEach(async () => {
    writes = [];
    formatResult = null;
    useSettingsStore.getState().setSetting('editor.formatOnSave', false);
    await openTheFile();
  });

  it('writes the buffer untouched when the setting is off', async () => {
    formatResult = FORMATTED; // available, but must not be consulted
    await useWorkspaceStore.getState().saveFile(FILE);

    expect(writes).toHaveLength(1);
    expect(writes[0].contents).toBe(ORIGINAL);
  });

  it('writes the FORMATTED text when the setting is on', async () => {
    // The regression this exists for: `written` must be re-read from the store
    // after formatting, not reused from the closure captured before it.
    useSettingsStore.getState().setSetting('editor.formatOnSave', true);
    formatResult = FORMATTED;
    await useWorkspaceStore.getState().saveFile(FILE);

    expect(writes).toHaveLength(1);
    expect(writes[0].contents).toBe(FORMATTED);
  });

  it('leaves the buffer clean after a formatting save', async () => {
    useSettingsStore.getState().setSetting('editor.formatOnSave', true);
    formatResult = FORMATTED;
    await useWorkspaceStore.getState().saveFile(FILE);

    const file = useWorkspaceStore.getState().openFiles.find((f) => f.path === FILE);
    expect(file?.isDirty).toBe(false);
    expect(file?.content).toBe(FORMATTED);
  });

  it('still saves when the formatter declines', async () => {
    useSettingsStore.getState().setSetting('editor.formatOnSave', true);
    formatResult = null;
    await useWorkspaceStore.getState().saveFile(FILE);

    expect(writes).toHaveLength(1);
    expect(writes[0].contents).toBe(ORIGINAL);
  });

  it('never lets a formatter failure block the save', async () => {
    useSettingsStore.getState().setSetting('editor.formatOnSave', true);
    formatResult = () => {
      throw new Error('language server died mid-format');
    };

    // If this rejects, Cmd+S has silently stopped saving.
    await expect(useWorkspaceStore.getState().saveFile(FILE)).resolves.toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(writes[0].contents).toBe(ORIGINAL);
  });
});
