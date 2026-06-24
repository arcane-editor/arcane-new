import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { useProjectContextStore } from '../../../../stores/project-context';
import { lookupUnityDocs, unityMajorMinor } from '../../../../data/unity-docs-index';
import { txt } from './shared';

const docsSchema = Type.Object({
  symbol: Type.String({ description: 'Unity API symbol, e.g. "Rigidbody.AddForce" or "Transform".' }),
});

/**
 * get_unity_docs (F-5.2) — version-matched Unity Scripting Reference lookup.
 * Offline + deterministic: constructs the docs URL for the project's Unity
 * major.minor from a local index; no network call.
 */
export function createGetUnityDocsTool(): AgentTool {
  return {
    name: 'get_unity_docs',
    label: 'get unity docs',
    description:
      "Look up the Unity Scripting Reference URL for an API symbol, matched to THIS project's Unity version (not 'latest'). Use to confirm an API exists / cite the correct versioned docs.",
    parameters: docsSchema,
    async execute(_id, params) {
      const { symbol } = params as Static<typeof docsSchema>;
      const version = useProjectContextStore.getState().unityVersion;
      const mm = unityMajorMinor(version);
      const hits = lookupUnityDocs(symbol, version, 3);
      const header = `Docs matched to Unity ${mm ?? '(version unknown — using latest)'}:`;
      if (hits.length === 0) {
        return txt(
          `${header}\nNo exact match for "${symbol}" in the local index. ` +
            `Try the full type/member name (e.g. "Rigidbody.AddForce").`,
        );
      }
      const body = hits.map((h) => `• ${h.name} [${h.category}] — ${h.url}`).join('\n');
      return txt(`${header}\n${body}`);
    },
  };
}
