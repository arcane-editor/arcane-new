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
export { computeUnityDecorations } from './services/csharp-decorations';
export type { UnityDecoration, UnityDecorationKind } from './services/csharp-decorations';
export { UNITY_LIFECYCLE_METHODS, LIFECYCLE_METHOD_NAMES } from './services/lifecycle-db';