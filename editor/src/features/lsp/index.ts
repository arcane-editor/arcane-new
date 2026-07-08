export { LspClient, LspRequestCanceledError } from './services/client';
export { LspManager, lspManager } from './services/manager';
export {
  syncDocumentOpen,
  syncDocumentClose,
  syncDocumentSave,
  syncDocumentChange,
  resetDocumentVersions,
  forgetDocument,
  getOpenDocumentUris,
  fileUri,
} from './services/document-sync';
export { registerLspProviders, attachClientToProviders } from './services/providers';
export {
  requestFileDiagnostics,
  type FileDiag,
  type FileDiagSeverity,
} from './services/diagnostics';
export {
  registerRenamePostProcessor,
  type RenamePostProcessor,
  type RenamePostProcessContext,
} from './services/rename-provider';
export {
  toMonacoRange,
  toLspPosition,
  toLspRange,
  type LspRange,
  type LspPosition,
} from './services/model-context';
export {
  applyLspWorkspaceEdit,
  type AppliedWorkspaceEditSummary,
  type LspWorkspaceEdit,
  type LspTextDocumentEdit,
  type LspTextEdit,
} from './services/workspace-edit';
export {
  registerLocalCodeActionSource,
  type LocalCodeActionSource,
  type LocalCodeAction,
  type LocalCodeActionContext,
} from './services/code-actions';
