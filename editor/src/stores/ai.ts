/**
 * AI conversation store — manages chat messages, streaming state, agent lifecycle,
 * and composer configuration (mode, effort, staged attachments).
 */

import { create } from 'zustand';
import type {
  AuthMethod,
  AvailableCommand,
  SessionConfigOption, AcpSessionUsage } from '../features/acp';
import {
  generateSessionId,
  saveSession,
  type AgentEvent,
  type AgentKind,
  coerceAgentKind,
  type AskUserOption,
  type AskUserParams,
  type AssistantMessage,
  type Attachment,
  type ChatMode,
  type ClaudeConnectState,
  type Effort,
  type PlanRef,
  type SaveSessionInput,
  type SessionData,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TurnError,
  type VerifiedCardData,
  coerceEffort,
  normalizePlanRestore,
  resetWriteApprovalSession,
  resolvePendingQuestion,
  restoreEffort,
} from '../features/ai-panel';
// From utils/, NOT the ai-panel barrel. This is called at MODULE SCOPE below,
// and the barrel is mid-evaluation when this module runs (barrel → AiChatPanel
// → here), so a barrel import resolved to a module whose own `const`s had not
// been initialized yet — a TDZ ReferenceError before the app could even render.
import { createUpdateCoalescer } from '../utils/update-coalescer';
import { useWorkspaceStore } from './workspace';
import { useCheckpointsStore } from './checkpoints';
import { useEditReviewStore } from './edit-review';
import { useAuthStore } from './auth';
import { useServerConfigStore, maxAllowedEffort } from './server-config';
import { notify } from './notifications';

// ---- UI-friendly message types ----

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/**
 * `ask_user` question-request fields (mirrors `PermissionOption`/
 * `AiMessage.permissionRequest` above). Resolved when the user answers via
 * `QuestionBlock`'s option chips or ChatInput's answer mode (`resolvedAnswer`
 * set), or locked as `cancelled: true` if the turn aborts mid-question or a
 * saved session restores with the question still pending.
 */
export interface QuestionRequestData {
  toolCallId: string;
  question: string;
  options?: AskUserOption[];
  allowMultiple?: boolean;
  resolvedAnswer?: string;
  cancelled?: boolean;
}

export interface AiMessage {
  id: string;
  role:
    | 'user'
    | 'assistant'
    | 'toolResult'
    | 'system'
    | 'permissionRequest'
    | 'questionRequest'
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
     * `PermissionRequestBlock`. Only the engine-mutate (UnityIDE) approval path
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
  /**
   * `ask_user` question-request fields (`role: 'questionRequest'` only) — see
   * `QuestionRequestData` above.
   */
  questionRequest?: QuestionRequestData;
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
  /**
   * The model id the server actually served this turn (from the `usage` SSE
   * event's `model` field, `hosted-stream.ts`), stamped on at `message_end`
   * (`role: 'assistant'` only) via `pendingServedModel`. Undefined for a
   * session saved before this field existed, or for any non-assistant role.
   */
  servedModel?: string;
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
 * A single entry in UnityIDE's own in-loop todo list (`todo_update` tool calls,
 * P3.5).
 */
export interface HostedPlanEntry {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
  /**
   * Optional difficulty tag ('easy' | 'hard'), carried in generically by JSON
   * session persistence like every other field here — no special-cased
   * serialization needed. Only ever populated on the high tier
   * (`services/difficulty.ts`'s `difficultyForRequest` gate); merged in from
   * the model's `todo_update` calls by `todo-tool.ts`'s `mergeTodoDifficulty`.
   */
  difficulty?: 'easy' | 'hard';
}

/** Plan-mode lifecycle. */
export type PlanPhase = 'idle' | 'planning' | 'awaiting-execute' | 'executing';

/**
 * Session-cumulative token usage (P4) — accumulated from the UnityIDE server's
 * `usage` SSE events (`hosted-stream.ts`), which were previously skipped
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
   * Set by `hosted-stream.ts` right before a 401/403-triggered logout, so
   * the sign-in gate that replaces the timeline can explain why the user
   * was signed out. Survives the logout-induced UI switch (unlike a
   * transient toast) because it lives in this store, not a dismissed one.
   */
  authNotice: string | null;

  /**
   * True when the server rejected an AI call with 403 `email_unverified`.
   * Deliberately distinct from `authNotice`: that one explains a session that
   * ENDED, whereas this is a session that is perfectly VALID and simply has
   * an unconfirmed mailbox. Conflating the two is what trapped every
   * email/password signup in a sign-in loop — see hosted-stream.ts.
   */
  verificationRequired: boolean;

  // Configuration
  mode: ChatMode;
  effort: Effort;
  sessionId: string | null;

  // Which backend the chat is using.
  selectedAgent: AgentKind;

  /**
   * External-agent (ACP) session state. All of it is scoped to one connected
   * agent and is meaningless while `selectedAgent === 'hosted'`, but it lives
   * flat here — rather than in a nested object — so the existing per-key
   * subscription pattern keeps working and a re-render is scoped to the field
   * that actually changed.
   */

  /**
   * The agent's own session id, needed to resume a thread with its full
   * context via `session/load`. Distinct from `sessionId`, which is UnityIDE's
   * transcript id, and persisted alongside it.
   */
  acpSessionId: string | null;
  /**
   * Settings the agent advertises (mode, model, effort, …). Rendered
   * generically by `AgentConfigBar` — UnityIDE never hardcodes the ids or the
   * values, because they change between agent releases.
   */
  agentConfigOptions: SessionConfigOption[];
  /** Slash commands this agent session offers. */
  agentAvailableCommands: AvailableCommand[];
  /**
   * Sign-in methods the agent advertises, populated only after it reports
   * `auth_required`. Empty is meaningful: an agent that needs auth but offers
   * no method we can drive is a dead end we must say so about.
   */
  agentAuthMethods: AuthMethod[];
  /**
   * Why the external agent cannot answer a prompt yet — or `ready` when it
   * can. One field rather than a boolean per reason: sign-in, a missing Node
   * and a crashed subprocess are mutually exclusive states with mutually
   * exclusive answers, and `ClaudeSetupGate` renders exactly one card.
   */
  agentConnect: ClaudeConnectState;
  /** Whether the agent subprocess is currently alive. */
  agentBridgeRunning: boolean;
  /**
   * How much of the external agent's context window is in use. `null` until
   * the agent reports it — which not every agent does, so the UI must treat
   * "unknown" as a real state rather than assuming zero.
   */
  agentContextUsage: AcpSessionUsage | null;
  /**
   * UnityIDE's own in-loop todo list, maintained via the `todo_update` tool
   * (P3.5). `null` means "no list yet this conversation" (distinct from `[]`,
   * an explicit empty list) so `PlanList` can tell "nothing to show" apart
   * from a live-but-empty list.
   */
  hostedPlan: HostedPlanEntry[] | null;
  /**
   * Transient per-turn holder for the served `model` id reported by the
   * in-flight request's `usage` SSE event (`hosted-stream.ts`'s
   * `recordServedModel`) — mirrors `streamingMessageId`'s lifecycle. Copied
   * onto the finalized assistant message as `servedModel` at `message_end`
   * and reset to `null` immediately after, since usage events always precede
   * the request's `[DONE]`. Not persisted itself (only the stamped message
   * field is); reset alongside `streamingMessageId` on conversation
   * reset/load so a stale value from a killed turn can never leak onto the
   * next one.
   */
  pendingServedModel: string | null;

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
  setVerificationRequired: (required: boolean) => void;
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
  setAcpSessionId: (id: string | null) => void;
  setAgentConfigOptions: (options: SessionConfigOption[]) => void;
  setAgentAvailableCommands: (commands: AvailableCommand[]) => void;
  setAgentContextUsage: (usage: AcpSessionUsage | null) => void;
  setAgentAuthMethods: (methods: AuthMethod[]) => void;
  setAgentConnect: (state: ClaudeConnectState) => void;
  setAgentBridgeRunning: (running: boolean) => void;
  /** Clear everything tied to one agent connection, keeping the transcript. */
  resetExternalAgentSession: () => void;
  setHostedPlan: (plan: HostedPlanEntry[] | null) => void;
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
  /** Pushes a `questionRequest` message the UI renders (mirrors `addPermissionRequest`). Called by `question-gate.ts`'s `requestUserQuestion`. */
  addQuestionRequest: (toolCallId: string, params: AskUserParams) => void;
  /**
   * The UI's SINGLE entry point for answering/cancelling a pending question
   * (`QuestionBlock`'s chips, or ChatInput's answer mode): locks the matching
   * message (`resolvedAnswer` or `cancelled: true`), schedules a save, and —
   * for an answer — resolves the gate's pending promise
   * (`resolvePendingQuestion`) so the blocked `ask_user` tool call can return.
   * No-op if the message is already locked (answered or cancelled) — mirrors
   * `QuestionBlock`'s own `locked` check, so a stale click/Enter can't
   * displace a resolution the model already received.
   */
  resolveQuestionRequest: (
    toolCallId: string,
    outcome: { answer: string } | { cancelled: true },
  ) => void;
  /**
   * Lock-only cancellation used by `question-gate.ts`'s own abort path — the
   * gate has already resolved its pending promise by the time it calls this,
   * so this must NOT call back into `resolvePendingQuestion` (that would be
   * circular). Silent no-op if `toolCallId` doesn't match any message (e.g.
   * the already-aborted-before-render branch in `requestUserQuestion`).
   */
  markQuestionCancelled: (toolCallId: string) => void;
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setPlanPhase: (phase: PlanPhase) => void;
  setActivePlanPath: (path: string | null) => void;
  /**
   * Plans produced by the current session, persisted with it so they are
   * reachable from chat history. Re-adding the same path replaces its entry
   * rather than duplicating it — regenerating a plan overwrites the file.
   */
  sessionPlans: PlanRef[];
  addSessionPlan: (plan: PlanRef) => void;
  setSessionPlans: (plans: PlanRef[]) => void;
  setPendingPrompt: (prompt: string | null) => void;
  setLastAttachments: (attachments: Attachment[]) => void;
  /** Accumulates a completed request's token usage into `sessionUsage` (P4, `hosted-stream.ts`). */
  recordSessionUsage: (inputTokens: number, outputTokens: number) => void;
  /** Stashes the in-flight request's served model id, read back at `message_end` (see `pendingServedModel`). */
  recordServedModel: (model: string) => void;
}

let messageCounter = 0;
function nextId(): string {
  return `msg_${++messageCounter}_${Date.now()}`;
}

/**
 * Restore-time sweep for `loadSessionIntoStore` — a saved session can contain
 * a `questionRequest` message that was still pending when the app quit (the
 * `ask_user` tool call, and the turn that asked it, is gone; there's no live
 * gate promise left to answer into). Locks any such message as `cancelled`
 * so a reloaded transcript never shows a stale, still-clickable question.
 */
function sweepUnresolvedQuestions(messages: AiMessage[]): AiMessage[] {
  return messages.map((m) =>
    m.role === 'questionRequest' &&
    m.questionRequest &&
    m.questionRequest.resolvedAnswer === undefined &&
    !m.questionRequest.cancelled
      ? { ...m, questionRequest: { ...m.questionRequest, cancelled: true } }
      : m,
  );
}

/**
 * Effort to restore for `loadSessionIntoStore` — `coerceEffort` first (a
 * session saved before Free-tier gating existed can carry a now-invalid
 * value), then `restoreEffort` clamps it to the account's current ceiling
 * ONLY when server-config is already known (`null` at cold start leaves the
 * persisted value alone — see `restoreEffort`'s own doc for why).
 */
function restoreSessionEffort(session: SessionData): Effort {
  const config = useServerConfigStore.getState().config;
  const maxAllowed = config ? maxAllowedEffort(config, useAuthStore.getState().plan) : null;
  return restoreEffort(coerceEffort(session.effort), maxAllowed);
}

// ---- Incremental session persistence ----
// Saves are debounced so streaming/turn boundaries don't each hit disk, but the
// user's prompt and every completed turn are persisted — so an interrupted turn
// (crash/quit mid-stream) isn't lost. `flushSessionNow` forces an immediate
// write (used on app close).

const SAVE_DEBOUNCE_MS = 600;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Every field tied to ONE external-agent connection. Declared once so
 * `resetConversation`, `loadSessionIntoStore` and an explicit disconnect can
 * never drift apart — a stale `acpSessionId` surviving a reset would make the
 * next `session/load` resume someone else's thread.
 *
 * `agentBridgeRunning` is deliberately absent: whether the subprocess is alive
 * is a fact about the process, not about the conversation, and only the
 * spawn/exit path may set it.
 */
function externalAgentReset(): Pick<
  AiState,
  'acpSessionId' | 'agentConfigOptions' | 'agentAvailableCommands' | 'agentAuthMethods' | 'agentConnect'
> {
  // Fresh arrays each call rather than a shared frozen constant: these land in
  // store state, and handing every reset the same array instance would let one
  // conversation's mutation leak into the next.
  return {
    acpSessionId: null,
    agentConfigOptions: [],
    agentAvailableCommands: [],
    agentAuthMethods: [],
    agentConnect: { kind: 'idle' },
  };
}

function buildSaveInput(): SaveSessionInput | null {
  const state = useAiStore.getState();
  if (!state.sessionId || state.messages.length === 0) return null;
  return {
    id: state.sessionId,
    mode: state.mode,
    effort: state.effort,
    messages: state.messages,
    agentKind: state.selectedAgent,
    acpSessionId: state.acpSessionId,
    workspacePath: useWorkspaceStore.getState().workspacePath,
    hostedPlan: state.hostedPlan,
    plans: state.sessionPlans,
    planPhase: state.planPhase,
    activePlanPath: state.activePlanPath,
  };
}

// Serializes the actual disk writes (T10 fix wave): `agent_end`'s flushSave()
// and `addTurnError`'s flushSave() can both fire for the same turn (a caught
// send error triggers `addTurnError`'s OWN immediate flush right after
// `agent_end`'s), so two `saveSession` calls can be in flight at once. The
// snapshot each call captures via `buildSaveInput()` is correct at
// invocation time (`addTurnError`'s always includes the error block, since
// its `set()` runs before its flush), but Tauri's underlying write doesn't
// guarantee completion order matches invocation order — an out-of-order
// finish would let the earlier (stale, error-less) write land on disk AFTER
// the later (correct) one, silently losing the error block and defeating
// survive-instant-quit. Chaining onto a shared promise forces every write to
// wait for the previous one to finish, so writes land on disk in the same
// order they were invoked.
//
// The chained step must never REJECT: `saveSession` already resolves to
// `false` on a handled failure (the `if (!ok)` branch below), but chaining
// via a bare `.then()` means an unhandled throw would leave `saveChain`
// permanently rejected — every subsequent `.then()` callback in the chain
// (i.e. every future save, for the rest of the app's lifetime) would then
// silently stop running entirely. The try/catch makes this step settle
// (resolve) unconditionally, exactly like the pre-existing `if (!ok)`
// contract already promises callers.
let saveChain: Promise<void> = Promise.resolve();

function persistSessionNow(): Promise<void> {
  const input = buildSaveInput();
  if (!input) return saveChain;
  saveChain = saveChain.then(async () => {
    try {
      const ok = await saveSession(input);
      if (!ok) notify.warning('Failed to save chat history.');
    } catch (error) {
      console.error('Unexpected error saving session:', error);
      notify.warning('Failed to save chat history.');
    }
  });
  return saveChain;
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

// ---- message_update coalescing (R2-T4 Stage 1) ----
// A streamed turn can fire `message_update` once per token; without
// coalescing, each one replaces the `messages` array wholesale, forcing a
// MessageList re-render + a markdown re-parse of the streaming
// AssistantMessage's text block on every token. `createUpdateCoalescer`
// caps the effective apply rate to ~1/windowMs (default 40ms, ~25Hz),
// always applying the LATEST content seen.
//
// `apply` re-reads `useAiStore.getState().streamingMessageId` (LIVE state,
// not a value captured back when the item was pushed) exactly the way the
// original uncoalesced handler did — so a trailing flush that fires late
// (after `message_end`/`agent_end` already cleared it, or after
// `truncateAfterMessage`/`resetConversation`/`loadSessionIntoStore` reset
// the conversation entirely) finds no matching id and is a safe no-op,
// never resurrecting stale content onto the wrong message or a fresh one.
// `message_end`/`agent_end` additionally call `.cancel()` before their own
// (authoritative) `set()`, so a flush already in flight can't race past
// them and clobber the final state they just wrote.
const messageUpdateCoalescer = createUpdateCoalescer<AssistantMessage>({
  apply: (msg) => {
    const streamId = useAiStore.getState().streamingMessageId;
    if (!streamId) return;
    useAiStore.setState((s) => ({
      messages: s.messages.map((m) =>
        m.id === streamId ? { ...m, content: msg.content ?? [] } : m,
      ),
    }));
  },
});

export const useAiStore = create<AiState>((set, get) => ({
  messages: [],
  streamingMessageId: null,
  isAgentRunning: false,
  toolCalls: new Map(),
  errorMessage: null,
  authNotice: null,
  verificationRequired: false,
  mode: 'agent',
  effort: 'low',
  sessionId: null,
  selectedAgent: 'hosted',
  acpSessionId: null,
  agentConfigOptions: [],
  agentAvailableCommands: [],
  agentAuthMethods: [],
  agentConnect: { kind: 'idle' },
  agentBridgeRunning: false,
  agentContextUsage: null,
  hostedPlan: null,
  pendingServedModel: null,
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
        // Clearing verificationRequired here is self-correcting: if the
        // mailbox is still unconfirmed, this run's 403 re-arms it immediately;
        // if the user verified in the meantime, the gate simply goes away.
        set({ isAgentRunning: true, errorMessage: null, authNotice: null, verificationRequired: false });
        break;
      }

      case 'agent_end': {
        // Cancel any pending coalesced message_update flush BEFORE this
        // authoritative set() — a late trailing flush is already a
        // guarded no-op (see `messageUpdateCoalescer` above), but
        // cancelling here also stops its pending timer outright.
        messageUpdateCoalescer.cancel();
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
          messageUpdateCoalescer.push(msg as AssistantMessage);
        }
        break;
      }

      case 'message_end': {
        // Authoritative — drop any pending coalesced flush before it can
        // race past this final content/stopReason/errorMessage write.
        messageUpdateCoalescer.cancel();
        const msg = event.message;
        if (msg.role === 'assistant') {
          const streamId = get().streamingMessageId;
          if (streamId) {
            const am = msg as AssistantMessage;
            // Read BEFORE the set() below so the closure captures this turn's
            // value even though the same set() also resets it to null.
            const servedModel = get().pendingServedModel;
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
                      servedModel: servedModel ?? undefined,
                    }
                  : m,
              ),
              streamingMessageId: null,
              // Reset for the next turn — usage events always precede this
              // request's [DONE], so `servedModel` above already captured it.
              pendingServedModel: null,
            }));
          } else {
            // No dangling stream message to stamp (e.g. already cleared by a
            // crash-recovery agent_end), but the pending value must still not
            // leak into the next turn.
            set({ pendingServedModel: null });
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

  setVerificationRequired: (required: boolean) => set({ verificationRequired: required }),

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
      verificationRequired: false,
      sessionId: null,
      hostedPlan: null,
      pendingServedModel: null,
      sessionPlans: [],
      attachments: [],
      planPhase: 'idle',
      activePlanPath: null,
      pendingPrompt: null,
      lastAttachments: [],
      sessionUsage: { input: 0, output: 0, requests: 0 },
      ...externalAgentReset(),
    });
    useCheckpointsStore.getState().reset();
    useEditReviewStore.getState().reset();
    // P5.3: "Apply all this session" doesn't carry across conversations.
    resetWriteApprovalSession();
  },

  loadSessionIntoStore: (session: SessionData) => {
    set(() => ({
      messages: sweepUnresolvedQuestions(session.messages ?? []),
      streamingMessageId: null,
      isAgentRunning: false,
      toolCalls: new Map(),
      errorMessage: null,
      authNotice: null,
      verificationRequired: false,
      sessionId: session.id,
      mode: session.mode ?? 'agent',
      // A session saved before Free-tier gating existed can carry a
      // now-invalid level ('super' was a real removed tier, 'high' is no
      // longer safe to auto-restore) — coerce and clamp rather than pass it
      // through, same treatment `agentKind` gets just below. See
      // `restoreSessionEffort`'s doc for the cold-start unclamped case.
      effort: restoreSessionEffort(session),
      // agentKind is already coerced to a live kind by parseSessionData, so
      // this goes through coerceAgentKind rather than repeating the default
      // literal — spelling it twice is how the two drift when the default
      // changes, and the rename just moved it once.
      selectedAgent: coerceAgentKind(session.agentKind),
      // T9: restore the persisted todo list rather than clearing it — a
      // session file saved before T9 lacks the key entirely (undefined),
      // which falls back to null same as a fresh conversation.
      hostedPlan: session.hostedPlan ?? null,
      // A restored transcript has no in-flight request to attribute — the
      // finalized messages already carry whatever `servedModel` they were
      // stamped with at save time.
      pendingServedModel: null,
      // Absent on sessions saved before plans were linked.
      sessionPlans: session.plans ?? [],
      attachments: [],
      // Restore plan state through the normalizer — a saved 'executing' run
      // no longer exists in this process; 'awaiting-execute' + the plan file's
      // [x] ticks are what can honestly be resumed.
      ...normalizePlanRestore(session.planPhase, session.activePlanPath),
      pendingPrompt: null,
      lastAttachments: [],
      sessionUsage: { input: 0, output: 0, requests: 0 },
      // A restored transcript is not a live agent connection: the subprocess is
      // gone and its advertised config/commands went with it. Only
      // `acpSessionId` survives, and only so the backend can offer to resume.
      ...externalAgentReset(),
      acpSessionId: session.acpSessionId ?? null,
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
  setAcpSessionId: (id: string | null) => set({ acpSessionId: id }),
  setAgentConfigOptions: (options: SessionConfigOption[]) =>
    set({ agentConfigOptions: options }),
  setAgentAvailableCommands: (commands: AvailableCommand[]) =>
    set({ agentAvailableCommands: commands }),
  setAgentAuthMethods: (methods: AuthMethod[]) => set({ agentAuthMethods: methods }),
  setAgentConnect: (state: ClaudeConnectState) => set({ agentConnect: state }),
  setAgentBridgeRunning: (running: boolean) => set({ agentBridgeRunning: running }),

  setAgentContextUsage: (usage) => set({ agentContextUsage: usage }),
  resetExternalAgentSession: () => set(externalAgentReset()),
  setHostedPlan: (plan: HostedPlanEntry[] | null) => {
    set({ hostedPlan: plan });
    // T9: persist mid-turn todo_update calls (debounced) so a crash between
    // updates doesn't lose the list — agent_end's flushSave() still covers
    // normal turn completion.
    scheduleSave();
  },

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

  addQuestionRequest: (toolCallId: string, params: AskUserParams) => {
    const msg: AiMessage = {
      id: nextId(),
      role: 'questionRequest',
      questionRequest: {
        toolCallId,
        question: params.question,
        options: params.options,
        allowMultiple: params.allowMultiple,
      },
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
  },

  resolveQuestionRequest: (
    toolCallId: string,
    outcome: { answer: string } | { cancelled: true },
  ) => {
    // Guard against a stale click/Enter arriving after the card already
    // locked (e.g. the gate's abort path cancelled it while a click was
    // in flight): re-resolving would let a cancelled card gain a
    // `resolvedAnswer` (or vice versa), rendering both footers at once
    // while the model already moved on with the first resolution. Mirrors
    // `QuestionBlock`'s own `locked` check. An unknown `toolCallId` (no
    // matching message) falls through unchanged — same no-op as before.
    const existing = get().messages.find(
      (m) => m.role === 'questionRequest' && m.questionRequest?.toolCallId === toolCallId,
    )?.questionRequest;
    if (existing && (existing.resolvedAnswer !== undefined || existing.cancelled)) {
      return;
    }
    set((s) => ({
      messages: s.messages.map((m) =>
        m.role === 'questionRequest' &&
        m.questionRequest &&
        m.questionRequest.toolCallId === toolCallId
          ? {
              ...m,
              questionRequest:
                'answer' in outcome
                  ? { ...m.questionRequest, resolvedAnswer: outcome.answer }
                  : { ...m.questionRequest, cancelled: true },
            }
          : m,
      ),
    }));
    // Unlike `resolvePermissionRequest` above, this schedules a save: an
    // answered/cancelled question can be resolved well before the turn's own
    // `agent_end` flush (the model may run several more tool calls first), so
    // a crash/quit in that window shouldn't lose the resolution.
    scheduleSave();
    if ('answer' in outcome) {
      // Reach the gate the same way ai.ts reaches other feature services
      // (e.g. `resetWriteApprovalSession` above): a static import through the
      // feature barrel. Safe here specifically because `ai.ts` itself is not
      // Bun-tested (unlike `question-gate.ts`, which dynamic-imports this
      // store to avoid pulling `stores/workspace.ts` → `@monaco-editor/react`
      // into Bun's DOM-less runtime) — there's no reverse constraint forcing
      // this particular import to be dynamic too.
      resolvePendingQuestion(toolCallId, outcome.answer);
    }
  },

  markQuestionCancelled: (toolCallId: string) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.role === 'questionRequest' &&
        m.questionRequest &&
        m.questionRequest.toolCallId === toolCallId
          ? { ...m, questionRequest: { ...m.questionRequest, cancelled: true } }
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
  sessionPlans: [],
  addSessionPlan: (plan) =>
    set((s) => ({
      sessionPlans: [...s.sessionPlans.filter((p) => p.path !== plan.path), plan],
    })),
  setSessionPlans: (plans) => set({ sessionPlans: plans }),
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

  recordServedModel: (model: string) => set({ pendingServedModel: model }),
}));

/**
 * Selector (Zustand-hook style, e.g. `useAiStore(selectPendingQuestion)`):
 * the newest unresolved `questionRequest` — no `resolvedAnswer`, not
 * `cancelled` — while the agent is actually running. `null` once the turn
 * ends (aborted/finished) or once the question is answered/cancelled, so
 * `ChatInput`'s answer-mode routing never targets a question nobody can
 * still resolve into a live gate promise.
 */
export function selectPendingQuestion(state: AiState): QuestionRequestData | null {
  if (!state.isAgentRunning) return null;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (
      m.role === 'questionRequest' &&
      m.questionRequest &&
      m.questionRequest.resolvedAnswer === undefined &&
      !m.questionRequest.cancelled
    ) {
      return m.questionRequest;
    }
  }
  return null;
}
