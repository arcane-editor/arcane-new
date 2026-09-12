import { invoke } from '@tauri-apps/api/core';

// ── The only invoke site for ScriptableObject field I/O ─────────────────────
//
// One place, so `check-invoke-args.mjs` has one payload shape to validate — and
// so the argument names can only drift here. NOTE: that checker only inspects
// TOP-LEVEL invoke arguments; it cannot see inside `edits`, so the field names
// of `SoFieldEdit` are guarded by a Rust test that deserialises a literal copy
// of this payload (`wire_payload_from_the_frontend_deserializes`).
//
// All YAML understanding lives in Rust. There is deliberately no TypeScript
// parser here: a second implementation would have to agree with the writer
// forever, across CRLF, block scalars, anchors and stripped documents.

/** Shape of a value as it is written on disk. */
export type SoValueKind =
  | 'scalar'
  | 'quoted'
  | 'inlineMap'
  | 'inlineSeq'
  | 'empty'
  | 'block'
  | 'opaque';

/** Why a value will not be rewritten. Mirrors Rust's `OpaqueReason`. */
export type SoOpaqueReason =
  | 'blockScalar'
  | 'anchorOrAlias'
  | 'possibleComment'
  | 'tabIndent'
  | 'unbalanced';

export interface SoFieldMember {
  name: string;
  raw: string;
}

export interface SoFieldValue {
  key: string;
  /** Verbatim bytes from the file, quotes included. */
  raw: string;
  kind: SoValueKind;
  editable: boolean;
  reason: SoOpaqueReason | null;
  /** Members of an inline map, in file order. */
  members: SoFieldMember[];
}

export interface SoAssetSnapshot {
  documentFileId: string;
  classId: string;
  scriptGuid: string | null;
  fields: SoFieldValue[];
  /** Content hash at read time — pass back as `expectedSha1` when writing. */
  sha1: string;
}

/** What to do when the key is not in the asset yet. */
export type SoIfMissing =
  | { mode: 'reject' }
  /** Insert directly after this sibling key, keeping serialization order. */
  | { mode: 'insertAfter'; anchor: string }
  | { mode: 'insertAtEnd' };

export interface SoFieldEdit {
  fileId: string;
  /** `damage`, or `tint.g` for one member of an inline map. */
  path: string;
  /** Exact bytes to write. */
  value: string;
  /** Refuse unless the current on-disk value is byte-equal to this. */
  expected?: string;
  /** Omitted means reject; the writer never invents a key by accident. */
  ifMissing?: SoIfMissing;
  /**
   * Delete the key instead of writing a value.
   *
   * A rename is insert-new + remove-old in ONE batch, so a crash between them
   * cannot lose the value. `value` is ignored when this is set.
   */
  remove?: boolean;
}

/** Mirrors Rust's `EditRejection`; `kind` is the discriminant. */
export interface SoEditRejection {
  kind: string;
  path?: string;
  member?: string;
  expected?: string;
  actual?: string;
  reason?: string;
  count?: number;
  fileId?: string;
  other?: string;
}

export interface SoEditResult {
  written: boolean;
  unchanged: boolean;
  rejections: SoEditRejection[];
  sha1: string;
  path: string;
}

/** Read one document's fields losslessly. */
export function readAssetFields(path: string, fileId?: string): Promise<SoAssetSnapshot> {
  return invoke<SoAssetSnapshot>('unity_asset_read_fields', { path, fileId });
}

/**
 * Apply edits atomically and byte-exactly.
 *
 * `expectedSha1` turns "Unity re-serialised this while you were editing" into a
 * rejected write instead of a clobber, so it is required rather than optional.
 */
export function writeAssetFields(
  path: string,
  edits: SoFieldEdit[],
  expectedSha1: string,
): Promise<SoEditResult> {
  return invoke<SoEditResult>('unity_asset_apply_edits', { path, edits, expectedSha1 });
}

/** Human-readable text for a rejection, shown against the field it belongs to. */
export function describeRejection(r: SoEditRejection): string {
  switch (r.kind) {
    case 'keyNotFound':
      return 'This field is not in the asset yet.';
    case 'ambiguousKey':
      return `The key appears ${r.count ?? 2} times — edit it in the raw YAML.`;
    case 'unsupportedValue':
      return `This value cannot be edited safely (${r.reason ?? 'unsupported'}).`;
    case 'unsupportedShape':
      return 'Lists and nested blocks are not editable here yet.';
    case 'mapMemberNotFound':
      return `No member "${r.member}" in this value.`;
    case 'valueMismatch':
      return 'The value changed on disk — reload before saving.';
    case 'illegalValue':
      return `That value cannot be written: ${r.reason ?? 'invalid'}.`;
    case 'documentNotFound':
      return 'The document this field belongs to is gone — reload.';
    case 'overlappingEdits':
      return 'Two edits touched the same value.';
    default:
      return 'This edit was refused.';
  }
}
