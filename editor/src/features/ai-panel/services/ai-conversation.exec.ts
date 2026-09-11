import { it, expect, mock } from 'bun:test';

/** Isolated regression: real UI/store/service code, mocked OS boundaries. */
import * as realCore from '@tauri-apps/api/core';
import * as realWebviewWindow from '@tauri-apps/api/webviewWindow';
import * as realWindow from '@tauri-apps/api/window';

mock.module('@tauri-apps/api/core', () => ({ ...realCore, invoke: async () => [] }));
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


import * as realVerified from '../../../features/ai-panel/services/verified-pass.ts';
let finishVerify!: (value:any)=>void;
mock.module('../../../features/ai-panel/services/verified-pass.ts',()=>({
 ...realVerified, touchedFileCount:()=>1,runVerifiedPass:()=>new Promise(resolve=>{finishVerify=resolve;}),
}));
const { useWorkspaceStore } = await import('../../../stores/workspace.ts');
const { useSettingsStore } = await import('../../../stores/settings.ts');
const { useProjectContextStore } = await import('../../../stores/project-context.ts');
const { useAiStore } = await import('../../../stores/ai.ts');
const { AgentService } = await import('../../../features/ai-panel/services/agent-service.ts');
it('New Chat cancels verification and refuses the old card', async () => {
  useProjectContextStore.setState({isUnityProject:true});
  useWorkspaceStore.setState({workspacePath:'/ws'});
  useSettingsStore.setState({settings:{...useSettingsStore.getState().settings,'unity.verifiedPass.enabled':true,'unity.consoleCheck.enabled':false}});
  useAiStore.setState({messages:[],sessionId:'old-session'});
  // No model calls: exercise the real lifecycle methods with a deferred verification boundary.
  const service = new AgentService() as any;
  const checking=service.runClosingChecks('agent');
  expect(typeof finishVerify).toBe('function');
  useAiStore.getState().resetConversation();
  // Store replacement itself must dispose the service, even before a new send.
  expect(service.wasLastSendAborted()).toBe(true);
  useAiStore.setState({sessionId:'new-session',messages:[]});
  finishVerify({files:1,touchedFiles:['Assets/OldSession.cs'],compile:'clean',analyzers:'skipped',guids:'skipped',uiToolkit:'skipped',scriptableObjects:'skipped',input:'skipped',layout:'skipped',console:'skipped',tests:'skipped'});
  await checking;
  expect(useAiStore.getState().sessionId).toBe('new-session');
  expect(useAiStore.getState().messages).toHaveLength(0);
  expect(service.closingAbort.signal.aborted).toBe(true);

});
