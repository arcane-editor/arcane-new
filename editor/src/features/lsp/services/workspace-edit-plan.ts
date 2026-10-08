import { pathFromFileUri } from '../../../utils/file-uri';
import type { LspWorkspaceEdit, LspTextEdit } from './workspace-edit';

export function documentIdentity(uriOrPath: string): string {
  const path = pathFromFileUri(uriOrPath).replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

export interface DocumentEdits {
  uri: string;
  path: string;
  version?: number | null;
  edits: LspTextEdit[];
}

/** Normalize aliases without dropping server version preconditions. */
export function normalizeWorkspaceEdit(edit: LspWorkspaceEdit): DocumentEdits[] {
  const documents = new Map<string, DocumentEdits>();
  const add = (uri: string, edits: LspTextEdit[], version?: number | null) => {
    if (!uri.startsWith('file://')) throw new Error(`Cannot modify a read-only or virtual document: ${uri}`);
    const key = documentIdentity(uri);
    const previous = documents.get(key);
    if (previous) {
      if (version != null && previous.version != null && version !== previous.version) {
        throw new Error(`Conflicting document versions: ${uri}`);
      }
      previous.version ??= version;
      previous.edits.push(...edits);
    } else {
      documents.set(key, { uri, path: pathFromFileUri(uri), version, edits: [...edits] });
    }
  };
  // Presence, including an empty array, takes precedence per LSP.
  if (edit.documentChanges !== undefined) {
    for (const change of edit.documentChanges) {
      if (!('textDocument' in change)) throw new Error(`Workspace ${change.kind} operations are not supported yet; nothing was changed.`);
      add(change.textDocument.uri, change.edits, change.textDocument.version);
    }
  } else {
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  }
  return [...documents.values()];
}

/** Validate before applying; positions and offsets both use UTF-16 units. */
export function applyEditsToText(text: string, edits: LspTextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const offset = (p: { line: number; character: number }) => {
    if (!Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0 || p.line >= starts.length) {
      throw new Error('An edit contains an invalid document position');
    }
    let end = p.line + 1 < starts.length ? starts[p.line + 1] - 1 : text.length;
    if (end > starts[p.line] && text[end - 1] === '\r') end--;
    return Math.min(starts[p.line] + p.character, end);
  };
  const spans = edits.map((e, index) => ({ start: offset(e.range.start), end: offset(e.range.end), text: e.newText, index }));
  spans.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  let end = -1;
  for (const span of spans) {
    if (span.end < span.start || span.start < end) throw new Error('Workspace edits overlap or have a reversed range');
    end = Math.max(end, span.end);
  }
  // Reverse equal-position inserts as well, preserving their specified order.
  let result = text;
  for (const span of spans.reverse()) result = result.slice(0, span.start) + span.text + result.slice(span.end);
  return result;
}
