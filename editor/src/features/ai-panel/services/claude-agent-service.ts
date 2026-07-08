/**
 * Claude agent service — owns one ClaudeAcpClient and translates Agent Client
 * Protocol semantics into the editor's existing AgentEvent + AiStore shape, so
 * MessageList / AssistantMessage / ToolCallBlock render Claude responses
 * exactly like Arcane responses.
 *
 * Lifecycle:
 *    ensureStarted()  →  spawn bridge → initialize → session/new
 *    sendPrompt(text) →  session/prompt → stream session/update notifications
 *                        → finally emits agent_end
 *    cancel()         →  session/cancel notification
 *    setPermissionMode/Model/Effort  →  applied at session boundary or via
 *                                       session/set_mode mid-thread
 *    dispose()        →  stop subprocess
 */

import { invoke } from '@tauri-apps/api/core';
import { ClaudeAcpClient, type AcpInstallInfo } from './claude-acp-client';
import { useAiStore, type PermissionOption } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useSettingsStore } from '../../../stores/settings';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { resolveAttachments } from './attachments';
import { loadMcpServers } from './mcp-config';
import type {
  Attachment,
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
} from './types';
import type {
  AssistantMessage,
  DiffContent,
  ToolCall,
} from './vendor/types';

interface AcpContentBlock {
  type?: string;
  text?: string;
  path?: string;
  oldText?: string;
  newText?: string;
  data?: string;
  mimeType?: string;
  /** resource_link blocks (file @-mentions) */
  uri?: string;
  name?: string;
}

interface AcpSessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: AcpContentBlock | AcpContentBlock[] | string;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    rawInput?: Record<string, unknown>;
    locations?: Array<{ path: string; line?: number }>;
    /** ACP `plan` update */
    entries?: Array<{ content?: string; status?: string; priority?: string }>;
    /** ACP `available_commands_update` */
    availableCommands?: Array<{ name?: string; description?: string }>;
    /** ACP `current_mode_update` */
    currentModeId?: string;
    [key: string]: unknown;
  };
}

interface AcpModeInfo {
  id: string;
  name?: string;
}

interface AcpModelInfo {
  modelId: string;
  name?: string;
}

/** Params the ACP client may call back into us with for terminal/* methods. */
interface AcpTerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  cwd?: string;
  outputByteLimit?: number;
}

interface AcpTerminalRefParams {
  sessionId: string;
  terminalId: string;
}

interface AcpFsReadParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

interface AcpFsWriteParams {
  sessionId: string;
  path: string;
  content: string;
}

interface AcpPermissionRequestParams {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string };
  options: PermissionOption[];
}

interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: Array<{ id: string; name: string; description?: string }>;
}

interface AcpNewSessionResult {
  sessionId: string;
  modes?: { currentModeId?: string; availableModes?: AcpModeInfo[] };
  models?: { currentModelId?: string; availableModels?: AcpModelInfo[] };
}

interface AcpPromptResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
}

class ClaudeAgentService {
  private client: ClaudeAcpClient | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  private streamingMessage: AssistantMessage | null = null;
  private streamingMessageStarted = false;
  private startInFlight: Promise<void> | null = null;

  /** Pending permission resolvers, keyed by toolCallId. */
  private permissionResolvers = new Map<
    string,
    (value: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }) => void
  >();

  /** Tool call id → display name, so tool_call_update can fill in the name. */
  private toolNameById = new Map<string, string>();

  /** Capabilities + model catalog captured from initialize / session/new. */
  private agentCapabilities: Record<string, unknown> = {};
  private availableModels: AcpModelInfo[] = [];
  private loadSessionSupported = false;

  /** While replaying a loaded session, suppress re-rendering its updates. */
  private suppressReplay = false;

  /** ACP terminalId → backend PTY id, for the terminal/* handlers. */
  private terminals = new Map<string, number>();

  /**
   * Spawn and initialize the bridge if it isn't already up. Concurrent callers
   * await the same in-flight promise.
   */
  async ensureStarted(): Promise<void> {
    if (this.initialized && this.client && this.sessionId) return;
    if (this.startInFlight) return this.startInFlight;

    this.startInFlight = this.doStart().finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async doStart(): Promise<void> {
    const workspacePath = await this.bootstrap();
    // session/new — pass user-configured MCP servers so the agent can use them.
    const mcpServers = await loadMcpServers().catch(() => []);
    try {
      const result = await this.client!.sendRequest<AcpNewSessionResult>('session/new', {
        cwd: workspacePath,
        mcpServers,
      });
      this.sessionId = result.sessionId;
      this.availableModels = result.models?.availableModels ?? [];
      useAiStore.getState().setClaudeAcpSessionId(result.sessionId);
    } catch (e) {
      await this.dispose();
      throw e;
    }

    // Apply current permission mode + model preference.
    await this.applyPermissionMode();
    await this.setModel(useAiStore.getState().claudeModel);
    this.initialized = true;
  }

  /**
   * Spawn the bridge and run the initialize handshake. Returns the workspace
   * path. Shared by doStart (session/new) and resumeSession (session/load).
   */
  private async bootstrap(): Promise<string> {
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) {
      throw new Error('Open a workspace before starting the Claude agent.');
    }

    // Pre-flight: is `claude` installed?
    const install: AcpInstallInfo = await ClaudeAcpClient.checkInstall();
    if (!install.claude_path) {
      throw new Error(
        'Claude Code CLI not found. Install it from https://code.claude.com, ' +
          'or run `npm i -g @anthropic-ai/claude-code`, then try again.',
      );
    }

    this.client = new ClaudeAcpClient({
      onRequest: (m, p) => this.handleRequest(m, p),
      onNotification: (m, p) => this.handleNotification(m, p),
      onExit: (info) => this.handleExit(info),
      onStderr: (line) => {
        // Useful in dev. Most stderr is dependency-resolution noise from npx.
        if (line && line.trim()) console.debug('[claude bridge]', line);
      },
    });

    await this.client.start(workspacePath);
    useAiStore.getState().setClaudeBridgeRunning(true);

    // initialize handshake — advertise fs + terminal so the bridge can run
    // commands through our PTY backend (see handleRequest terminal/* cases).
    try {
      const init = await this.client.sendRequest<AcpInitializeResult>('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'arcane-editor', version: '0.1.0' },
      });
      this.agentCapabilities = init.agentCapabilities ?? {};
      this.loadSessionSupported = Boolean(
        (this.agentCapabilities as { loadSession?: unknown }).loadSession,
      );
    } catch (e) {
      await this.dispose();
      throw e;
    }
    return workspacePath;
  }

  /**
   * Resume a prior Claude chat by ACP sessionId. The saved transcript is shown
   * from our own session JSON (by the caller); here we re-attach the bridge to
   * that session so the *next* prompt continues with full context.
   *
   * Returns true if the bridge loaded the session (continuation will have the
   * prior context), false if it couldn't (caller should soft-resume: a fresh
   * session that still displays the saved transcript).
   */
  async resumeSession(acpSessionId: string): Promise<boolean> {
    await this.dispose();
    let workspacePath: string;
    try {
      workspacePath = await this.bootstrap();
    } catch (e) {
      useAiStore.getState().setError(e instanceof Error ? e.message : String(e));
      return false;
    }

    if (!this.loadSessionSupported) {
      // Bridge can't load — fall back to a fresh session (soft resume).
      await this.doStartAfterBootstrap(workspacePath);
      return false;
    }

    const mcpServers = await loadMcpServers().catch(() => []);
    this.suppressReplay = true; // we already render the saved transcript
    try {
      await this.client!.sendRequest('session/load', {
        sessionId: acpSessionId,
        cwd: workspacePath,
        mcpServers,
      });
      this.sessionId = acpSessionId;
      useAiStore.getState().setClaudeAcpSessionId(acpSessionId);
      await this.applyPermissionMode();
      await this.setModel(useAiStore.getState().claudeModel);
      this.initialized = true;
      return true;
    } catch (e) {
      console.warn('session/load failed, soft-resuming:', e);
      await this.doStartAfterBootstrap(workspacePath);
      return false;
    } finally {
      this.suppressReplay = false;
    }
  }

  /** session/new on an already-bootstrapped client (soft-resume fallback). */
  private async doStartAfterBootstrap(workspacePath: string): Promise<void> {
    const mcpServers = await loadMcpServers().catch(() => []);
    const result = await this.client!.sendRequest<AcpNewSessionResult>('session/new', {
      cwd: workspacePath,
      mcpServers,
    });
    this.sessionId = result.sessionId;
    this.availableModels = result.models?.availableModels ?? [];
    useAiStore.getState().setClaudeAcpSessionId(result.sessionId);
    await this.applyPermissionMode();
    await this.setModel(useAiStore.getState().claudeModel);
    this.initialized = true;
  }

  /**
   * Send a user prompt and await stop. Streams updates through the AiStore.
   */
  async sendPrompt(text: string, attachments: Attachment[] = []): Promise<void> {
    try {
      await this.ensureStarted();
    } catch (e) {
      useAiStore
        .getState()
        .setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!this.client || !this.sessionId) return;

    const ai = useAiStore.getState();

    // Checkpoints (P5.2): open a new turn so `handleFsWrite`'s pre-write
    // snapshots below get grouped for later restore. See the matching guard
    // in agent-service.ts's sendMessage for why a missing sessionId means
    // skipping rather than mistagging the turn.
    if (ai.sessionId) {
      useCheckpointsStore.getState().beginTurn(ai.sessionId, this.currentUserMessageId());
    }

    // Resolve @-context + images into ACP content blocks before the turn starts
    // so attachment errors surface immediately.
    const prompt = await this.buildPromptBlocks(text, attachments);

    ai.handleAgentEvent({ type: 'agent_start' });

    // Pre-create the streaming assistant message so deltas have something to update.
    this.streamingMessage = {
      role: 'assistant',
      content: [],
      timestamp: Date.now(),
    };
    this.streamingMessageStarted = false;

    try {
      const result = await this.client.sendRequest<AcpPromptResult>('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      });
      this.finalizeStreamingMessage(result.stopReason);
    } catch (e) {
      this.finalizeStreamingMessage('cancelled');
      ai.setError(e instanceof Error ? e.message : String(e));
    } finally {
      ai.handleAgentEvent({ type: 'agent_end', messages: [] });
      this.streamingMessage = null;
      this.streamingMessageStarted = false;
    }
  }

  /**
   * Convert the editor's Attachment[] into ACP prompt content blocks:
   *   - text          → { type: 'text' }
   *   - image         → { type: 'image', mimeType, data }  (base64, no data: prefix)
   *   - file          → { type: 'resource_link', uri, name } (Claude reads on demand)
   *   - unity-*        → resolved to <unity-*> text via resolveAttachments()
   */
  private async buildPromptBlocks(
    text: string,
    attachments: Attachment[],
  ): Promise<AcpContentBlock[]> {
    const blocks: AcpContentBlock[] = [];
    if (text) blocks.push({ type: 'text', text });
    if (attachments.length === 0) return blocks;

    // Unity attachments have no ACP-native shape — render them to text blocks
    // using the same resolver the Arcane path uses.
    const unityish = attachments.filter(
      (a) =>
        a.kind === 'unity-doc' ||
        a.kind === 'unity-context' ||
        a.kind === 'unity-object',
    );
    if (unityish.length > 0) {
      const resolved = await resolveAttachments(unityish);
      if (resolved.warnings.length > 0) {
        useAiStore.getState().setError(resolved.warnings.join('\n'));
      }
      if (resolved.prefix) blocks.push({ type: 'text', text: resolved.prefix });
    }

    for (const a of attachments) {
      if (a.kind === 'image') {
        const comma = a.dataUrl.indexOf(',');
        const data = comma >= 0 ? a.dataUrl.slice(comma + 1) : a.dataUrl;
        if (data) blocks.push({ type: 'image', mimeType: a.mimeType, data });
      } else if (a.kind === 'file') {
        blocks.push({ type: 'resource_link', uri: pathToFileUri(a.path), name: a.relPath });
      }
    }
    return blocks;
  }

  /** Collect ACP `diff` content blocks ({path, oldText, newText}) from any content. */
  private extractDiffs(
    content: AcpContentBlock | AcpContentBlock[] | string | undefined,
  ): DiffContent[] {
    if (!content || typeof content === 'string') return [];
    const list = Array.isArray(content) ? content : [content];
    const out: DiffContent[] = [];
    for (const c of list) {
      if (c && typeof c === 'object' && c.type === 'diff') {
        out.push({
          path: c.path ?? '',
          oldText: c.oldText ?? '',
          newText: c.newText ?? '',
        });
      }
    }
    return out;
  }

  /** Stop the current prompt turn (notification — no response). */
  async cancel(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    try {
      await this.client.sendNotification('session/cancel', {
        sessionId: this.sessionId,
      });
    } catch (e) {
      console.warn('session/cancel failed:', e);
    }
    // Resolve any open permission prompts as cancelled so promises don't dangle.
    for (const [, resolve] of this.permissionResolvers) {
      resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.permissionResolvers.clear();
  }

  /** Apply the current permission mode from the store via session/set_mode. */
  async applyPermissionMode(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    const mode = useAiStore.getState().claudePermissionMode;
    try {
      await this.client.sendRequest('session/set_mode', {
        sessionId: this.sessionId,
        modeId: mode,
      });
    } catch (e) {
      // Some agent versions don't support this method; swallow.
      console.warn('session/set_mode failed:', e);
    }
  }

  /**
   * Update the Claude model. Applies live via session/set_model when the bridge
   * advertises model selection; otherwise the choice is stored and applied on
   * the next session/new. Family aliases (opus/sonnet/haiku) are resolved
   * against the bridge-advertised model ids — we never hardcode model strings.
   */
  async setModel(model: ClaudeModel): Promise<void> {
    useAiStore.getState().setClaudeModel(model);
    if (!this.client || !this.sessionId) return;
    const modelId = this.resolveModelId(model);
    if (!modelId) return; // 'auto', or no advertised match → bridge default
    try {
      await this.client.sendRequest('session/set_model', {
        sessionId: this.sessionId,
        modelId,
      });
    } catch (e) {
      // Older bridges have no runtime swap; choice still applies on next chat.
      console.warn('session/set_model failed:', e);
    }
  }

  /** Map a model family alias to a bridge-advertised model id (substring match). */
  private resolveModelId(model: ClaudeModel): string | null {
    if (model === 'auto') return null;
    const match = this.availableModels.find((m) =>
      m.modelId.toLowerCase().includes(model),
    );
    return match?.modelId ?? null;
  }

  setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    useAiStore.getState().setClaudePermissionMode(mode);
    return this.applyPermissionMode();
  }

  setEffort(effort: ClaudeEffort): void {
    // Effort has no standardized ACP runtime channel; store it so the picker
    // reflects the selection and it can be applied on the next session/new.
    useAiStore.getState().setClaudeEffort(effort);
  }

  /**
   * Called by the permission UI when the user clicks a button.
   */
  resolvePermission(toolCallId: string, optionId: string): void {
    const resolver = this.permissionResolvers.get(toolCallId);
    if (!resolver) return;
    this.permissionResolvers.delete(toolCallId);
    useAiStore.getState().resolvePermissionRequest(toolCallId, optionId);
    resolver({ outcome: { outcome: 'selected', optionId } });
  }

  async dispose(): Promise<void> {
    if (this.client) {
      try {
        await this.client.stop();
      } catch {
        // Ignore
      }
      this.client = null;
    }
    this.initialized = false;
    this.sessionId = null;
    this.streamingMessage = null;
    this.streamingMessageStarted = false;
    this.suppressReplay = false;
    this.permissionResolvers.clear();
    this.toolNameById.clear();
    this.terminals.clear();
    this.availableModels = [];
    this.loadSessionSupported = false;
    this.agentCapabilities = {};
    useAiStore.getState().setClaudeBridgeRunning(false);
  }

  // ── ACP request handlers (bridge → editor) ──────────────────

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file':
        return this.handleFsRead(params as AcpFsReadParams);
      case 'fs/write_text_file':
        return this.handleFsWrite(params as AcpFsWriteParams);
      case 'session/request_permission':
        return this.handlePermissionRequest(params as AcpPermissionRequestParams);
      case 'terminal/create':
        return this.handleTerminalCreate(params as AcpTerminalCreateParams);
      case 'terminal/output':
        return this.handleTerminalOutput(params as AcpTerminalRefParams);
      case 'terminal/wait_for_exit':
        return this.handleTerminalWait(params as AcpTerminalRefParams);
      case 'terminal/kill':
        return this.handleTerminalKill(params as AcpTerminalRefParams);
      case 'terminal/release':
        return this.handleTerminalRelease(params as AcpTerminalRefParams);
      default:
        throw new Error(`Unhandled ACP method: ${method}`);
    }
  }

  // ── ACP terminal/* → Rust PTY backend (terminal.rs acp_terminal_*) ──

  private async handleTerminalCreate(
    p: AcpTerminalCreateParams,
  ): Promise<{ terminalId: string }> {
    const id = await invoke<number>('acp_terminal_create', {
      command: p.command,
      args: p.args ?? [],
      cwd: p.cwd ?? useWorkspaceStore.getState().workspacePath ?? null,
      env: p.env ?? [],
      outputByteLimit: p.outputByteLimit ?? null,
    });
    const terminalId = `term_${id}`;
    this.terminals.set(terminalId, id);
    return { terminalId };
  }

  private async handleTerminalOutput(p: AcpTerminalRefParams): Promise<{
    output: string;
    truncated: boolean;
    exitStatus: { exitCode: number | null; signal: string | null } | null;
  }> {
    const id = this.terminals.get(p.terminalId);
    if (id === undefined) throw new Error(`Unknown terminalId: ${p.terminalId}`);
    const r = await invoke<{
      output: string;
      truncated: boolean;
      exited: boolean;
      exit_code: number | null;
      signal: string | null;
    }>('acp_terminal_output', { id });
    return {
      output: r.output,
      truncated: r.truncated,
      exitStatus: r.exited ? { exitCode: r.exit_code, signal: r.signal } : null,
    };
  }

  private async handleTerminalWait(
    p: AcpTerminalRefParams,
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const id = this.terminals.get(p.terminalId);
    if (id === undefined) throw new Error(`Unknown terminalId: ${p.terminalId}`);
    const r = await invoke<{ exit_code: number | null; signal: string | null }>(
      'acp_terminal_wait',
      { id },
    );
    return { exitCode: r.exit_code, signal: r.signal };
  }

  private async handleTerminalKill(p: AcpTerminalRefParams): Promise<null> {
    const id = this.terminals.get(p.terminalId);
    if (id !== undefined) await invoke('acp_terminal_kill', { id });
    return null;
  }

  private async handleTerminalRelease(p: AcpTerminalRefParams): Promise<null> {
    const id = this.terminals.get(p.terminalId);
    if (id !== undefined) {
      await invoke('acp_terminal_release', { id });
      this.terminals.delete(p.terminalId);
    }
    return null;
  }

  private async handleFsRead(params: AcpFsReadParams): Promise<{ content: string }> {
    const content = await invoke<string>('read_file', { path: params.path });
    if (params.line !== undefined || params.limit !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(0, (params.line ?? 1) - 1);
      const end = params.limit !== undefined ? start + params.limit : undefined;
      return { content: lines.slice(start, end).join('\n') };
    }
    return { content };
  }

  private async handleFsWrite(params: AcpFsWriteParams): Promise<null> {
    // Checkpoints (P5.2): snapshot the pre-write content before the actual
    // write, same rule as the Arcane path's checkpoint-gate.ts — read-before-
    // write is the only order that captures the pre-image at all. ACP
    // fs/write_text_file paths are absolute per spec, so no cwd resolution
    // needed here (unlike checkpoint-gate.ts, which resolves the vendor
    // write/edit tools' relative-or-absolute path convention).
    if (useSettingsStore.getState().getSetting('ai.checkpoints.enabled') !== false) {
      const before = await invoke<string>('read_file', { path: params.path }).catch(() => null);
      useCheckpointsStore.getState().recordPreWrite(params.path, before);
    }
    await invoke('write_file', { path: params.path, contents: params.content });
    return null;
  }

  /** The AiMessage id of the most recent user message — mirrors agent-service.ts's helper. */
  private currentUserMessageId(): string {
    const messages = useAiStore.getState().messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return `turn_${Date.now()}`;
  }

  private handlePermissionRequest(
    params: AcpPermissionRequestParams,
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    const toolCallId = params.toolCall?.toolCallId ?? `perm_${Date.now()}`;
    const toolName = params.toolCall?.title;
    useAiStore.getState().addPermissionRequest(toolCallId, toolName, params.options);

    return new Promise((resolve) => {
      this.permissionResolvers.set(toolCallId, resolve);
    });
  }

  // ── Notifications (bridge → editor) ─────────────────────────

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    this.applySessionUpdate(params as AcpSessionUpdate);
  }

  private applySessionUpdate(payload: AcpSessionUpdate): void {
    const update = payload?.update;
    if (!update) return;
    const ai = useAiStore.getState();

    // During session/load replay we already display the saved transcript, so
    // skip re-rendering replayed turns (plan/commands/mode still apply below).
    if (
      this.suppressReplay &&
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk' ||
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update')
    ) {
      return;
    }

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        this.ensureStreamingStarted();
        const text = this.contentToText(update.content);
        if (!text) return;
        if (!this.streamingMessage) return;
        const last =
          this.streamingMessage.content[this.streamingMessage.content.length - 1];
        if (last && last.type === 'text') {
          last.text += text;
        } else {
          this.streamingMessage.content.push({ type: 'text', text });
        }
        this.emitMessageUpdate();
        break;
      }
      case 'agent_thought_chunk': {
        this.ensureStreamingStarted();
        const text = this.contentToText(update.content);
        if (!text || !this.streamingMessage) return;
        const last =
          this.streamingMessage.content[this.streamingMessage.content.length - 1];
        if (last && last.type === 'thinking') {
          last.thinking += text;
        } else {
          this.streamingMessage.content.push({ type: 'thinking', thinking: text });
        }
        this.emitMessageUpdate();
        break;
      }
      case 'tool_call': {
        this.ensureStreamingStarted();
        const toolCallId = update.toolCallId;
        if (!toolCallId || !this.streamingMessage) return;
        const name = update.title || update.kind || 'tool';
        this.toolNameById.set(toolCallId, name);
        const tc: ToolCall = {
          type: 'toolCall',
          id: toolCallId,
          name,
          arguments: (update.rawInput as Record<string, unknown>) ?? {},
        };
        this.streamingMessage.content.push(tc);
        this.emitMessageUpdate();
        ai.handleAgentEvent({
          type: 'tool_execution_start',
          toolCallId,
          toolName: name,
          args: (update.rawInput as Record<string, unknown>) ?? {},
        });
        // Surface any edit-review diffs as soon as they arrive.
        const startDiffs = this.extractDiffs(update.content);
        if (startDiffs.length > 0) {
          ai.handleAgentEvent({
            type: 'tool_execution_update',
            toolCallId,
            toolName: name,
            result: { content: [], diffs: startDiffs },
          });
        }
        // If the tool call arrived already completed (Claude's "read" tool
        // often does this), fold its content in immediately.
        if (update.status === 'completed' || update.status === 'failed') {
          const text = this.contentToText(update.content);
          ai.handleAgentEvent({
            type: 'tool_execution_end',
            toolCallId,
            toolName: name,
            result: {
              content: [{ type: 'text', text }],
              diffs: startDiffs.length ? startDiffs : undefined,
            },
            isError: update.status === 'failed',
          });
        }
        break;
      }
      case 'tool_call_update': {
        const toolCallId = update.toolCallId;
        if (!toolCallId) return;
        const name = this.toolNameById.get(toolCallId) ?? '';
        const text = this.contentToText(update.content);
        const diffs = this.extractDiffs(update.content);
        if (update.status === 'completed' || update.status === 'failed') {
          ai.handleAgentEvent({
            type: 'tool_execution_end',
            toolCallId,
            toolName: name,
            result: {
              content: [{ type: 'text', text }],
              diffs: diffs.length ? diffs : undefined,
            },
            isError: update.status === 'failed',
          });
        } else if (text || diffs.length) {
          ai.handleAgentEvent({
            type: 'tool_execution_update',
            toolCallId,
            toolName: name,
            result: {
              content: text ? [{ type: 'text', text }] : [],
              diffs: diffs.length ? diffs : undefined,
            },
          });
        }
        break;
      }
      case 'plan': {
        const entries = update.entries ?? [];
        ai.setClaudePlan(
          entries.map((e) => ({
            content: e.content ?? '',
            status:
              e.status === 'in_progress' || e.status === 'completed'
                ? e.status
                : 'pending',
            priority: e.priority,
          })),
        );
        break;
      }
      case 'available_commands_update': {
        const cmds = update.availableCommands ?? [];
        ai.setClaudeAvailableCommands(
          cmds.map((c) => ({ name: c.name ?? '', description: c.description })),
        );
        break;
      }
      case 'current_mode_update': {
        const modeId = update.currentModeId ?? null;
        ai.setClaudeCurrentMode(modeId);
        // Reflect a self-initiated mode switch in the permission-mode picker.
        if (
          modeId === 'default' ||
          modeId === 'acceptEdits' ||
          modeId === 'plan' ||
          modeId === 'bypassPermissions'
        ) {
          ai.setClaudePermissionMode(modeId);
        }
        break;
      }
      default:
        break;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * Emit `message_start` lazily on the first content chunk. Without this,
   * the UI flashes an empty assistant bubble whenever the model thinks before
   * speaking.
   */
  private ensureStreamingStarted(): void {
    if (this.streamingMessageStarted || !this.streamingMessage) return;
    this.streamingMessageStarted = true;
    useAiStore.getState().handleAgentEvent({
      type: 'message_start',
      message: { ...this.streamingMessage, content: [] },
    });
  }

  private emitMessageUpdate(): void {
    if (!this.streamingMessage) return;
    useAiStore.getState().handleAgentEvent({
      type: 'message_update',
      message: {
        ...this.streamingMessage,
        content: this.streamingMessage.content.map((c) => ({ ...c })),
      },
    });
  }

  private finalizeStreamingMessage(stopReason: AcpPromptResult['stopReason']): void {
    if (!this.streamingMessage) return;
    if (!this.streamingMessageStarted) {
      // Nothing was ever streamed (e.g. cancelled before first chunk). Nothing
      // to finalize — the message_start was never emitted.
      return;
    }
    useAiStore.getState().handleAgentEvent({
      type: 'message_end',
      message: {
        ...this.streamingMessage,
        stopReason: this.translateStopReason(stopReason),
      },
    });
  }

  private translateStopReason(
    reason: AcpPromptResult['stopReason'],
  ): 'stop' | 'length' | 'aborted' | 'error' {
    switch (reason) {
      case 'max_tokens':
      case 'max_turn_requests':
        return 'length';
      case 'cancelled':
        return 'aborted';
      case 'refusal':
        return 'error';
      default:
        return 'stop';
    }
  }

  private contentToText(
    content: AcpContentBlock | AcpContentBlock[] | string | undefined,
  ): string {
    if (content === undefined || content === null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c) => this.contentToText(c)).join('');
    }
    if (content.type === 'text') return content.text ?? '';
    // diff blocks are rendered separately as DiffBlocks (see extractDiffs).
    if (content.type === 'diff') return '';
    return '';
  }

  private handleExit(info: { error?: string }): void {
    useAiStore.getState().setClaudeBridgeRunning(false);
    this.initialized = false;
    this.sessionId = null;
    this.client = null;
    if (info.error) {
      useAiStore.getState().setError(`Claude bridge exited: ${info.error}`);
    }
    // Clear any pending permission resolvers so awaiters don't dangle.
    for (const [, resolve] of this.permissionResolvers) {
      resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.permissionResolvers.clear();
  }
}

/** Convert an absolute filesystem path to a file:// URI for ACP resource_link. */
function pathToFileUri(absPath: string): string {
  const normalized = absPath.startsWith('/') ? absPath : `/${absPath}`;
  return `file://${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

// ── Singleton ─────────────────────────────────────────────────

let instance: ClaudeAgentService | null = null;

export function getClaudeAgentService(): ClaudeAgentService {
  if (!instance) instance = new ClaudeAgentService();
  return instance;
}

export async function resetClaudeAgentService(): Promise<void> {
  if (instance) {
    await instance.dispose();
    instance = null;
  }
}
