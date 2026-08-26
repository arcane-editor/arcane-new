/**
 * Claude Code as a chat backend, driven over the Agent Client Protocol.
 *
 * Claude owns its own agent loop, its own tools and its own context window, so
 * unlike the Arcane path there is no `StreamFn` to swap and no vendor loop to
 * run. What this class does is translate: ACP `session/update` notifications
 * become `AgentEvent`s fed to `useAiStore.handleAgentEvent`, so `MessageList`,
 * `ToolCallBlock`, `PermissionRequestBlock`, `PlanList`, the per-turn
 * checkpoints and the Accept/Reject review queue all render a Claude turn
 * exactly as they render an Arcane one, with no branch of their own.
 *
 * Lifecycle:
 *
 *   ensureSession()  probe → launch → `initialize` → `session/new`|`session/load`
 *   sendMessage()    `session/prompt`, streaming updates until a stop reason
 *   abort()          `session/cancel` (a notification — the turn ends itself)
 *   dispose()        release terminals, kill the subprocess
 *
 * Two invariants carried over from `agent-service.ts`, because the UI depends
 * on them regardless of which backend produced the turn:
 *
 *   1. `sendMessage` does NOT add the user bubble. Every caller does that
 *      first — see the two-step contract documented in `retry-turn.ts`.
 *   2. On abort, no outcome block is emitted at all. A cancelled turn is not a
 *      failure and must not render an error card with a Retry button.
 */

import {
  AcpClient,
  ACP_PROMPT_TIMEOUT_MS,
  ACP_PROTOCOL_VERSION,
  AGENT_METHOD,
  CLIENT_METHOD,
  isAuthRequired,
  isLaunchable,
  launchParams,
  looksLikeExpiredAuth,
  probeClaudeAgent,
  resolveSetupState,
  toMessage,
  type AcpProbe,
  type ContentBlock,
  type FsReadParams,
  type FsWriteParams,
  type InitializeResult,
  type NewSessionResult,
  type PromptResult,
  type RequestPermissionOutcome,
  type RequestPermissionParams,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type TerminalCreateParams,
  type TerminalRefParams,
  type ToolCallUpdate,
  AcpMethodNotFoundError,
  type CreateElicitationParams,
  type CreateElicitationResult,
  type ElicitationValue,
} from '../../acp';
import { useAiStore } from '../../../stores/ai';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { useWorkspaceStore } from '../../../stores/workspace';
import { cancelExternalAgentApprovals, requestExternalAgentPermission } from './approval-gate';
import { handleFsRead, handleFsWrite } from './acp-fs';
import { AcpTerminals } from './acp-terminals';
import {
  contentToText,
  dataUrlToBase64,
  extractDiffs,
  planEntriesFor,
  stopReasonFor,
  toolDisplayName,
  toolStatusFor,
  reconcileToolCall,
  CLIENT_CAPABILITIES,
  configOptionPayload,
} from './acp-translate';
// `fileUri` is the single source for file:// construction — hand-rolling one
// silently breaks every Windows path (`file://D%3A/...` vs `file:///D:/...`),
// which is why a repo-wide test forbids it.
import { fileUri } from '../../lsp';
import { resolveAttachments } from './attachments';
import { loadMcpServers } from './mcp-config';
import {
  choicesFor,
  encodeAnswer,
  parseElicitationForm,
  questionTextFor,
} from './acp-elicitation';
import { requestUserQuestion } from './question-gate';
import { openUrl } from '@tauri-apps/plugin-opener';
import { classifyTurnError } from './turn-errors';
import { isReplayableContent } from './replay-filter';
import {
  ClaudeSetupRequiredError,
  classifyConnectError,
  type ClaudeConnectState,
} from './claude-connect';
import type { Attachment } from './types';
import type {
  AgentToolResult,
  AssistantMessage,
  TextContent,
  ToolCall,
} from './vendor/types';

/** The agent id Rust keys this subprocess by, and the tag on every event. */
const AGENT_ID = 'claude';

/**
 * Reported to the agent in `clientInfo`; shows up in its own logs.
 *
 * A literal rather than Tauri's `getVersion()` because the handshake below is
 * synchronous. It drifted two minors behind before anyone noticed, so
 * `check:version` now asserts this equals package.json — keep them together.
 */
const APP_VERSION = '0.3.2';

// `ClaudeSetupRequiredError` is declared in `claude-connect.ts` alongside the
// state it maps to, and re-exported here because this is where callers expect
// the backend's errors to live.
export { ClaudeSetupRequiredError } from './claude-connect';

export class ClaudeBackend {
  readonly kind = 'claude' as const;

  private client: AcpClient | null = null;
  private terminals = new AcpTerminals();
  private acpSessionId: string | null = null;
  private initResult: InitializeResult | null = null;
  private sessionCwd: string | null = null;
  private startInFlight: Promise<void> | null = null;

  /** The assistant message being streamed, and whether the UI knows about it. */
  private streaming: AssistantMessage | null = null;
  private streamingStarted = false;

  /** Tool call id → display name, so a later update can label itself. */
  private toolNames = new Map<string, string>();
  /** Last known arguments per tool call — they stream in after the call opens. */
  private toolArgs = new Map<string, Record<string, unknown>>();
  /** Questions currently on screen, so the turn's end can lock them. */
  private openQuestions = new Set<string>();
  /** Tool call id → accumulated result, so updates are additive not replacing. */
  private toolResults = new Map<string, AgentToolResult>();

  private abortRequested = false;
  private promptInFlight = false;
  /**
   * Aborted when the turn ends for any reason. Questions raised mid-turn hang
   * on the user, so they need a signal that fires on Stop or on the agent
   * dying — otherwise a stopped turn leaves a live question card behind.
   */
  private turnAbort: AbortController | null = null;
  /** True while `session/load` replays history we are already rendering. */
  private suppressReplay = false;

  // ── Public surface (the ChatBackend contract) ──────────────────

  async sendMessage(text: string, opts: { attachments?: Attachment[] }): Promise<void> {
    if (this.promptInFlight) return;

    const ai = useAiStore.getState();
    this.abortRequested = false;

    const connection = await this.connect();
    if (connection.kind !== 'ready') {
      // `connect` has already written the reason to the store, and
      // `ClaudeSetupGate` renders it as a card with the one button that fixes
      // it. Only a genuine fault also belongs in the transcript: duplicating
      // "sign in" or "install Node" as a red error block beside the card that
      // says the same thing is noise, and neither has a Retry that could work.
      if (connection.kind === 'failed') ai.addTurnError(classifyTurnError(connection.message));
      return;
    }

    const prompt = await this.buildPromptBlocks(text, opts.attachments ?? []);

    this.promptInFlight = true;
    this.turnAbort = new AbortController();
    this.resetStreamState();
    ai.handleAgentEvent({ type: 'agent_start' });

    // Anchor the turn's checkpoint to the user message the caller just added,
    // so "restore this turn" reverts exactly the edits this prompt caused.
    const userMessageId = currentUserMessageId();
    if (ai.sessionId && userMessageId) {
      useCheckpointsStore.getState().beginTurn(ai.sessionId, userMessageId);
    }

    try {
      const result = await this.client!.request<PromptResult>(
        AGENT_METHOD.sessionPrompt,
        { sessionId: this.acpSessionId, prompt },
        ACP_PROMPT_TIMEOUT_MS,
      );
      this.finalizeStreaming(stopReasonFor(result?.stopReason));
    } catch (e) {
      this.finalizeStreaming('error');
      if (this.abortRequested) {
        // Invariant 2: a user-requested stop produces no outcome block.
      } else if (isAuthRequired(e)) {
        this.enterAuthRequired();
      } else {
        useAiStore.getState().addTurnError(classifyTurnError(toMessage(e)));
      }
    } finally {
      this.promptInFlight = false;
      this.endTurnQuestions();
      useCheckpointsStore.getState().endTurn();
      useAiStore.getState().handleAgentEvent({ type: 'agent_end', messages: [] });
    }
  }

  /**
   * Bring the agent up, and record WHY if it cannot come up.
   *
   * Called on two paths, and it must behave identically on both:
   *
   *  - eagerly, by `ClaudeSetupGate` the moment Claude Code is the selected
   *    agent, so a signed-out user is offered a sign-in button instead of a
   *    blank panel, and so the agent's own modes and models are on screen
   *    before the first message rather than after it. Nothing else in the
   *    editor can discover any of that — it all arrives from `initialize` and
   *    `session/new`, which only happen once the subprocess is running.
   *  - lazily, from `sendMessage`, because a send must still work if the panel
   *    was never opened (a restored session, a command, a retried turn).
   *
   * Never throws: every reason is a state the UI renders, and `ensureSession`
   * de-duplicates concurrent callers so the two paths cannot race into two
   * subprocesses.
   */
  async connect(): Promise<ClaudeConnectState> {
    const ai = useAiStore.getState();

    // No folder is not a failure to report — the composer is disabled anyway,
    // and an agent's cwd is fixed at `session/new`, so there is nothing to
    // connect to yet.
    if (!useWorkspaceStore.getState().workspacePath) {
      ai.setAgentConnect({ kind: 'idle' });
      return { kind: 'idle' };
    }

    if (this.sessionIsCurrent()) {
      ai.setAgentConnect({ kind: 'ready' });
      return { kind: 'ready' };
    }

    ai.setAgentConnect({ kind: 'connecting' });
    try {
      await this.ensureSession();
    } catch (e) {
      const failure = classifyConnectError(e);
      // `enterAuthRequired` also populates the sign-in methods the agent
      // advertised, which the card needs to offer a button at all.
      if (failure.kind === 'auth-required') this.enterAuthRequired();
      else useAiStore.getState().setAgentConnect(failure);
      return failure;
    }
    // Re-read: the handshake wrote to the store on the way through.
    useAiStore.getState().setAgentConnect({ kind: 'ready' });
    return { kind: 'ready' };
  }

  abort(): void {
    if (!this.promptInFlight || !this.client || !this.acpSessionId) return;
    this.abortRequested = true;
    // A notification, not a request: the agent acknowledges by ending the turn
    // with `stopReason: 'cancelled'`, which the prompt call above is awaiting.
    void this.client
      .notify(AGENT_METHOD.sessionCancel, { sessionId: this.acpSessionId })
      .catch(() => {});
    cancelExternalAgentApprovals();
    this.turnAbort?.abort();
  }

  /**
   * A restored transcript is display-only until the next prompt: `resume` only
   * notes that a previous agent session may be resumable. The actual
   * `session/load` happens on the next `ensureSession`, so reopening a window
   * does not spawn a subprocess for a conversation the user may never continue.
   */
  resume(): void {
    /* no-op by design — see the doc comment. */
  }

  reset(): void {
    void this.dispose();
  }

  rewindToLastUserPrompt(): void {
    // Claude keeps its own conversation history; rewinding ours would desync
    // the two. A retry starts a fresh prompt against the same agent session.
  }

  async dispose(): Promise<void> {
    this.promptInFlight = false;
    cancelExternalAgentApprovals();
    await this.terminals.releaseAll().catch(() => {});
    this.terminals = new AcpTerminals();
    const client = this.client;
    this.client = null;
    this.acpSessionId = null;
    this.initResult = null;
    this.sessionCwd = null;
    this.resetStreamState();
    useAiStore.getState().setAgentBridgeRunning(false);
    // `agentConnect` is deliberately NOT cleared here. `dispose` is also the
    // first step of a RECONNECT (`doStart` tears down a session pinned to the
    // old cwd), and dropping to `idle` mid-connect would pull the "Starting…"
    // card out from under a connection that is still in progress. The two
    // callers for which teardown really is final — `resetClaudeBackend` and
    // `resetConversation` — clear it themselves.
    await client?.stop().catch(() => {});
  }

  /** Change one agent-advertised setting (mode, model, effort, …). */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (!this.client || !this.acpSessionId) return;
    const response = await this.client.request<{ configOptions?: SessionConfigOption[] }>(
      AGENT_METHOD.sessionSetConfigOption,
      configOptionPayload(this.acpSessionId, configId, value),
    );
    // The agent returns the full reconciled set — switching model can change
    // which modes exist, so trusting our local edit would show stale options.
    if (response?.configOptions) {
      useAiStore.getState().setAgentConfigOptions(response.configOptions);
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────

  /** Idempotent, and safe to call concurrently: callers share one attempt. */
  private async ensureSession(): Promise<void> {
    if (this.sessionIsCurrent()) return;
    if (this.startInFlight) return this.startInFlight;

    this.startInFlight = this.doStart().finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private cwdUnchanged(): boolean {
    return this.sessionCwd === useWorkspaceStore.getState().workspacePath;
  }

  /**
   * True when the live subprocess is serving the session the STORE is showing.
   *
   * The store's `acpSessionId` is the deciding half, and it is not redundant
   * with our own. New Chat and picking a different thread from the history both
   * change it without going anywhere near this class — so without this check a
   * reused connection would answer the new transcript with the old thread's
   * context, and the config options that arrive with `session/new` would never
   * be re-fetched, leaving the composer's model and mode pills empty. Making it
   * a precondition here means every caller gets that right by default instead of
   * having to remember to tear the agent down first.
   */
  private sessionIsCurrent(): boolean {
    return (
      !!this.client?.isRunning &&
      !!this.acpSessionId &&
      this.cwdUnchanged() &&
      useAiStore.getState().acpSessionId === this.acpSessionId
    );
  }

  private async doStart(): Promise<void> {
    // A workspace changed under a live session invalidates it — the agent's cwd
    // is fixed at session/new and cannot be moved.
    if (this.client) await this.dispose();

    const cwd = useWorkspaceStore.getState().workspacePath;
    if (!cwd) throw new Error('Open a folder before starting an agent.');

    const probe = await probeClaudeAgent();
    const setup = resolveSetupState(probe);
    if (!isLaunchable(setup)) throw new ClaudeSetupRequiredError(setup);

    const params = launchParams(setup, probe);
    if (!params) throw new ClaudeSetupRequiredError(setup);

    await this.launch(params, cwd);
    await this.initialize(probe);
    await this.openSession(cwd);
  }

  private async launch(
    params: { command: string; args: string[]; env: Record<string, string> },
    cwd: string,
  ): Promise<void> {
    const client = new AcpClient({
      agentId: AGENT_ID,
      onRequest: (method, p) => this.handleRequest(method, p),
      onNotification: (method, p) => this.handleNotification(method, p),
      onExit: (info) => this.handleExit(info),
      onStderr: (line) => console.debug('[claude]', line),
    });
    await client.start({ ...params, cwd });
    this.client = client;
    this.sessionCwd = cwd;
    useAiStore.getState().setAgentBridgeRunning(true);
    useAiStore.getState().setAgentContextUsage(null);
  }

  private async initialize(_probe: AcpProbe): Promise<void> {
    const result = await this.client!.request<InitializeResult>(AGENT_METHOD.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: 'arcane', title: 'Arcane', version: APP_VERSION },
    });

    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      // Half-speaking a protocol produces failures far from their cause. Refuse
      // clearly instead, naming both versions so the fix is obvious.
      throw new Error(
        `This Claude agent speaks ACP v${result.protocolVersion}, but Arcane speaks ` +
          `v${ACP_PROTOCOL_VERSION}. Update Arcane, or reinstall the agent from Settings.`,
      );
    }

    this.initResult = result;
    useAiStore.getState().setAgentAuthMethods(result.authMethods ?? []);
  }

  private async openSession(cwd: string): Promise<void> {
    const mcpServers = await loadMcpServers().catch(() => []);
    const previous = useAiStore.getState().acpSessionId;
    const canLoad = this.initResult?.agentCapabilities?.loadSession === true;

    if (previous && canLoad) {
      try {
        // The transcript is already on screen from our own session file; the
        // agent replays its history as `session/update`s, which would duplicate
        // every message. Suppress them and keep only the resumed context.
        this.suppressReplay = true;
        const loaded = await this.client!.request<{
          configOptions?: SessionConfigOption[] | null;
        }>(AGENT_METHOD.sessionLoad, {
          sessionId: previous,
          cwd,
          mcpServers,
        });
        this.acpSessionId = previous;
        // Two possible sources, because the agent may use either: the response
        // itself, or a `config_option_update` notification during the load.
        // Taken here only when non-empty, so a response that omits them does
        // not clobber what the notification already delivered.
        if (loaded?.configOptions?.length) {
          useAiStore.getState().setAgentConfigOptions(loaded.configOptions);
        }
        // The `session/new` path below sets these on the way out; the resume
        // path returned without them, so a restored session was left looking
        // connected while the store still said `idle`.
        useAiStore.getState().setAgentConnect({ kind: 'ready' });
        return;
      } catch (e) {
        if (isAuthRequired(e)) throw e;
        // Soft-resume: a session the agent has forgotten (restarted, expired,
        // pruned) is not an error. Start fresh — the user keeps their visible
        // transcript, and only the agent's memory of it is lost.
        console.warn('[claude] session/load failed, starting a new session:', toMessage(e));
      } finally {
        this.suppressReplay = false;
      }
    }

    const result = await this.client!.request<NewSessionResult>(AGENT_METHOD.sessionNew, {
      cwd,
      mcpServers,
    });
    this.acpSessionId = result.sessionId;

    const ai = useAiStore.getState();
    ai.setAcpSessionId(result.sessionId);
    ai.setAgentConfigOptions(result.configOptions ?? []);
    ai.setAgentConnect({ kind: 'ready' });
  }

  private enterAuthRequired(): void {
    const ai = useAiStore.getState();
    ai.setAgentConnect({ kind: 'auth-required' });
    ai.setAgentAuthMethods(this.initResult?.authMethods ?? []);
  }

  /** Re-run the session handshake after the user has signed in. */
  async retryAfterAuth(): Promise<ClaudeConnectState> {
    // The agent caches its unauthenticated state, so restart rather than
    // retrying `session/new` on the same process.
    await this.dispose();
    return this.connect();
  }

  // ── Prompt construction ───────────────────────────────────────

  /**
   * Turn the composer's text and attachments into ACP content blocks.
   *
   * File attachments become `resource_link`s rather than inlined text: Claude
   * has its own read tool and its own context budget, so handing it a pointer
   * lets it decide how much of a file it actually needs. Unity attachments have
   * no such tool, so those are resolved to text here.
   */
  private async buildPromptBlocks(text: string, attachments: Attachment[]): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];

    const files = attachments.filter((a): a is Extract<Attachment, { kind: 'file' }> => a.kind === 'file');
    const images = attachments.filter(
      (a): a is Extract<Attachment, { kind: 'image' }> => a.kind === 'image',
    );
    const rest = attachments.filter((a) => a.kind !== 'file' && a.kind !== 'image');

    if (rest.length > 0) {
      const resolved = await resolveAttachments(rest);
      if (resolved.prefix) blocks.push({ type: 'text', text: resolved.prefix });
    }

    if (text) blocks.push({ type: 'text', text });

    for (const file of files) {
      blocks.push({
        type: 'resource_link',
        uri: fileUri(file.path),
        name: file.relPath || file.path,
      });
    }

    const acceptsImages = this.initResult?.agentCapabilities?.promptCapabilities?.image === true;
    for (const image of images) {
      if (!acceptsImages) continue; // Sending one anyway makes the agent error out.
      blocks.push({
        type: 'image',
        mimeType: image.mimeType,
        data: dataUrlToBase64(image.dataUrl),
      });
    }

    return blocks;
  }

  // ── Agent → client requests ───────────────────────────────────

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case CLIENT_METHOD.fsRead:
        return handleFsRead(params as FsReadParams);
      case CLIENT_METHOD.fsWrite:
        return handleFsWrite(params as FsWriteParams);
      case CLIENT_METHOD.terminalCreate:
        return this.terminals.create(params as TerminalCreateParams);
      case CLIENT_METHOD.terminalOutput:
        return this.terminals.output(params as TerminalRefParams);
      case CLIENT_METHOD.terminalWaitForExit:
        return this.terminals.waitForExit(params as TerminalRefParams);
      case CLIENT_METHOD.terminalKill:
        return this.terminals.kill(params as TerminalRefParams);
      case CLIENT_METHOD.terminalRelease:
        return this.terminals.release(params as TerminalRefParams);
      case CLIENT_METHOD.requestPermission:
        return this.handlePermissionRequest(params as RequestPermissionParams);
      case CLIENT_METHOD.elicitationCreate:
        return this.handleElicitation(params as CreateElicitationParams);
      default:
        // Answered as JSON-RPC -32601, which agents are required to handle —
        // capability negotiation exists precisely so an agent can cope with a
        // client that does not implement something.
        throw new AcpMethodNotFoundError(method);
    }
  }

  private async handlePermissionRequest(
    params: RequestPermissionParams,
  ): Promise<RequestPermissionOutcome> {
    const toolCallId = params.toolCall?.toolCallId ?? `perm_${Date.now()}`;
    const toolName = params.toolCall?.title;
    const diffs = extractDiffs(params.toolCall?.content);

    const optionId = await requestExternalAgentPermission(
      toolCallId,
      toolName,
      params.options ?? [],
      undefined,
      diffs[0],
    );

    // `null` means the user stopped the turn rather than choosing a rejection.
    // ACP distinguishes the two, and an agent told "rejected" will apologise
    // and try something else instead of stopping.
    return optionId === null
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId } };
  }

  /**
   * `elicitation/create` — the agent asking the USER something, as opposed to
   * asking permission to act. Claude Code's `AskUserQuestion` arrives here.
   *
   * Each field is asked as an ordinary Arcane question, in order, through the
   * same gate the `ask_user` tool uses — so the user gets `QuestionBlock`'s
   * chips, the composer's answer mode, and the existing cancel semantics, with
   * no second question UI to build or keep consistent.
   */
  private async handleElicitation(
    params: CreateElicitationParams,
  ): Promise<CreateElicitationResult> {
    if (params.mode === 'url') {
      // We advertise URL elicitation because the alternative is the agent
      // silently losing a sign-in flow; the browser is the only place such a
      // flow can complete.
      if (typeof params.url === 'string' && params.url) {
        await openUrl(params.url).catch(() => {});
        return { action: 'accept', content: {} };
      }
      return { action: 'decline' };
    }
    if (params.mode !== 'form') return { action: 'decline' };

    const form = parseElicitationForm(params);
    if (!form) return { action: 'decline' };

    const signal = this.turnAbort?.signal;
    const content: Record<string, ElicitationValue> = {};

    for (const field of form.fields) {
      const questionId = `${params.toolCallId ?? params.elicitationId ?? 'ask'}:${field.key}`;
      this.openQuestions.add(questionId);
      const outcome = await requestUserQuestion(
        questionId,
        {
          question: questionTextFor(form, field),
          options: choicesFor(field)?.map((c) => ({
            label: c.label,
            description: c.description,
            preview: c.preview,
          })),
          allowMultiple: field.kind === 'multiselect',
        },
        signal,
      );
      this.openQuestions.delete(questionId);

      if (outcome.kind === 'cancelled') return { action: 'cancel' };
      Object.assign(content, encodeAnswer(field, outcome.answer));
    }

    // Nothing answered is a skip, not an abort: the agent is told the user
    // passed and carries on, which is what `decline` means to it.
    return Object.keys(content).length > 0
      ? { action: 'accept', content }
      : { action: 'decline' };
  }

  /**
   * Lock any question still on screen when the turn ends. The gate's own abort
   * path covers a Stop click; this covers the turn ending underneath a
   * question for any other reason (agent crash, timeout).
   */
  private endTurnQuestions(): void {
    this.turnAbort?.abort();
    this.turnAbort = null;
    const ai = useAiStore.getState();
    for (const id of this.openQuestions) ai.markQuestionCancelled(id);
    this.openQuestions.clear();
  }

  // ── Agent → client notifications ──────────────────────────────

  private handleNotification(method: string, params: unknown): void {
    if (method !== CLIENT_METHOD.sessionUpdate) return;
    const payload = params as SessionNotification | undefined;
    if (!payload?.update) return;
    // Selective, not wholesale. A `session/load` replay carries the thread we
    // are already rendering AND the loaded session's settings; dropping the
    // whole channel took the settings with it and left a resumed chat with no
    // model, mode or effort controls at all. See `replay-filter.ts`.
    if (this.suppressReplay && isReplayableContent(payload.update.sessionUpdate)) return;
    this.applyUpdate(payload.update);
  }

  private applyUpdate(update: SessionUpdate): void {
    const ai = useAiStore.getState();

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentToText((update as { content?: unknown }).content);
        if (!text) break;
        if (looksLikeExpiredAuth(text)) this.enterAuthRequired();
        this.appendStreamingText(text, 'text');
        break;
      }

      case 'agent_thought_chunk': {
        const text = contentToText((update as { content?: unknown }).content);
        if (text) this.appendStreamingText(text, 'thinking');
        break;
      }

      case 'user_message_chunk':
        // Our own prompt, echoed back. The user bubble is already rendered.
        break;

      case 'tool_call':
        this.startToolCall(update as ToolCallUpdate);
        break;

      case 'tool_call_update':
        this.updateToolCall(update as ToolCallUpdate);
        break;

      case 'plan':
        ai.setArcanePlan(planEntriesFor((update as { entries?: never }).entries));
        break;

      case 'usage_update': {
        // Not every agent reports this, so the UI treats its absence as
        // "unknown" rather than "empty" — see `agentContextUsage`.
        const u = update as unknown as { used?: number; size?: number };
        if (typeof u.used === 'number' && typeof u.size === 'number' && u.size > 0) {
          ai.setAgentContextUsage({ used: u.used, size: u.size });
        }
        break;
      }

      case 'available_commands_update':
        ai.setAgentAvailableCommands(
          (update as { availableCommands?: never[] }).availableCommands ?? [],
        );
        break;

      case 'config_option_update':
        ai.setAgentConfigOptions((update as { configOptions?: never[] }).configOptions ?? []);
        break;

      case 'current_mode_update': {
        // Modes are also exposed as a config option, so mirror the change there
        // rather than tracking the same value in two places.
        const modeId = (update as { currentModeId?: string }).currentModeId;
        if (modeId) {
          ai.setAgentConfigOptions(
            ai.agentConfigOptions.map((o) =>
              o.id === 'mode' && o.type === 'select' ? { ...o, currentValue: modeId } : o,
            ),
          );
        }
        break;
      }

      default:
        // Forward compatibility, not laziness: a newer agent sends update kinds
        // this build has never heard of (`usage_update`, `compaction_update`,
        // …). Ignoring one costs a little fidelity; throwing would kill the turn.
        break;
    }
  }

  // ── Streaming assistant message ───────────────────────────────

  private resetStreamState(): void {
    this.streaming = null;
    this.streamingStarted = false;
    this.toolNames.clear();
    this.toolArgs.clear();
    this.toolResults.clear();
  }

  /**
   * Append to the streaming assistant message, starting it lazily.
   *
   * Lazily, because Claude routinely thinks before it speaks: emitting
   * `message_start` when the turn begins leaves an empty bubble pulsing on
   * screen for however long that takes.
   */
  private appendStreamingText(text: string, kind: 'text' | 'thinking'): void {
    if (!this.streaming) {
      this.streaming = { role: 'assistant', content: [], timestamp: Date.now() };
    }

    const content = this.streaming.content;
    const last = content[content.length - 1];
    if (kind === 'text') {
      if (last && last.type === 'text') (last as TextContent).text += text;
      else content.push({ type: 'text', text });
    } else {
      if (last && last.type === 'thinking') last.thinking += text;
      else content.push({ type: 'thinking', thinking: text });
    }

    const ai = useAiStore.getState();
    if (!this.streamingStarted) {
      this.streamingStarted = true;
      ai.handleAgentEvent({ type: 'message_start', message: this.streaming });
    } else {
      ai.handleAgentEvent({ type: 'message_update', message: this.streaming });
    }
  }

  private finalizeStreaming(stopReason: AssistantMessage['stopReason']): void {
    if (!this.streaming || !this.streamingStarted) {
      this.streaming = null;
      this.streamingStarted = false;
      return;
    }
    this.streaming.stopReason = stopReason;
    useAiStore.getState().handleAgentEvent({ type: 'message_end', message: this.streaming });
    this.streaming = null;
    this.streamingStarted = false;
  }

  // ── Tool calls ────────────────────────────────────────────────

  private startToolCall(update: ToolCallUpdate): void {
    const { toolCallId } = update;
    if (!toolCallId) return;

    const name = toolDisplayName(update);
    const args = isRecord(update.rawInput) ? update.rawInput : {};
    this.toolNames.set(toolCallId, name);
    if (Object.keys(args).length > 0) this.toolArgs.set(toolCallId, args);

    useAiStore.getState().handleAgentEvent({
      type: 'tool_execution_start',
      toolCallId,
      toolName: name,
      args,
    });
    // The event above fills the `toolCalls` Map and nothing else, and a Map
    // entry renders nowhere. `ToolCallBlock` is reached from a `toolCall`
    // CONTENT BLOCK inside an assistant message, so the call has to join the
    // bubble — exactly as Arcane's own loop does it.
    //
    // This used to `finalizeStreaming('toolUse')` here instead, on the belief
    // that a tool renders between two messages. Nothing renders it there: the
    // bubble closed, no block was ever added, and a turn that ran 27 tools
    // showed one sentence and looked frozen.
    this.upsertStreamingToolCall(toolCallId, name, args);

    // A tool call can arrive already finished (a cached read, an instant edit),
    // in which case there is no follow-up update to render its result.
    if (update.status === 'completed' || update.status === 'failed') {
      this.updateToolCall(update);
    } else {
      this.emitToolResult(toolCallId, update, false);
    }
  }

  private updateToolCall(update: ToolCallUpdate): void {
    const { toolCallId } = update;
    if (!toolCallId) return;

    // Titles and inputs arrive LATE. The adapter opens a shell call as a
    // generic "Terminal" with `rawInput: {}` and only fills in the real
    // command once the model has finished streaming the tool's arguments —
    // verified against the live adapter, not inferred. Keeping the opening
    // label would leave every shell call reading "Terminal" with no command,
    // so re-announce the call as soon as it gets more specific.
    //
    // `tool_execution_start` is keyed by id and simply replaces the entry, and
    // the accumulated result is written straight back by the emit below, so
    // re-announcing loses nothing.
    const { name, args, changed } = reconcileToolCall(update, {
      name: this.toolNames.get(toolCallId),
      args: this.toolArgs.get(toolCallId),
    });

    if (changed) {
      this.toolNames.set(toolCallId, name);
      this.toolArgs.set(toolCallId, args);
      useAiStore
        .getState()
        .handleAgentEvent({ type: 'tool_execution_start', toolCallId, toolName: name, args });
    }
    // Also covers the case where the opening `tool_call` never arrived: the
    // result would otherwise stream into a Map entry with no row to show it.
    this.upsertStreamingToolCall(toolCallId, name, args);

    const status = toolStatusFor(update.status);
    const finished = status === 'complete' || status === 'error';
    this.emitToolResult(toolCallId, update, finished, status === 'error');
  }

  /**
   * Add (or refresh) a tool call inside the streaming assistant message.
   *
   * Starts the bubble lazily, mirroring `appendStreamingText` — a tool can be
   * the first thing a turn produces, and an empty bubble pulsing before it
   * would be the same problem that method solves for text.
   *
   * Upsert, not append: the adapter opens a shell call as a generic "Terminal"
   * with `rawInput: {}` and only fills in the real command once the model has
   * finished streaming the arguments, so `updateToolCall` re-announces it.
   * Matching on the block's id keeps that a rename of one row instead of a
   * second row for the same call.
   */
  private upsertStreamingToolCall(
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
  ): void {
    if (!this.streaming) {
      this.streaming = { role: 'assistant', content: [], timestamp: Date.now() };
    }

    const existing = this.streaming.content.find(
      (b): b is ToolCall => b.type === 'toolCall' && b.id === toolCallId,
    );
    if (existing) {
      existing.name = name;
      existing.arguments = args;
    } else {
      this.streaming.content.push({ type: 'toolCall', id: toolCallId, name, arguments: args });
    }

    const ai = useAiStore.getState();
    if (!this.streamingStarted) {
      this.streamingStarted = true;
      ai.handleAgentEvent({ type: 'message_start', message: this.streaming });
    } else {
      ai.handleAgentEvent({ type: 'message_update', message: this.streaming });
    }
  }

  private emitToolResult(
    toolCallId: string,
    update: ToolCallUpdate,
    finished: boolean,
    isError = false,
  ): void {
    const name = this.toolNames.get(toolCallId) ?? 'tool';
    const text = contentToText(
      (update.content ?? [])
        .filter((c) => (c as { type?: string })?.type === 'content')
        .map((c) => (c as { content: ContentBlock }).content),
    );
    const diffs = extractDiffs(update.content);

    // Accumulate: ACP updates are incremental, so replacing the result would
    // make earlier output vanish as later chunks arrive.
    const previous = this.toolResults.get(toolCallId);
    const merged: AgentToolResult = {
      content: text
        ? [...(previous?.content ?? []), { type: 'text', text }]
        : (previous?.content ?? []),
      diffs: diffs.length > 0 ? [...(previous?.diffs ?? []), ...diffs] : previous?.diffs,
    };
    this.toolResults.set(toolCallId, merged);

    useAiStore.getState().handleAgentEvent(
      finished
        ? { type: 'tool_execution_end', toolCallId, toolName: name, result: merged, isError }
        : { type: 'tool_execution_update', toolCallId, toolName: name, result: merged },
    );
  }

  // ── Process death ─────────────────────────────────────────────

  private handleExit(info: { error?: string }): void {
    const wasPrompting = this.promptInFlight;
    this.promptInFlight = false;
    this.endTurnQuestions();
    this.client = null;
    this.acpSessionId = null;
    this.initResult = null;
    this.sessionCwd = null;

    const ai = useAiStore.getState();
    ai.setAgentBridgeRunning(false);
    // `agentConnect` is left alone on purpose. A crash is reported as the turn
    // error below, and `connect` starts a fresh subprocess on the next send
    // because `this.client` is now null — whereas flipping to `idle` here would
    // have the gate respawn the agent immediately, turning a repeatable crash
    // into a spawn loop the user cannot interrupt.
    // Every card waiting on an answer is now waiting on a dead process.
    cancelExternalAgentApprovals();
    this.finalizeStreaming('error');

    if (wasPrompting && !this.abortRequested) {
      ai.addTurnError({
        kind: 'crash',
        title: 'Claude stopped unexpectedly',
        detail: 'The agent process exited mid-turn. Send again to restart it.',
        raw: info.error ?? 'The agent process exited.',
        retriable: true,
      });
      // The store only clears `isAgentRunning` on `agent_end`; without this a
      // crash would leave the composer disabled forever.
      ai.handleAgentEvent({ type: 'agent_end', messages: [] });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The id of the newest user message — what a turn's checkpoint is anchored to. */
function currentUserMessageId(): string | null {
  const messages = useAiStore.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].id;
  }
  return null;
}

let instance: ClaudeBackend | null = null;

export function getClaudeBackend(): ClaudeBackend {
  if (!instance) instance = new ClaudeBackend();
  return instance;
}

export async function resetClaudeBackend(): Promise<void> {
  const current = instance;
  instance = null;
  // Final, unlike `dispose`'s other callers: this is an agent switch, a
  // workspace change, a sign-out or a new chat. `idle` (rather than `failed`)
  // because nothing went wrong — and because it is what tells `ClaudeSetupGate`
  // to connect again when Claude is still the selected agent.
  useAiStore.getState().setAgentConnect({ kind: 'idle' });
  await current?.dispose();
}
