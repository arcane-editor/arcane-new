// ── ScriptableObject schema ─────────────────────────────────────────────────
//
// Turns a scanned C# class into the shape a typed inspector needs: which fields
// Unity serializes, what control each one deserves, and the attribute metadata
// (`[Header]`, `[Range]`, `[Tooltip]`, `[FormerlySerializedAs]`) that makes the
// form readable.
//
// This is the INTENT side of the feature. The values on disk are the TRUTH
// side, read by the Rust asset reader. Where the two disagree the row degrades
// to a read-only raw value — which is why the rule below is "under-claim, never
// over-claim". Guessing `float` for something Unity actually stored as
// `{fileID: 0}` would write a scalar over an object reference and silently
// unassign it; guessing `unknown` for a float merely costs an edit.

import {
  offsetInSpan,
  offsetToLineCol,
  type AttributeUse,
  type ClassDecl,
  type CSharpScan,
  type FieldDecl,
  type SourceSpan,
} from './csharp-scan';
import { isSerializedFieldDecl } from './serialized-fields';
import {
  bareTypeName,
  UNITY_OBJECT_TYPES,
  WIDGET_BY_TYPE,
} from '../data/unity-knowledge';

export type SoWidgetKind =
  | 'int' | 'float' | 'bool' | 'string'
  | 'enum' | 'enumFlags'
  | 'vector2' | 'vector3' | 'vector4' | 'vector2Int' | 'vector3Int'
  | 'color' | 'rect' | 'bounds' | 'layerMask'
  | 'objectRef'
  /** An in-file `[Serializable]` struct/class — shown, not edited (pass 1). */
  | 'nested'
  /** Not representable; rendered read-only as its raw YAML. */
  | 'unknown';

export type SoBaseKind = 'scriptableObject' | 'monoBehaviour' | 'unknown';

export interface SoField {
  /** C# identifier. Also the YAML key Unity serializes it under. */
  name: string;
  csharpType: string;
  bareType: string;
  widget: SoWidgetKind;
  isArray: boolean;
  elementType: string | null;
  elementWidget: SoWidgetKind | null;

  /** `[Header("…")]` declared on this field, which starts a new group. */
  header: string | null;
  tooltip: string | null;
  range: { min: number; max: number } | null;
  min: number | null;
  /** True for `[HideInInspector]` — serialized, but Unity does not show it. */
  hiddenInInspector: boolean;
  /** `[SerializeReference]` — polymorphic, never editable here. */
  serializeReference: boolean;
  /** Every `[FormerlySerializedAs("…")]` name, oldest first. */
  formerNames: string[];

  enumMembers: Array<{ name: string; value: number }> | null;
  enumIsFlags: boolean;

  /** False when the value must not be written (unknown/nested/array/…). */
  editable: boolean;
  /** 1-based line of the declaration, for codelens anchoring. */
  declLine: number;
  nameOffset: number;
  declSpan: SourceSpan;
  attributes: string[];
}

export interface SoFieldGroup {
  /** `[Header]` text, or null for fields declared before the first header. */
  header: string | null;
  fields: SoField[];
}

export interface SoSchema {
  className: string;
  baseTypes: string[];
  baseKind: SoBaseKind;
  /** The unresolved base type name when `baseKind === 'unknown'`. */
  unresolvedBase: string | null;
  /** `[CreateAssetMenu(menuName = …)]`. */
  menuPath: string | null;
  defaultFileName: string | null;
  /** Serialized fields in declaration order — the order Unity writes them. */
  fields: SoField[];
  groups: SoFieldGroup[];
}

const LIST_TYPES = new Set(['List', 'IList', 'IReadOnlyList', 'IEnumerable', 'ICollection']);

/** Classify a class by its immediate base list. No cross-file resolution. */
export function classBaseKind(cls: ClassDecl): SoBaseKind {
  for (const b of cls.baseTypes) {
    const bare = bareTypeName(b);
    if (bare === 'ScriptableObject') return 'scriptableObject';
    if (bare === 'MonoBehaviour') return 'monoBehaviour';
  }
  return 'unknown';
}

/** The first base token that is not an obvious interface, for the banner text. */
function firstBaseType(cls: ClassDecl): string | null {
  for (const b of cls.baseTypes) {
    const bare = bareTypeName(b);
    if (!/^I[A-Z]/.test(bare)) return bare;
  }
  return cls.baseTypes.length > 0 ? bareTypeName(cls.baseTypes[0]) : null;
}

/** Split `List<T>` / `T[]` into its element type, or null when not a sequence. */
export function elementTypeOf(csharpType: string): string | null {
  const t = csharpType.trim();
  if (/\[\s*\]\s*$/.test(t)) return t.replace(/\[\s*\]\s*$/, '').trim();
  const generic = /^([A-Za-z_][\w.]*)\s*<(.+)>$/.exec(t);
  if (generic && LIST_TYPES.has(bareTypeName(generic[1]))) return generic[2].trim();
  return null;
}

/**
 * Which control a type deserves. Order matters: a type that is BOTH an in-file
 * enum and a known struct name should resolve as the enum the file declares.
 */
export function widgetForType(csharpType: string, scan: CSharpScan): SoWidgetKind {
  const bare = bareTypeName(csharpType);

  const known = WIDGET_BY_TYPE[bare];
  if (known) return known as SoWidgetKind;

  const enumDecl = scan.enums.find((e) => e.name === bare);
  if (enumDecl) return enumDecl.isFlags ? 'enumFlags' : 'enum';

  if (UNITY_OBJECT_TYPES.has(bare)) return 'objectRef';

  const inFile = scan.classes.find((c) => c.name === bare);
  if (inFile) {
    // A class deriving from a Unity object is referenced, not inlined.
    if (classBaseKind(inFile) !== 'unknown') return 'objectRef';
    if (inFile.attributes.includes('Serializable')) return 'nested';
  }

  return 'unknown';
}

function argOf(use: AttributeUse | undefined, index: number) {
  return use?.args[index];
}

function attr(field: FieldDecl, name: string): AttributeUse | undefined {
  return field.attributeUses.find((a) => a.name === name);
}

function buildField(scan: CSharpScan, field: FieldDecl): SoField {
  const csharpType = field.type;
  const bare = bareTypeName(csharpType);
  const elementType = elementTypeOf(csharpType);
  const isArray = elementType !== null;

  const baseWidget = widgetForType(isArray ? elementType! : csharpType, scan);
  const elementWidget = isArray ? baseWidget : null;
  const widget: SoWidgetKind = isArray ? 'unknown' : baseWidget;

  const rangeUse = attr(field, 'Range');
  const rangeMin = argOf(rangeUse, 0)?.number;
  const rangeMax = argOf(rangeUse, 1)?.number;
  const range =
    typeof rangeMin === 'number' && typeof rangeMax === 'number'
      ? { min: rangeMin, max: rangeMax }
      : null;

  const minUse = attr(field, 'Min');
  const min = argOf(minUse, 0)?.number ?? null;

  const enumDecl = scan.enums.find((e) => e.name === (isArray ? bareTypeName(elementType!) : bare));
  const enumMembers = enumDecl
    ? enumDecl.members
        .filter((m): m is { name: string; value: number; nameOffset: number } => m.value !== null)
        .map((m) => ({ name: m.name, value: m.value }))
    : null;

  const serializeReference = field.attributes.includes('SerializeReference');
  const editable =
    !isArray &&
    !serializeReference &&
    widget !== 'unknown' &&
    widget !== 'nested';

  return {
    name: field.name,
    csharpType,
    bareType: bare,
    widget,
    isArray,
    elementType,
    elementWidget,
    header: attr(field, 'Header')?.args[0]?.text ?? null,
    tooltip: attr(field, 'Tooltip')?.args[0]?.text ?? null,
    range,
    min,
    hiddenInInspector: field.attributes.includes('HideInInspector'),
    serializeReference,
    formerNames: field.attributeUses
      .filter((a) => a.name === 'FormerlySerializedAs')
      .map((a) => a.args[0]?.text)
      .filter((t): t is string => typeof t === 'string'),
    enumMembers,
    enumIsFlags: enumDecl?.isFlags ?? false,
    editable,
    declLine: offsetToLineCol(scan.lineStarts, field.nameOffset).line + 1,
    nameOffset: field.nameOffset,
    declSpan: field.declSpan,
    attributes: field.attributes,
  };
}

/** Group consecutive fields under the `[Header]` that introduces them. */
export function fieldGroups(fields: SoField[]): SoFieldGroup[] {
  const groups: SoFieldGroup[] = [];
  let current: SoFieldGroup | null = null;
  for (const f of fields) {
    if (f.header !== null || current === null) {
      current = { header: f.header, fields: [] };
      groups.push(current);
    }
    current.fields.push(f);
  }
  return groups;
}

/**
 * Build the schema for a scanned document.
 *
 * Picks the ScriptableObject class when there is one, else the named class,
 * else the first class. Returns null when the document has no class at all.
 */
export function buildSoSchema(
  scan: CSharpScan,
  opts?: { className?: string },
): SoSchema | null {
  if (scan.classes.length === 0) return null;

  const named = opts?.className
    ? scan.classes.find((c) => c.name === opts.className)
    : undefined;
  const cls =
    named ??
    scan.classes.find((c) => classBaseKind(c) === 'scriptableObject') ??
    scan.classes[0];
  if (!cls) return null;

  // The class gate is applied HERE, by choosing `cls`, so the field test is the
  // declaration-level one. Going through `isSerializedField` would re-derive
  // the owner and reject everything when the base is a type declared in another
  // file — leaving a promoted `unknown` schema with no fields at all.
  const fields = scan.fields
    .filter((f) => cls.bodySpan && offsetInSpan(cls.bodySpan, f.nameOffset))
    .filter(isSerializedFieldDecl)
    .map((f) => buildField(scan, f));

  const baseKind = classBaseKind(cls);
  const menu = cls.attributeUses.find((a) => a.name === 'CreateAssetMenu');
  const namedArg = (n: string) =>
    menu?.args.find((a) => a.name === n)?.text ?? null;

  return {
    className: cls.name,
    baseTypes: cls.baseTypes,
    baseKind,
    unresolvedBase: baseKind === 'unknown' ? firstBaseType(cls) : null,
    menuPath: namedArg('menuName'),
    defaultFileName: namedArg('fileName'),
    fields,
    groups: fieldGroups(fields),
  };
}
