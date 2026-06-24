import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, languages, Position, Uri as MonacoUri, IDisposable } from 'monaco-editor';
import { useProjectContextStore } from '../../../stores/project-context';
import { useWorkspaceStore } from '../../../stores/workspace';
import { classifyFile, FilePriority } from '../../csharp';
import { useSceneUsageStore, readScriptGuid, type AssetUsageEntry } from '../../unity-context';

function modelUriToAbsPath(uri: MonacoUri): string | null {
  if (uri.scheme !== 'file') return null;
  try {
    return decodeURIComponent(uri.path);
  } catch {
    return uri.path;
  }
}

function basenameWithoutExt(absPath: string): string {
  const base = absPath.split('/').pop() ?? absPath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function isMonoBehaviourFile(absPath: string): boolean {
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!useProjectContextStore.getState().isUnityProject) return false;
  if (!ws) return false;
  const prefix = ws.endsWith('/') ? ws : ws + '/';
  if (!absPath.startsWith(prefix)) return false;
  const rel = absPath.slice(prefix.length);
  return classifyFile(rel) === FilePriority.MonoBehaviour;
}

function formatFooter(entries: AssetUsageEntry[]): string {
  const scenes = entries.filter((e) => e.kind === 'scene').length;
  const prefabs = entries.filter((e) => e.kind === 'prefab').length;
  if (scenes === 0 && prefabs === 0) {
    return '_Not used in any scenes or prefabs_';
  }
  const parts: string[] = [];
  if (scenes > 0) parts.push(`**${scenes}** ${scenes === 1 ? 'scene' : 'scenes'}`);
  if (prefabs > 0) parts.push(`**${prefabs}** ${prefabs === 1 ? 'prefab' : 'prefabs'}`);
  return `Used in ${parts.join(' • ')} · [view](command:unity.openAssetUsagePanel)`;
}

class UsageHoverProvider implements languages.HoverProvider {
  async provideHover(
    model: MonacoEditorNs.ITextModel,
    position: Position,
  ): Promise<languages.Hover | null> {
    const absPath = modelUriToAbsPath(model.uri);
    if (!absPath || !isMonoBehaviourFile(absPath)) return null;

    const wordAtPos = model.getWordAtPosition(position);
    if (!wordAtPos) return null;

    const className = basenameWithoutExt(absPath);
    if (wordAtPos.word !== className) return null;

    const ws = useWorkspaceStore.getState().workspacePath;
    if (!ws) return null;

    const guid = await readScriptGuid(absPath);
    if (!guid) return null;

    let entries = useSceneUsageStore.getState().getUsages(guid);
    if (!entries) {
      entries = await useSceneUsageStore.getState().ensureUsagesForFile(absPath, ws);
    }

    return {
      contents: [
        {
          value: formatFooter(entries),
          isTrusted: true,
        },
      ],
      range: {
        startLineNumber: position.lineNumber,
        startColumn: wordAtPos.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: wordAtPos.endColumn,
      },
    };
  }
}

let registered = false;

export function registerUsageHoverProvider(monaco: Monaco): IDisposable {
  if (registered) return { dispose: () => {} };
  registered = true;
  const reg = monaco.languages.registerHoverProvider('csharp', new UsageHoverProvider());
  return {
    dispose: () => {
      reg.dispose();
      registered = false;
    },
  };
}
