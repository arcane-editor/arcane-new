import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listenScoped } from '../../../utils/tauri-listener';

/**
 * Debug Adapter Protocol client. Speaks DAP to the Rust DAP host (`dap.rs`)
 * which spawns the mono-debug adapter and relays its `Content-Length`-framed
 * stdio over the `dap-message` / `dap-exited` Tauri events.
 *
 * Mirrors the LSP client's seq-correlation pattern: each request gets a unique
 * `seq`; responses carry `request_seq`, which we match against a pending map.
 * Adapter-initiated events (stopped/continued/terminated/output…) are fanned
 * out to registered handlers so the debug store can drive UI state.
 */

export interface DapResponse {
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEvent {
  type: 'event';
  event: string;
  body?: unknown;
}

type DapEventHandler = (body: unknown) => void;

interface PendingRequest {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15_000;

class DapClient {
  private nextSeq = 1;
  private pending = new Map<number, PendingRequest>();
  private eventHandlers = new Map<string, Set<DapEventHandler>>();
  private unlistenMessage: UnlistenFn | null = null;
  private unlistenExited: UnlistenFn | null = null;
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  /** Subscribe to a DAP event (e.g. 'stopped', 'continued', 'terminated', 'output'). */
  on(event: string, handler: DapEventHandler): () => void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  /** Spawn the adapter and attach event listeners. Throws if Mono/adapter missing. */
  async start(): Promise<void> {
    if (this.running) return;
    // Attach listeners BEFORE starting so we don't miss the adapter's early
    // 'initialized' event (the host emits the instant dap_start returns).
    this.unlistenMessage = await listenScoped<string>('dap-message', (e) => {
      this.handleMessage(e.payload);
    });
    this.unlistenExited = await listenScoped('dap-exited', () => {
      this.handleExit();
    });
    try {
      await invoke('dap_start');
      this.running = true;
    } catch (err) {
      await this.cleanupListeners();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private handleMessage(raw: string): void {
    let msg: DapResponse | DapEvent;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'response') {
      const pending = this.pending.get(msg.request_seq);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.request_seq);
      if (msg.success) {
        pending.resolve(msg.body);
      } else {
        pending.reject(new Error(msg.message || `DAP ${msg.command} failed`));
      }
    } else if (msg.type === 'event') {
      const handlers = this.eventHandlers.get(msg.event);
      if (handlers) {
        for (const h of handlers) h(msg.body);
      }
    }
  }

  private handleExit(): void {
    this.running = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Debug adapter exited'));
    }
    this.pending.clear();
    const handlers = this.eventHandlers.get('__exited');
    if (handlers) for (const h of handlers) h(undefined);
  }

  /** Send a DAP request and await its response body. */
  async request<T = unknown>(command: string, args?: unknown): Promise<T> {
    if (!this.running) throw new Error('Debug adapter is not running');
    const seq = this.nextSeq++;
    const payload = JSON.stringify({ seq, type: 'request', command, arguments: args });
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP request '${command}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(seq, { resolve, reject, timer });
    });
    await invoke('dap_send', { message: payload });
    return result as Promise<T>;
  }

  async stop(): Promise<void> {
    if (this.running) {
      try {
        await this.request('disconnect', { terminateDebuggee: false });
      } catch {
        /* adapter may already be gone */
      }
    }
    try {
      await invoke('dap_stop');
    } catch {
      /* ignore */
    }
    this.handleExit();
    await this.cleanupListeners();
  }

  private async cleanupListeners(): Promise<void> {
    this.unlistenMessage?.();
    this.unlistenExited?.();
    this.unlistenMessage = null;
    this.unlistenExited = null;
    this.running = false;
  }
}

/** Singleton DAP client (one debug session at a time). */
export const dapClient = new DapClient();
