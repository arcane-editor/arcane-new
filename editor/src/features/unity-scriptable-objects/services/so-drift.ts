// ── Schema drift ────────────────────────────────────────────────────────────
//
// The C# class is the schema; the `.asset` files are the rows. They fall out of
// step every time someone edits the class, and Unity says nothing:
//
//  • A field ADDED in code is simply absent from existing assets. Unity fills
//    the default at load, so nothing breaks — and the value is never tuned
//    because nobody can see that it exists.
//  • A field RENAMED in code no longer matches the key the assets store. Unity
//    cannot match them, so every tuned value silently reverts to the default.
//    This is the expensive one: no compiler error, no warning, and it usually
//    surfaces a sprint later as "the balance feels wrong".
//  • A field REMOVED from code leaves its key behind in every asset. Harmless
//    to Unity, but it shows up in every diff forever.
//
// Pure: the caller supplies the schema and the instances it already read, so
// this is testable without Tauri and cheap to re-run.

import type { SoField, SoSchema } from '../../unity-analyzers';
import type { SoAssetSnapshot, SoFieldEdit } from './asset-fields-client';

export type DriftKind = 'added' | 'renamed' | 'orphan';

/** One asset affected by a finding, plus whatever value is at stake. */
export interface DriftAsset {
  path: string;
  name: string;
  fileId: string;
  /** The value stored under the old key, for a rename. */
  currentRaw: string | null;
  /** The key to anchor an insertion after, for `added`/`renamed`. */
  insertAfter: string | null;
}

export interface DriftFinding {
  kind: DriftKind;
  /** The field as the class now names it, or the stale key for an orphan. */
  key: string;
  /** For a rename: the key the assets still store it under. */
  formerKey: string | null;
  /** Human-readable C# type, for display. */
  csharpType: string | null;
  assets: DriftAsset[];
  /** False when we can describe the drift but not safely repair it. */
  fixable: boolean;
}

/** Unity's own bookkeeping, never part of a class's schema. */
function isBookkeeping(key: string): boolean {
  return key.startsWith('m_') || key === 'serializedVersion';
}

/** A default value to write for a newly added field, or null if we can't infer one. */
export function defaultRawFor(field: SoField): string | null {
  switch (field.widget) {
    case 'int':
    case 'float':
      return '0';
    case 'bool':
      return '0';
    case 'string':
      return "''";
    case 'enum':
    case 'enumFlags':
      // The member with value 0 if there is one, else the lowest.
      if (!field.enumMembers || field.enumMembers.length === 0) return '0';
      return String(
        field.enumMembers.find((m) => m.value === 0)?.value ??
          Math.min(...field.enumMembers.map((m) => m.value)),
      );
    default:
      // Vectors, colours, references and anything structured have no
      // single obviously-correct literal. Leaving the key absent lets Unity
      // supply the real default, which is better than us inventing one.
      return null;
  }
}

export interface DriftInput {
  schema: SoSchema;
  instances: Array<{ path: string; name: string; snapshot: SoAssetSnapshot }>;
}

/**
 * Compare a class against every asset instancing it.
 *
 * Findings are ordered by severity: renames first, because they are the only
 * kind that silently destroys data.
 */
export function computeDrift({ schema, instances }: DriftInput): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const schemaByName = new Map(schema.fields.map((f) => [f.name, f]));

  for (const field of schema.fields) {
    const added: DriftAsset[] = [];
    const renamed: DriftAsset[] = [];

    for (const inst of instances) {
      const keys = new Set(inst.snapshot.fields.map((f) => f.key));
      if (keys.has(field.name)) continue;

      const former = field.formerNames.find((n) => keys.has(n));
      const anchor = lastPresentKeyBefore(schema, inst, field.name);
      if (former) {
        renamed.push({
          path: inst.path,
          name: inst.name,
          fileId: inst.snapshot.documentFileId,
          currentRaw: inst.snapshot.fields.find((f) => f.key === former)?.raw ?? null,
          insertAfter: anchor,
        });
      } else {
        added.push({
          path: inst.path,
          name: inst.name,
          fileId: inst.snapshot.documentFileId,
          currentRaw: null,
          insertAfter: anchor,
        });
      }
    }

    if (renamed.length > 0) {
      findings.push({
        kind: 'renamed',
        key: field.name,
        formerKey: field.formerNames.find((n) =>
          instances.some((i) => i.snapshot.fields.some((f) => f.key === n)),
        ) ?? field.formerNames[0] ?? null,
        csharpType: field.csharpType,
        assets: renamed,
        fixable: true,
      });
    }
    if (added.length > 0) {
      findings.push({
        kind: 'added',
        key: field.name,
        formerKey: null,
        csharpType: field.csharpType,
        assets: added,
        // Only fixable when we can name a default worth writing.
        fixable: field.editable && defaultRawFor(field) !== null,
      });
    }
  }

  // Keys in the assets that the class no longer declares.
  const orphanAssets = new Map<string, DriftAsset[]>();
  for (const inst of instances) {
    for (const f of inst.snapshot.fields) {
      if (isBookkeeping(f.key)) continue;
      if (schemaByName.has(f.key)) continue;
      // A key that is some field's FORMER name is a rename, not an orphan —
      // reporting it twice would invite deleting the value before it moves.
      const isFormer = schema.fields.some((s) => s.formerNames.includes(f.key));
      if (isFormer) continue;
      const list = orphanAssets.get(f.key) ?? [];
      list.push({
        path: inst.path,
        name: inst.name,
        fileId: inst.snapshot.documentFileId,
        currentRaw: f.raw,
        insertAfter: null,
      });
      orphanAssets.set(f.key, list);
    }
  }
  for (const [key, assets] of orphanAssets) {
    findings.push({
      kind: 'orphan',
      key,
      formerKey: null,
      csharpType: null,
      assets,
      fixable: true,
    });
  }

  const severity: Record<DriftKind, number> = { renamed: 0, added: 1, orphan: 2 };
  return findings.sort(
    (a, b) => severity[a.kind] - severity[b.kind] || a.key.localeCompare(b.key),
  );
}

/**
 * The last schema field that IS present in this asset before `name`, so an
 * inserted key lands in the class's declaration order rather than at the end.
 */
function lastPresentKeyBefore(
  schema: SoSchema,
  inst: { snapshot: SoAssetSnapshot },
  name: string,
): string | null {
  const keys = new Set(inst.snapshot.fields.map((f) => f.key));
  let anchor: string | null = null;
  for (const f of schema.fields) {
    if (f.name === name) break;
    if (keys.has(f.name)) anchor = f.name;
    else {
      const former = f.formerNames.find((n) => keys.has(n));
      if (former) anchor = former;
    }
  }
  return anchor;
}

/** The edits that repair one finding, grouped by asset path. */
export function fixEditsFor(
  finding: DriftFinding,
  field: SoField | null,
): Map<string, SoFieldEdit[]> {
  const byPath = new Map<string, SoFieldEdit[]>();
  if (!finding.fixable) return byPath;

  for (const asset of finding.assets) {
    const edits: SoFieldEdit[] = [];
    switch (finding.kind) {
      case 'renamed': {
        if (!finding.formerKey || asset.currentRaw === null) break;
        // Insert the new key carrying the OLD value, then drop the old key —
        // one atomic write, so a crash cannot lose the value between them.
        edits.push({
          fileId: asset.fileId,
          path: finding.key,
          value: asset.currentRaw,
          ifMissing: { mode: 'insertAfter', anchor: finding.formerKey },
        });
        edits.push({
          fileId: asset.fileId,
          path: finding.formerKey,
          value: '',
          remove: true,
          expected: asset.currentRaw,
        });
        break;
      }
      case 'added': {
        const value = field ? defaultRawFor(field) : null;
        if (value === null) break;
        edits.push({
          fileId: asset.fileId,
          path: finding.key,
          value,
          ifMissing: asset.insertAfter
            ? { mode: 'insertAfter', anchor: asset.insertAfter }
            : { mode: 'insertAtEnd' },
        });
        break;
      }
      case 'orphan': {
        edits.push({
          fileId: asset.fileId,
          path: finding.key,
          value: '',
          remove: true,
        });
        break;
      }
    }
    if (edits.length > 0) byPath.set(asset.path, edits);
  }
  return byPath;
}

/** One-line description of what a finding means, in the user's terms. */
export function describeDrift(f: DriftFinding): string {
  const n = f.assets.length;
  const assets = `${n} ${n === 1 ? 'asset' : 'assets'}`;
  switch (f.kind) {
    case 'renamed':
      return `${assets} still store this under "${f.formerKey}". Unity cannot match it, so every tuned value reverts to the default on next load.`;
    case 'added':
      return `Declared in code, absent from ${assets}. Unity fills the default at load, so the value is never tuned.`;
    case 'orphan':
      return `No longer declared in the class, still present in ${assets}. Harmless to Unity, but it shows up in every diff.`;
  }
}
