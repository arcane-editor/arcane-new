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
  markCsharpProjectLoading,
  resetCsharpProjectLoaded,
  onCsharpProjectLoaded,
  whenCsharpProjectLoaded,
  CSHARP_READINESS_FAILSAFE_MS,
} from './services/project-readiness';
export {
  isLoadStartedMessage,
  isLoadFinishedMessage,
} from './services/csharp-ls-log-markers';
export {
  setRoslynAnalyzersInjected,
  roslynAnalyzersInjected,
  roslynAnalyzersReporting,
} from './services/roslyn-analyzers-state';
export {
  requestFileDiagnostics,
  type FileDiag,
  type FileDiagSeverity,
} from './services/diagnostics';
// Find Usages. The provider in providers.ts feeds Monaco's peek widget and
// keeps nothing, so the panel has to be able to ask for itself.
export {
  queryReferences,
  NoLanguageServerError,
  type ReferenceHit,
} from './services/references';

// Format-on-save. Goes to the server for a NAMED path rather than running
// Monaco's format action on whatever editor happens to be focused.
export { formatDocumentBeforeSave } from './services/format-on-save';
export {
  registerRenamePostProcessor,
  type RenamePostProcessor,
  type RenamePostProcessContext,
} from './services/rename-provider';
export {
  toMonacoRange,
  toLspPosition,
  toLspRange,
  lspDocumentUri,
  modelFilePath,
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
