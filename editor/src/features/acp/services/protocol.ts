/**
 * Agent Client Protocol (ACP) v1 wire types.
 *
 * Hand-written subset of the official schema, covering exactly what Arcane
 * sends and receives. Source of truth: https://agentclientprotocol.com and the
 * generated types in `@agentclientprotocol/sdk` (`dist/schema/types.gen.d.ts`).
 *
 * Two rules for editing this file:
 *
 * 1. **Every optional field stays optional.** ACP is explicitly extensible —
 *    agents may add `_meta` and new fields at any time, and a newer agent will
 *    send `sessionUpdate` variants this file has never heard of. Nothing here
 *    may be narrowed into something that throws on an unknown value.
 * 2. **No agent-specific literals.** Mode ids, model ids and effort levels are
 *    advertised by the agent at runtime (see `SessionConfigOption`); hardcoding
 *    Claude's current set is what made the previous integration go stale.
 *
 * Wire format is JSON-RPC 2.0 as newline-delimited JSON on the agent's stdio —
 * NOT LSP-style `Content-Length` framing.
 */

/** The protocol major version Arcane implements. */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC: the agent needs the user to authenticate first. */
export const ACP_AUTH_REQUIRED = -32000;
/** JSON-RPC: method not found — what we answer for anything we don't handle. */
export const ACP_METHOD_NOT_FOUND = -32601;
/** JSON-RPC: internal error — what a throwing handler becomes. */
export const ACP_INTERNAL_ERROR = -32603;

// ── Content ──────────────────────────────────────────────────────

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ImageBlock {
  type: 'image';
  /** Base64, WITHOUT the `data:<mime>;base64,` prefix. */
  data: string;
  mimeType: string;
  uri?: string;
}
export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}
export interface EmbeddedResourceBlock {
  type: 'resource';
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
}
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ResourceLinkBlock
  | EmbeddedResourceBlock
  | { type: string; [k: string]: unknown };

// ── Initialize ───────────────────────────────────────────────────

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  auth?: { terminal?: boolean; _meta?: Record<string, unknown> };
  _meta?: Record<string, unknown>;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * An authentication method the agent advertises.
 *
 * `type: 'terminal'` is the one Claude Code uses: the CLIENT re-runs the agent
 * program with these extra `args` in an interactive terminal and treats exit
 * code 0 as success. Per spec such a method MUST NOT be passed to
 * `authenticate` — see `auth.ts`.
 */
export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  type?: 'terminal' | string;
  args?: string[];
  env?: Record<string, string>;
  _meta?: {
    'terminal-auth'?: { command: string; args: string[]; label?: string };
    [k: string]: unknown;
  } | null;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: { name?: string; title?: string; version?: string };
  _meta?: Record<string, unknown> | null;
}

// ── Session config options (mode / model / effort / …) ────────────

export interface SessionConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

/**
 * One agent-advertised setting. Everything a user can tune about a running
 * session arrives this way — the adapter exposes `mode`, `model`, `effort`,
 * `agent` and `fast` today, but the UI must render whatever it is given.
 */
export type SessionConfigOption = {
  id: string;
  name: string;
  description?: string | null;
  /** UX grouping hint: 'mode' | 'model' | 'model_config' | 'thought_level' | … */
  category?: string | null;
} & (
  | { type: 'select'; currentValue: string; options: SessionConfigSelectOption[] }
  | { type: 'boolean'; currentValue: boolean }
);

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}
export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface NewSessionParams {
  cwd: string;
  mcpServers?: McpServerConfig[];
}
export interface NewSessionResult {
  sessionId: string;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

// ── Prompt turn ──────────────────────────────────────────────────

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface PromptResult {
  stopReason: StopReason;
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Advisory only — render an unknown kind as a generic tool. */
export type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search'
  | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export interface ToolCallDiffContent {
  type: 'diff';
  path: string;
  oldText: string | null;
  newText: string;
}
export interface ToolCallTerminalContent {
  type: 'terminal';
  terminalId: string;
}
export interface ToolCallTextContent {
  type: 'content';
  content: ContentBlock;
}
export type ToolCallContent =
  | ToolCallDiffContent
  | ToolCallTerminalContent
  | ToolCallTextContent
  | { type: string; [k: string]: unknown };

export interface ToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: ToolKind | string;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpPlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low' | string;
  status?: 'pending' | 'in_progress' | 'completed' | string;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
}

/**
 * The streamed progress of a turn. **The union is open on purpose**: a newer
 * agent may send `usage_update`, `compaction_update`, `session_info_update` and
 * more. Consumers must switch with a `default` that ignores the update, never
 * one that throws.
 */
export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock; messageId?: string }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock; messageId?: string }
  | ({ sessionUpdate: 'tool_call' } & ToolCallUpdate)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallUpdate)
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: 'config_option_update'; configOptions: SessionConfigOption[] }
  | { sessionUpdate: string; [k: string]: unknown };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

// ── Client methods the agent calls back into ─────────────────────

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}
export interface RequestPermissionParams {
  sessionId: string;
  toolCall?: ToolCallUpdate;
  options: PermissionOption[];
}
export type RequestPermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

export interface FsReadParams {
  sessionId: string;
  path: string;
  /** 1-based. */
  line?: number;
  limit?: number;
}
export interface FsWriteParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  cwd?: string;
  outputByteLimit?: number;
}
export interface TerminalRefParams {
  sessionId: string;
  terminalId: string;
}
export interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
}
export interface TerminalWaitResult {
  exitCode: number | null;
  signal: string | null;
}

/** Method-name constants, so a typo is a compile error rather than a silent no-op. */
export const AGENT_METHOD = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
} as const;

export const CLIENT_METHOD = {
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  fsRead: 'fs/read_text_file',
  fsWrite: 'fs/write_text_file',
  terminalCreate: 'terminal/create',
  terminalOutput: 'terminal/output',
  terminalRelease: 'terminal/release',
  terminalWaitForExit: 'terminal/wait_for_exit',
  terminalKill: 'terminal/kill',
  elicitationCreate: 'elicitation/create',
  elicitationComplete: 'elicitation/complete',
} as const;

/**
 * How much of the model's context window the session has consumed. Claude Code
 * surfaces this prominently, and it is the one number that predicts a
 * compaction — worth showing rather than discarding.
 */
export interface SessionUsage {
  used: number;
  size: number;
}

// ── Elicitation (structured questions) ───────────────────────────
//
// How an agent asks the USER something mid-turn, as opposed to asking
// permission to act. Claude Code's `AskUserQuestion` tool arrives this way —
// and ONLY if the client advertises `elicitation.form`, otherwise the adapter
// puts the tool on its disallowed list and the model silently loses the
// ability to ask. Advertising it is the whole feature.

/** One choice in a `oneOf` / `anyOf` enum. `const` is the value to send back. */
export interface EnumOption {
  const: string;
  title: string;
  description?: string | null;
  _meta?: Record<string, unknown> | null;
}

/**
 * A single field of the requested form. Only the primitive shapes ACP allows;
 * anything else is rendered as free text rather than dropped.
 */
export interface ElicitationPropertySchema {
  type?: string;
  title?: string | null;
  description?: string | null;
  /** Present on a single-select string field. */
  oneOf?: EnumOption[] | null;
  /** Bare string enum, the shape MCP servers tend to send. */
  enum?: string[] | null;
  /** Present on a multi-select array field. */
  items?: { anyOf?: EnumOption[] | null; enum?: string[] | null } | null;
  default?: unknown;
  _meta?: Record<string, unknown> | null;
}

export interface ElicitationSchema {
  type?: string;
  title?: string | null;
  description?: string | null;
  properties?: Record<string, ElicitationPropertySchema>;
  required?: string[] | null;
}

export interface CreateElicitationParams {
  /** 'form' is the only mode Arcane advertises; 'url' is answered by opening it. */
  mode: string;
  sessionId?: string;
  toolCallId?: string | null;
  requestId?: string | null;
  message: string;
  requestedSchema?: ElicitationSchema;
  /** `mode: 'url'` only. */
  url?: string;
  elicitationId?: string;
  _meta?: Record<string, unknown> | null;
}

export type ElicitationValue = string | number | boolean | string[];

export type CreateElicitationResult =
  | { action: 'accept'; content: Record<string, ElicitationValue> }
  /** The user chose not to answer. The agent continues the turn without it. */
  | { action: 'decline' }
  /** The user cancelled — the agent aborts the tool call. */
  | { action: 'cancel' };

/**
 * `_meta` key the Claude adapter uses to mark the per-question free-text field
 * that mirrors the CLI's "Other" box. Its value names the question it belongs
 * to, which is how a typed answer gets routed to the right slot.
 */
export const ASK_CUSTOM_ANSWER_META = '_askUserQuestionCustomAnswer';

/** `_meta` key carrying an option's preview text (a mockup, a code snippet). */
export const ASK_OPTION_META = '_claude/askUserQuestionOption';
