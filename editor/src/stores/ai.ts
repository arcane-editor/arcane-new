/**
 * AI conversation store — manages chat messages, streaming state, agent lifecycle,
 * and composer configuration (mode, effort, staged attachments).
 */

import { create } from 'zustand';
import {
  generateSessionId,
  saveSession,
  type AgentEvent,
  type AgentKind,
  type AssistantMessage,
  type Attachment,
  type ChatMode,
  type ClaudeEffort,
  type ClaudeModel,
  type ClaudePermissionMode,
  type Effort,
  type SessionData,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '../features/ai-panel';
import { useWorkspaceStore } from './workspace';

// ---- UI-friendly message types ----

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'toolResult' | 'system' | 'permissionRequest';
  /** User message text */
  text?: string;
  /** Assistant message content blocks (text, thinking, tool calls) */
  content?: (TextContent | ThinkingContent | ToolCall)[];
  /** Tool result fields */
  toolCallId?: string;
  toolName?: string;
  toolResult?: { content: string; isError: boolean };
  /**
   * Permission request fields. Resolved when the user clicks an option in the
   * inline buttons. After resolution, `resolvedOptionId` is set and the buttons
   * become non-interactive.
   */
  permissionRequest?: {
    toolCallId: string;
    toolName?: string;
    options: PermissionOption[];
    resolvedOptionId?: string;
  };
  /** Attachments shown above this message (user role only) */
  attachments?: Attachment[];
  /** Metadata */
  timestamp: number;
  isStreaming?: boolean;
}

export interface ToolCallStatus {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'complete' | 'error';
  result?: string;
  isError?: boolean;
  /** File diffs surfaced by the tool (Claude edit-review). Rendered as DiffBlocks. */
  diffs?: Array<{ path: string; oldText: string; newText: string }>;
}

/** A single entry in Claude's streamed TODO/plan list (ACP `plan` update). */
export interface ClaudePlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: string;
}

/** A slash command advertised by the Claude bridge (ACP `available_commands_update`). */
export interface ClaudeCommand {
  name: string;
  description?: string;
}

/** Plan-mode lifecycle. */
export type PlanPhase = 'idle' | 'planning' | 'awaiting-execute' | 'executing';

interface AiState {
  // Conversation
  messages: AiMessage[];
  streamingMessageId: string | null;

  // Agent status
  isAgentRunning: boolean;
  toolCalls: Map<string, ToolCallStatus>;
  errorMessage: string | null;

  // Configuration
  mode: ChatMode;
  effort: Effort;
  sessionId: string | null;

  // Which backend the chat is using.
  selectedAgent: AgentKind;
  claudeModel: ClaudeModel;
  claudePermissionMode: ClaudePermissionMode;
  claudeEffort: ClaudeEffort;
  /**
   * Whether the Claude bridge subprocess is currently running. The agent
   * service mirrors its lifecycle into here so UI can show a status pill.
   */
  claudeBridgeRunning: boolean;
  /** Claude's streamed TODO/plan checklist (ACP `plan` update). */
  claudePlan: ClaudePlanEntry[];
  /** Slash commands the Claude bridge advertises for this session. */
  claudeAvailableCommands: ClaudeCommand[];
  /** Claude's active mode, if it self-switches mid-thread. */
  claudeCurrentMode: string | null;
  /** The real ACP sessionId from session/new — needed to resume via session/load. */
  claudeAcpSessionId: string | null;

  // Composer staging
  attachments: Attachment[];

  // Plan-mode state
  planPhase: PlanPhase;
  /** Workspace-absolute path to the most recent plan markdown file. */
  activePlanPath: string | null;
  /** Last user prompt sent in plan-mode, used by Regenerate. */
  pendingPrompt: string | null;
  /** Snapshot of the attachments the last plan was created with. */
  lastAttachments: Attachment[];

  // Actions
  handleAgentEvent: (event: AgentEvent) => void;
  addUserMessage: (text: string, attachments?: Attachment[]) => void;
  setAgentRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  resetConversation: () => void;
  /** Load a saved session's messages + config into the store for viewing/resume. */
  loadSessionIntoStore: (session: SessionData) => void;
  setMode: (mode: ChatMode) => void;
  setEffort: (effort: Effort) => void;
  setSelectedAgent: (agent: AgentKind) => void;
  setClaudeModel: (model: ClaudeModel) => void;
  setClaudePermissionMode: (mode: ClaudePermissionMode) => void;
  setClaudeEffort: (effort: ClaudeEffort) => void;
  setClaudeBridgeRunning: (running: boolean) => void;
  setClaudePlan: (plan: ClaudePlanEntry[]) => void;
  setClaudeAvailableCommands: (commands: ClaudeCommand[]) => void;
  setClaudeCurrentMode: (mode: string | null) => void;
  setClaudeAcpSessionId: (id: string | null) => void;
  addAssistantTextMessage: (text: string) => string;
  addSystemMessage: (text: string) => string;
  addPermissionRequest: (
    toolCallId: string,
    toolName: string | undefined,
    options: PermissionOption[],
  ) => string;
  resolvePermissionRequest: (toolCallId: string, optionId: string) => void;
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setPlanPhase: (phase: PlanPhase) => void;
  setActivePlanPath: (path: string | null) => void;
  setPendingPrompt: (prompt: string | null) => void;
  setLastAttachments: (attachments: Attachment[]) => void;
}

let messageCounter = 0;
function nextId(): string {
  return `msg_${++messageCounter}_${Date.now()}`;
}

export const useAiStore = create<AiState>((set, get) => ({
  messages: [],
  streamingMessageId: null,
  isAgentRunning: false,
  toolCalls: new Map(),
  errorMessage: null,
  mode: 'agent',
  effort: 'mid',
  sessionId: null,
  selectedAgent: 'arcane',
  claudeModel: 'auto',
  claudePermissionMode: 'default',
  claudeEffort: 'high',
  claudeBridgeRunning: false,
  claudePlan: [],
  claudeAvailableCommands: [],
  claudeCurrentMode: null,
  claudeAcpSessionId: null,
  attachments: [],
  planPhase: 'idle',
  activePlanPath: null,
  pendingPrompt: null,
  lastAttachments: [],

  handleAgentEvent: (event: AgentEvent) => {
    switch (event.type) {
      case 'agent_start': {
        let { sessionId } = get();
        if (!sessionId) {
          sessionId = generateSessionId();
          set({ sessionId });
        }
        set({ isAgentRunning: true, errorMessage: null });
        break;
      }

      case 'agent_end': {
        set({ isAgentRunning: false, streamingMessageId: null });
        const state = get();
        if (state.sessionId && state.messages.length > 0) {
          saveSession({
            id: state.sessionId,
            mode: state.mode,
            effort: state.effort,
            messages: state.messages,
            agentKind: state.selectedAgent,
            workspacePath: useWorkspaceStore.getState().workspacePath,
            acpSessionId: state.claudeAcpSessionId,
            claudeModel: state.claudeModel,
            claudeEffort: state.claudeEffort,
            claudePermissionMode: state.claudePermissionMode,
          }).catch(() => {});
        }
        break;
      }

      case 'message_start': {
        const msg = event.message;
        if (msg.role === 'assistant') {
          const id = nextId();
          const aiMsg: AiMessage = {
            id,
            role: 'assistant',
            content: (msg as AssistantMessage).content ?? [],
            timestamp: msg.timestamp,
            isStreaming: true,
          };
          set((s) => ({
            messages: [...s.messages, aiMsg],
            streamingMessageId: id,
          }));
        } else if (msg.role === 'toolResult') {
          const tr = msg as any;
          const aiMsg: AiMessage = {
            id: nextId(),
            role: 'toolResult',
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            toolResult: {
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
              isError: tr.isError ?? false,
            },
            timestamp: tr.timestamp,
          };
          set((s) => ({ messages: [...s.messages, aiMsg] }));
        }
        break;
      }

      case 'message_update': {
        const msg = event.message;
        if (msg.role === 'assistant') {
          const streamId = get().streamingMessageId;
          if (streamId) {
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === streamId
                  ? { ...m, content: (msg as AssistantMessage).content ?? [] }
                  : m,
              ),
            }));
          }
        }
        break;
      }

      case 'message_end': {
        const msg = event.message;
        if (msg.role === 'assistant') {
          const streamId = get().streamingMessageId;
          if (streamId) {
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === streamId
                  ? {
                      ...m,
                      content: (msg as AssistantMessage).content ?? [],
                      isStreaming: false,
                    }
                  : m,
              ),
              streamingMessageId: null,
            }));
          }
        }
        break;
      }

      case 'tool_execution_start': {
        const tc: ToolCallStatus = {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          status: 'running',
        };
        set((s) => {
          const next = new Map(s.toolCalls);
          next.set(event.toolCallId, tc);
          return { toolCalls: next };
        });
        break;
      }

      case 'tool_execution_update': {
        set((s) => {
          const next = new Map(s.toolCalls);
          const existing = next.get(event.toolCallId);
          if (existing) {
            const resultText = event.result.content
              .filter((c): c is TextContent => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
            next.set(event.toolCallId, {
              ...existing,
              result: resultText,
              diffs: event.result.diffs ?? existing.diffs,
            });
          }
          return { toolCalls: next };
        });
        break;
      }

      case 'tool_execution_end': {
        set((s) => {
          const next = new Map(s.toolCalls);
          const existing = next.get(event.toolCallId);
          if (existing) {
            const resultText = event.result.content
              .filter((c): c is TextContent => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
            next.set(event.toolCallId, {
              ...existing,
              status: event.isError ? 'error' : 'complete',
              result: resultText,
              isError: event.isError,
              diffs: event.result.diffs ?? existing.diffs,
            });
          }
          return { toolCalls: next };
        });
        break;
      }
    }
  },

  addUserMessage: (text: string, attachments?: Attachment[]) => {
    const msg: AiMessage = {
      id: nextId(),
      role: 'user',
      text,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
  },

  setAgentRunning: (running: boolean) => set({ isAgentRunning: running }),

  setError: (error: string | null) => set({ errorMessage: error }),

  resetConversation: () =>
    set({
      messages: [],
      streamingMessageId: null,
      isAgentRunning: false,
      toolCalls: new Map(),
      errorMessage: null,
      sessionId: null,
      claudePlan: [],
      claudeAvailableCommands: [],
      claudeCurrentMode: null,
      claudeAcpSessionId: null,
      attachments: [],
      planPhase: 'idle',
      activePlanPath: null,
      pendingPrompt: null,
      lastAttachments: [],
    }),

  loadSessionIntoStore: (session: SessionData) =>
    set((s) => ({
      messages: session.messages ?? [],
      streamingMessageId: null,
      isAgentRunning: false,
      toolCalls: new Map(),
      errorMessage: null,
      sessionId: session.id,
      mode: session.mode ?? 'agent',
      effort: session.effort ?? 'mid',
      selectedAgent: session.agentKind ?? 'arcane',
      claudeAcpSessionId: session.acpSessionId ?? null,
      claudeModel: session.claudeModel ?? s.claudeModel,
      claudeEffort: session.claudeEffort ?? s.claudeEffort,
      claudePermissionMode: session.claudePermissionMode ?? s.claudePermissionMode,
      claudePlan: [],
      claudeAvailableCommands: [],
      claudeCurrentMode: null,
      attachments: [],
      planPhase: 'idle',
      activePlanPath: null,
      pendingPrompt: null,
      lastAttachments: [],
    })),

  setMode: (mode: ChatMode) => set({ mode }),

  setEffort: (effort: Effort) => set({ effort }),

  setSelectedAgent: (agent: AgentKind) => set({ selectedAgent: agent }),
  setClaudeModel: (model: ClaudeModel) => set({ claudeModel: model }),
  setClaudePermissionMode: (mode: ClaudePermissionMode) =>
    set({ claudePermissionMode: mode }),
  setClaudeEffort: (effort: ClaudeEffort) => set({ claudeEffort: effort }),
  setClaudeBridgeRunning: (running: boolean) => set({ claudeBridgeRunning: running }),
  setClaudePlan: (plan: ClaudePlanEntry[]) => set({ claudePlan: plan }),
  setClaudeAvailableCommands: (commands: ClaudeCommand[]) =>
    set({ claudeAvailableCommands: commands }),
  setClaudeCurrentMode: (mode: string | null) => set({ claudeCurrentMode: mode }),
  setClaudeAcpSessionId: (id: string | null) => set({ claudeAcpSessionId: id }),

  addAssistantTextMessage: (text: string) => {
    const id = nextId();
    const msg: AiMessage = {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    return id;
  },

  addSystemMessage: (text: string) => {
    const id = nextId();
    const msg: AiMessage = {
      id,
      role: 'system',
      text,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    return id;
  },

  addPermissionRequest: (
    toolCallId: string,
    toolName: string | undefined,
    options: PermissionOption[],
  ) => {
    const id = nextId();
    const msg: AiMessage = {
      id,
      role: 'permissionRequest',
      permissionRequest: { toolCallId, toolName, options },
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    return id;
  },

  resolvePermissionRequest: (toolCallId: string, optionId: string) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.role === 'permissionRequest' &&
        m.permissionRequest &&
        m.permissionRequest.toolCallId === toolCallId
          ? {
              ...m,
              permissionRequest: { ...m.permissionRequest, resolvedOptionId: optionId },
            }
          : m,
      ),
    }));
  },

  addAttachment: (attachment: Attachment) =>
    set((s) => ({ attachments: [...s.attachments, attachment] })),

  removeAttachment: (id: string) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),

  clearAttachments: () => set({ attachments: [] }),

  setPlanPhase: (phase: PlanPhase) => set({ planPhase: phase }),
  setActivePlanPath: (path: string | null) => set({ activePlanPath: path }),
  setPendingPrompt: (prompt: string | null) => set({ pendingPrompt: prompt }),
  setLastAttachments: (attachments: Attachment[]) => set({ lastAttachments: attachments }),
}));
