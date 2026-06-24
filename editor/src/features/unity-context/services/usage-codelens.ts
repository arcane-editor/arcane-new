import type { Monaco } from '@monaco-editor/react';
import type {
  editor as MonacoEditorNs,
  languages,
  IDisposable,
  Uri as MonacoUri,
} from 'monaco-editor';
import { useProjectContextStore } from '../../../stores/project-context';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useSettingsStore } from '../../../stores/settings';
import { useUiStore } from '../../../stores/ui';
import { useUnityIndexStore } from '../../../stores/unity-index';
import { classifyFile, FilePriority } from '../../csharp';
import { useSceneUsageStore } from '../stores/scene-usage';
import { readScriptGuid } from './scene-usage-finder';

const COMMAND_ID = 'unity.showAssetUsagesForScript';
// Back-compat alias: the usage *hover* links to this no-arg command to open the
// panel for the active script. Registered here so the hover keeps working.
const OPEN_PANEL_COMMAND_ID = 'unity.openAssetUsagePanel';

// First top-level `class` declaration. Optional modifiers (any order, repeated)
// precede `class`; we only need the line, not a full parse.
const CLASS_DECL_REGEX =
  /^\s*(?:public\s+|internal\s+|sealed\s+|abstract\s+|partial\s+|static\s+|private\s+|protected\s+)*class\s+\w+/;

/** Reference counts for a guid, bucketed by referencing-asset kind. */
interface UsageCounts {
  scenes: number;
  prefabs: number;
  scriptableObjects: number;
}

// ── per-guid cache, invalidated when the index changes ──────────────────────
// CodeLens refreshes fire often (scroll, edit, focus). We must NOT invoke the
// Rust index on every refresh — so results are cached by guid and only
// recomputed when the index generation bumps (a fresh build/delta completed).
const cache = new Map<string, { gen: number; counts: UsageCounts }>();
const inflight = new Map<string, Promise<UsageCounts>>();
let indexGeneration = 0;

function modelUriToAbsPath(uri: MonacoUri): string | null {
  if (uri.scheme !== 'file') return null;
  try {
    return decodeURIComponent(uri.path);
  } catch {
    return uri.path;
  }
}

function isEnabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.codeLens.assetUsages') === true
  );
}

function isMonoBehaviourFile(absPath: string): boolean {
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!ws) return false;
  const prefix = ws.endsWith('/') ? ws : ws + '/';
  if (!absPath.startsWith(prefix)) return false;
  const rel = absPath.slice(prefix.length);
  return classifyFile(rel) === FilePriority.MonoBehaviour;
}

function classifyHit(path: string): keyof UsageCounts | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.unity')) return 'scenes';
  if (lower.endsWith('.prefab')) return 'prefabs';
  if (lower.endsWith('.asset')) return 'scriptableObjects';
  return null;
}

/** Resolve usage counts for a guid, served from cache when the index is unchanged. */
async function getCounts(guid: string): Promise<UsageCounts> {
  const cached = cache.get(guid);
  if (cached && cached.gen === indexGeneration) return cached.counts;

  const existing = inflight.get(guid);
  if (existing) return existing;

  const gen = indexGeneration;
  const promise = (async () => {
    const hits = await useUnityIndexStore.getState().findReferences(guid);
    const counts: UsageCounts = { scenes: 0, prefabs: 0, scriptableObjects: 0 };
    for (const hit of hits) {
      const bucket = classifyHit(hit.path);
      if (bucket) counts[bucket] += 1;
    }
    cache.set(guid, { gen, counts });
    return counts;
  })();

  inflight.set(guid, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(guid);
  }
}

/** "Used in 3 prefabs, 2 scenes" — pluralized, zero-kinds omitted, '' when total 0. */
function formatTitle(counts: UsageCounts): string {
  const parts: string[] = [];
  if (counts.prefabs > 0) {
    parts.push(`${counts.prefabs} ${counts.prefabs === 1 ? 'prefab' : 'prefabs'}`);
  }
  if (counts.scenes > 0) {
    parts.push(`${counts.scenes} ${counts.scenes === 1 ? 'scene' : 'scenes'}`);
  }
  if (counts.scriptableObjects > 0) {
    parts.push(
      `${counts.scriptableObjects} ${counts.scriptableObjects === 1 ? 'asset' : 'assets'}`,
    );
  }
  if (parts.length === 0) return '';
  return `Used in ${parts.join(', ')}`;
}

class UsageCodeLensProvider implements languages.CodeLensProvider {
  // Monaco's CodeLensProvider exposes onDidChange as an Event; the Emitter's
  // .event has a structural type we don't need to name precisely here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDidChange: any;
  private disposers: Array<() => void> = [];

  constructor(monaco: Monaco) {
    const emitter = new monaco.Emitter<UsageCodeLensProvider>();
    this.onDidChange = emitter.event;

    // Recompute lenses when the index finishes (re)building: bump the cache
    // generation so getCounts() refetches, then ask Monaco to re-request.
    let lastStatus = useUnityIndexStore.getState().status;
    const unsubIndex = useUnityIndexStore.subscribe((state) => {
      if (state.status === lastStatus) return;
      lastStatus = state.status;
      if (state.status === 'ready') {
        indexGeneration += 1;
        emitter.fire(this);
      }
    });
    this.disposers.push(unsubIndex);

    // Toggling the setting on/off should add/remove the lens immediately.
    let lastSetting = useSettingsStore.getState().getSetting('unity.codeLens.assetUsages');
    const unsubSettings = useSettingsStore.subscribe((state) => {
      const next = state.settings['unity.codeLens.assetUsages'];
      if (next !== lastSetting) {
        lastSetting = next;
        emitter.fire(this);
      }
    });
    this.disposers.push(unsubSettings);
  }

  dispose() {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  async provideCodeLenses(
    model: MonacoEditorNs.ITextModel,
  ): Promise<languages.CodeLensList> {
    const empty: languages.CodeLensList = { lenses: [], dispose: () => {} };
    if (!isEnabled()) return empty;

    const absPath = modelUriToAbsPath(model.uri);
    if (!absPath || !isMonoBehaviourFile(absPath)) return empty;

    // Locate the first top-level class declaration.
    const lineCount = model.getLineCount();
    let classLine = 0;
    for (let line = 1; line <= lineCount; line++) {
      if (CLASS_DECL_REGEX.test(model.getLineContent(line))) {
        classLine = line;
        break;
      }
    }
    if (classLine === 0) return empty;

    const guid = await readScriptGuid(absPath);
    if (!guid) return empty;

    const counts = await getCounts(guid);
    const title = formatTitle(counts);
    // Default: show nothing when the script isn't referenced anywhere, to keep
    // the gutter quiet.
    if (!title) return empty;

    const range = {
      startLineNumber: classLine,
      startColumn: 1,
      endLineNumber: classLine,
      endColumn: 1,
    };
    return {
      lenses: [
        {
          range,
          id: `unity-asset-usage-${guid}`,
          command: {
            id: COMMAND_ID,
            title,
            arguments: [absPath],
          },
        },
      ],
      dispose: () => {},
    };
  }

  resolveCodeLens(_model: MonacoEditorNs.ITextModel, codeLens: languages.CodeLens) {
    return codeLens;
  }
}

/** Open the Asset Usage panel and load references for `scriptAbsPath`. */
function showUsagesForScript(scriptAbsPath: string): void {
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!ws) return;
  const ui = useUiStore.getState();
  ui.setActiveRightSidebarView('unity-inspector');
  ui.setRightSidebarVisible(true);
  void useSceneUsageStore.getState().loadForScript(scriptAbsPath, ws);
}

let commandRegistered = false;
let providerRegistered = false;

/**
 * Register the Unity "asset usages" CodeLens for C# files. Idempotent. The
 * provider self-gates per request on `isUnityProject` + the
 * `unity.codeLens.assetUsages` setting, so it is inert for non-Unity projects
 * and when the user disables the lens. Call once where the other Unity Monaco
 * providers are wired (App mount).
 */
export function initUsageCodeLens(monaco: Monaco): IDisposable {
  if (!commandRegistered) {
    monaco.editor.registerCommand(COMMAND_ID, (_accessor: unknown, scriptAbsPath?: string) => {
      const path = scriptAbsPath ?? useWorkspaceStore.getState().activeFilePath;
      if (path) showUsagesForScript(path);
    });
    // No-arg alias used by the usage hover's "view" link → active file.
    monaco.editor.registerCommand(OPEN_PANEL_COMMAND_ID, () => {
      const path = useWorkspaceStore.getState().activeFilePath;
      if (path) showUsagesForScript(path);
    });
    commandRegistered = true;
  }
  if (providerRegistered) return { dispose: () => {} };
  providerRegistered = true;
  const provider = new UsageCodeLensProvider(monaco);
  const reg = monaco.languages.registerCodeLensProvider('csharp', provider);
  return {
    dispose: () => {
      provider.dispose();
      reg.dispose();
      providerRegistered = false;
    },
  };
}
