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
/** Make the next send reject, so a failure's effect on the chain is testable. */
let failNextSend = false;
/**
 * Milliseconds each send waits before it "reaches the server", by call index.
 *
 * This is the whole point of the ordering test. `lsp_send` is a Tauri command
 * task that awaits a shared mutex, so the order tasks acquire it is NOT the
 * order they were spawned in — but a mock that resolves immediately preserves
 * call order for free and would pass whether or not the client chains its
 * sends. Descending delays make an unchained client record them backwards.
 */
let sendDelays: number[] = [];
let sendIndex = 0;

// Spread the real module: other modules in the graph import more than
// `invoke` from it (e.g. `SERIALIZE_TO_IPC_FN`), and a mock that returns only
// what this test needs breaks their imports.
mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  invoke: async (cmd: string, args: { message: string }) => {
    if (cmd !== 'lsp_send') return undefined;
    if (failNextSend) {
      failNextSend = false;
      throw new Error('simulated send failure');
    }
    const delay = sendDelays[sendIndex++];
    if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
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
    sendDelays = [];
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
    await new Promise((r) => setTimeout(r, 20));

    // The held notification was released, and the request went out behind it
    // rather than overtaking it.
    expect(released).toBe(true);
    expect(methodsOf(sent)).toEqual(['textDocument/didChange', 'initialize']);
    void pending;
  });

  it('sends notifications in the order they were issued', async () => {
    // The reason this matters: `syncDocumentChange` sends the WHOLE document.
    // If v3 overtakes v2 the server's copy of the buffer ends up as the older
    // text and stays wrong until the next edit, so every completion and
    // diagnostic after that describes a file the user is not looking at.
    sent = [];
    sendIndex = 0;
    // The first send is the slowest, so a client that fires them in parallel
    // records them in reverse.
    sendDelays = [40, 30, 20, 10];
    const client = new LspClient('csharp');

    for (const version of [2, 3, 4, 5]) {
      client.notify('textDocument/didChange', {
        textDocument: { uri: 'file:///C:/a.cs', version },
        contentChanges: [{ text: `v${version}` }],
      });
    }
    await new Promise((r) => setTimeout(r, 300));

    expect(sent.map((b) => JSON.parse(b).params.textDocument.version)).toEqual([2, 3, 4, 5]);
    sendDelays = [];
  });

  it('does not let a failed notification block what follows it', async () => {
    sent = [];
    sendDelays = [];
    failNextSend = true;
    const client = new LspClient('typescript');

    client.notify('textDocument/didOpen', { textDocument: { uri: 'file:///C:/b.ts' } });
    client.notify('textDocument/didSave', { textDocument: { uri: 'file:///C:/b.ts' } });
    void client.request('initialize', {}).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    // The first send rejected and was dropped; everything after it still went.
    expect(methodsOf(sent)).toEqual(['textDocument/didSave', 'initialize']);
  });
});
