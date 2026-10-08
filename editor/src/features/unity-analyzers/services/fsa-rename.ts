import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';
import {
  registerRenamePostProcessor,
  workspaceTextEdits,
  documentIdentity,
  type RenamePostProcessor,
  type RenamePostProcessContext,
  type LspWorkspaceEdit,
  type LspTextEdit,
} from '../../lsp';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';
import {
  scanCSharp,
  lineColToOffset,
  offsetToLineCol,
  type CSharpScan,
  type FieldDecl,
} from './csharp-scan';
import { isSerializedField, isSerializedFieldDecl } from './serialized-fields';

const SERIALIZATION_USING = 'UnityEngine.Serialization';

function gateEnabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.rename.formerlySerializedAs') === true
  );
}

/**
 * Has the field already got a [FormerlySerializedAs("oldName")] for this exact
 * old name? Checks the scanned attributes plus a raw text scan of the decl span
 * (attributes carry only names, not args).
 */
function hasFormerlySerializedAs(
  scan: CSharpScan,
  field: FieldDecl,
  oldName: string,
): boolean {
  if (!field.attributes.includes('FormerlySerializedAs')) return false;
  const declText = scan.text.slice(field.declSpan.start, field.declSpan.end);
  // Match FormerlySerializedAs("oldName") allowing nameof or whitespace noise.
  const re = new RegExp(
    `FormerlySerializedAs\\s*\\(\\s*"${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
  );
  return re.test(declText);
}

/** True if the using directive set already imports UnityEngine.Serialization. */
function hasSerializationUsing(scan: CSharpScan): boolean {
  return scan.usings.some((u) => u.name.replace(/\s*=\s*.*/, '').trim() === SERIALIZATION_USING);
}

/** LSP TextEdit that inserts text at a 0-based offset (zero-width range). */
function insertAt(scan: CSharpScan, offset: number, newText: string): LspTextEdit {
  const pos = offsetToLineCol(scan.lineStarts, offset);
  return {
    range: {
      start: { line: pos.line - 1, character: pos.col - 1 },
      end: { line: pos.line - 1, character: pos.col - 1 },
    },
    newText,
  };
}

const processor: RenamePostProcessor = async (ctx: RenamePostProcessContext): Promise<LspWorkspaceEdit> => {
  const { oldName, newName, workspaceEdit } = ctx;
  if (!gateEnabled() || !oldName || oldName === newName) return workspaceEdit;
  const documents = workspaceTextEdits(workspaceEdit);
  const protectedDocuments = [];
  for (const document of documents) {
    if (!document.path.toLowerCase().endsWith('.cs')) { protectedDocuments.push(document); continue; }
    const open = useWorkspaceStore.getState().openFiles.find(f => documentIdentity(f.path) === documentIdentity(document.path));
    const text = open?.content ?? await invoke<string>('read_file', { path: document.path });
    ctx.documentTextPreconditions.set(documentIdentity(document.path), text);
    const scan = scanCSharp(text);
    const extras: LspTextEdit[] = [];
    // The semantic rename result identifies declarations by their actual edit
    // spans. A same-named field in the active file must never be substituted.
    for (const field of scan.fields) {
      const isRenamedDeclaration = field.name === oldName && document.edits.some(edit => {
        const start = lineColToOffset(scan.lineStarts, edit.range.start.line + 1, edit.range.start.character + 1);
        const end = lineColToOffset(scan.lineStarts, edit.range.end.line + 1, edit.range.end.character + 1);
        return start <= field.nameOffset && end >= field.nameOffset + field.name.length;
      });
      const explicitlySerialized = field.attributes.some(a => a === 'SerializeField' || a === 'SerializeReference');
      if (!isRenamedDeclaration || !(isSerializedField(scan, field) || (explicitlySerialized && isSerializedFieldDecl(field)))) continue;
      if (hasFormerlySerializedAs(scan, field, oldName)) continue;
      extras.push(insertAt(scan, field.declSpan.start, `[FormerlySerializedAs("${oldName}")]\n${field.indent}`));
    }
    if (extras.length && !hasSerializationUsing(scan)) {
      if (scan.usings.length) extras.push(insertAt(scan, scan.usings.at(-1)!.endOffset, `\nusing ${SERIALIZATION_USING};`));
      else extras.push(insertAt(scan, 0, `using ${SERIALIZATION_USING};\n`));
    }
    protectedDocuments.push({ ...document, edits: [...document.edits, ...extras] });
  }
  return {
    ...workspaceEdit,
    changes: undefined,
    documentChanges: protectedDocuments.map(d => ({ textDocument: { uri: d.uri, version: d.version }, edits: d.edits })),
  };
};

let unregister: (() => void) | null = null;

/** Register the FormerlySerializedAs rename post-processor. Idempotent. */
export function registerFsaRename(): () => void {
  if (unregister) return unregister;
  const off = registerRenamePostProcessor(processor);
  unregister = () => {
    off();
    unregister = null;
  };
  return unregister;
}

export function unregisterFsaRename(): void {
  if (unregister) unregister();
}
