import {
  offsetInSpan,
  type CSharpScan,
  type FieldDecl,
} from './csharp-scan';
import { classIsSerializable } from './fix-helpers';

// ── Serialized-field determination ───────────────────────────────────────────
//
// Unity serializes a field when it is:
//   • a `public` instance field (not const, not static, not readonly), OR
//   • a `[SerializeField]` private/protected instance field,
// declared in a class deriving from MonoBehaviour or ScriptableObject,
// and NOT marked `[NonSerialized]`. Properties are never serialized.
//
// We work purely off the syntactic scan — no type resolution — which is enough
// for the FormerlySerializedAs feature and the serialization diagnostics.

/** Is the given scanned field one Unity will serialize? */
export function isSerializedField(scan: CSharpScan, field: FieldDecl): boolean {
  if (field.modifiers.includes('static')) return false;
  if (field.modifiers.includes('const')) return false;
  if (field.modifiers.includes('readonly')) return false;
  if (field.attributes.includes('NonSerialized')) return false;

  // Must live in a serializable class.
  const owner = scan.classes.find(
    (c) => c.bodySpan && offsetInSpan(c.bodySpan, field.nameOffset),
  );
  if (!owner || !classIsSerializable(owner)) return false;

  const isPublic = field.modifiers.includes('public');
  const hasSerializeField = field.attributes.includes('SerializeField');

  // public => serialized (unless [NonSerialized], handled above).
  // private/protected/internal => only serialized with [SerializeField].
  if (isPublic) return true;
  return hasSerializeField;
}

/**
 * Find the serialized field whose identifier sits at (or spans) `offset`
 * (e.g. the rename position). Returns null if none.
 */
export function serializedFieldAtOffset(
  scan: CSharpScan,
  offset: number,
): FieldDecl | null {
  for (const field of scan.fields) {
    const start = field.nameOffset;
    const end = field.nameOffset + field.name.length;
    if (offset >= start && offset <= end && isSerializedField(scan, field)) {
      return field;
    }
  }
  return null;
}

/** Find a serialized field by exact identifier name. */
export function serializedFieldByName(
  scan: CSharpScan,
  name: string,
): FieldDecl | null {
  for (const field of scan.fields) {
    if (field.name === name && isSerializedField(scan, field)) return field;
  }
  return null;
}
