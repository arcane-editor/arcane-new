/**
 * Re-export shim. The data now lives at `src/data/unity-api-names.ts` so it
 * can be shared with the AI panel's mention picker without cross-feature
 * internal imports.
 */

export {
  UNITY_API_NAMES,
  type UnityApiKind,
  type UnityApiName,
} from '../../../data/unity-api-names';
