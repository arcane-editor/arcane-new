// ── Binding the schema (intent) to the asset (truth) ────────────────────────
//
// The C# class says what fields SHOULD exist and how to render them. The file
// says what IS there. They disagree constantly — a field added in code and not
// yet in the asset, a field renamed with `[FormerlySerializedAs]`, a stale key
// left behind by a rename, a value whose shape is not what the type implies.
//
// Every one of those is a state here rather than a crash or a guess, and the
// mismatch case degrades to read-only. That is the safety net that lets the
// schema's widget selection be merely good rather than perfect: intent alone
// could write a scalar over an object reference, so truth gets a veto.

import type { SoField, SoSchema } from '../../unity-analyzers';
import type { SoAssetSnapshot, SoFieldEdit, SoFieldValue } from './asset-fields-client';
import { encodeValue } from './so-value-format';

export type SoRowState =
  /** Schema field bound to the key of the same name. */
  | 'bound'
  /** In the class, not yet in the asset — Unity would supply the default. */
  | 'missing'
  /** Bound through a `[FormerlySerializedAs]` name. */
  | 'migrated'
  /** Present, but its shape is not what the type implies. Read-only. */
  | 'degraded'
  /** In the asset with no matching field in the class — a rename left it. */
  | 'unmapped';

export interface SoRow {
  /** Null only for an `unmapped` row. */
  field: SoField | null;
  /** The YAML key this row reads and writes. */
  yamlKey: string;
  value: SoFieldValue | null;
  state: SoRowState;
  editable: boolean;
  /** Set for `migrated`, naming the old key it is still stored under. */
  migratedFrom: string | null;
  /**
   * For a `missing` row: the key to insert after, so the new line lands in the
   * class's declaration order rather than at the end of the document. Null when
   * nothing precedes it in the file, in which case it appends.
   */
  insertAfter: string | null;
}

/** Which value shapes a widget can legitimately be backed by. */
const SHAPE_FOR_WIDGET: Record<string, string[]> = {
  int: ['scalar'],
  float: ['scalar'],
  bool: ['scalar'],
  string: ['scalar', 'quoted', 'empty'],
  enum: ['scalar'],
  enumFlags: ['scalar'],
  vector2: ['inlineMap'],
  vector3: ['inlineMap'],
  vector4: ['inlineMap'],
  vector2Int: ['inlineMap'],
  vector3Int: ['inlineMap'],
  color: ['inlineMap'],
  rect: ['inlineMap'],
  bounds: ['inlineMap'],
  layerMask: ['scalar', 'inlineMap'],
  objectRef: ['inlineMap'],
};

/**
 * Does the value on disk contradict what the declared type implies?
 *
 * Only meaningful for a widget we actually render. A `List<T>` or an
 * `AnimationCurve` has no entry here because we do not claim to know its shape
 * — that is an unsupported TYPE, which is normal, not drift. Conflating the two
 * put a warning triangle next to every list in the project.
 */
function shapeContradicts(field: SoField, value: SoFieldValue): boolean {
  const allowed = SHAPE_FOR_WIDGET[field.widget];
  if (!allowed) return false; // no opinion about this type
  return !allowed.includes(value.kind);
}

/**
 * Build the row list: schema order first, then any keys the schema does not
 * know about.
 *
 * Unmapped keys are surfaced rather than hidden — they are exactly the debris a
 * field rename leaves behind, and seeing them is the point.
 */
export function buildRows(schema: SoSchema, snapshot: SoAssetSnapshot): SoRow[] {
  const byKey = new Map(snapshot.fields.map((f) => [f.key, f]));
  const consumed = new Set<string>();
  const rows: SoRow[] = [];
  /** Last schema field found in the file — the anchor for the next insertion. */
  let lastPresentKey: string | null = null;

  for (const field of schema.fields) {
    const direct = byKey.get(field.name);
    if (direct) {
      consumed.add(field.name);
      const contradicts = shapeContradicts(field, direct);
      rows.push({
        field,
        yamlKey: field.name,
        value: direct,
        state: contradicts ? 'degraded' : 'bound',
        editable: !contradicts && field.editable && direct.editable,
        migratedFrom: null,
        insertAfter: null,
      });
      lastPresentKey = field.name;
      continue;
    }

    // Not under its current name — try the names it used to have.
    const former = field.formerNames.find((n) => byKey.has(n));
    if (former) {
      const value = byKey.get(former)!;
      consumed.add(former);
      const contradicts = shapeContradicts(field, value);
      rows.push({
        field,
        yamlKey: former,
        value,
        state: contradicts ? 'degraded' : 'migrated',
        editable: !contradicts && field.editable && value.editable,
        migratedFrom: former,
        insertAfter: null,
      });
      lastPresentKey = former;
      continue;
    }

    rows.push({
      field,
      yamlKey: field.name,
      value: null,
      state: 'missing',
      // Editable: writing it INSERTS the key, anchored after the last field
      // that is actually in the file so the result keeps Unity's order.
      editable: field.editable,
      migratedFrom: null,
      insertAfter: lastPresentKey,
    });
  }

  for (const value of snapshot.fields) {
    if (consumed.has(value.key)) continue;
    // Unity's own bookkeeping is not interesting to a designer.
    if (value.key.startsWith('m_') || value.key === 'serializedVersion') continue;
    rows.push({
      field: null,
      yamlKey: value.key,
      value,
      state: 'unmapped',
      editable: false,
      migratedFrom: null,
      insertAfter: null,
    });
  }

  return rows;
}

/**
 * Turn a draft into an edit, or null when there is nothing to write.
 *
 * Returning null for a no-op is load-bearing: an unchanged value must never
 * reach disk, or every focus change would bump the asset's mtime and trigger a
 * Unity reimport.
 */
export function toEdit(
  row: SoRow,
  draft: string,
  fileId: string,
): SoFieldEdit | null {
  if (!row.editable || !row.field) return null;
  const encoded = encodeValue(draft, row.field);
  if (!encoded.ok) return null;

  // Not in the file yet — this write inserts the key.
  if (!row.value) {
    return {
      fileId,
      path: row.yamlKey,
      value: encoded.raw,
      ifMissing: row.insertAfter
        ? { mode: 'insertAfter', anchor: row.insertAfter }
        : { mode: 'insertAtEnd' },
    };
  }

  if (encoded.raw === row.value.raw) return null;
  return {
    fileId,
    path: row.yamlKey,
    value: encoded.raw,
    // Field-level optimistic concurrency: refuse if someone else moved it.
    expected: row.value.raw,
  };
}

/** Edit one member of an inline map (a Vector3 component, a Color channel). */
export function toMemberEdit(
  row: SoRow,
  member: string,
  draft: string,
  fileId: string,
): SoFieldEdit | null {
  if (!row.editable || !row.value) return null;
  const current = row.value.members.find((m) => m.name === member);
  if (!current) return null;
  const next = draft.trim();
  if (next === '' || !Number.isFinite(Number(next))) return null;
  if (next === current.raw) return null;
  return {
    fileId,
    path: `${row.yamlKey}.${member}`,
    value: next,
    expected: current.raw,
  };
}
