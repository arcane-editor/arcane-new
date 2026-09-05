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
  pathFromFileUri,
} from './services/document-sync';
export { registerLspProviders, attachClientToProviders } from './services/providers';
export {
  isCsharpProjectLoaded,
  markCsharpProjectLoaded,
  resetCsharpProjectLoaded,
  onCsharpProjectLoaded,
  whenCsharpProjectLoaded,
  CSHARP_READINESS_FAILSAFE_MS,
} from './services/project-readiness';
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
// Project-wide symbol search. Not a Monaco provider — the standalone API has
// no workspace-symbol hook — so the command palette calls this directly.
// `LspTextEdit` is deliberately NOT re-exported here: workspace-edit already
// owns that name in this barrel.
export {
  queryWorkspaceSymbols,
  MIN_SYMBOL_QUERY_LENGTH,
  type WorkspaceSymbolHit,
} from './services/symbol-providers';

// Solution-wide analysis. csharp-ls advertises
// `diagnosticProvider.workspaceDiagnostics`, so this needs no Roslyn host —
// see services/workspace-diagnostics.ts.
export {
  runWorkspaceDiagnostics,
  resetWorkspaceDiagnostics,
  type WorkspaceAnalysisResult,
} from './services/workspace-diagnostics';

// Provisioning the C# server itself, so the user never runs
// `dotnet tool install -g csharp-ls` by hand — see services/csharp-ls-provision.ts.
export {
  ensureCsharpLs,
  resetCsharpLsProvisioning,
  describeProvisionFailure,
  describeDotnetBlock,
  type CsharpLsStatus,
  type CsharpLsSource,
  type CsharpLsInstallError,
  type DotnetBlock,
  type DotnetBlockReason,
  type EnsureResult,
} from './services/csharp-ls-provision';
