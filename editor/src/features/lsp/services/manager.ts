import { invoke } from '@tauri-apps/api/core';
import { LspClient } from './client';
import type { LspServerKey } from '../../../utils/language-detect';

/**
 * Multi-tenant LSP layer. Holds one `LspClient` per language server key
 * (e.g. `csharp`, `python`, `typescript`). Clients are created lazily on
 * first lookup; servers are started on demand by the workspace store.
 *
 * Frontend filters tagged Tauri events (`lsp-message`, `lsp-stderr`,
 * `lsp-exited`) by language inside each `LspClient`, so multiple clients
 * coexist over the same global event channels without cross-talk.
 */
export class LspManager {
  private clients = new Map<string, LspClient>();

  /** Get-or-create the client for a language. Does not start it. */
  client(language: LspServerKey | string): LspClient {
    let c = this.clients.get(language);
    if (!c) {
      c = new LspClient(language);
      this.clients.set(language, c);
    }
    return c;
  }

  /** True iff a client has been created for this language (running or not). */
  has(language: string): boolean {
    return this.clients.has(language);
  }

  /** Iterate clients that are currently running. */
  forEachActive(fn: (client: LspClient, language: string) => void): void {
    for (const [lang, client] of this.clients) {
      if (client.isRunning()) fn(client, lang);
    }
  }

  /** All registered clients (running or not). */
  all(): LspClient[] {
    return [...this.clients.values()];
  }

  /**
   * Gracefully stop every running client and tear down every server. Used
   * when switching workspaces.
   */
  async stopAll(): Promise<void> {
    const stops = this.all().map((c) =>
      c.stop().catch((err) => {
        console.warn(`[LSP ${c.languageId}] stop failed during stopAll:`, err);
      }),
    );
    await Promise.allSettled(stops);

    // Belt-and-braces: ask the backend to drop any leftover entries the
    // graceful shutdown didn't manage to kill (e.g. clients that were never
    // initialized but had spawned children).
    try {
      await invoke('lsp_stop_all');
    } catch (err) {
      console.warn('[LspManager] backend lsp_stop_all failed:', err);
    }
  }
}

export const lspManager = new LspManager();
