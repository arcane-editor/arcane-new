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
  type Effort,
  type SaveSessionInput,
  type SessionData,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TurnError,
  type VerifiedCardData,
  resetWriteApprovalSession,
} from '../features/ai-panel';
import { useWorkspaceStore } from './workspace';
import { useCheckpointsStore } from './checkpoints';
import { useEditReviewStore } from './edit-review';
import { notify } from './notifications';

// ---- UI-friendly message types ----

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AiMessage {
  id: string;
  role:
    | 'user'
    | 'assistant'
    | 'toolResult'
    | 'system'
    | 'permissionRequest'
    | 'verifiedPass'
    | 'error';
  /** User message text */
  text?: string;
  /** Assistant message content blocks (text, thinking, tool calls) */
  content?: (TextContent | ThinkingContent | ToolCall)[];
  /**
   * Turn-error classification (T3's `turn-errors.ts`), `role: 'error'` only.
   * Synthesized at T5's single choke point (outcome detection) — this task
   * only plumbs the field through the store/persistence layer.
   */
  turnError?: TurnError;
  /**
   * Assistant provenance copied verbatim from the vendor `AssistantMessage`
   * at `message_end` (`role: 'assistant'` only) — how the turn ended and,
   * for an error tail, the raw message. Must survive persistence so a
   * reloaded session can still detect a prior error tail.
   */
  stopReason?: StopReason;
  errorMessage?: string;
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
    /**
     * One-line summary of the action being approved (P5.1), e.g. "enter Play
     * Mode" or "run EditMode tests" — passed through from `approval-gate.ts`'s
     * `requestEngineApproval` verb summary. Rendered under the title in
     * `PermissionRequestBlock`. Only the engine-mutate (Arcane) approval path
     * sets this today; other permission requests leave it undefined.
     */
    detail?: string;
    /**
     * Pending file diff (P5.3, `write-approval-gate.ts`'s pre-apply gate) —
     * rendered EXPANDED via `DiffBlock` above the action buttons. Only the
     * file-write approval path sets this; engine-mutate permission requests
     * leave it undefined.
     */
    diff?: { path: string; oldText: string; newText: string };
  };
  /** Attachments shown above this message (user role only) */
  attachments?: Attachment[];
  /**
   * Verified-pass closing check (P3.4, `verifiedPass` role only) — the
   * post-send analyzer/compile/GUID sweep, rendered as a compact card. Like
   * `permissionRequest`/`system` messages, this is UI-only and not part of
   * the LLM history (see `restoreAgentMessages`'s skip comment in
   * agent-service.ts). It happens to round-trip through session save/load
   * today (messages are persisted generically as JSON, unfiltered), but that
   * isn't specially maintained — if a future format change drops it, the
   * card simply doesn't reappear after a reload. Acceptable for v1.
   */
  verifiedPass?: VerifiedCardData;
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
  /** File diffs surfaced by the tool's edit-review. Rendered as DiffBlocks. */
  diffs?: Array<{ path: string; oldText: string; newText: string }>;
}

/**
 * A single entry in Arcane's own in-loop todo list (`todo_update` tool calls,
 * P3.5).
 */
export interface ArcanePlanEntry {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

/** Plan-mode lifecycle. */
export type PlanPhase = 'idle' | 'planning' | 'awaiting-execute' | 'executing';

/**
 * Session-cumulative token usage (P4) — accumulated from the Arcane server's
 * `usage` SSE events (`arcane-stream.ts`), which were previously skipped
 * client-side entirely. Purely for later surfacing (e.g. a cost/usage
 * indicator); nothing renders it yet.
 */
export interface SessionUsage {
  input: number;
  output: number;
  requests: number;
}

interface AiState {
  // Conversation
  messages: AiMessage[];
  streamingMessageId: string | null;

  // Agent status
  isAgentRunning: boolean;
  toolCalls: Map<string, ToolCallStatus>;
  errorMessage: string | null;
  /**
   * Set by `arcane-stream.ts` right before a 401/403-triggered logout, so
   * the sign-in gate that replaces the timeline can explain why the user
   * was signed out. Survives the logout-induced UI switch (unlike a
   * transient toast) because it lives in this store, not a dismissed one.
   */
  authNotice: string | null;

  // Configuration
  mode: ChatMode;
  effort: Effort;
  sessionId: string | null;

  // Which backend the chat is using.
  selectedAgent: AgentKind;
  /**
   * Arcane's own in-loop todo list, maintained via the `todo_update` tool
   * (P3.5). `null` means "no list yet this conversation" (distinct from `[]`,
   * an explicit empty list) so `PlanList` can tell "nothing to show" apart
   * from a live-but-empty list.
   */
  arcanePlan: ArcanePlanEntry[] | null;

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

  /** Session-cumulative token usage (P4) — see `SessionUsage`. */
  sessionUsage: SessionUsage;

  // Actions
  handleAgentEvent: (event: AgentEvent) => void;
  addUserMessage: (text: string, attachments?: Attachment[]) => void;
  setAgentRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  setAuthNotice: (notice: string | null) => void;
  /** Appends a `role: 'error'` message (T5's outcome-detection choke point) and flushes it to disk immediately — an error must survive an instant quit. Returns the new message id. */
  addTurnError: (error: TurnError) => string;
  /** Drops all messages after `messageId` (keeping it), prunes now-orphaned `toolCalls` entries, and schedules a save. Used by Retry (T5) to roll history back before re-sending. */
  truncateAfterMessage: (messageId: string) => void;
  resetConversation: () => void;
  /** Load a saved session's messages + config into the store for viewing/resume. */
  loadSessionIntoStore: (session: SessionData) => void;
  /** Cancel any pending debounced save and persist the session immediately. */
  flushSessionNow: () => Promise<void>;
  setMode: (mode: ChatMode) => void;
  setEffort: (effort: Effort) => void;
  setSelectedAgent: (agent: AgentKind) => void;
  setArcanePlan: (plan: ArcanePlanEntry[] | null) => void;
  addAssistantTextMessage: (text: string) => string;
  addSystemMessage: (text: string) => string;
  addVerifiedPassMessage: (data: VerifiedCardData) => string;
  addPermissionRequest: (
    toolCallId: string,
    toolName: string | undefined,
    options: PermissionOption[],
    detail?: string,
    diff?: { path: string; oldText: string; newText: string },
  ) => string;
  resolvePermissionRequest: (toolCallId: string, optionId: string) => void;
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setPlanPhase: (phase: PlanPhase) => void;
  setActivePlanPath: (path: string | null) => void;
  setPendingPrompt: (prompt: string | null) => void;
  setLastAttachments: (attachments: Attachment[]) => void;
  /** Accumulates a completed request's token usage into `sessionUsage` (P4, `arcane-stream.ts`). */
  recordSessionUsage: (inputTokens: number, outputTokens: number) => void;
}

let messageCounter = 0;
function nextId(): string {
  return `msg_${++messageCounter}_${Date.now()}`;
}

// ---- Incremental session persistence ----
// Saves are debounced so streaming/turn boundaries don't each hit disk, but the
// user's prompt and every completed turn are persisted — so an interrupted turn
// (crash/quit mid-stream) isn't lost. `flushSessionNow` forces an immediate
// write (used on app close).

const SAVE_DEBOUNCE_MS = 600;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function buildSaveInput(): SaveSessionInput | null {
  const state = useAiStore.getState();
  if (!state.sessionId || state.messages.length === 0) return null;
  return {
    id: state.sessionId,
    mode: state.mode,
    effort: state.effort,
    messages: state.messages,
    agentKind: state.selectedAgent,
    workspacePath: useWorkspaceStore.getState().workspacePath,
  };
}

async function persistSessionNow(): Promise<void> {
  const input = buildSaveInput();
  if (!input) return;
  const ok = await saveSession(input);
  if (!ok) notify.warning('Failed to save chat history.');
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistSessionNow();
  }, SAVE_DEBOUNCE_MS);
}

function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return persistSessionNow();
}

export const useAiStore = create<AiState>((set, get) => ({
  messages: [],
  streamingMessageId: null,
  isAgentRunning: false,
  toolCalls: new Map(),
  errorMessage: null,
  authNotice: null,
  mode: 'agent',
  effort: 'high',
  sessionId: null,
  selectedAgent: 'arcane',
  arcanePlan: null,
  attachments: [],
  planPhase: 'idle',
  activePlanPath: null,
  pendingPrompt: null,
  lastAttachments: [],
  sessionUsage: { input: 0, output: 0, requests: 0 },

  handleAgentEvent: (event: AgentEvent) => {
    switch (event.type) {
      case 'agent_start': {
        let { sessionId } = get();
        if (!sessionId) {
          sessionId = generateSessionId();
          set({ sessionId });
        }
        set({ isAgentRunning: true, errorMessage: null, authNotice: null });
        break;
      }

      case 'agent_end': {
        set((s) => ({
          isAgentRunning: false,
          streamingMessageId: null,
          // A streaming message can still be dangling here if the loop died
          // without a matching message_end (e.g. a crash) — clear its spinner
          // rather than leaving it frozen mid-stream.
          messages: s.streamingMessageId
            ? s.messages.map((m) =>
                m.id === s.streamingMessageId ? { ...m, isStreaming: false } : m,
              )
            : s.messages,
        }));
        // Persist the finished turn immediately (cancels any pending debounce).
        void flushSave();
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
            const am = msg as AssistantMessage;
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === streamId
                  ? {
                      ...m,
                      content: am.content ?? [],
                      // THE core fix (T4): today both fields are dropped here
                      // and an error tail renders as an empty bubble.
                      stopReason: am.stopReason,
                      errorMessage: am.errorMessage,
                      isStreaming: false,
                    }
                  : m,
              ),
              streamingMessageId: null,
            }));
          }
          // Persist at each completed assistant turn so a later crash can't lose it.
          scheduleSave();
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
    // Ensure a sessionId exists before the agent starts so the prompt is saved
    // even if the turn is interrupted before agent_start.
    set((s) => ({
      messages: [...s.messages, msg],
      sessionId: s.sessionId ?? generateSessionId(),
    }));
    scheduleSave();
  },

  setAgentRunning: (running: boolean) => set({ isAgentRunning: running }),

  setError: (error: string | null) => set({ errorMessage: error }),

  setAuthNotice: (notice: string | null) => set({ authNotice: notice }),

  addTurnError: (error: TurnError) => {
    const id = nextId();
    const msg: AiMessage = {
      id,
      role: 'error',
      turnError: error,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    // Errors must survive an instant quit — flush immediately rather than
    // the debounced scheduleSave() other turn completions use.
    void flushSave();
    return id;
  },

  truncateAfterMessage: (messageId: string) => {
    const idx = get().messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    set((s) => {
      const kept = s.messages.slice(0, idx + 1);
      const keptToolCallIds = new Set<string>();
      for (const m of kept) {
        for (const block of m.content ?? []) {
          if (block.type === 'toolCall') keptToolCallIds.add(block.id);
        }
      }
      const nextToolCalls = new Map<string, ToolCallStatus>();
      for (const [tcId, status] of s.toolCalls) {
        if (keptToolCallIds.has(tcId)) nextToolCalls.set(tcId, status);
      }
      return { messages: kept, toolCalls: nextToolCalls };
    });
    scheduleSave();
  },

  flushSessionNow: () => flushSave(),

  resetConversation: () => {
    set({
      messages: [],
      streamingMessageId: null,
      isAgentRunning: false,
      toolCalls: new Map(),
      errorMessage: null,
      authNotice: null,
      sessionId: null,
      arcanePlan: null,
      attachments: [],
      planPhase: 'idle',
      activePlanPath: null,
      pendingPrompt: null,
      lastAttachments: [],
      sessionUsage: { input: 0, output: 0, requests: 0 },
    });
    useCheckpointsStore.getState().reset();
    useEditReviewStore.getState().reset();
    // P5.3: "Apply all this session" doesn't carry across conversations.
    resetWriteApprovalSession();
  },

  loadSessionIntoStore: (session: SessionData) => {
    set(() => ({
      messages: session.messages ?? [],
      streamingMessageId: null,
      isAgentRunning: false,
      toolCalls: new Map(),
      errorMessage: null,
      authNotice: null,
      sessionId: session.id,
      mode: session.mode ?? 'agent',
      effort: session.effort ?? 'high',
      // agentKind is coerced to a live kind on load (see session-persistence);
      // old non-Arcane sessions restore as read-only Arcane transcripts.
      selectedAgent: session.agentKind ?? 'arcane',
      arcanePlan: null,
      attachments: [],
      planPhase: 'idle',
      activePlanPath: null,
      pendingPrompt: null,
      lastAttachments: [],
      sessionUsage: { input: 0, output: 0, requests: 0 },
    }));
    void useCheckpointsStore.getState().loadForSession(session.id);
    void useEditReviewStore.getState().loadForSession(session.id);
    // P5.3: loading a different session is a fresh approval context too —
    // "Apply all this session" shouldn't leak in from whatever was open before.
    resetWriteApprovalSession();
  },

  setMode: (mode: ChatMode) => set({ mode }),

  setEffort: (effort: Effort) => set({ effort }),

  setSelectedAgent: (agent: AgentKind) => set({ selectedAgent: agent }),
  setArcanePlan: (plan: ArcanePlanEntry[] | null) => set({ arcanePlan: plan }),

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

  addVerifiedPassMessage: (data: VerifiedCardData) => {
    const id = nextId();
    const msg: AiMessage = {
      id,
      role: 'verifiedPass',
      verifiedPass: data,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    return id;
  },

  addPermissionRequest: (
    toolCallId: string,
    toolName: string | undefined,
    options: PermissionOption[],
    detail?: string,
    diff?: { path: string; oldText: string; newText: string },
  ) => {
    const id = nextId();
    const msg: AiMessage = {
      id,
      role: 'permissionRequest',
      permissionRequest: { toolCallId, toolName, options, detail, diff },
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

  recordSessionUsage: (inputTokens: number, outputTokens: number) =>
    set((s) => ({
      sessionUsage: {
        input: s.sessionUsage.input + inputTokens,
        output: s.sessionUsage.output + outputTokens,
        requests: s.sessionUsage.requests + 1,
      },
    })),
}));
