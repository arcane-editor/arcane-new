// Version-matched Unity docs on hover (F-10 T10.2). Hovering a UnityEngine API
// symbol in C# shows a link to docs.unity3d.com for THIS project's Unity
// major.minor (not "latest"), backed by the shared version-matched docs index.

import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, languages, Position, IDisposable } from 'monaco-editor';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { lookupUnityDocs, unityMajorMinor } from '../../../data/unity-docs-index';

function enabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.docs.versionMatchedHover') !== false
  );
}

class UnityDocsHoverProvider implements languages.HoverProvider {
  provideHover(
    model: MonacoEditorNs.ITextModel,
    position: Position,
  ): languages.Hover | null {
    if (!enabled()) return null;
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    const symbol = word.word;
    // Types/members are PascalCase — skip locals/keywords cheaply.
    if (!/^[A-Z]/.test(symbol)) return null;

    const version = useProjectContextStore.getState().unityVersion;
    const hits = lookupUnityDocs(symbol, version, 1);
    const hit = hits[0];
    if (!hit) return null;

    // Require a precise match: the hovered word equals the entry name or its
    // last segment (member). Avoids fuzzy false-positives on plain identifiers.
    const last = hit.name.split('.').pop();
    if (hit.name !== symbol && last !== symbol) return null;

    const mm = unityMajorMinor(version);
    return {
      range: {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      },
      contents: [
        { value: `**${hit.name}** · _${hit.category}_` },
        {
          value: `[Unity Scripting Reference${mm ? ` (${mm})` : ''}](${hit.url})`,
          isTrusted: true,
        },
      ],
    };
  }
}

let registered = false;

/**
 * Register the version-matched Unity docs hover for C#. Idempotent; self-gates on
 * isUnityProject + the `unity.docs.versionMatchedHover` setting. Call once where
 * the other Unity Monaco providers are wired (EditorPanel.beforeMount).
 */
export function registerUnityDocsHover(monaco: Monaco): IDisposable {
  if (registered) return { dispose: () => {} };
  registered = true;
  const reg = monaco.languages.registerHoverProvider('csharp', new UnityDocsHoverProvider());
  return {
    dispose: () => {
      reg.dispose();
      registered = false;
    },
  };
}
