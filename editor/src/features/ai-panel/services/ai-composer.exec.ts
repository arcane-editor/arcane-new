import { it, expect, mock } from 'bun:test';

/** Isolated regression: real UI/store/service code, mocked OS boundaries. */
import * as realCore from '@tauri-apps/api/core';
import * as realWebviewWindow from '@tauri-apps/api/webviewWindow';
import * as realWindow from '@tauri-apps/api/window';

let composerProps: any;
mock.module('@tauri-apps/api/core', () => ({ ...realCore, invoke: async () => undefined }));
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
mock.module('../../../features/editor', () => ({
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
mock.module('../../../features/ai-panel/components/LexicalChatInput', () => ({
  default: (props: any) => { composerProps = props; return null; },
}));

// Mocked at the LEAF, not at the `features/lsp` barrel: replacing a module
// makes bun re-evaluate its dependents, so the barrel picks these up and
// `workspace.ts`'s barrel import sees them — without having to mirror the
// barrel's ~40 other exports (and re-mirror them on every change).
// `isRunning: true` is what makes `getRunningClientForFile` hand back a client
// at all — without it the format branch is skipped and every case below passes
// vacuously. The document-sync calls around the save reach `notify`/`request`
// on the same object, so the fake has to answer those too.
mock.module('../../../features/lsp/services/manager', () => ({
  lspManager: {
    client: () => ({
      isRunning: () => true,
      notify: () => {},
      request: async () => null,
    }),
  },
  LspManager: class {},
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

const { useWorkspaceStore } = await import('../../../stores/workspace');
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { useAiStore } = await import('../../../stores/ai.ts');
const { getAgentService } = await import('../../../features/ai-panel/services/agent-service.ts');
const { default: ChatInput } = await import('../../../features/ai-panel/components/ChatInput.tsx');
const { dispatchComposerSend } = await import('./composer-dispatch');
const { ClaudeBackend } = await import('./claude-backend');
it('running composer declines keyboard submit and preserves attachments', () => {
  useWorkspaceStore.setState({workspacePath:'/ws'});
  useAiStore.setState({mode:'ask',selectedAgent:'hosted',isAgentRunning:true, messages:[],attachments:[{kind:'file',path:'/ws/A.cs',label:'A.cs'}] as any});
  const service=getAgentService() as any;
  service.sendInFlight=true;
  renderToStaticMarkup(React.createElement(ChatInput));
  expect(composerProps.onSubmit('followup that should remain in draft')).toBe(false);
  expect(useAiStore.getState().messages).toHaveLength(0);
  expect(useAiStore.getState().attachments).toHaveLength(1);
  expect(useAiStore.getState().errorMessage).toBeNull();

});

it('Stop while preplanning dependencies load cancels the queued send and releases the composer', async () => {
  useAiStore.getState().resetConversation();
  useAiStore.setState({ mode: 'agent', selectedAgent: 'hosted' });
  const service = getAgentService();
  const originalSend = service.sendMessage;
  let sends = 0;
  service.sendMessage = async () => { sends++; };
  try {
    expect(dispatchComposerSend('prepare a scene', [])).toBe(true);
    expect(useAiStore.getState().isSubmitting).toBe(true);
    service.abort();
    for (let i = 0; i < 100 && useAiStore.getState().isSubmitting; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(sends).toBe(0);
    expect(useAiStore.getState().isSubmitting).toBe(false);
    expect(useAiStore.getState().errorMessage).toBeNull();
  } finally {
    service.sendMessage = originalSend;
    service.dispose();
  }
});

it('Stop while an external agent connects prevents the queued prompt', async () => {
  const backend = new ClaudeBackend();
  let connected!: () => void;
  backend.connect = () => new Promise((resolve) => { connected = () => resolve({ kind: 'ready' }); });
  let promptBuilt = false;
  (backend as any).buildPromptBlocks = async () => { promptBuilt = true; return []; };
  const pending = backend.sendMessage('prepare a scene', {});
  backend.abort();
  connected();
  await pending;
  expect(promptBuilt).toBe(false);
});
