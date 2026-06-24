import type { LspClient } from './client';

// ── Version/open-state tracking ──────────────────────────────────

/** Per-file version counter (keyed by file path). */
const documentVersions = new Map<string, number>();

/** Tracks which files have been successfully opened with didOpen. */
const openDocuments = new Set<string>();

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
  for (const path of openDocuments) {
    uris.add(fileUri(path));
  }
  return uris;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Notify the LSP server that a document has been opened.
 * Starts version tracking at 1 for this file.
 */
export function syncDocumentOpen(
  client: LspClient,
  filePath: string,
  content: string,
  languageId: string,
): void {
  if (!isSyncablePath(filePath)) return;

  // Avoid invalid duplicate didOpen. If already open, treat as content update.
  if (openDocuments.has(filePath)) {
    syncDocumentChange(client, filePath, content);
    return;
  }

  const version = 1;
  documentVersions.set(filePath, version);
  openDocuments.add(filePath);

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
  if (!openDocuments.has(filePath)) return;

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
 * Removes version tracking for this file.
 */
export function syncDocumentClose(
  client: LspClient,
  filePath: string,
): void {
  if (!isSyncablePath(filePath)) return;
  if (!openDocuments.has(filePath)) return;

  client.notify('textDocument/didClose', {
    textDocument: {
      uri: fileUri(filePath),
    },
  });

  openDocuments.delete(filePath);
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
  if (!openDocuments.has(filePath)) return;

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
  openDocuments.clear();
}

/**
 * Drop tracking for a single file so the next `syncDocumentOpen` sends a
 * real `didOpen` (instead of falling through to `didChange`). Used when a
 * single language server restarts — its files were already in
 * `openDocuments` from before the crash, but the new server has no
 * record of them.
 */
export function forgetDocument(filePath: string): void {
  documentVersions.delete(filePath);
  openDocuments.delete(filePath);
}
