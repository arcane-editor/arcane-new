import {
  registerRenamePostProcessor,
  type RenamePostProcessor,
  type RenamePostProcessContext,
  type LspWorkspaceEdit,
  type LspTextEdit,
  type LspTextDocumentEdit,
} from '../../lsp';
import { resolveAssetPath } from '../../unity-context';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnityIndexStore } from '../../../stores/unity-index';
import { notify } from '../../../stores/notifications';
import {
  scanCSharp,
  lineColToOffset,
  offsetToLineCol,
  type CSharpScan,
  type FieldDecl,
} from './csharp-scan';
import { serializedFieldAtOffset, serializedFieldByName } from './serialized-fields';

const SERIALIZATION_USING = 'UnityEngine.Serialization';

function gateEnabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.analyzers.enabled') === true &&
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

/**
 * Best-effort: report the blast radius of a serialized-field rename. The asset
 * GUID index maps the script's .cs path to a GUID; reverse references count
 * scenes/prefabs that instantiate the script and may have the old field value
 * serialized under the old name. Skipped silently if the index is empty.
 */
async function reportBlastRadius(filePath: string): Promise<void> {
  try {
    const guid = resolveAssetPath(filePath);
    if (!guid) return; // index not populated / script has no .meta yet
    const refs = await useUnityIndexStore.getState().findReferences(guid);
    if (!refs || refs.length === 0) return;
    const assetCount = refs.length;
    const totalHits = refs.reduce((sum, r) => sum + (r.count ?? 1), 0);
    notify.info(
      `Renamed serialized field — ${totalHits} reference${totalHits === 1 ? '' : 's'} ` +
        `across ${assetCount} scene${assetCount === 1 ? '' : 's'}/prefab${assetCount === 1 ? '' : 's'} ` +
        `may need reassignment (a [FormerlySerializedAs] attribute was added to preserve them).`,
    );
  } catch (err) {
    console.warn('[unity-analyzers] blast-radius report failed:', err);
  }
}

const processor: RenamePostProcessor = (ctx: RenamePostProcessContext): LspWorkspaceEdit => {
  const { model, position, oldName, newName, workspaceEdit } = ctx;
  if (!gateEnabled()) return workspaceEdit;
  if (!oldName || oldName === newName) return workspaceEdit;

  let scan: CSharpScan;
  try {
    scan = scanCSharp(model.getValue());
  } catch {
    return workspaceEdit;
  }

  // Resolve the field at the rename position; fall back to matching by the old
  // name (the cursor might be on a usage, not the declaration).
  const renameOffset = lineColToOffset(scan.lineStarts, position.lineNumber, position.column);
  const field =
    serializedFieldAtOffset(scan, renameOffset) ?? serializedFieldByName(scan, oldName);
  if (!field) return workspaceEdit;

  // Don't duplicate an existing FormerlySerializedAs for this old name.
  if (hasFormerlySerializedAs(scan, field, oldName)) return workspaceEdit;

  const uri = model.uri.toString();
  const extraEdits: LspTextEdit[] = [];

  // 1) Insert [FormerlySerializedAs("oldName")] immediately above the field
  //    declaration, matching its indentation.
  const insertOffset = field.declSpan.start;
  const attrLine = `[FormerlySerializedAs("${oldName}")]\n${field.indent}`;
  extraEdits.push(insertAt(scan, insertOffset, attrLine));

  // 2) Add `using UnityEngine.Serialization;` if absent.
  if (!hasSerializationUsing(scan)) {
    if (scan.usings.length > 0) {
      // After the last existing using.
      const last = scan.usings[scan.usings.length - 1];
      extraEdits.push(insertAt(scan, last.endOffset, `\nusing ${SERIALIZATION_USING};`));
    } else {
      // No usings — insert at the very top of the file.
      extraEdits.push(insertAt(scan, 0, `using ${SERIALIZATION_USING};\n`));
    }
  }

  // Merge our extra edits into the workspace edit for this file. We APPEND to
  // any existing edits for this uri; the lsp applier sorts bottom-up before
  // applying, so insertion order vs the LSP's own rename edits is handled.
  const merged: LspWorkspaceEdit = { ...workspaceEdit };
  if (merged.documentChanges && merged.documentChanges.length > 0) {
    // Find (or create) the TextDocumentEdit for our uri.
    const existing = merged.documentChanges.find(
      (c): c is LspTextDocumentEdit =>
        'textDocument' in c &&
        (c as LspTextDocumentEdit).textDocument.uri === uri,
    );
    if (existing) {
      existing.edits = [...existing.edits, ...extraEdits];
    } else {
      merged.documentChanges = [
        ...merged.documentChanges,
        { textDocument: { uri }, edits: extraEdits },
      ];
    }
  } else {
    const changes = { ...(merged.changes ?? {}) };
    changes[uri] = [...(changes[uri] ?? []), ...extraEdits];
    merged.changes = changes;
  }

  // Fire the blast-radius notification after the edit applies (best-effort).
  // We don't block the rename on the index lookup.
  void reportBlastRadius(model.uri.fsPath ?? model.uri.path);

  return merged;
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
