import type { LspClient } from './client';

// ── Version/open-state tracking ──────────────────────────────────

/** Per-file version counter (keyed by file path). */
const documentVersions = new Map<string, number>();

/**
 * Ref-counts outstanding "opens" per file path. A file can be opened for more
 * than one reason at once — e.g. a real editor tab AND an ephemeral
 * diagnostics fetch (`features/lsp/services/diagnostics.ts`) racing with it —
 * so one caller closing its interest must not tear down tracking out from
 * under another caller that still considers the document open. `didOpen` is
 * only sent on 0→1; `didClose` only on 1→0. A path is present in this map iff
 * its count is ≥ 1 (i.e. "tracked"/"open"); it's removed entirely at 0.
 */
const openCounts = new Map<string, number>();

/**
 * Per-path "generation" counter, bumped by `forgetDocument`. `syncDocumentOpen`
 * returns the path's current epoch as a claim token; `syncDocumentClose` can
 * be given that token back to make its close a no-op if a `forgetDocument`
 * (LSP restart resync) happened in between — see `forgetDocument` for the
 * failure trace this guards against.
 */
const documentEpochs = new Map<string, number>();

function currentEpoch(filePath: string): number {
  return documentEpochs.get(filePath) ?? 0;
}

function isSyncablePath(filePath: string): boolean {
  // Ignore virtual/invalid paths (diff://, auth://, empty, etc.)
  return !!filePath && !filePath.includes('://');
}

export function fileUri(filePath: string): string {
  // Encode path components for valid URIs (spaces → %20, etc.). Split first
  // so separators survive — encodeURIComponent would escape them.
  const encodeSegments = (p: string) => p.split('/').map(encodeURIComponent).join('/');

  // Windows drive path (`D:/x/y`). Paths reach the frontend `/`-separated
  // (src-tauri/src/path_util.rs), so the drive would otherwise become its own
  // segment and encode to `D%3A` — producing `file://D%3A/x/y`, where the
  // drive is parsed as the URI *authority*. The drive must sit in the path:
  // `file:///D:/x/y`. The colon is left literal, matching what VS Code and
  // Roslyn-based servers emit.
  const drive = /^([A-Za-z]:)\/(.*)$/.exec(filePath);
  if (drive) return `file:///${drive[1]}/${encodeSegments(drive[2])}`;

  // UNC (`//server/share/x`) — here the host genuinely IS the authority, so
  // it collapses to `file://server/share/x` rather than gaining slashes.
  const unc = /^\/\/([^/]+)\/(.*)$/.exec(filePath);
  if (unc) return `file://${unc[1]}/${encodeSegments(unc[2])}`;

  // POSIX: the leading empty segment supplies the third slash.
  return 'file://' + encodeSegments(filePath);
}

/**
 * Exact inverse of [`fileUri`]: `file:///D:/x/A.cs` → `D:/x/A.cs`,
 * `file://server/share/A.cs` → `//server/share/A.cs`,
 * `file:///Users/me/A.cs` → `/Users/me/A.cs`.
 *
 * The naive `decodeURIComponent(uri.replace('file://', ''))` this replaces got
 * both Windows shapes wrong: it left the third slash in front of the drive
 * (`/D:/x/A.cs`, which Win32 rejects with os error 123 — see
 * `src-tauri/src/path_util.rs`), and it dropped the two leading slashes of a
 * UNC path along with its host's authority position.
 *
 * Decoding per segment (not over the whole string) matters for the same reason
 * `fileUri` encodes per segment: a `%2F` inside a file name must not decode
 * into a separator.
 *
 * Non-`file://` input is returned unchanged, matching the previous behaviour
 * at the call sites that don't pre-filter.
 */
export function pathFromFileUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  const decodeSegments = (p: string) => p.split('/').map(decodeURIComponent).join('/');
  const rest = uri.slice('file://'.length);

  // Empty authority (`file:///…`) — a POSIX or Windows-drive path.
  if (rest.startsWith('/')) {
    const body = rest.slice(1);
    // The drive letter belongs to the path, so it must NOT keep that slash.
    if (/^[A-Za-z]:(\/|$)/.test(body)) return decodeSegments(body);
    return '/' + decodeSegments(body);
  }

  // Non-empty authority = a UNC host, which `fileUri` collapsed from
  // `//host/share` to `file://host/share`; restore the leading slashes.
  return '//' + decodeSegments(rest);
}

/**
 * Return the set of file:// URIs the LSP server has been told are open.
 * Used by the completion provider to detect URI mismatches and recover
 * by sending a `didOpen` if the model URI isn't tracked.
 */
export function getOpenDocumentUris(): Set<string> {
  const uris = new Set<string>();
  for (const path of openCounts.keys()) {
    uris.add(fileUri(path));
  }
  return uris;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Notify the LSP server that a document has been opened.
 * Starts version tracking at 1 for this file on the first (0→1) open;
 * subsequent opens while still tracked just bump the ref-count and forward
 * to `syncDocumentChange` (existing dedup behavior — callers that "open" an
 * already-tracked file are really just pushing a content update, e.g. the
 * completion provider's defensive re-open path).
 *
 * Returns the path's current epoch — a claim token callers that might race a
 * `forgetDocument` (e.g. an ephemeral diagnostics fetch, see `diagnostics.ts`)
 * should hold onto and pass back to `syncDocumentClose` so a stale close
 * can't tear down state a restart resync already rebuilt without them.
 */
export function syncDocumentOpen(
  client: LspClient,
  filePath: string,
  content: string,
  languageId: string,
): number {
  if (!isSyncablePath(filePath)) return currentEpoch(filePath);

  const count = openCounts.get(filePath) ?? 0;
  if (count > 0) {
    openCounts.set(filePath, count + 1);
    syncDocumentChange(client, filePath, content);
    return currentEpoch(filePath);
  }

  const version = 1;
  documentVersions.set(filePath, version);
  openCounts.set(filePath, 1);

  const uri = fileUri(filePath);
  client.notify('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId,
      version,
      text: content,
    },
  });
  console.info('[LSP] didOpen sent', { filePath, uri, languageId });
  return currentEpoch(filePath);
}

/**
 * Notify the LSP server that a document's content has changed.
 *
 * Sends the full document content as a single change event (full sync).
 * Each call increments the document version. This is NOT debounced because
 * the LSP server relies on monotonically increasing version numbers for every
 * change; the server itself debounces expensive operations like diagnostics.
 */
export function syncDocumentChange(
  client: LspClient,
  filePath: string,
  content: string,
): void {
  if (!isSyncablePath(filePath)) return;

  // didChange without didOpen is invalid per LSP.
  if (!openCounts.has(filePath)) return;

  const prev = documentVersions.get(filePath) ?? 1;
  const version = prev + 1;
  documentVersions.set(filePath, version);

  client.notify('textDocument/didChange', {
    textDocument: {
      uri: fileUri(filePath),
      version,
    },
    contentChanges: [{ text: content }],
  });
}

/**
 * Notify the LSP server that a document has been closed.
 *
 * Decrements the ref-count for this file; only sends `didClose` and removes
 * version tracking on the 1→0 transition (the last outstanding "open"
 * closing). A close for an untracked path (count already 0, or never opened)
 * is a no-op — the count is never allowed to go negative.
 *
 * If `epoch` is provided (the claim token `syncDocumentOpen` returned to this
 * caller) and it doesn't match the path's CURRENT epoch, the whole close is a
 * no-op — a `forgetDocument` (LSP restart resync) happened between this
 * caller's open and its close, so the caller's claim predates state the
 * resync already rebuilt from scratch; applying it would tear down the
 * restarted server's tracking for an interest it never actually held. Callers
 * that don't hold a claim token (real editor-tab close paths) omit `epoch`
 * and close unconditionally, exactly as before.
 */
export function syncDocumentClose(
  client: LspClient,
  filePath: string,
  epoch?: number,
): void {
  if (!isSyncablePath(filePath)) return;
  if (epoch !== undefined && epoch !== currentEpoch(filePath)) return;

  const count = openCounts.get(filePath) ?? 0;
  if (count <= 0) return;

  if (count > 1) {
    openCounts.set(filePath, count - 1);
    return;
  }

  client.notify('textDocument/didClose', {
    textDocument: {
      uri: fileUri(filePath),
    },
  });

  openCounts.delete(filePath);
  documentVersions.delete(filePath);
}

/**
 * Notify the LSP server that a document has been saved.
 */
export function syncDocumentSave(
  client: LspClient,
  filePath: string,
  content: string,
): void {
  if (!isSyncablePath(filePath)) return;
  if (!openCounts.has(filePath)) return;

  client.notify('textDocument/didSave', {
    textDocument: {
      uri: fileUri(filePath),
    },
    text: content,
  });
}

/**
 * Clear all tracked document versions.
 * Call this when switching workspaces so stale version state is discarded.
 */
export function resetDocumentVersions(): void {
  documentVersions.clear();
  openCounts.clear();
  documentEpochs.clear();
}

/**
 * Drop tracking for a single file so the next `syncDocumentOpen` sends a
 * real `didOpen` (instead of falling through to `didChange`). Used when a
 * single language server restarts — its files were already tracked (with
 * some ref-count) from before the crash, but the new server has no record of
 * them, so tracking is fully reset to 0 (not merely decremented) regardless
 * of how many outstanding "opens" it had.
 *
 * Also bumps the path's epoch, invalidating any claim tokens `syncDocumentOpen`
 * handed out before this call. Guards a restart-timing race: an ephemeral
 * open (e.g. `diagnostics.ts`'s one-shot fetch) can be in flight when the LSP
 * crashes; `handleClientCrash`'s resync calls `forgetDocument` then
 * `syncDocumentOpen` for the tab's own interest (a fresh 0→1 open under the
 * new epoch) before the ephemeral fetch's `finally` gets a chance to close
 * its now-stale pre-crash interest. Without the epoch check, that stale close
 * would see ref-count 1 and send a REAL `didClose` to the just-restarted
 * server for a document the tab still considers open, silently breaking sync
 * for that tab until a full close+reopen.
 */
export function forgetDocument(filePath: string): void {
  documentVersions.delete(filePath);
  openCounts.delete(filePath);
  documentEpochs.set(filePath, currentEpoch(filePath) + 1);
}
