/**
 * `unity_scriptable_objects` — the project's ScriptableObject contract, for the agent.
 *
 * A ScriptableObject is a schema (the C# class) plus rows (the `.asset` files),
 * and Unity keeps them in step by NAME. Rename a serialized field without
 * `[FormerlySerializedAs]` and Unity simply cannot match the stored key any
 * more: every tuned value in every asset reverts to its default on next load,
 * with no compiler error, no console warning, and nothing in the diff to see.
 * It usually surfaces a sprint later as "the balance feels wrong".
 *
 * Before this tool the agent had no route to any of that. `read` on a `.asset`
 * spends thousands of tokens on YAML to recover a handful of field names, and
 * the drift itself is invisible at any price — it is a property of the class
 * and the assets TOGETHER, which no single file contains.
 *
 * Everything here comes from the same places the ScriptableObject inspector
 * reads: `buildSoSchema` for the class, the Rust asset reader for the values,
 * and `computeDrift` for the join. Sharing them means the agent and the
 * inspector can never disagree about what a type declares.
 */

import { Type, type Static } from '@sinclair/typebox';
import { invoke } from '@tauri-apps/api/core';
import type { AgentTool } from '../vendor/types';
import { txt, cap } from './text-result';
import type { SoField, SoSchema } from '../../../unity-analyzers';
import type { SoAssetSnapshot, DriftFinding } from '../../../unity-scriptable-objects';

/** Mirrors Rust's `SoTypeGroup` (`unity_asset_edit.rs`). */
export interface SoTypeGroup {
  scriptGuid: string;
  scriptPath: string | null;
  typeName: string;
  instances: Array<{ path: string; name: string }>;
}

const schema = Type.Object({
  type: Type.Optional(
    Type.String({
      description:
        'Class name to describe, e.g. "WeaponData". Omit to list every ScriptableObject type in the project.',
    }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        'A .cs file (describe that class) or a .asset file (read that instance\'s stored values). Alternative to `type`.',
    }),
  ),
  instances: Type.Optional(
    Type.Boolean({
      description:
        'Also show the stored value of each field across every asset of this type — the tuning table.',
    }),
  ),
  drift: Type.Optional(
    Type.Boolean({
      description:
        'Report where the assets no longer match the class: fields renamed (values silently lost), added (never tuned), or removed (stale keys).',
    }),
  ),
});
type Params = Static<typeof schema>;

/**
 * Injectable data access.
 *
 * Every default reaches its feature through a dynamic `import()`, for the
 * reason `input-actions-tool.ts` documents at the same seam: the
 * `unity-analyzers` and `unity-scriptable-objects` barrels pull Monaco and
 * React, and a static import would drag `stores/theme.ts` into Bun's DOM-less
 * runtime, where its module-scope `document` access kills the suite on import
 * alone.
 */
export interface ScriptableObjectsToolDeps {
  listTypes: (workspacePath: string) => Promise<SoTypeGroup[]>;
  readFile: (path: string) => Promise<string>;
  readMany: (paths: string[]) => Promise<Array<{ path: string; snapshot: SoAssetSnapshot }>>;
  readFields: (path: string) => Promise<SoAssetSnapshot>;
  buildSchema: (source: string, className?: string) => Promise<SoSchema | null>;
  computeDrift: (input: {
    schema: SoSchema;
    instances: Array<{ path: string; name: string; snapshot: SoAssetSnapshot }>;
  }) => Promise<DriftFinding[]>;
  describeDrift: (finding: DriftFinding) => Promise<string>;
  pickColumns: (schema: SoSchema, max: number) => Promise<SoField[]>;
  formatCell: (raw: string | null, field: SoField) => Promise<string>;
}

const defaultDeps: ScriptableObjectsToolDeps = {
  listTypes: (workspacePath) =>
    invoke<SoTypeGroup[]>('unity_scriptable_object_types', { workspacePath }),
  readFile: (path) => invoke<string>('read_file', { path }),
  readMany: (paths) =>
    invoke<Array<{ path: string; snapshot: SoAssetSnapshot }>>('unity_asset_read_many', { paths }),
  async readFields(path) {
    const { readAssetFields } = await import('../../../unity-scriptable-objects');
    return readAssetFields(path);
  },
  async buildSchema(source, className) {
    const { scanCSharp, buildSoSchema } = await import('../../../unity-analyzers');
    return buildSoSchema(scanCSharp(source), className ? { className } : undefined);
  },
  async computeDrift(input) {
    const { computeDrift } = await import('../../../unity-scriptable-objects');
    return computeDrift(input);
  },
  async describeDrift(finding) {
    const { describeDrift } = await import('../../../unity-scriptable-objects');
    return describeDrift(finding);
  },
  async pickColumns(soSchema, max) {
    const { pickColumns } = await import('../../../unity-scriptable-objects');
    return pickColumns(soSchema, max);
  },
  async formatCell(raw, field) {
    const { formatCell } = await import('../../../unity-scriptable-objects');
    return formatCell(raw, field);
  },
};

/** Workspace-relative path, so output matches the file tree the user sees. */
function rel(path: string, workspacePath: string): string {
  const prefix = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function assetName(path: string): string {
  return path.split('/').pop()?.replace(/\.asset$/i, '') ?? path;
}

const NO_TYPES_TEXT =
  'No ScriptableObject types with instances in this project. A class deriving from ' +
  'ScriptableObject that nobody has instanced yet has nothing to browse — read the .cs directly. ' +
  'New instances are created in Unity (Assets → Create → …, driven by [CreateAssetMenu]); ' +
  'do not hand-write a .asset file.';

// ── Rendering (pure) ─────────────────────────────────────────────────────────

const MAX_INSTANCES_LISTED = 6;
const SCHEMA_COLUMNS = 8;

/** Every type with at least one asset. */
export function renderInventory(groups: SoTypeGroup[], workspacePath: string): string {
  if (groups.length === 0) return NO_TYPES_TEXT;

  const out = [`ScriptableObject types with instances (${groups.length}):`, ''];
  for (const g of [...groups].sort((a, b) => a.typeName.localeCompare(b.typeName))) {
    const script = g.scriptPath ? `  ${rel(g.scriptPath, workspacePath)}` : '  (script not resolved)';
    out.push(`${g.typeName} — ${g.instances.length} asset${g.instances.length === 1 ? '' : 's'}${script}`);
    const shown = g.instances.slice(0, MAX_INSTANCES_LISTED);
    const more = g.instances.length - shown.length;
    const names = shown.map((i) => rel(i.path, workspacePath)).join(', ');
    out.push(`    ${names}${more > 0 ? `, …${more} more` : ''}`);
  }
  out.push(
    '',
    'Pass type:"<ClassName>" for its serialized fields, instances:true for the tuning table, ' +
      'or drift:true to check whether the assets still match the class.',
  );
  return out.join('\n');
}

function fieldLine(f: SoField): string {
  const bits: string[] = [];
  const type = f.isArray ? `${f.elementType ?? f.bareType}[]` : f.csharpType;
  bits.push(`${f.name.padEnd(22)} ${type}`);
  if (f.range) bits.push(`range ${f.range.min}..${f.range.max}`);
  if (f.min !== null) bits.push(`min ${f.min}`);
  if (f.enumMembers && f.enumMembers.length > 0) {
    const members = f.enumMembers.map((m) => `${m.name}=${m.value}`).join(', ');
    bits.push(`${f.enumIsFlags ? 'flags' : 'enum'}: ${members}`);
  }
  if (f.widget === 'objectRef') bits.push('object reference');
  if (f.serializeReference) bits.push('[SerializeReference] — polymorphic');
  if (f.hiddenInInspector) bits.push('[HideInInspector]');
  if (!f.editable) bits.push('not writable by unity_asset_edit');
  if (f.formerNames.length > 0) {
    bits.push(`[FormerlySerializedAs] ${f.formerNames.map((n) => `"${n}"`).join(', ')}`);
  }
  const head = bits.shift() ?? f.name;
  const tail = bits.length > 0 ? `  (${bits.join('; ')})` : '';
  const tooltip = f.tooltip ? `\n        "${f.tooltip}"` : '';
  return `    ${head}${tail}${tooltip}`;
}

/** The class: what Unity will serialize, in the order it writes it. */
export function renderSchema(
  soSchema: SoSchema,
  scriptPath: string | null,
  instanceCount: number,
  workspacePath: string,
): string {
  const out: string[] = [];
  const where = scriptPath ? `  (${rel(scriptPath, workspacePath)})` : '';
  out.push(`${soSchema.className}${where}`);
  out.push(`  base: ${soSchema.baseTypes.join(', ') || '(none)'} — ${soSchema.baseKind}`);
  if (soSchema.menuPath || soSchema.defaultFileName) {
    out.push(
      `  [CreateAssetMenu] menuName: ${soSchema.menuPath ?? '(default)'}  fileName: ${soSchema.defaultFileName ?? '(default)'}`,
    );
  }
  out.push(`  instances: ${instanceCount}`);

  if (soSchema.fields.length === 0) {
    out.push('', 'No serialized fields. Nothing is stored in the assets.');
    return out.join('\n');
  }

  out.push('', 'Serialized fields (Unity writes them in this order):');
  for (const group of soSchema.groups) {
    if (group.header) out.push(`  [${group.header}]`);
    for (const f of group.fields) out.push(fieldLine(f));
  }

  out.push(
    '',
    `Renaming a field WITHOUT adding [FormerlySerializedAs("oldName")] makes Unity unable to ` +
      `match the stored key, so every tuned value in all ${instanceCount} asset${instanceCount === 1 ? '' : 's'} ` +
      `reverts to its default. There is no compiler error and no warning. Add the attribute in the ` +
      `same edit as the rename, then call unity_scriptable_objects with drift:true to confirm.`,
  );
  return out.join('\n');
}

/** One asset's stored values. */
export function renderInstance(
  snapshot: SoAssetSnapshot,
  path: string,
  workspacePath: string,
): string {
  const out = [`${rel(path, workspacePath)}`, `  document fileID: ${snapshot.documentFileId}  classId: ${snapshot.classId}`];
  if (snapshot.scriptGuid) out.push(`  script guid: ${snapshot.scriptGuid}`);
  out.push('', 'Stored values (verbatim from the file):');
  for (const f of snapshot.fields) {
    const note = f.editable ? '' : `   [not editable: ${f.reason ?? f.kind}]`;
    out.push(`  ${f.key.padEnd(22)} ${f.raw}${note}`);
  }
  out.push(
    '',
    'Change a value with unity_asset_edit — it writes byte-exactly through the same guarded ' +
      'writer the inspector uses. Do NOT edit this file with the edit tool: the YAML carries ' +
      'fileIDs and GUIDs that a text edit can silently break.',
  );
  return out.join('\n');
}

// ── Execution paths ──────────────────────────────────────────────────────────

function findGroup(groups: SoTypeGroup[], name: string): SoTypeGroup | null {
  const lower = name.toLowerCase();
  return (
    groups.find((g) => g.typeName === name) ??
    groups.find((g) => g.typeName.toLowerCase() === lower) ??
    null
  );
}

async function instancesTable(
  soSchema: SoSchema,
  group: SoTypeGroup,
  deps: ScriptableObjectsToolDeps,
): Promise<string> {
  const columns = await deps.pickColumns(soSchema, SCHEMA_COLUMNS);
  if (columns.length === 0) {
    return 'No scalar fields to tabulate — this type stores only references, arrays or nested values.';
  }
  const read = await deps.readMany(group.instances.map((i) => i.path));
  const out = [`Values across ${read.length} asset${read.length === 1 ? '' : 's'}:`, ''];
  out.push(['asset'.padEnd(28), ...columns.map((c) => c.name)].join(' | '));

  for (const { path, snapshot } of read) {
    const byKey = new Map(snapshot.fields.map((f) => [f.key, f.raw]));
    const cells: string[] = [];
    for (const col of columns) {
      let raw = byKey.get(col.name) ?? null;
      // A value still stored under a former name is that field's value, not a
      // blank — otherwise a half-finished rename reads as data loss here.
      if (raw === null) {
        for (const former of col.formerNames) {
          const legacy = byKey.get(former);
          if (legacy !== undefined) {
            raw = legacy;
            break;
          }
        }
      }
      cells.push(await deps.formatCell(raw, col));
    }
    out.push([assetName(path).padEnd(28), ...cells].join(' | '));
  }
  out.push('', 'A cell showing — means the key is absent from that asset.');
  return out.join('\n');
}

async function driftReport(
  soSchema: SoSchema,
  group: SoTypeGroup,
  workspacePath: string,
  deps: ScriptableObjectsToolDeps,
): Promise<string> {
  const read = await deps.readMany(group.instances.map((i) => i.path));
  const findings = await deps.computeDrift({
    schema: soSchema,
    instances: read.map((r) => ({ path: r.path, name: assetName(r.path), snapshot: r.snapshot })),
  });

  if (findings.length === 0) {
    return `No schema drift: every one of the ${read.length} ${group.typeName} asset${read.length === 1 ? '' : 's'} matches the class as declared.`;
  }

  const out = [
    `Schema drift for ${group.typeName} — ${findings.length} finding${findings.length === 1 ? '' : 's'} across ${read.length} asset${read.length === 1 ? '' : 's'}:`,
  ];
  for (const f of findings) {
    out.push('');
    const label = f.kind.toUpperCase();
    const former = f.formerKey ? `  (assets still store "${f.formerKey}")` : '';
    out.push(`${label}  ${f.key}${former}${f.csharpType ? `  ${f.csharpType}` : ''}`);
    out.push(`  ${await deps.describeDrift(f)}`);
    const shown = f.assets.slice(0, MAX_INSTANCES_LISTED);
    for (const a of shown) {
      const value = a.currentRaw !== null ? ` (${f.formerKey ?? f.key}: ${a.currentRaw})` : '';
      out.push(`    ${rel(a.path, workspacePath)}${value}`);
    }
    if (f.assets.length > shown.length) {
      out.push(`    …${f.assets.length - shown.length} more`);
    }
    out.push(`  ${f.fixable ? 'Repairable with unity_fix_so_drift.' : 'Not automatically repairable — describe the fix to the user.'}`);
  }
  out.push(
    '',
    'A "renamed" finding is the destructive one: the value is still on disk under the old key, ' +
      'and Unity will drop it the next time it loads the asset. Repair it before that happens.',
  );
  return out.join('\n');
}

export function createUnityScriptableObjectsTool(
  workspacePath: string,
  deps: ScriptableObjectsToolDeps = defaultDeps,
): AgentTool {
  return {
    name: 'unity_scriptable_objects',
    label: 'unity scriptable objects',
    description:
      "Read the project's ScriptableObjects: every type with assets, the serialized fields a class declares " +
      '(types, ranges, enum members, [FormerlySerializedAs] names, [CreateAssetMenu] path), the values stored ' +
      'across every instance, and schema drift between the class and its assets. ' +
      'Call this BEFORE renaming, removing or reordering any serialized field on a ScriptableObject or ' +
      'MonoBehaviour: a rename without [FormerlySerializedAs] silently reverts every tuned value in every ' +
      'asset to its default, with no compiler error and no warning. ' +
      'Far cheaper than reading .asset YAML, and it can see drift, which no single file contains.',
    parameters: schema,
    async execute(_id, params) {
      const { type, path, instances = false, drift = false } = params as Params;

      // A `.asset` path is answerable without the project inventory.
      if (path && /\.asset$/i.test(path)) {
        try {
          const snapshot = await deps.readFields(path);
          return txt(cap(renderInstance(snapshot, path, workspacePath)));
        } catch (e) {
          return txt(
            `Could not read ${rel(path, workspacePath)} as a Unity asset: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      let groups: SoTypeGroup[];
      try {
        groups = await deps.listTypes(workspacePath);
      } catch {
        return txt(
          'Could not enumerate ScriptableObject types — the Unity asset index is unavailable. ' +
            'Retry once, or read the class and its .asset files directly.',
        );
      }

      // A `.cs` path describes that class whether or not it has instances.
      if (path && /\.cs$/i.test(path)) {
        const source = await deps.readFile(path).catch(() => null);
        if (source === null) return txt(`Could not read ${rel(path, workspacePath)}.`);
        const built = await deps.buildSchema(source);
        if (!built) return txt(`No class found in ${rel(path, workspacePath)}.`);
        const group = findGroup(groups, built.className);
        return txt(
          cap(renderSchema(built, path, group?.instances.length ?? 0, workspacePath)),
        );
      }

      if (!type) return txt(cap(renderInventory(groups, workspacePath)));

      const group = findGroup(groups, type);
      if (!group) {
        const known = groups.map((g) => g.typeName).join(', ');
        return txt(
          `No ScriptableObject type named "${type}" has any assets in this project. ` +
            (known
              ? `Types with assets: ${known}. `
              : 'No type in this project has assets yet. ') +
            'If the class exists but has no instances, pass its .cs path instead.',
        );
      }
      if (!group.scriptPath) {
        return txt(
          `${group.typeName} has ${group.instances.length} asset(s), but its script could not be ` +
            'resolved from the GUID index, so the class schema is unavailable. The assets are: ' +
            group.instances.map((i) => rel(i.path, workspacePath)).join(', '),
        );
      }

      const source = await deps.readFile(group.scriptPath).catch(() => null);
      if (source === null) return txt(`Could not read ${rel(group.scriptPath, workspacePath)}.`);
      const built = await deps.buildSchema(source, group.typeName);
      if (!built) return txt(`No class named ${group.typeName} in ${rel(group.scriptPath, workspacePath)}.`);

      const sections = [
        renderSchema(built, group.scriptPath, group.instances.length, workspacePath),
      ];
      if (instances) sections.push(await instancesTable(built, group, deps));
      if (drift) sections.push(await driftReport(built, group, workspacePath, deps));
      return txt(cap(sections.join('\n\n')));
    },
  };
}
