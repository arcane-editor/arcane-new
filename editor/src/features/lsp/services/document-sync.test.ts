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

  // Residual Critical from the P3.3 re-review (trace (c)): tab opens, then an
  // ephemeral diagnostics fetch opens (count 2). The LSP crashes mid-fetch;
  // the restart resync (`stores/workspace.ts`) calls `forgetDocument` (hard
  // reset + epoch bump) then re-opens for the tab (count 0→1, new epoch)
  // *before* the pre-crash ephemeral fetch's `finally` gets to close. Without
  // epoch-scoping, that stale close would see ref-count 1 and send a REAL
  // `didClose` to the freshly-restarted server, silently breaking sync for
  // the still-open tab.
  describe('epoch-scoped close (restart-resync race)', () => {
    it('a stale-epoch close after forgetDocument+resync is a no-op — the doc stays tracked and sync continues (trace c)', () => {
      const { client, calls } = fakeClient();
      const path = '/proj/Foo.cs';

      // Tab opens for real (count 0→1).
      syncDocumentOpen(client, path, 'tab v1', 'csharp');
      // Ephemeral diagnostics fetch opens while the tab is open (count 1→2);
      // captures the epoch as its claim token, exactly like
      // `diagnostics.ts`'s `requestFileDiagnostics` does.
      const ephemeralEpoch = syncDocumentOpen(client, path, 'ephemeral snapshot', 'csharp');

      // LSP crashes mid-fetch. Restart resync hard-resets tracking and
      // re-opens for the tab's own interest — a NEW epoch.
      forgetDocument(path);
      syncDocumentOpen(client, path, 'tab v1', 'csharp');

      // The pre-crash ephemeral fetch's `finally` now runs, closing with its
      // now-stale epoch claim — must be a no-op, not a real didClose.
      syncDocumentClose(client, path, ephemeralEpoch);

      expect(getOpenDocumentUris().has(fileUri(path))).toBe(true);
      expect(calls.filter((c) => c.method === 'textDocument/didClose')).toEqual([]);

      // The tab's subsequent edits keep syncing — this is exactly what
      // silently broke before the fix (an unscoped close would have wiped
      // tracking, turning this into a no-op until a full close+reopen).
      syncDocumentChange(client, path, 'tab v2');
      expect(calls.map((c) => c.method)).toEqual([
        'textDocument/didOpen', // tab's initial open
        'textDocument/didChange', // ephemeral open dedups (count 1→2)
        'textDocument/didOpen', // resync's real open after forgetDocument
        'textDocument/didChange', // tab's post-resync edit
      ]);
    });

    it('a stale-epoch close is a no-op even when the ref-count is exactly 1 (would otherwise trigger a real didClose)', () => {
      const { client, calls } = fakeClient();
      const path = '/proj/Baz.cs';

      const staleEpoch = syncDocumentOpen(client, path, 'v1', 'csharp'); // epoch 0
      forgetDocument(path); // epoch → 1, tracking cleared
      syncDocumentOpen(client, path, 'v2', 'csharp'); // count 0→1 under epoch 1

      syncDocumentClose(client, path, staleEpoch); // stale epoch 0 !== current 1

      expect(getOpenDocumentUris().has(fileUri(path))).toBe(true);
      expect(calls.filter((c) => c.method === 'textDocument/didClose')).toEqual([]);
    });

    it('a normal ephemeral open/close pair (no forget in between) still closes properly since the epoch matches', () => {
      const { client, calls } = fakeClient();
      const path = '/proj/Qux.cs';

      const epoch = syncDocumentOpen(client, path, 'v1', 'csharp');
      syncDocumentClose(client, path, epoch);

      expect(getOpenDocumentUris().has(fileUri(path))).toBe(false);
      expect(calls.map((c) => c.method)).toEqual([
        'textDocument/didOpen',
        'textDocument/didClose',
      ]);
    });

    it('a close without an epoch arg (user-tab callers) applies unconditionally, even after a forgetDocument bumped the epoch', () => {
      const { client, calls } = fakeClient();
      const path = '/proj/Quux.cs';

      syncDocumentOpen(client, path, 'v1', 'csharp');
      forgetDocument(path); // bumps epoch, clears tracking
      syncDocumentOpen(client, path, 'v2', 'csharp'); // count 0→1 again

      syncDocumentClose(client, path); // no epoch arg — unconditional, as before the fix

      expect(getOpenDocumentUris().has(fileUri(path))).toBe(false);
      expect(calls.map((c) => c.method)).toEqual([
        'textDocument/didOpen',
        'textDocument/didOpen',
        'textDocument/didClose',
      ]);
    });
  });
});
