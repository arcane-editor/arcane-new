/**
 * AI vendor types - adapted from PI coding agent (github.com/badlogic/pi-mono)
 * Merges types from packages/ai/src/types.ts and packages/agent/src/types.ts
 *
 * This file has NO imports from other vendor files to avoid circular deps.
 * event-stream.ts imports from here, not the other way around.
 */

import type { TSchema, Static } from '@sinclair/typebox';

// =========================================================================
// Content types
// =========================================================================

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// =========================================================================
// Messages
// =========================================================================

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface Usage {
  input: number;
  output: number;
  totalTokens: number;
}

export interface UserMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCall)[];
  model?: string;
  usage?: Usage;
  stopReason?: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: string | (TextContent | ImageContent)[];
  isError?: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// =========================================================================
// Tools
// =========================================================================

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

// =========================================================================
// Context (what gets sent to the LLM)
// =========================================================================

export interface Context {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
}

// =========================================================================
// Model
// =========================================================================

export interface Model {
  id: string;
  name: string;
  provider: string;
}

// =========================================================================
// Streaming events — normalized events the agent loop processes
// =========================================================================

export type AssistantMessageEvent =
  | { type: 'start' }
  | { type: 'text_start'; index: number }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'text_end'; index: number }
  | { type: 'thinking_start'; index: number }
  | { type: 'thinking_delta'; index: number; thinking: string }
  | { type: 'thinking_end'; index: number }
  | { type: 'toolcall_start'; index: number; id: string; name: string }
  | { type: 'toolcall_delta'; index: number; arguments: string }
  | { type: 'toolcall_end'; index: number }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; error: Error; partial?: AssistantMessage };

// =========================================================================
// Stream function
// =========================================================================

/**
 * Return type for StreamFn — an async iterable of events with a result()
 * accessor for the final AssistantMessage. Defined inline to avoid a
 * circular import from event-stream.ts.
 */
export type AssistantMessageEventStreamLike = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export type StreamFn = (
  context: Context,
  options: StreamOptions,
) => AssistantMessageEventStreamLike;

export interface StreamOptions {
  model: Model;
  signal?: AbortSignal;
  reasoning?: string;
}

// =========================================================================
// Agent tools — extend Tool with execute capability
// =========================================================================

/** A file edit surfaced by a tool, rendered as a unified diff in the UI. */
export interface DiffContent {
  path: string;
  oldText: string;
  newText: string;
}

export interface AgentToolResult {
  content: (TextContent | ImageContent)[];
  /**
   * Optional file diffs produced by the tool (e.g. Claude's edit-review).
   * Arcane tools leave this undefined; only the Claude ACP path sets it.
   */
  diffs?: DiffContent[];
}

export type AgentToolUpdateCallback = (partialResult: AgentToolResult) => void;

export interface AgentTool<TParameters extends TSchema = TSchema>
  extends Tool<TParameters> {
  label: string;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) => Promise<AgentToolResult>;
}

// =========================================================================
// Agent loop config
// =========================================================================

export interface AgentLoopConfig {
  model: Model;
  streamFn: StreamFn;
  convertToLlm: (messages: AgentMessage[]) => Message[];
  getApiKey?: () => Promise<string | undefined> | string | undefined;
  signal?: AbortSignal;
  reasoning?: string;
}

// =========================================================================
// Agent state
// =========================================================================

export interface AgentState {
  systemPrompt: string;
  model: Model;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AssistantMessage;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}

// =========================================================================
// Custom agent messages (extensible beyond base Message)
// =========================================================================

export interface BashExecutionMessage {
  role: 'bashExecution';
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  timestamp: number;
}

export type AgentMessage = Message | BashExecutionMessage;

// =========================================================================
// Agent events — emitted during the agent loop
// =========================================================================

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage }
  | { type: 'message_end'; message: AgentMessage }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };
