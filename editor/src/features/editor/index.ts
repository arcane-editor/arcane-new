import './styles/better-comments.css';

export { default as EditorPanel } from './components/EditorPanel';
export { default as EditorErrorBoundary } from './components/EditorErrorBoundary';
export { default as Breadcrumbs } from './components/Breadcrumbs';
export async function loadMonacoWorkers(): Promise<void> {
  await import('./services/monaco-workers');
}

export {
  initMonaco,
  getMonaco,
  setupWorkspaceIntelliSense,
  teardownWorkspaceIntelliSense,
} from './services/monaco-init';
export { disposeModelForPath } from './services/model-disposal';
export {
  configureTypeScriptDefaults,
  loadWorkspaceFiles,
  loadTypeDefinitions,
  updateExtraLib,
  disposeExtraLibs,
} from './services/monaco-typescript';
