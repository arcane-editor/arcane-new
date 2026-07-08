// Ref-counted open-tracking semantics (LSP lifecycle fix). document-sync.ts's
// LSP client boundary (`LspClient`) has no side effects worth mocking here —
// `notify()` just needs a `(method, params)` callback — so these tests fake
// the client directly (cast through `unknown` past its private fields) and
// assert on both the emitted notification sequence and `getOpenDocumentUris`.
//
// Covers the Finding-1 failure trace: an ephemeral diagnostics fetch
// (`diagnostics.ts`) opens a file a user then opens for real in an editor tab
// during the fetch's settle window; the ephemeral fetch's `finally` must not
// tear down the user's tab's tracking when it closes its own interest.

import { describe, it, expect, beforeEach } from 'bun:test';
import type { LspClient } from './client';
import {
  syncDocumentOpen,
  syncDocumentClose,
  syncDocumentChange,
  getOpenDocumentUris,
  resetDocumentVersions,
  forgetDocument,
  fileUri,
} from './document-sync';

function fakeClient(): { client: LspClient; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    notify: (method: string, params: unknown) => {
      calls.push({ method, params });
    },
  } as unknown as LspClient;
  return { client, calls };
}

describe('document-sync ref-counted open tracking', () => {
  beforeEach(() => {
    resetDocumentVersions();
  });

  it('open/open/close leaves the doc tracked and never sends didClose', () => {
    const { client, calls } = fakeClient();
    const path = '/proj/Foo.cs';

    syncDocumentOpen(client, path, 'v1', 'csharp');
    syncDocumentOpen(client, path, 'v2', 'csharp');
    syncDocumentClose(client, path);

    expect(getOpenDocumentUris().has(fileUri(path))).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
    ]);
  });

  it('open/close/close: the second close is a no-op (count never goes negative)', () => {
    const { client, calls } = fakeClient();
    const path = '/proj/Bar.cs';

    syncDocumentOpen(client, path, 'v1', 'csharp');
    syncDocumentClose(client, path);
    syncDocumentClose(client, path);

    expect(getOpenDocumentUris().has(fileUri(path))).toBe(false);
    expect(calls.map((c) => c.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didClose',
    ]);
  });

  it('a close on a never-opened path is a no-op', () => {
    const { client, calls } = fakeClient();
    syncDocumentClose(client, '/proj/NeverOpened.cs');
    expect(calls).toEqual([]);
  });

  it('interleaved ephemeral+user open/close sequence ends with the doc still tracked (Finding 1 failure trace)', () => {
    const { client, calls } = fakeClient();
    const path = '/proj/Foo.cs';

    // Ephemeral diagnostics fetch opens the file (count 0→1, real didOpen).
    syncDocumentOpen(client, path, 'ephemeral content', 'csharp');
    // User opens the same file in a real tab during the fetch's settle
    // window (count 1→2, dedups to didChange — workspace.ts's openFile path).
    syncDocumentOpen(client, path, 'user content', 'csharp');
    // Ephemeral fetch's `finally` closes its own interest (count 2→1) — must
    // NOT emit didClose or drop tracking; the user's tab is still open.
    syncDocumentClose(client, path);

    expect(getOpenDocumentUris().has(fileUri(path))).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
    ]);

    // The user's subsequent edits keep syncing normally — this is exactly
    // what silently broke before the fix (a no-op at the "didChange without
    // didOpen is invalid" guard once the ephemeral close wiped tracking).
    syncDocumentChange(client, path, 'user edit');
    expect(calls.map((c) => c.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange',
    ]);
  });

  it('forgetDocument fully resets tracking regardless of ref-count (LSP restart re-sync)', () => {
    const { client, calls } = fakeClient();
    const path = '/proj/Foo.cs';

    syncDocumentOpen(client, path, 'v1', 'csharp');
    syncDocumentOpen(client, path, 'v2', 'csharp'); // count = 2

    forgetDocument(path);
    expect(getOpenDocumentUris().has(fileUri(path))).toBe(false);

    // Next open after forgetDocument sends a REAL didOpen again (a restarted
    // server has never seen this file), not a didChange dedup.
    syncDocumentOpen(client, path, 'v3', 'csharp');
    expect(calls.map((c) => c.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didOpen',
    ]);
  });
});
