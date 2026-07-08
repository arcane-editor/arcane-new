// TS mirrors of the Rust `unity_diff.rs` serde shapes (camelCase) returned by
// the `unity_scene_diff` / `unity_scene_diff_revs` commands, plus a compact
// text formatter used both by tests and (later) an LLM-facing "Summarize"
// prompt. Field-for-field comments below track the doc comments on the Rust
// structs — see `editor/src-tauri/src/unity_diff.rs`.
//
// NOTE on nullability: none of the Rust structs use
// `skip_serializing_if`, so every `Option<T>` field serializes as an
// explicit `null` (never an absent key) — the TS types below use `T | null`
// rather than `T | undefined` to match exactly.

export type ObjectDiffStatus = 'added' | 'removed' | 'renamed' | 'moved' | 'modified';
export type ComponentDiffStatus = 'added' | 'removed' | 'modified';
export type PrefabOverrideStatus = 'added' | 'removed' | 'modified';

/** One property that differs between old and new (or exists on only one side). */
export interface PropertyDiff {
  key: string;
  old: string | null;
  new: string | null;
}

/** A component add/remove/modify under one GameObject. */
export interface ComponentDiff {
  fileId: string;
  classId: string;
  typeName: string;
  scriptGuid: string | null;
  status: ComponentDiffStatus;
  propertyDiffs: PropertyDiff[];
}

/** Subtree rollup for a whole GameObject added/removed at once. */
export interface SubtreeSummary {
  /** Count of descendant GameObjects (recursive), not including the root. */
  childCount: number;
  /** Distinct resolved component type names anywhere in the subtree (root included), sorted. */
  componentTypes: string[];
}

/** One GameObject's diff. */
export interface ObjectDiff {
  fileId: string;
  /** Current (new-side) name; for a pure removal this is the old name. */
  name: string;
  status: ObjectDiffStatus;
  /** Slash-joined name path from the scene root to this object. */
  hierarchyPath: string;
  oldName: string | null;
  newName: string | null;
  oldParentName: string | null;
  newParentName: string | null;
  /** GameObject-level field changes; excludes m_Name and m_Component (surfaced structurally). */
  propertyDiffs: PropertyDiff[];
  componentDiffs: ComponentDiff[];
  /** Present only for whole-subtree "added"/"removed" statuses. */
  subtreeSummary: SubtreeSummary | null;
}

/** A single prefab-instance property override (`m_Modifications` entry) that differs. */
export interface PrefabOverrideDiff {
  /** fileID of the owning `PrefabInstance` (classId 1001) document. */
  prefabInstanceFileId: string;
  prefabAssetName: string | null;
  prefabAssetGuid: string | null;
  targetFileId: string;
  targetGuid: string;
  propertyPath: string;
  oldValue: string | null;
  newValue: string | null;
  /** Raw `objectReference: {...}` payload (trimmed) for whichever side has one. */
  oldObjectReference: string | null;
  newObjectReference: string | null;
  /** Asset name resolved from whichever side's object_reference guid is present. */
  objectReferenceAssetName: string | null;
  objectReferenceGuid: string | null;
  status: PrefabOverrideStatus;
}

/** Exact counts across the whole diff, computed before the 500-item cap. */
export interface DiffSummary {
  addedObjects: number;
  removedObjects: number;
  modifiedObjects: number;
  movedObjects: number;
  componentChanges: number;
  propertyChanges: number;
}

/** Full structured diff between two versions of one Unity asset file. */
export interface SceneDiff {
  objectDiffs: ObjectDiff[];
  prefabOverrideDiffs: PrefabOverrideDiff[];
  summary: DiffSummary;
  /** True when `objectDiffs` was capped at 500 entries. */
  truncated: boolean;
}

// ── Formatting ───────────────────────────────────────────────────────────---

function fmtVal(v: string | null): string {
  return v === null ? '∅' : v;
}

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

/**
 * Human-readable phrases for each non-zero counter in a `DiffSummary`, e.g.
 * `["2 added", "1 removed", "14 properties changed"]`. Shared by the compact
 * text formatter below and the `SceneDiffViewer` header so the wording never
 * drifts between the two surfaces.
 */
export function summarizeDiffCounts(summary: DiffSummary): string[] {
  const parts: string[] = [];
  if (summary.addedObjects > 0) parts.push(`${summary.addedObjects} added`);
  if (summary.removedObjects > 0) parts.push(`${summary.removedObjects} removed`);
  if (summary.modifiedObjects > 0) parts.push(`${summary.modifiedObjects} modified`);
  if (summary.movedObjects > 0) parts.push(`${summary.movedObjects} moved`);
  if (summary.componentChanges > 0) {
    parts.push(`${summary.componentChanges} component ${plural(summary.componentChanges, 'change', 'changes')}`);
  }
  if (summary.propertyChanges > 0) {
    parts.push(`${summary.propertyChanges} ${plural(summary.propertyChanges, 'property', 'properties')} changed`);
  }
  return parts;
}

/**
 * One-line summary for a whole `SceneDiff`: the counter phrases from
 * `summarizeDiffCounts`, a prefab-override count when present, and a
 * truncation note when `truncated`. `"No changes"` when nothing differs.
 */
export function formatDiffSummaryLine(diff: SceneDiff): string {
  const parts = summarizeDiffCounts(diff.summary);
  if (diff.prefabOverrideDiffs.length > 0) {
    const n = diff.prefabOverrideDiffs.length;
    parts.push(`${n} prefab ${plural(n, 'override', 'overrides')}`);
  }
  const base = parts.length > 0 ? parts.join(' · ') : 'No changes';
  return diff.truncated ? `${base} (truncated — showing first 500 objects)` : base;
}

function formatPropertyLine(p: PropertyDiff): string {
  return `${p.key}: ${fmtVal(p.old)} → ${fmtVal(p.new)}`;
}

function formatComponentDiffLines(c: ComponentDiff): string[] {
  if (c.status === 'added') return [`+ ${c.typeName} added`];
  if (c.status === 'removed') return [`- ${c.typeName} removed`];
  return c.propertyDiffs.map((p) => `${c.typeName} ${p.key}: ${fmtVal(p.old)} → ${fmtVal(p.new)}`);
}

/** GO-level property changes, then per-component changes, in that order. */
function formatChangeLines(od: ObjectDiff): string[] {
  const lines: string[] = od.propertyDiffs.map(formatPropertyLine);
  for (const c of od.componentDiffs) lines.push(...formatComponentDiffLines(c));
  return lines;
}

function formatSubtreeSuffix(subtree: SubtreeSummary | null): string {
  if (!subtree) return '';
  const componentCount = subtree.componentTypes.length;
  return ` (${componentCount} ${plural(componentCount, 'component', 'components')}, ${subtree.childCount} ${plural(subtree.childCount, 'child', 'children')})`;
}

function formatAddedOrRemovedLine(verb: 'Added' | 'Removed', od: ObjectDiff): string {
  return `${verb} GameObject '${od.name}'${formatSubtreeSuffix(od.subtreeSummary)}`;
}

function formatRenamedLines(od: ObjectDiff): string[] {
  let header = `Renamed '${od.oldName}' → '${od.newName}' (${od.hierarchyPath})`;
  if (od.oldParentName !== null || od.newParentName !== null) {
    header += `; moved from '${od.oldParentName ?? '?'}' to '${od.newParentName ?? '?'}'`;
  }
  const changes = formatChangeLines(od);
  return changes.length > 0 ? [header, ...changes.map((c) => `  ${c}`)] : [header];
}

function formatMovedLines(od: ObjectDiff): string[] {
  const header = `Moved '${od.name}' from '${od.oldParentName ?? '?'}' to '${od.newParentName ?? '?'}'`;
  const changes = formatChangeLines(od);
  return changes.length > 0 ? [header, ...changes.map((c) => `  ${c}`)] : [header];
}

function formatModifiedLines(od: ObjectDiff): string[] {
  const header = `Modified '${od.name}' (${od.hierarchyPath})`;
  const changes = formatChangeLines(od);
  if (changes.length === 0) return [header];
  if (changes.length === 1) return [`${header}: ${changes[0]}`];
  return [`${header}:`, ...changes.map((c) => `  ${c}`)];
}

function formatObjectDiffLines(od: ObjectDiff): string[] {
  switch (od.status) {
    case 'added':
      return [formatAddedOrRemovedLine('Added', od)];
    case 'removed':
      return [formatAddedOrRemovedLine('Removed', od)];
    case 'renamed':
      return formatRenamedLines(od);
    case 'moved':
      return formatMovedLines(od);
    default:
      return formatModifiedLines(od);
  }
}

function formatPrefabOverrideLines(p: PrefabOverrideDiff): string[] {
  const owner = p.prefabAssetName ? `'${p.prefabAssetName}'` : `prefab instance ${p.prefabInstanceFileId}`;
  const isReferenceChange = p.oldObjectReference !== null || p.newObjectReference !== null;
  let change: string;
  if (isReferenceChange) {
    if (p.status === 'removed') {
      change = 'reference removed';
    } else {
      const label = p.objectReferenceAssetName ?? p.objectReferenceGuid ?? 'unknown asset';
      change = `reference → ${label}`;
    }
  } else {
    change = `${fmtVal(p.oldValue)} → ${fmtVal(p.newValue)}`;
  }
  return [`Prefab override on ${owner}: ${p.propertyPath} ${change}`];
}

/**
 * Compact human/LLM-readable rendering of a `SceneDiff`: a summary line,
 * then one entry per object diff, then one entry per prefab override diff.
 * Deterministic (mirrors the Rust engine's already-deterministic array
 * order) — safe to use as an LLM prompt fragment or a test fixture.
 */
export function formatSceneDiffForPrompt(diff: SceneDiff): string {
  const lines: string[] = [formatDiffSummaryLine(diff)];
  for (const od of diff.objectDiffs) lines.push(...formatObjectDiffLines(od));
  for (const pod of diff.prefabOverrideDiffs) lines.push(...formatPrefabOverrideLines(pod));
  return lines.join('\n');
}
