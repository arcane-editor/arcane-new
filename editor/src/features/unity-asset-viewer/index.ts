// Structured Unity asset viewer (F-3.2 T7.2). Renders scenes/prefabs/.asset/.mat
// as a navigable tree via the Rust `unity_parse_asset` parser, with a raw/edit
// fallback handled by the editor host.
export { AssetViewer } from './components/AssetViewer';
export { InputActionsViewer, isInputActionsFile } from './components/InputActionsViewer';
export { isUnityAssetFile } from './services/asset-model';

// Semantic scene/prefab git-diff viewer (P6.2), driven by the Rust
// `unity_scene_diff` diff engine (P6.1). `EditorPanel`/`workspace` import
// ONLY through this barrel per the deep-modules rule.
export { SceneDiffViewer } from './components/SceneDiffViewer';
export {
  formatSceneDiffForPrompt,
  formatDiffSummaryLine,
  summarizeDiffCounts,
} from './services/scene-diff-model';
export type {
  SceneDiff,
  ObjectDiff,
  ObjectDiffStatus,
  ComponentDiff,
  ComponentDiffStatus,
  PropertyDiff,
  SubtreeSummary,
  PrefabOverrideDiff,
  PrefabOverrideStatus,
  DiffSummary,
} from './services/scene-diff-model';
