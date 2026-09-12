// ── "N instances" CodeLens on a ScriptableObject class ──────────────────────
//
// One lens, on the class declaration, and a click that opens the Inspector's
// Instances tab.
//
// Deliberately NOT per-field. A per-field stat line ("6.8 – 88.0 · median 12.8")
// needs every instance READ, which is O(instances × file size) — and
// `provideCodeLenses` re-runs on every model change. `usage-codelens.ts`
// documents that exact trap from experience: uncached, a common MonoBehaviour
// meant re-parsing hundreds of assets on each keystroke. When per-field stats
// arrive they should come from one aggregate Rust command, off the main thread,
// not from a TypeScript fan-out that would then have to be replaced.

import type { Monaco } from '@monaco-editor/react';
import type { IDisposable, languages } from 'monaco-editor';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUiStore } from '../../../stores/ui';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUnityIndexStore } from '../../../stores/unity-index';
import { classifyFile, FilePriority } from '../../csharp';
import { buildSoSchema, scanCSharp, offsetToLineCol } from '../../unity-analyzers';
import { readAssetMetaGuid, useSceneUsageStore } from '../../unity-context';

const COMMAND_ID = 'unity.showScriptableObjectInstances';
const SETTING_KEY = 'unity.codeLens.scriptableObjectInstances';

/** guid → instance count, invalidated whenever the GUID index changes. */
const countCache = new Map<string, number>();
let indexGeneration = 0;

function isEnabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting(SETTING_KEY) === true
  );
}

/**
 * Monaco model URIs are `file://…`; the stores speak absolute paths.
 * Duplicated locally rather than widening another feature's barrel for six
 * lines — the same call this codebase already makes elsewhere.
 */
function modelUriToAbsPath(uri: { path?: string; fsPath?: string }): string | null {
  const raw = uri.fsPath ?? uri.path;
  if (!raw) return null;
  return decodeURIComponent(raw);
}

async function instanceCount(scriptAbsPath: string): Promise<number> {
  const guid = await readAssetMetaGuid(scriptAbsPath);
  if (!guid) return 0;
  const cached = countCache.get(guid);
  if (cached !== undefined) return cached;
  const hits = await useUnityIndexStore.getState().findReferences(guid);
  const count = hits.filter((h) => h.path.toLowerCase().endsWith('.asset')).length;
  countCache.set(guid, count);
  return count;
}

/** Open the Inspector on the Instances tab for this script. */
function showInstances(scriptAbsPath: string): void {
  const ui = useUiStore.getState();
  ui.setActiveRightSidebarView('unity-inspector');
  ui.setRightSidebarVisible(true);
  const ws = useWorkspaceStore.getState().workspacePath;
  if (ws) void useSceneUsageStore.getState().loadForScript(scriptAbsPath, ws);
}

class SoInstanceCodeLensProvider implements languages.CodeLensProvider {
  // Monaco types `onDidChange` as an Event with a shape we do not need to name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDidChange: any;
  private disposers: Array<() => void> = [];

  constructor(monaco: Monaco) {
    const emitter = new monaco.Emitter<SoInstanceCodeLensProvider>();
    this.onDidChange = emitter.event;

    // Two triggers, not one: `status` covers a full (re)build, `indexRevision`
    // covers incremental deltas which leave status untouched. Watching only one
    // leaves the count stale until restart.
    let lastStatus = useUnityIndexStore.getState().status;
    let lastRevision = useUnityIndexStore.getState().indexRevision;
    this.disposers.push(
      useUnityIndexStore.subscribe((state) => {
        const rebuilt = state.status !== lastStatus && state.status === 'ready';
        const delta = state.indexRevision !== lastRevision;
        lastStatus = state.status;
        lastRevision = state.indexRevision;
        if (!rebuilt && !delta) return;
        indexGeneration += 1;
        countCache.clear();
        emitter.fire(this);
      }),
    );

    let lastSetting = useSettingsStore.getState().getSetting(SETTING_KEY);
    this.disposers.push(
      useSettingsStore.subscribe((state) => {
        const next = state.settings[SETTING_KEY];
        if (next !== lastSetting) {
          lastSetting = next as boolean;
          emitter.fire(this);
        }
      }),
    );
  }

  async provideCodeLenses(
    model: Parameters<languages.CodeLensProvider['provideCodeLenses']>[0],
  ): Promise<languages.CodeLensList> {
    const empty: languages.CodeLensList = { lenses: [], dispose: () => {} };
    if (!isEnabled()) return empty;

    const abs = modelUriToAbsPath(model.uri);
    if (!abs || !abs.toLowerCase().endsWith('.cs')) return empty;

    const ws = useWorkspaceStore.getState().workspacePath;
    if (!ws) return empty;
    const prefix = ws.endsWith('/') ? ws : ws + '/';
    if (!abs.startsWith(prefix)) return empty;
    if (classifyFile(abs.slice(prefix.length)) !== FilePriority.MonoBehaviour) return empty;

    const scan = scanCSharp(model.getValue());
    const schema = buildSoSchema(scan);
    if (!schema) return empty;

    const cls = scan.classes.find((c) => c.name === schema.className);
    if (!cls) return empty;

    const count = await instanceCount(abs);
    // The base check is syntactic; instances on disk prove the type where it
    // cannot. Either is enough, but a class with neither gets no lens.
    if (schema.baseKind !== 'scriptableObject' && count === 0) return empty;
    // An empty title means no lens — this codebase's quiet-gutter convention.
    if (count === 0) return empty;

    const { line } = offsetToLineCol(scan.lineStarts, cls.nameOffset);
    const lineNumber = line + 1;

    return {
      lenses: [
        {
          range: {
            startLineNumber: lineNumber,
            startColumn: 1,
            endLineNumber: lineNumber,
            endColumn: 1,
          },
          id: `so-instances-${schema.className}-${indexGeneration}`,
          command: {
            id: COMMAND_ID,
            title: `${count} ${count === 1 ? 'instance' : 'instances'}`,
            arguments: [abs],
          },
        },
      ],
      dispose: () => {},
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

let commandRegistered = false;
let providerRegistered = false;

/**
 * Register the "N instances" CodeLens for C# files. Idempotent, and self-gating
 * per request on `isUnityProject` plus its setting.
 */
export function initSoInstanceCodeLens(monaco: Monaco): IDisposable {
  if (!commandRegistered) {
    monaco.editor.registerCommand(COMMAND_ID, (_accessor: unknown, scriptAbsPath?: string) => {
      const path = scriptAbsPath ?? useWorkspaceStore.getState().activeFilePath;
      if (path) showInstances(path);
    });
    commandRegistered = true;
  }
  if (providerRegistered) return { dispose: () => {} };
  providerRegistered = true;
  const provider = new SoInstanceCodeLensProvider(monaco);
  const reg = monaco.languages.registerCodeLensProvider('csharp', provider);
  return {
    dispose: () => {
      provider.dispose();
      reg.dispose();
      providerRegistered = false;
    },
  };
}
