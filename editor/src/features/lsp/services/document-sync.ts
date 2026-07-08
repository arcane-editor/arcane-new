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

function isSyncablePath(filePath: string): boolean {
  // Ignore virtual/invalid paths (diff://, auth://, empty, etc.)
  return !!filePath && !filePath.includes('://');
}

export function fileUri(filePath: string): string {
  // Encode path components for valid URIs (spaces → %20, etc.)
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return 'file://' + encoded;
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
 */
export function syncDocumentOpen(
  client: LspClient,
  filePath: string,
  content: string,
  languageId: string,
): void {
  if (!isSyncablePath(filePath)) return;

  const count = openCounts.get(filePath) ?? 0;
  if (count > 0) {
    openCounts.set(filePath, count + 1);
    syncDocumentChange(client, filePath, content);
    return;
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
 */
export function syncDocumentClose(
  client: LspClient,
  filePath: string,
): void {
  if (!isSyncablePath(filePath)) return;

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
}

/**
 * Drop tracking for a single file so the next `syncDocumentOpen` sends a
 * real `didOpen` (instead of falling through to `didChange`). Used when a
 * single language server restarts — its files were already tracked (with
 * some ref-count) from before the crash, but the new server has no record of
 * them, so tracking is fully reset to 0 (not merely decremented) regardless
 * of how many outstanding "opens" it had.
 */
export function forgetDocument(filePath: string): void {
  documentVersions.delete(filePath);
  openCounts.delete(filePath);
}
