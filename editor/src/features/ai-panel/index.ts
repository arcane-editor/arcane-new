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
export type { SessionData, SessionSummary, SaveSessionInput, PlanRef } from './services/session-persistence';
export { restoreLatestSessionForWorkspace } from './services/session-restore';
export { fixConsoleError } from './services/fix-console-error';
export { planController } from './services/plan-controller';
export { resetWriteApprovalSession } from './services/write-approval-gate';
export type { AskUserOption, AskUserParams } from './services/ask-user-tool';
export { resolvePendingQuestion } from './services/question-gate';
export type { VerifiedCardData } from './services/verified-pass';
export type { TurnError, TurnErrorKind } from './services/turn-errors';
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
export { decideRevertOutcome } from './services/checkpoints/revert-outcome';
export type { RevertOutcome } from './services/checkpoints/revert-outcome';
export {
  clearReviewPaths,
  listPending,
  registerForActiveTurn,
  markRejectFailed,
} from './services/edit-review/review-core';
export type { PendingReviewEntry } from './services/edit-review/review-core';
export { saveReviews, loadReviews } from './services/edit-review/review-store-io';
export type {
  AgentKind,
  Attachment,
  ChatMode,
  Effort,
} from './services/types';
export { coerceEffort } from './services/types';
export type {
  AgentEvent,
  AssistantMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  AgentTool,
  AgentToolResult,
} from './services/vendor/types';
// NOTE: `createUpdateCoalescer` deliberately does NOT live here. It is a pure,
// dependency-free timing utility, and re-exporting it through this barrel made
// it part of a cycle that broke app startup outright — see
// src/utils/update-coalescer.ts. Import it from '../utils/update-coalescer'.
