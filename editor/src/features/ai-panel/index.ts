export { default as AiChatPanel } from './components/AiChatPanel';
export { default as MaximizedAiOverlay } from './components/MaximizedAiOverlay';
export {
  saveSession,
  generateSessionId,
  loadSession,
  loadLatestSession,
  listSessions,
  deleteSession,
  renameSession,
} from './services/session-persistence';
export type { SessionData, SessionSummary, SaveSessionInput } from './services/session-persistence';
export { restoreLatestSessionForWorkspace } from './services/session-restore';
export { fixConsoleError } from './services/fix-console-error';
export { resetWriteApprovalSession } from './services/write-approval-gate';
export type { VerifiedCardData } from './services/verified-pass';
export { summarizeSceneDiff } from './services/summarize-scene-diff';
export { computeRestorePlan, getSkippedTooLargePaths } from './services/checkpoints/restore-plan';
export type {
  CheckpointEntry,
  CheckpointTurn,
  RestorePlanEntry,
} from './services/checkpoints/restore-plan';
export { saveCheckpoints, loadCheckpoints } from './services/checkpoints/checkpoint-store-io';
export { runRestorePlan, filterAppliedRestoreEntries } from './services/checkpoints/apply-restore';
export type { ApplyRestoreDeps, ApplyRestoreOutcome } from './services/checkpoints/apply-restore';
export type {
  AgentKind,
  Attachment,
  ChatMode,
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
  Effort,
} from './services/types';
export type {
  AgentEvent,
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  AgentTool,
  AgentToolResult,
} from './services/vendor/types';
