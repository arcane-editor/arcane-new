export { default as SceneContextPanel } from './components/SceneContextPanel';
export { default as SceneUsagePanel } from './components/SceneUsagePanel';
export { parseSceneFile, parseScriptableObjectAsset } from './services/scene-parser';
export { resolveGuid, resolveAssetPath, scanMetaFiles } from './services/guid-resolver';
export {
  findAssetUsages,
  findInstanceUsages,
  readScriptGuid,
  type AssetKind,
  type AssetUsageEntry,
  type SceneGameObjectRef,
  type SceneFieldRef,
} from './services/scene-usage-finder';
export { useSceneUsageStore } from './stores/scene-usage';
export { initUsageCodeLens } from './services/usage-codelens';

// Cache-invalidation policy, shared with anything that writes a Unity asset:
// call `noteSelfWrittenAsset` immediately BEFORE writing so the watcher event
// it produces does not blow away the usage caches.
export {
  noteSelfWrittenAsset,
  shouldInvalidate,
  SELF_WRITE_SUPPRESSION_MS,
} from './services/usage-invalidation';

// `readScriptGuid` reads any `<abs>.meta` guid, not just a script's — aliased
// so a caller asking for an .asset's own guid reads sensibly at the call site.
export { readScriptGuid as readAssetMetaGuid } from './services/scene-usage-finder';
