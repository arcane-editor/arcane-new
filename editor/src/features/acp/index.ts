/**
 * Agent Client Protocol (ACP) — transport for external coding agents.
 *
 * This feature owns the protocol and the process, and nothing else: it does not
 * import the AI store, the chat UI, or anything from `features/ai-panel`. That
 * one-way dependency (`ai-panel -> acp -> stores/utils`) is deliberate — a
 * mutual barrel import between two features is what broke app startup before
 * (see the note at the bottom of `features/ai-panel/index.ts`).
 *
 * Meaning lives one layer up, in `ai-panel/services/claude-backend.ts`.
 */

export { AcpClient, ACP_REQUEST_TIMEOUT_MS, ACP_PROMPT_TIMEOUT_MS } from './services/client';
export type { AcpClientOptions } from './services/client';

export {
  AcpMethodNotFoundError,
  AcpRequestError,
  isAuthRequired,
  looksLikeExpiredAuth,
  toMessage,
} from './services/errors';
export type { JsonRpcErrorBody } from './services/errors';

export {
  installClaudeAgent,
  isLaunchable,
  launchParams,
  parseNodeMajor,
  probeClaudeAgent,
  resolveSetupState,
  REQUIRED_NODE_MAJOR,
} from './services/install';
export type { AcpProbe, AcpSetupState, AcpInstallProgress } from './services/install';

export {
  ACP_AUTH_REQUIRED,
  ACP_INTERNAL_ERROR,
  ACP_METHOD_NOT_FOUND,
  ACP_PROTOCOL_VERSION,
  AGENT_METHOD,
  CLIENT_METHOD,
} from './services/protocol';
export type {
  AcpPlanEntry,
  AgentCapabilities,
  AuthMethod,
  AvailableCommand,
  ClientCapabilities,
  ContentBlock,
  FsReadParams,
  FsWriteParams,
  ImageBlock,
  InitializeResult,
  McpServerConfig,
  NewSessionParams,
  NewSessionResult,
  PermissionOption as AcpPermissionOption,
  PromptResult,
  RequestPermissionOutcome,
  RequestPermissionParams,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionMode,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  StopReason as AcpStopReason,
  TerminalCreateParams,
  TerminalOutputResult,
  TerminalRefParams,
  TerminalWaitResult,
  TextBlock,
  ToolCallContent,
  ToolCallStatus as AcpToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from './services/protocol';
