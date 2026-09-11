import { describe, it, expect, afterAll, mock } from 'bun:test';

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

let diskText = 'class Player{}';
let notifyCalls: any[] = [];
let disposed: string[] = [];
let delayedReads: Array<(value: any) => void> | null = null;
let writes: Array<{ path: string; contents: string }> = [];
let delayedWrites: Array<() => void> | null = null;
const FILE = '/ws/Player.cs';
const ORIGINAL = 'class Player{void Update(){}}';

mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_directory') return [];
    if (cmd === 'read_file_checked' && delayedReads) return new Promise(resolve => delayedReads!.push(resolve));
    if (cmd === 'read_file_checked') return { text: ORIGINAL, isBinary: false, size: ORIGINAL.length };
    if (cmd === 'write_file_if_unchanged') {
      if (args?.expectedContent !== diskText) return false;
      if (delayedWrites) return new Promise((resolve) => delayedWrites!.push(() => {
        writes.push(args as { path: string; contents: string });
        diskText = String(args?.contents);
        resolve(true);
      }));
      writes.push(args as { path: string; contents: string });
      diskText = String(args?.contents);
      return true;
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
  disposeModelForPath: (path: string) => { disposed.push(path); },
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
      notify: (method: string, params: any) => { notifyCalls.push({ method, params }); },
      request: async () => null,
    }),
  },
  LspManager: class {},
}));

mock.module('../features/lsp/services/format-on-save', () => ({ formatDocumentBeforeSave: async () => null }));

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

const { useWorkspaceStore } = await import('../stores/workspace');
const { getOpenDocumentUris, resetDocumentVersions } = await import('../features/lsp');
const { useSettingsStore } = await import('../stores/settings');

afterAll(() => {
  mock.restore();
});

async function openTheFile(): Promise<void> {
  useWorkspaceStore.setState({ openFiles: [], activeFilePath: null });
  await useWorkspaceStore.getState().openFile(FILE, 'Player.cs');
}


const { useProjectContextStore } = await import('../stores/project-context.ts');
useProjectContextStore.setState({ isUnityProject: false });
useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, 'editor.formatOnSave': false } });
function resetFixture() {
  diskText=ORIGINAL; writes=[]; notifyCalls=[]; disposed=[]; delayedReads=null; resetDocumentVersions();
  useWorkspaceStore.setState({ workspacePath: null, assetsRootPath: null, openFiles: [], activeFilePath: null, tree: [] });
}
describe('file integrity and lifecycle regressions', () => {
  it('overlapping opens share one tab and release one LSP claim', async () => {
    resetFixture(); delayedReads=[];
    const a = useWorkspaceStore.getState().openFile(FILE, 'Player.cs');
    const b = useWorkspaceStore.getState().openFile(FILE, 'Player.cs');
    for (const resolve of delayedReads) resolve({ text: ORIGINAL, isBinary: false, size: ORIGINAL.length });
    await Promise.all([a,b]);
    expect(useWorkspaceStore.getState().openFiles).toHaveLength(1);
    useWorkspaceStore.getState().closeFile(FILE);
    expect(getOpenDocumentUris().size).toBe(0);

  });
  it('rename transfers LSP tracking and disposes the old model', async () => {
    resetFixture(); await openTheFile(); notifyCalls=[];
    const renamed = '/ws/Renamed.cs';
    await useWorkspaceStore.getState().renamePath(FILE, renamed);
    useWorkspaceStore.getState().updateFileContent(renamed, 'class Renamed{}');
    expect(notifyCalls.filter(n=>n.method==='textDocument/didChange')).toHaveLength(1);
    expect(getOpenDocumentUris().has('file:///ws/Player.cs')).toBe(false);
    expect(getOpenDocumentUris().has('file:///ws/Renamed.cs')).toBe(true);
    expect(disposed).toEqual([FILE]);

  });
  it('delete cleans models and LSP documents', async () => {
    resetFixture(); await openTheFile(); notifyCalls=[];
    await useWorkspaceStore.getState().deletePath(FILE);
    expect(useWorkspaceStore.getState().openFiles).toHaveLength(0);
    expect(disposed).toEqual([FILE]);
    expect(getOpenDocumentUris().size).toBe(0);
    expect(notifyCalls.filter(n=>n.method==='textDocument/didClose')).toHaveLength(1);

  });
  it('external edits prevent a save and keep the local buffer dirty', async () => {
    resetFixture(); await openTheFile();
    useWorkspaceStore.getState().updateFileContent(FILE, 'class Player{int userChange;}');
    diskText = 'class Player{int externalChange;}';
    await useWorkspaceStore.getState().saveFile(FILE);
    expect(diskText).toBe('class Player{int externalChange;}');
    expect(writes).toHaveLength(0);
    expect(useWorkspaceStore.getState().openFiles[0].saveConflict).toBe(true);
    expect(useWorkspaceStore.getState().openFiles[0].isDirty).toBe(true);

  });
});

it('closing during a delayed read prevents a late tab and LSP open', async () => {
  resetFixture(); delayedReads=[];
  const opening=useWorkspaceStore.getState().openFile(FILE, 'Player.cs');
  useWorkspaceStore.getState().closeFile(FILE);
  delayedReads[0]({text: ORIGINAL, isBinary:false, size: ORIGINAL.length});
  await opening;
  expect(useWorkspaceStore.getState().openFiles).toHaveLength(0);
  expect(getOpenDocumentUris().size).toBe(0);
});
it('a slow earlier open cannot steal focus from the latest navigation', async () => {
  resetFixture(); delayedReads=[];
  const first=useWorkspaceStore.getState().openFile(FILE, 'Player.cs');
  const last=useWorkspaceStore.getState().openFile('/ws/Last.cs', 'Last.cs');
  delayedReads[1]({text: ORIGINAL, isBinary:false, size: ORIGINAL.length});
  await last;
  delayedReads[0]({text: ORIGINAL, isBinary:false, size: ORIGINAL.length});
  await first;
  expect(useWorkspaceStore.getState().activeFilePath).toBe('/ws/Last.cs');
});
it('directory deletion cleans background documents as well as the foreground tab', async () => {
  resetFixture();
  await useWorkspaceStore.getState().openFile('/ws/sub/A.cs', 'A.cs');
  await useWorkspaceStore.getState().openFile('/ws/sub/B.cs', 'B.cs');
  await useWorkspaceStore.getState().deletePath('/ws/sub');
  expect(disposed.sort()).toEqual(['/ws/sub/A.cs','/ws/sub/B.cs']);
  expect(getOpenDocumentUris().size).toBe(0);
});

it('Windows drive and separator variants share the complete tab lifecycle', async () => {
  resetFixture();
  await useWorkspaceStore.getState().openFile('c:\\workspace\\Player.cs', 'Player.cs');
  await useWorkspaceStore.getState().openFile('C:/workspace/Player.cs', 'Player.cs');
  expect(useWorkspaceStore.getState().openFiles).toHaveLength(1);
  useWorkspaceStore.getState().updateFileContent('c:/workspace/Player.cs', 'changed');
  expect(useWorkspaceStore.getState().openFiles[0].content).toBe('changed');
  await useWorkspaceStore.getState().saveFile('c:\\workspace\\Player.cs');
  expect(diskText).toBe('changed');
  useWorkspaceStore.getState().closeFile('c:\\workspace\\Player.cs');
  expect(useWorkspaceStore.getState().openFiles).toHaveLength(0);
  expect(getOpenDocumentUris().size).toBe(0);
});

it('queued saves cannot take ownership of a closed and reopened tab', async () => {
  resetFixture();
  await openTheFile();
  useWorkspaceStore.getState().updateFileContent(FILE, 'first save');
  delayedWrites = [];
  try {
    const first = useWorkspaceStore.getState().saveFile(FILE);
    const queued = useWorkspaceStore.getState().saveFile(FILE);
    expect(delayedWrites).toHaveLength(1);
    useWorkspaceStore.getState().closeFile(FILE);
    await openTheFile();
    useWorkspaceStore.getState().updateFileContent(FILE, 'new tab draft');
    delayedWrites[0]();
    await Promise.all([first, queued]);
    const file = useWorkspaceStore.getState().openFiles[0];
    expect(file.content).toBe('new tab draft');
    expect(file.saveConflict).not.toBe(true);
    expect(file.isDirty).toBe(true);
    expect(writes).toHaveLength(1);
  } finally {
    delayedWrites = null;
  }
});
