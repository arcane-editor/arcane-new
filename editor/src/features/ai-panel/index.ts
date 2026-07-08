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
export type { VerifiedCardData } from './services/verified-pass';
export { summarizeSceneDiff } from './services/summarize-scene-diff';
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
