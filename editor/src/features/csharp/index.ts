import './styles/unity-decorations.css';

export { default as DotnetMissingModal } from './components/DotnetMissingModal';
export { NewScriptModal } from './components/NewScriptModal';
export {
  SCRIPT_TEMPLATES,
  renderTemplate,
  validateClassName,
  suggestPascalCase,
  type ScriptTemplateKind,
  type ScriptTemplateMeta,
} from './data/templates';
export { offerClassRenameSync } from './services/class-rename-sync';
export { classifyFile, sortFilesByPriority, FilePriority } from './services/FileClassifier';
export {
  attachUnityDecorations,
  disposeUnityDecorations,
  computeUnityDecorations,
} from './services/csharp-decorations';
export type { UnityDecoration, UnityDecorationKind } from './services/csharp-decorations';
// The table itself lives in `src/data/unity-messages.ts` — shared data, not
// a csharp-feature internal. Re-exported here so existing consumers of this
// barrel are unaffected.
export { UNITY_LIFECYCLE_METHODS, LIFECYCLE_METHOD_NAMES } from '../../data/unity-messages';