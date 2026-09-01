import { invoke } from '@tauri-apps/api/core';
import { safeUnlisten, listenScoped } from '../../../utils/tauri-listener';
import { fileUri } from './document-sync';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  method: string;
}

/**
 * Tagged error for LSP request cancellation/content-modified codes
 * (-32800 / -32801 / -32802). These fire constantly during normal use
 * — pyright and typescript-language-server cancel superseded requests
 * — so callers can `instanceof`-check this to swallow them quietly
 * instead of treating them as real failures.
 */
export class LspRequestCanceledError extends Error {
  readonly code: number;
  constructor(method: string, languageId: string, code: number) {
    super(`LSP request '${method}' (${languageId}) canceled (${code})`);
    this.name = 'LspRequestCanceledError';
    this.code = code;
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  params?: unknown;
}

/**
 * Tagged event payload emitted by the Rust backend so the frontend can
 * fan-in by language with a single global listener.
 */
interface LspEventPayload {
  language: string;
  body: string;
}

const REQUEST_TIMEOUT_MS = 180_000;
const STDERR_RING_SIZE = 50;

// ── workspace/applyEdit handler injection ───────────────────────

/** LSP `ApplyWorkspaceEditResult` shape sent back to the server. */
export interface ApplyEditResult {
  applied: boolean;
  failureReason?: string;
}

export type ApplyEditHandler = (edit: unknown) => Promise<ApplyEditResult>;

/**
 * Handler for server-initiated `workspace/applyEdit` requests, injected
 * by workspace-edit.ts during provider registration (see
 * `registerApplyEditHandler`). Injection — instead of importing
 * workspace-edit.ts here — avoids the import cycle client.ts →
 * workspace-edit.ts → stores/workspace.ts → features/lsp barrel →
 * client.ts. Module-level because a WorkspaceEdit applies across the
 * whole workspace regardless of which language server sent it.
 */
let applyEditHandler: ApplyEditHandler | null = null;

export function setApplyEditHandler(fn: ApplyEditHandler | null): void {
  applyEditHandler = fn;
}

/**
 * One JSON-RPC client bound to a single language server. The backend
 * tracks one process per language; this class tracks one client per
 * language and filters Tauri events by the `language` field on the
 * payload so multiple `LspClient` instances can share the same global
 * `lsp-message` / `lsp-stderr` / `lsp-exited` event channels.
 */
export class LspClient {
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  private unlisten: (() => void) | null = null;
  private unlistenExited: (() => void) | null = null;
  private unlistenStderr: (() => void) | null = null;
  private exitedCallback: (() => void) | null = null;
  private running = false;
  private stderrRing: string[] = [];
  private serverCapabilities: Record<string, unknown> | null = null;

  constructor(public readonly languageId: string) {}

  /**
   * Start the LSP server for this language and perform the initialize
   * handshake. Defensively releases any prior listeners/notification
   * handlers/pending requests before starting.
   */
  async start(workspacePath: string, solutionPath?: string): Promise<void> {
    if (this.running || this.unlisten || this.unlistenExited || this.unlistenStderr) {
      this.cleanup();
    }

    // Attach listeners BEFORE spawning the child. The Rust backend's
    // stdout/stderr reader tasks start emitting events the instant
    // `lsp_start` returns, so registering listeners after the invoke
    // would race against that — early stderr lines (e.g. the `csharp-ls
    // 0.22.0.0 initializing` banner) would be lost.
    this.unlisten = await listenScoped<LspEventPayload>('lsp-message', (event) => {
      if (event.payload.language !== this.languageId) return;
      this.handleMessage(event.payload.body);
    });

    this.unlistenExited = await listenScoped<LspEventPayload>('lsp-exited', (event) => {
      if (event.payload.language !== this.languageId) return;
      if (!this.running) return; // Already stopped via stop()
      console.warn(`[LSP ${this.languageId}] Server process exited unexpectedly`);
      this.running = false;
      for (const [id, pending] of this.pendingRequests) {
        this.clearPendingTimeout(
          id,
          pending as PendingRequest & { timeoutId?: ReturnType<typeof setTimeout> },
        );
        pending.reject(new Error(`LSP server (${this.languageId}) exited`));
      }
      this.pendingRequests.clear();
      if (this.exitedCallback) this.exitedCallback();
    });

    // Capture stderr lines into a ring buffer for diagnostics surfacing.
    this.unlistenStderr = await listenScoped<LspEventPayload>('lsp-stderr', (event) => {
      if (event.payload.language !== this.languageId) return;
      this.stderrRing.push(event.payload.body);
      if (this.stderrRing.length > STDERR_RING_SIZE) {
        this.stderrRing.splice(0, this.stderrRing.length - STDERR_RING_SIZE);
      }
    });

    try {
      await invoke('lsp_start', {
        language: this.languageId,
        workspacePath,
        solutionPath,
      });
    } catch (err) {
      // Spawn failed — clean up the listeners we just attached so we don't
      // leak them when the caller catches and recovers.
      this.cleanup();
      throw err;
    }

    // Shares `fileUri` with document-sync so the root and the documents opened
    // under it agree — a Windows `D:/...` root built by hand would come out as
    // `file://D:/...` (drive as authority) and not match any didOpen URI.
    const rootUri = fileUri(workspacePath);

    const initResult = await this.request('initialize', {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: workspacePath.split('/').pop() ?? 'root' }],
      capabilities: {
        general: {
          positionEncodings: ['utf-16'],
          regularExpressions: { engine: 'ECMAScript', version: 'ES2022' },
          markdown: { parser: 'marked', version: '14.0' },
        },
        textDocument: {
          completion: {
            dynamicRegistration: true,
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              commitCharactersSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              deprecatedSupport: true,
              preselectSupport: true,
              tagSupport: { valueSet: [1] },
              insertReplaceSupport: true,
              resolveSupport: {
                properties: ['documentation', 'detail', 'additionalTextEdits'],
              },
              insertTextModeSupport: { valueSet: [1, 2] },
              labelDetailsSupport: true,
            },
            completionItemKind: {
              valueSet: [
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
                19, 20, 21, 22, 23, 24, 25,
              ],
            },
            completionList: {
              itemDefaults: [
                'commitCharacters',
                'editRange',
                'insertTextFormat',
                'insertTextMode',
                'data',
              ],
            },
          },
          hover: {
            contentFormat: ['markdown', 'plaintext'],
            dynamicRegistration: false,
          },
          signatureHelp: {
            dynamicRegistration: false,
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext'],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          declaration: {
            dynamicRegistration: false,
            linkSupport: true,
          },
          definition: {
            dynamicRegistration: false,
            linkSupport: true,
          },
          typeDefinition: {
            dynamicRegistration: false,
            linkSupport: true,
          },
          implementation: {
            dynamicRegistration: false,
            linkSupport: true,
          },
          references: {
            dynamicRegistration: false,
          },
          documentHighlight: {
            dynamicRegistration: false,
          },
          // Declared because a server may gate its own capability on the
          // client asking for it — csharp-ls advertises all of these, and
          // `verify:intellisense` fails if any of them stops coming back.
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: {
              valueSet: [
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
                19, 20, 21, 22, 23, 24, 25, 26,
              ],
            },
            labelSupport: true,
          },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { range: true, full: { delta: false } },
            formats: ['relative'],
            tokenTypes: [
              'namespace', 'type', 'class', 'enum', 'interface', 'struct',
              'typeParameter', 'parameter', 'variable', 'property',
              'enumMember', 'event', 'function', 'method', 'macro', 'keyword',
              'modifier', 'comment', 'string', 'number', 'regexp', 'operator',
              'decorator',
            ],
            tokenModifiers: [
              'declaration', 'definition', 'readonly', 'static', 'deprecated',
              'abstract', 'async', 'modification', 'documentation',
              'defaultLibrary',
            ],
            overlappingTokenSupport: false,
            multilineTokenSupport: false,
            serverCancelSupport: false,
            augmentsSyntaxTokens: true,
          },
          formatting: { dynamicRegistration: false },
          rangeFormatting: { dynamicRegistration: false },
          onTypeFormatting: { dynamicRegistration: false },
          callHierarchy: { dynamicRegistration: false },
          typeHierarchy: { dynamicRegistration: false },
          inlayHint: {
            dynamicRegistration: false,
            resolveSupport: { properties: ['tooltip', 'label.tooltip'] },
          },
          rename: { prepareSupport: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ['', 'quickfix', 'refactor'] },
            },
            isPreferredSupport: true,
            dataSupport: true,
          },
          synchronization: {
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
            dynamicRegistration: false,
          },
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ['create', 'rename', 'delete'],
            failureHandling: 'textOnlyTransactional',
            normalizesLineEndings: true,
            changeAnnotationSupport: { groupsOnLabel: true },
          },
          didChangeConfiguration: { dynamicRegistration: true },
          didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
          symbol: { dynamicRegistration: true },
          executeCommand: { dynamicRegistration: true },
          fileOperations: {
            didCreate: true,
            willCreate: true,
            didRename: true,
            willRename: true,
            didDelete: true,
            willDelete: true,
          },
        },
      },
    });

    // Stash the server's advertised capabilities so providers can
    // feature-detect (e.g. renameProvider.prepareProvider) at request time.
    this.serverCapabilities =
      initResult && typeof initResult === 'object'
        ? ((initResult as { capabilities?: Record<string, unknown> }).capabilities ?? null)
        : null;

    this.notify('initialized', {});
    this.running = true;

    console.info(`[LSP ${this.languageId}] Initialized:`, initResult);
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.running && method !== 'initialize') {
      throw new Error(
        `LSP client (${this.languageId}) is not running (attempted '${method}')`,
      );
    }

    const id = this.nextId++;

    const promise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
      });

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          pending.reject(
            new Error(
              `LSP request '${method}' (id=${id}, lang=${this.languageId}) timed out after ${REQUEST_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, REQUEST_TIMEOUT_MS);

      (
        this.pendingRequests.get(id) as PendingRequest & {
          timeoutId?: ReturnType<typeof setTimeout>;
        }
      ).timeoutId = timeoutId;
    });

    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    try {
      await invoke('lsp_send', {
        language: this.languageId,
        message: JSON.stringify(msg),
      });
    } catch (err) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        this.clearPendingTimeout(id, pending);
        pending.reject(
          new Error(`Failed to send LSP request '${method}' (${this.languageId}): ${err}`),
        );
      }
    }

    return promise;
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    invoke('lsp_send', {
      language: this.languageId,
      message: JSON.stringify(msg),
    }).catch((err) => {
      console.error(`[LSP ${this.languageId}] Failed to send notification '${method}':`, err);
    });
  }

  /**
   * Register a callback for server-initiated notifications.
   * Returns an unsubscribe function.
   */
  onNotification(method: string, callback: (params: unknown) => void): () => void {
    let listeners = this.notificationListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.notificationListeners.set(method, listeners);
    }
    listeners.add(callback);

    return () => {
      listeners!.delete(callback);
      if (listeners!.size === 0) {
        this.notificationListeners.delete(method);
      }
    };
  }

  /**
   * Gracefully shut down the LSP server and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    try {
      await this.request('shutdown', null);
      this.notify('exit', null);
    } catch (err) {
      console.error(`[LSP ${this.languageId}] Error during shutdown:`, err);
    }

    try {
      await invoke('lsp_stop', { language: this.languageId });
    } catch (err) {
      console.error(`[LSP ${this.languageId}] Error stopping process:`, err);
    }

    this.cleanup();
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register a callback invoked when the LSP server exits unexpectedly.
   */
  onExited(callback: () => void): void {
    this.exitedCallback = callback;
  }

  /**
   * Return the most recent server stderr lines (newest last).
   * Useful for surfacing server errors in the UI.
   */
  getRecentStderr(): string[] {
    return [...this.stderrRing];
  }

  /**
   * The `capabilities` object from the server's `initialize` response,
   * or null before initialization / after stop. Providers use this to
   * feature-detect optional methods (prepareRename, codeAction/resolve…).
   */
  getServerCapabilities(): Record<string, unknown> | null {
    return this.serverCapabilities;
  }

  // ── Private ──────────────────────────────────────────────

  private handleMessage(payload: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(payload);
    } catch {
      console.error(`[LSP ${this.languageId}] Failed to parse message:`, payload);
      return;
    }

    // Response to a pending request (has id, no method)
    if (msg.id != null && !msg.method) {
      const pending = this.pendingRequests.get(msg.id) as
        | (PendingRequest & { timeoutId?: ReturnType<typeof setTimeout> })
        | undefined;

      if (!pending) {
        console.warn(
          `[LSP ${this.languageId}] Received response for unknown request id=${msg.id}`,
        );
        return;
      }

      this.pendingRequests.delete(msg.id);
      if (pending.timeoutId) clearTimeout(pending.timeoutId);

      if (msg.error) {
        const code = msg.error.code;
        if (code === -32800 || code === -32801 || code === -32802) {
          pending.reject(new LspRequestCanceledError(pending.method, this.languageId, code));
        } else {
          pending.reject(
            new Error(
              `LSP error on '${pending.method}' (${this.languageId}): [${code}] ${msg.error.message}`,
            ),
          );
        }
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-initiated notification (has method, no id)
    if (msg.method && msg.id == null) {
      const listeners = this.notificationListeners.get(msg.method);
      if (listeners) {
        for (const cb of listeners) {
          try {
            cb(msg.params);
          } catch (err) {
            console.error(
              `[LSP ${this.languageId}] Notification handler error for '${msg.method}':`,
              err,
            );
          }
        }
      }
      return;
    }

    // Server-to-client request (has both method and id).
    if (msg.method && msg.id != null) {
      // workspace/applyEdit needs async work (applying the edit) before
      // responding, so it's handled outside the synchronous switch.
      if (msg.method === 'workspace/applyEdit') {
        void this.handleApplyEditRequest(msg.id, msg.params);
        return;
      }

      let result: unknown = null;

      switch (msg.method) {
        case 'client/registerCapability':
        case 'client/unregisterCapability':
        case 'window/workDoneProgress/create':
        case 'workspace/codeLens/refresh':
        case 'workspace/semanticTokens/refresh':
        case 'workspace/inlayHint/refresh':
        case 'workspace/inlineValue/refresh':
        case 'workspace/diagnostic/refresh':
        case 'workspace/foldingRange/refresh':
          result = null;
          break;

        case 'workspace/configuration': {
          const items = (msg.params as { items?: unknown[] })?.items ?? [];
          result = items.map(() => ({}));
          break;
        }

        case 'workspace/workspaceFolders':
          result = null;
          break;

        case 'window/showMessageRequest':
          result = null;
          break;

        default: {
          console.warn(
            `[LSP ${this.languageId}] Unhandled server request: ${msg.method} (id=${msg.id})`,
          );
          const errorResponse = {
            jsonrpc: '2.0' as const,
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          };
          invoke('lsp_send', {
            language: this.languageId,
            message: JSON.stringify(errorResponse),
          }).catch(() => {});
          return;
        }
      }

      const response = { jsonrpc: '2.0' as const, id: msg.id, result };
      invoke('lsp_send', {
        language: this.languageId,
        message: JSON.stringify(response),
      }).catch((err) => {
        console.error(
          `[LSP ${this.languageId}] Failed to respond to server request '${msg.method}':`,
          err,
        );
      });
      return;
    }
  }

  /**
   * Apply a server-initiated `workspace/applyEdit` request through the
   * injected handler and respond with `ApplyWorkspaceEditResult` once
   * the (async) application finishes.
   */
  private async handleApplyEditRequest(id: number, params: unknown): Promise<void> {
    let result: ApplyEditResult;
    const edit = (params as { edit?: unknown } | null)?.edit;

    if (!applyEditHandler) {
      result = {
        applied: false,
        failureReason: 'No workspace/applyEdit handler is registered',
      };
    } else if (!edit) {
      result = {
        applied: false,
        failureReason: 'workspace/applyEdit request carried no edit',
      };
    } else {
      try {
        result = await applyEditHandler(edit);
      } catch (err) {
        result = {
          applied: false,
          failureReason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const response = { jsonrpc: '2.0' as const, id, result };
    invoke('lsp_send', {
      language: this.languageId,
      message: JSON.stringify(response),
    }).catch((err) => {
      console.error(
        `[LSP ${this.languageId}] Failed to respond to 'workspace/applyEdit':`,
        err,
      );
    });
  }

  private clearPendingTimeout(
    _id: number,
    pending: PendingRequest & { timeoutId?: ReturnType<typeof setTimeout> },
  ): void {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
  }

  private cleanup(): void {
    if (this.unlisten) {
      safeUnlisten(this.unlisten);
      this.unlisten = null;
    }
    if (this.unlistenExited) {
      safeUnlisten(this.unlistenExited);
      this.unlistenExited = null;
    }
    if (this.unlistenStderr) {
      safeUnlisten(this.unlistenStderr);
      this.unlistenStderr = null;
    }

    for (const [id, pending] of this.pendingRequests) {
      this.clearPendingTimeout(
        id,
        pending as PendingRequest & { timeoutId?: ReturnType<typeof setTimeout> },
      );
      pending.reject(new Error(`LSP client (${this.languageId}) stopped`));
    }
    this.pendingRequests.clear();
    this.notificationListeners.clear();
    this.running = false;
    this.serverCapabilities = null;
  }
}
