// ── Instances table: which columns, and what goes in a cell ─────────────────
//
// FIDELITY WARNING, and it is deliberate.
//
// The table reads `AssetUsageEntry.fields`, which comes from
// `extractMonoBehaviourFields` — a deliberately cheap skim of the YAML that
// only sees exactly-2-space-indented keys, drops `m_*`, drops object
// references, drops empty values and lists, truncates at 80 characters, and
// stops after 8 fields. That is fine for a preview over many assets and wrong
// as a source of truth.
//
// So the rule here is: a value we did not certainly find renders as an em dash,
// never as a guess and never as a neighbouring field's value. Full fidelity
// comes from opening an instance, which reads through the Rust asset reader.

import type { SoField, SoSchema } from '../../unity-analyzers';
import type { AssetUsageEntry, SceneFieldRef } from '../../unity-context';

/** Widgets whose value is a single scalar the skim can actually report. */
const COLUMNABLE = new Set(['string', 'enum', 'enumFlags', 'int', 'float', 'bool']);

export const MAX_INSTANCE_COLUMNS = 4;

/**
 * Choose the columns for the instances table: the first few scalar fields in
 * declaration order.
 *
 * Object references, nested values, arrays and unknowns are skipped — the skim
 * cannot report them, so a column of em dashes would be pure noise.
 */
export function pickColumns(
  schema: SoSchema | null,
  max = MAX_INSTANCE_COLUMNS,
): SoField[] {
  if (!schema) return [];
  return schema.fields
    .filter((f) => !f.isArray && !f.hiddenInInspector && COLUMNABLE.has(f.widget))
    .slice(0, max);
}

/** Index an entry's skimmed fields by their YAML key. */
function indexFields(fields: SceneFieldRef[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of fields ?? []) map.set(f.label, f.value);
  return map;
}

/**
 * The display value of one cell, or null when the skim did not report it.
 *
 * Also consults `[FormerlySerializedAs]` names, so an asset still stored under
 * the old key shows its value instead of a blank while the rename settles.
 */
export function cellValue(entry: AssetUsageEntry, field: SoField): string | null {
  const byKey = indexFields(entry.fields);
  const direct = byKey.get(field.name);
  if (direct !== undefined) return direct;
  for (const former of field.formerNames) {
    const legacy = byKey.get(former);
    if (legacy !== undefined) return legacy;
  }
  return null;
}

/**
 * Render a raw YAML scalar the way the field's widget implies.
 *
 * Only the transformations that are unambiguous: Unity stores a bool as 0/1 and
 * an enum as its ordinal, and showing either raw makes the table unreadable.
 * Anything unrecognised passes through untouched rather than being guessed at.
 */
export function formatCell(raw: string | null, field: SoField): string {
  if (raw === null) return '—';
  const value = raw.trim();
  if (field.widget === 'bool') {
    if (value === '0') return 'false';
    if (value === '1') return 'true';
    return value;
  }
  if (field.widget === 'enum' && field.enumMembers) {
    const n = Number(value);
    const member = Number.isFinite(n) ? field.enumMembers.find((m) => m.value === n) : undefined;
    return member ? member.name : value;
  }
  return value;
}

/** Instances of the open script, in a stable order. */
export function instanceRows(entries: AssetUsageEntry[] | null): AssetUsageEntry[] {
  return (entries ?? []).filter((e) => e.kind === 'scriptableObject' && e.isInstance);
}
