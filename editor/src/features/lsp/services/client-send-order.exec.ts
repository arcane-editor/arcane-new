import { describe, it, expect, mock } from 'bun:test';

/**
 * REAL-EXECUTION test for the send ordering in `LspClient`.
 *
 * **The race.** `notify` and `request` each cross into Rust as their own
 * `invoke('lsp_send')`, and `lsp_send` (src-tauri/src/lsp.rs) awaits a
 * per-window mutex before writing to the server's stdin. Two Tauri command
 * tasks spawned back to back have no guaranteed lock-acquisition order, so the
 * `textDocument/didChange` carrying the character the user just typed and the
 * `textDocument/completion` asking what follows it could reach the server in
 * either order. When they invert, Roslyn answers against the previous revision
 * of the buffer — and a completion list computed one keystroke late is
 * indistinguishable, at the wire level, from a server that has nothing to say.
 *
 * Monaco makes this a live risk rather than a theoretical one: `type()` fires
 * the content change (which reaches `syncDocumentChange`) and `_onDidType`
 * (which reaches the completion provider) in the same synchronous turn.
 *
 * Deliberately `.exec.ts`, not `.test.ts` — same reason as
 * `src/stores/search-*.exec.ts`: `mock.module` mutates Bun's module registry
 * for the rest of the process, and `client.ts` is already loaded by the time
 * `bun test src` reaches this directory (`model-context.test.ts` pulls it in
 * transitively), so the mock would be installed too late to take effect.
 * Runs in its own process via `bun run test:isolated`.
 */

import * as realCore from '@tauri-apps/api/core';
import * as realEvent from '@tauri-apps/api/event';

/** Every `lsp_send` body, in the order Rust would receive it. */
let sent: string[] = [];
/** Resolvers for in-flight sends, so a slow notification can be held open. */
let gate: (() => void) | null = null;

// Spread the real module: other modules in the graph import more than
// `invoke` from it (e.g. `SERIALIZE_TO_IPC_FN`), and a mock that returns only
// what this test needs breaks their imports.
mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  invoke: async (cmd: string, args: { message: string }) => {
    if (cmd !== 'lsp_send') return undefined;
    if (gate) {
      // Hold this send open until the test releases it.
      await new Promise<void>((resolve) => {
        const release = gate!;
        gate = null;
        queueMicrotask(() => {
          release();
          resolve();
        });
      });
    }
    sent.push(args.message);
    return undefined;
  },
}));

mock.module('@tauri-apps/api/event', () => ({
  ...realEvent,
  listen: async () => () => {},
}));

const { LspClient } = await import('./client');

function methodsOf(bodies: string[]): string[] {
  return bodies.map((b) => JSON.parse(b).method as string);
}

describe('LspClient send ordering', () => {
  it('sends a request only after the notification issued before it', async () => {
    sent = [];
    const client = new LspClient('csharp');

    // A notification whose `invoke` does not settle immediately — the exact
    // shape that let a completion overtake a didChange.
    let released = false;
    gate = () => {
      released = true;
    };

    client.notify('textDocument/didChange', { textDocument: { uri: 'file:///C:/a.cs' } });

    // `initialize` is the one method `request` accepts before the client is
    // running, which keeps this test to the ordering behaviour alone.
    const pending = client.request('initialize', {}).catch(() => {});
    // Let the queued microtasks drain; the request must not have been written.
    await Promise.resolve();
    await Promise.resolve();

    expect(released).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    expect(methodsOf(sent)).toEqual(['textDocument/didChange', 'initialize']);
    void pending;
  });

  it('does not let a failed notification block later requests', async () => {
    sent = [];
    const client = new LspClient('typescript');

    client.notify('textDocument/didOpen', { textDocument: { uri: 'file:///C:/b.ts' } });
    void client.request('initialize', {}).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(methodsOf(sent)).toEqual(['textDocument/didOpen', 'initialize']);
  });
});
