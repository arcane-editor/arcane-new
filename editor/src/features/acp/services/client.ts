/**
 * Minimal Agent Client Protocol client, speaking JSON-RPC 2.0 over Tauri events.
 *
 * Rust owns the subprocess (`src-tauri/src/acp.rs`): it forwards each line the
 * agent writes to stdout as an `acp-message` event and writes lines we hand to
 * `acp_send` back to the agent's stdin. Wire format is ONE JSON OBJECT PER LINE
 * — not LSP-style `Content-Length` framing.
 *
 * This class is deliberately semantics-free. It owns exactly four things:
 *   - request-id allocation and response correlation (with a timeout)
 *   - dispatching agent→client requests to a handler and replying
 *   - forwarding agent→client notifications to a handler
 *   - failing every in-flight request when the agent dies
 *
 * Everything that knows what a `session/update` MEANS lives one layer up, in
 * `features/ai-panel/services/claude-backend.ts`.
 */

import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listenScoped, safeUnlisten } from '../../../utils/tauri-listener';
import { AcpRequestError, toMessage, type JsonRpcErrorBody, AcpMethodNotFoundError } from './errors';
import { ACP_INTERNAL_ERROR, ACP_METHOD_NOT_FOUND } from './protocol';

/**
 * Matches the LSP client's budget. Long, because a `session/prompt` legitimately
 * runs for many minutes — but not unbounded, because a wedged agent must not
 * leave the composer disabled forever.
 */
export const ACP_REQUEST_TIMEOUT_MS = 180_000;

/** `session/prompt` is the one request allowed to outlive the default budget. */
export const ACP_PROMPT_TIMEOUT_MS = 30 * 60_000;

/**
 * Everything this client needs from the outside world. Extracted so tests can
 * drive the protocol without a webview, exactly as `hosted-stream.ts` takes an
 * injectable `fetchImpl`. Production always uses `tauriAcpTransport`.
 */
export interface AcpTransport {
  start(params: {
    agentId: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string> | null;
  }): Promise<void>;
  send(agentId: string, message: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  /** Subscribe to one Tauri event; resolves with its unlisten function. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
  unlisten(fn: UnlistenFn): void;
}

export const tauriAcpTransport: AcpTransport = {
  // Spelled out rather than spread: `check-invoke-args.mjs` matches the payload
  // literally against the Rust signature, and a spread is invisible to it.
  start: ({ agentId, command, args, cwd, env }) =>
    invoke('acp_start', { agentId, command, args, cwd, env }),
  send: (agentId, message) => invoke('acp_send', { agentId, message }),
  stop: (agentId) => invoke('acp_stop', { agentId }),
  listen: <T,>(event: string, handler: (payload: T) => void) =>
    listenScoped<T>(event, (e) => handler(e.payload)),
  unlisten: (fn) => safeUnlisten(fn),
};

export interface AcpClientOptions {
  /**
   * Which agent this client drives. Rust tags every event with it so several
   * agents can share one event channel.
   */
  agentId: string;
  /**
   * Handle a request FROM the agent. Return a value (becomes `result`) or throw
   * (becomes `error`). Methods: `fs/*`, `terminal/*`,
   * `session/request_permission`.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  /** Handle a notification from the agent. Most common: `session/update`. */
  onNotification?: (method: string, params: unknown) => void;
  /** The agent process exited — expectedly or not. */
  onExit?: (info: { error?: string }) => void;
  /** Every stderr line, for the diagnostics panel and the trace log. */
  onStderr?: (line: string) => void;
  /** Test seam. Defaults to the real Tauri transport. */
  transport?: AcpTransport;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export class AcpClient {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private unlistens: UnlistenFn[] = [];
  private readonly opts: AcpClientOptions;
  private readonly transport: AcpTransport;
  private started = false;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
    this.transport = opts.transport ?? tauriAcpTransport;
  }

  get isRunning(): boolean {
    return this.started;
  }

  /**
   * Spawn the agent and start listening. Idempotent.
   *
   * Listeners are attached BEFORE `acp_start` on purpose: Rust's reader task
   * begins emitting the instant the process is spawned, and Tauri silently
   * discards an emit that has no registered listener (it returns `Ok(())`), so
   * subscribing afterwards can lose the agent's first message.
   */
  async start(params: {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
  }): Promise<void> {
    if (this.started) return;

    const { agentId } = this.opts;
    const unlistens = await Promise.all([
      this.transport.listen<{ agentId: string; body: string }>('acp-message', (payload) => {
        if (payload.agentId !== agentId) return;
        this.handleIncomingLine(payload.body);
      }),
      this.transport.listen<{ agentId: string; error?: string }>('acp-exited', (payload) => {
        if (payload.agentId !== agentId) return;
        this.handleExit(payload.error);
      }),
      this.transport.listen<{ agentId: string; body: string }>('acp-stderr', (payload) => {
        if (payload.agentId !== agentId) return;
        this.opts.onStderr?.(payload.body);
      }),
    ]);
    this.unlistens = unlistens;

    try {
      await this.transport.start({
        agentId,
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        env: params.env ?? null,
      });
      this.started = true;
    } catch (error) {
      this.detachListeners();
      throw new Error(toMessage(error));
    }
  }

  /**
   * Send a JSON-RPC request and await its response.
   *
   * Deliberately NOT `async`: the caller must receive the pending promise in
   * the same tick it was created. An `await` before the `return` leaves the
   * promise unowned while the write is in flight, and an agent that dies in
   * that window rejects a promise nobody is holding — an unhandled rejection
   * for what is, from the caller's side, an ordinary failed request.
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = ACP_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.started) {
      return Promise.reject(new Error(`Cannot send '${method}': the agent is not running.`));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        method,
        timer,
      });
    });

    void this.write({ jsonrpc: '2.0', id, method, params }).catch((error) => {
      this.settle(id)?.reject(new Error(toMessage(error)));
    });
    return promise;
  }

  /** Send a JSON-RPC notification (no response is expected or awaited). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.started) {
      throw new Error(`Cannot notify '${method}': the agent is not running.`);
    }
    await this.write({ jsonrpc: '2.0', method, params });
  }

  /** Kill the agent and tear down listeners. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.detachListeners();
    this.rejectAllPending(new Error('The agent was stopped.'));
    try {
      await this.transport.stop(this.opts.agentId);
    } catch {
      // The process may already be gone; stopping is best-effort by design.
    }
  }

  // ── Internals ──────────────────────────────────────────────────

  private async write(message: unknown): Promise<void> {
    await this.transport.send(this.opts.agentId, JSON.stringify(message));
  }

  private settle(id: number | string): PendingRequest | undefined {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
    return entry;
  }

  private detachListeners(): void {
    for (const unlisten of this.unlistens) this.transport.unlisten(unlisten);
    this.unlistens = [];
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private handleIncomingLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      // Not our problem to fix: the adapter redirects console.* to stderr, but
      // a stray stdout write from a nested tool would land here. Drop it — the
      // Rust trace log keeps the raw line for debugging.
      console.warn('[acp] ignoring non-JSON line from agent');
      return;
    }

    // Response: has an id and no method.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.settle(msg.id);
      if (!entry) {
        // A response to a request we already timed out or abandoned.
        return;
      }
      if (msg.error) {
        entry.reject(new AcpRequestError(entry.method, msg.error));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Request: has both an id and a method.
    if (msg.id !== undefined && msg.method !== undefined) {
      void this.dispatchRequest(msg.id, msg.method, msg.params);
      return;
    }

    // Notification: a method, no id.
    if (msg.method !== undefined) {
      try {
        this.opts.onNotification?.(msg.method, msg.params);
      } catch (e) {
        // A throwing UI handler must not take down the protocol loop.
        console.error('[acp] notification handler threw:', e);
      }
      return;
    }
  }

  private async dispatchRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!this.opts.onRequest) {
      await this.reply(id, { error: { code: ACP_METHOD_NOT_FOUND, message: `Unhandled: ${method}` } });
      return;
    }
    try {
      const result = await this.opts.onRequest(method, params);
      await this.reply(id, { result: result ?? null });
    } catch (e) {
      const code =
        e instanceof AcpMethodNotFoundError ? ACP_METHOD_NOT_FOUND : ACP_INTERNAL_ERROR;
      await this.reply(id, { error: { code, message: toMessage(e) } });
    }
  }

  private async reply(
    id: number | string,
    body: { result: unknown } | { error: JsonRpcErrorBody },
  ): Promise<void> {
    try {
      await this.write({ jsonrpc: '2.0', id, ...body });
    } catch (e) {
      // The agent died between receiving its request and our reply. Nothing to
      // do — the exit handler is about to fail everything anyway.
      console.error('[acp] failed to reply:', toMessage(e));
    }
  }

  private handleExit(error?: string): void {
    if (!this.started) return;
    this.started = false;
    this.detachListeners();
    this.rejectAllPending(new Error(error ? `The agent exited: ${error}` : 'The agent exited.'));
    this.opts.onExit?.({ error });
  }
}
