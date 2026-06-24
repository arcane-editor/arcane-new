import type { Monaco } from '@monaco-editor/react';
import type {
  editor as MonacoEditorNs,
  languages,
  IDisposable,
  Uri as MonacoUri,
} from 'monaco-editor';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { useTestStore } from '../stores/test-store';

const RUN_CMD = 'unity.test.runOne';
const DEBUG_CMD = 'unity.test.debugOne';

function modelUriToAbsPath(uri: MonacoUri): string | null {
  if (uri.scheme !== 'file') return null;
  try {
    return decodeURIComponent(uri.path);
  } catch {
    return uri.path;
  }
}

function enabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.testRunner.enabled') !== false
  );
}

class TestCodeLensProvider implements languages.CodeLensProvider {
  // Monaco types onDidChange as IEvent<this>; the Emitter's event is invariant,
  // so we widen to `any` (same as usage-codelens) to satisfy the interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDidChange: any;
  private disposers: Array<() => void> = [];

  constructor(monaco: Monaco) {
    const emitter = new monaco.Emitter<TestCodeLensProvider>();
    this.onDidChange = emitter.event;
    // Re-request lenses when discovery results / run results change.
    const unsub = useTestStore.subscribe(() => emitter.fire(this));
    this.disposers.push(unsub, () => emitter.dispose());
  }

  provideCodeLenses(model: MonacoEditorNs.ITextModel): languages.CodeLensList {
    const empty: languages.CodeLensList = { lenses: [], dispose: () => {} };
    if (!enabled()) return empty;
    const abs = modelUriToAbsPath(model.uri);
    if (!abs) return empty;

    const lenses: languages.CodeLens[] = [];
    for (const asm of useTestStore.getState().assemblies) {
      for (const fx of asm.fixtures) {
        for (const t of fx.tests) {
          if (t.filePath !== abs) continue;
          const range = {
            startLineNumber: t.line,
            startColumn: 1,
            endLineNumber: t.line,
            endColumn: 1,
          };
          lenses.push({
            range,
            id: `test-run-${t.id}`,
            command: { id: RUN_CMD, title: '▶ Run', arguments: [t.fullName, t.mode] },
          });
          lenses.push({
            range,
            id: `test-debug-${t.id}`,
            command: { id: DEBUG_CMD, title: 'Debug', arguments: [t.fullName, t.mode] },
          });
        }
      }
    }
    return { lenses, dispose: () => {} };
  }

  resolveCodeLens(_model: MonacoEditorNs.ITextModel, codeLens: languages.CodeLens) {
    return codeLens;
  }

  dispose() {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

let commandRegistered = false;
let providerRegistered = false;

/**
 * Register the "Run | Debug" CodeLens above Unity test methods (F-8). Reuses the
 * discovery data in useTestStore — no extra parsing. Idempotent; self-gates on
 * isUnityProject + the testRunner setting. Call once where the other Unity
 * Monaco providers are wired.
 */
export function initTestCodeLens(monaco: Monaco): IDisposable {
  if (!commandRegistered) {
    monaco.editor.registerCommand(RUN_CMD, (_a: unknown, fullName?: string, mode?: string) => {
      if (fullName) useTestStore.getState().runFiltered(fullName, mode === 'PlayMode' ? 'PlayMode' : 'EditMode');
    });
    monaco.editor.registerCommand(DEBUG_CMD, (_a: unknown, fullName?: string, mode?: string) => {
      if (fullName) useTestStore.getState().debugTest(fullName, mode === 'PlayMode' ? 'PlayMode' : 'EditMode');
    });
    commandRegistered = true;
  }
  if (providerRegistered) return { dispose: () => {} };
  providerRegistered = true;
  const provider = new TestCodeLensProvider(monaco);
  const reg = monaco.languages.registerCodeLensProvider('csharp', provider);
  return {
    dispose: () => {
      provider.dispose();
      reg.dispose();
      providerRegistered = false;
    },
  };
}
