export { default as AiChatPanel } from './components/AiChatPanel';
export { default as MaximizedAiOverlay } from './components/MaximizedAiOverlay';
// The design composer's toolbar row reuses the reasoning-level pill rather than
// growing a second control that means the same thing and can disagree with it.
export { default as EffortSelector } from './components/EffortSelector';
export {
  saveSession,
  generateSessionId,
  loadSession,
  loadLatestSession,
  listSessions,
  deleteSession,
  renameSession,
  normalizePlanRestore,
} from './services/session-persistence';
export type { SessionData, SessionSummary, SaveSessionInput, PlanRef } from './services/session-persistence';
export { restoreLatestSessionForWorkspace } from './services/session-restore';
// `getAgentService` alongside `resetAgentService`: the design dock has to seed
// the agent's own message history when it swaps a session in (`resume`), the
// same call `SessionHistory` makes for the same reason.
export { getAgentService, resetAgentService } from './services/agent-service';
// External agents (ACP). `disposeExternalBackends` is exported for App.tsx's
// workspace-change teardown, which must kill an agent pinned to the folder the
// user just left.
export {
  disposeExternalBackends,
  getChatBackend,
  sendChatMessage,
  currentExternalAgentStatus,
} from './services/chat-backend';
export {
  canUseExternalAgents,
  externalAgentStatus,
  type ExternalAgentGate,
  type ExternalAgentStatus,
} from './services/external-agent-gate';
export type { ClaudeConnectState } from './services/claude-connect';
export {
  clearAiPanelDropTarget,
  highlightAiPanelDropTarget,
  isDropOnAiPanel,
} from './services/drop-target';
export { fixConsoleError } from './services/fix-console-error';
export { isAiComposerFocused } from './services/composer-focus';
// The design dock submits through the SAME routing body the composer uses, so
// a design send goes down one code path with every other send rather than
// growing a parallel one that can drift from it.
export { dispatchComposerSend } from './services/composer-dispatch';
// The design log falls back to this for any tool it has no columnar vocabulary
// for, rather than growing a second half-complete label table beside it.
export { humanizeToolCall } from './services/humanize-tool-call';
export type { HumanizedToolCall } from './services/humanize-tool-call';
export { EFFORT_ORDER, cycleEffort, nextEffort, clampEffort, restoreEffort } from './data/effort';
export { planController } from './services/plan-controller';
export { planModeTransition, normalizeLivePlanState, PLAN_PARKED_NOTICE } from './services/mode-transition';
export type { ModeTransitionInput, ModeTransition } from './services/mode-transition';
export { resetWriteApprovalSession } from './services/write-approval-gate';
export type { AskUserOption, AskUserParams } from './services/ask-user-tool';
// Image staging, shared with the design dock's picker, paste and drop paths.
export {
  pickImages,
  imagesFromPaths,
  imageFromBlob,
  imageBlobsFromClipboard,
  isImagePath,
} from './services/image-attach';
export type { ImageAttachment, StagedImages } from './services/image-attach';
// The words an image-only send carries. Shared so the transcript the user reads
// and the prompt the model receives are the same string.
export { promptTextForImages } from './services/attachments';
export { hasPendingQuestion, resolvePendingQuestion } from './services/question-gate';
export { findPendingQuestion } from './services/pending-question';
// The design dock answers a blocked `ask_user` from its own composer, so it
// needs the same routing rule the panel's composer uses — one definition, or
// the two surfaces disagree about what counts as an answer.
export { shouldRouteToQuestion } from './services/question-routing';
export { resolvePendingApproval } from './services/approval-gate';
export type { VerifiedCardData } from './services/verified-pass';
export type { TurnError, TurnErrorKind } from './services/turn-errors';
export type { PromptMode } from './services/prompts';
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
export { coerceEffort, coerceAgentKind } from './services/types';
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
