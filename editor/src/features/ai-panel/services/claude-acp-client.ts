/**
 * Minimal Agent Client Protocol (ACP) client over Tauri events.
 *
 * Talks to the `@agentclientprotocol/claude-agent-acp` bridge that the Rust
 * side spawns. Wire format is JSON-RPC 2.0, one message per line. Rust forwards
 * each line as a `claude-message` Tauri event and writes outgoing lines via
 * the `claude_send` command.
 *
 * Responsibilities:
 *   - Auto-increment JSON-RPC request ids and correlate responses
 *   - Dispatch incoming requests (fs/*, terminal/*, session/request_permission)
 *     to a user-supplied handler
 *   - Forward notifications (session/update) to a user-supplied handler
 *
 * No ACP semantics live here — the agent service layer translates session/update
 * into the editor's AgentEvent shape.
 *
 * ACP spec: https://agentclientprotocol.com
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface AcpInstallInfo {
  claude_path: string | null;
  node_path: string | null;
  bridge_path: string | null;
}

export interface AcpClientOptions {
  /**
   * Handle a request *from* the bridge to the client. Return a value (becomes
   * `result`) or throw (becomes `error`). Common methods: `fs/read_text_file`,
   * `fs/write_text_file`, `session/request_permission`.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;

  /**
   * Handle a notification *from* the bridge. Most common: `session/update`.
   */
  onNotification?: (method: string, params: unknown) => void;

  /**
   * Called when the bridge process exits unexpectedly.
   */
  onExit?: (info: { error?: string }) => void;

  /**
   * Called for every stderr line — useful for surfacing bridge errors in
   * dev logs without showing them in the chat.
   */
  onStderr?: (line: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class ClaudeAcpClient {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private unlistens: UnlistenFn[] = [];
  private opts: AcpClientOptions;
  private started = false;

  constructor(opts: AcpClientOptions = {}) {
    this.opts = opts;
  }

  /**
   * Check what's installed locally. Does not spawn anything.
   */
  static async checkInstall(): Promise<AcpInstallInfo> {
    return invoke<AcpInstallInfo>('claude_check_install');
  }

  /**
   * Spawn the bridge subprocess and start listening. Idempotent: calling
   * twice is a no-op.
   */
  async start(workspacePath: string, executableOverride?: string): Promise<void> {
    if (this.started) return;

    // Subscribe before spawn so we don't miss the bridge's initial output.
    const unlistenMsg = await listen<{ body: string }>('claude-message', (event) => {
      this.handleIncomingLine(event.payload.body);
    });
    const unlistenExit = await listen<{ error?: string }>('claude-exited', (event) => {
      this.handleExit(event.payload?.error);
    });
    const unlistenStderr = await listen<{ body: string }>('claude-stderr', (event) => {
      this.opts.onStderr?.(event.payload.body);
    });
    this.unlistens = [unlistenMsg, unlistenExit, unlistenStderr];

    try {
      await invoke('claude_start', {
        workspacePath,
        executableOverride: executableOverride ?? null,
      });
      this.started = true;
    } catch (error) {
      for (const u of this.unlistens) u();
      this.unlistens = [];
      throw error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : JSON.stringify(error));
    }
  }

  /**
   * Send a JSON-RPC request and await the response.
   */
  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.started) {
      throw new Error(`Cannot send '${method}': Claude bridge is not started`);
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        method,
      });
    });
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    try {
      await invoke('claude_send', { message: payload });
    } catch (error) {
      this.pending.delete(id);
      throw error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : JSON.stringify(error));
    }
    return promise;
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    if (!this.started) {
      throw new Error(`Cannot send notification '${method}': bridge not started`);
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    await invoke('claude_send', { message: payload });
  }

  /**
   * Stop the bridge subprocess and tear down listeners. Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const u of this.unlistens) u();
    this.unlistens = [];
    for (const [, pending] of this.pending) {
      pending.reject(new Error('Claude bridge stopped'));
    }
    this.pending.clear();
    try {
      await invoke('claude_stop');
    } catch {
      // Ignore — process may already be dead
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private handleIncomingLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      console.warn('[acp] failed to parse line:', trimmed);
      return;
    }

    // Response (has id + (result | error), no method)
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        console.warn('[acp] response for unknown id', msg.id);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new Error(`ACP ${pending.method} failed: ${msg.error.message || 'unknown'}`),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Request (has id + method)
    if (msg.id !== undefined && msg.method !== undefined) {
      this.dispatchIncomingRequest(msg.id, msg.method, msg.params).catch((e) => {
        console.error('[acp] request dispatch failed:', e);
      });
      return;
    }

    // Notification (method, no id)
    if (msg.method !== undefined) {
      try {
        this.opts.onNotification?.(msg.method, msg.params);
      } catch (e) {
        console.error('[acp] notification handler threw:', e);
      }
      return;
    }

    console.warn('[acp] unrecognized message:', msg);
  }

  private async dispatchIncomingRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!this.opts.onRequest) {
      await this.sendError(id, -32601, `Method not handled: ${method}`);
      return;
    }
    try {
      const result = await this.opts.onRequest(method, params);
      await this.sendResult(id, result ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.sendError(id, -32603, msg);
    }
  }

  private async sendResult(id: number | string, result: unknown): Promise<void> {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    try {
      await invoke('claude_send', { message: payload });
    } catch (e) {
      console.error('[acp] failed to send result:', e);
    }
  }

  private async sendError(
    id: number | string,
    code: number,
    message: string,
  ): Promise<void> {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
    try {
      await invoke('claude_send', { message: payload });
    } catch (e) {
      console.error('[acp] failed to send error:', e);
    }
  }

  private handleExit(error?: string): void {
    this.started = false;
    for (const u of this.unlistens) u();
    this.unlistens = [];
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`Claude bridge exited${error ? `: ${error}` : ''}`));
    }
    this.pending.clear();
    this.opts.onExit?.({ error });
  }
}
