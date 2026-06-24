import type { editor } from 'monaco-editor';
import type { LspWorkspaceEdit, LspTextEdit } from '../../lsp';
import {
  offsetToLineCol,
  type CSharpScan,
  type ClassDecl,
} from './csharp-scan';
import { bareTypeName, UNITY_MESSAGE_BASE_TYPES } from '../data/unity-knowledge';

// ── WorkspaceEdit builders for single-file quick-fixes ───────────────────────
//
// All quick-fix edits target the document currently being analysed, addressed
// by the model's own uri so the lsp applier (applyLspWorkspaceEdit) routes them
// through the open Monaco model (undo-friendly). Offsets in `edits` are 0-based
// (LSP TextEdit semantics).

export interface PendingEdit {
  /** 0-based start offset. */
  start: number;
  /** 0-based end offset (exclusive). */
  end: number;
  newText: string;
}

/** Build a single-file LspWorkspaceEdit from offset-based edits. */
export function buildEdit(
  scan: CSharpScan,
  model: editor.ITextModel | null,
  edits: PendingEdit[],
): LspWorkspaceEdit | undefined {
  if (!model) return undefined;
  const textEdits: LspTextEdit[] = edits.map((e) => {
    const start = offsetToLineCol(scan.lineStarts, e.start);
    const end = offsetToLineCol(scan.lineStarts, e.end);
    return {
      range: {
        start: { line: start.line - 1, character: start.col - 1 },
        end: { line: end.line - 1, character: end.col - 1 },
      },
      newText: e.newText,
    };
  });
  return { changes: { [model.uri.toString()]: textEdits } };
}

// ── Class / message helpers ──────────────────────────────────────────────────

/** True if the class's base list names a Unity message-receiving base type. */
export function classReceivesMessages(cls: ClassDecl): boolean {
  return cls.baseTypes.some((b) => UNITY_MESSAGE_BASE_TYPES.has(bareTypeName(b)));
}

/**
 * True if the class extends MonoBehaviour or ScriptableObject (the
 * serializable-by-Unity bases). Editor/EditorWindow classes are NOT included —
 * their fields aren't serialized into assets.
 */
export function classIsSerializable(cls: ClassDecl): boolean {
  return cls.baseTypes.some((b) => {
    const bare = bareTypeName(b);
    return bare === 'MonoBehaviour' || bare === 'ScriptableObject';
  });
}

/** All classes that receive Unity messages. */
export function messageClasses(scan: CSharpScan): ClassDecl[] {
  return scan.classes.filter(classReceivesMessages);
}
