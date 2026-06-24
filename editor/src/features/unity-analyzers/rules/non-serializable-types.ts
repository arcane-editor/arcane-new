import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { type CSharpScan, type FieldDecl } from '../services/csharp-scan';
import { isSerializedField } from '../services/serialized-fields';
import { buildEdit } from '../services/fix-helpers';
import { bareTypeName, UNITY_SERIALIZABLE_STRUCTS } from '../data/unity-knowledge';

// ── Known non-serializable container shapes ──────────────────────────────────
// Unity's serializer cannot persist Dictionary<,>, plain interfaces, or nested
// generic collections (List<List<>>). We flag a small, conservative set of
// known-bad types to avoid false positives — when unsure, we stay silent.

/** Outer generic container that Unity cannot serialize at all. */
function isNonSerializableContainer(type: string): boolean {
  const bare = bareTypeName(type);
  if (bare === 'Dictionary' || bare === 'IDictionary' || bare === 'SortedDictionary') {
    return true;
  }
  if (bare === 'HashSet' || bare === 'ISet') return true;
  return false;
}

/** Nested generic collection, e.g. List<List<int>> / List<int[]> — unsupported. */
function isNestedGenericCollection(type: string): boolean {
  const bare = bareTypeName(type);
  if (bare !== 'List' && bare !== 'IList' && bare !== 'IEnumerable') return false;
  // Look at the inner type argument.
  const open = type.indexOf('<');
  const close = type.lastIndexOf('>');
  if (open < 0 || close <= open) return false;
  const inner = type.slice(open + 1, close).trim();
  const innerBare = bareTypeName(inner);
  // List of a list, or list of an array.
  if (inner.includes('[') && inner.includes(']')) return true;
  return innerBare === 'List' || innerBare === 'Dictionary';
}

/**
 * Interface heuristic: an `I` + UpperCase type that is NOT a known-good Unity
 * struct/value type and not a generic container. Conservative — used only to
 * SUGGEST [SerializeReference], never an error on its own.
 */
function looksLikeInterface(type: string): boolean {
  const bare = bareTypeName(type);
  if (UNITY_SERIALIZABLE_STRUCTS.has(bare)) return false;
  // Common false-positives to exclude explicitly.
  if (bare === 'Input' || bare === 'Image' || bare === 'Int32') return false;
  return /^I[A-Z]/.test(bare);
}

export const nonSerializableTypesRule: AnalyzerRule = {
  id: 'unity/non-serializable-type',
  defaultSeverity: 'warning',
  settingKey: 'unity.serializationDiagnostics.enabled',

  run(scan, ctx): Finding[] {
    const findings: Finding[] = [];

    for (const field of scan.fields) {
      // Only consider fields the user clearly intends Unity to serialize.
      const intendsSerialize =
        field.attributes.includes('SerializeField') || isSerializedField(scan, field);
      if (!intendsSerialize) continue;
      // Respect explicit opt-out.
      if (field.attributes.includes('NonSerialized')) continue;
      // [SerializeReference] already opts into polymorphic serialization.
      if (field.attributes.includes('SerializeReference')) continue;

      const typeSpan = typeSpanFor(scan, field);

      if (isNonSerializableContainer(field.type)) {
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: typeSpan.start,
          end: typeSpan.end,
          code: 'UNITY0101',
          message: `Unity cannot serialize '${field.type}'. Dictionary/HashSet are not supported by Unity serialization — use a serializable wrapper (parallel List<>s or a custom struct list).`,
        });
        continue;
      }

      if (isNestedGenericCollection(field.type)) {
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: typeSpan.start,
          end: typeSpan.end,
          code: 'UNITY0102',
          message: `Unity cannot serialize nested generic collections like '${field.type}'. Wrap the inner collection in a [Serializable] struct/class.`,
        });
        continue;
      }

      if (looksLikeInterface(field.type)) {
        // For interface/abstract reference types, suggest [SerializeReference].
        const fix = buildSerializeReferenceFix(scan, ctx.model, field);
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: typeSpan.start,
          end: typeSpan.end,
          code: 'UNITY0103',
          message: `Unity cannot serialize interface field '${field.type}' by value. Add [SerializeReference] to serialize it polymorphically, or use a concrete type.`,
          fixes: fix,
        });
      }
    }

    return findings;
  },
};

/** Offset span of the field's type token within the declaration. */
function typeSpanFor(scan: CSharpScan, field: FieldDecl): { start: number; end: number } {
  // The type immediately precedes the name; locate it in the decl text.
  const declStart = field.declSpan.start;
  const declText = scan.text.slice(declStart, field.nameOffset);
  const idx = declText.lastIndexOf(field.type);
  if (idx >= 0) {
    return { start: declStart + idx, end: declStart + idx + field.type.length };
  }
  // Fallback: highlight the name.
  return { start: field.nameOffset, end: field.nameOffset + field.name.length };
}

function buildSerializeReferenceFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  field: FieldDecl,
): Finding['fixes'] {
  // Insert [SerializeReference] above the field declaration (matching indent).
  const edit = buildEdit(scan, model, [
    {
      start: field.declSpan.start,
      end: field.declSpan.start,
      newText: `[SerializeReference]\n${field.indent}`,
    },
  ]);
  if (!edit) return undefined;
  return [{ title: 'Add [SerializeReference]', isPreferred: true, edit }];
}
