/**
 * `unity_fix_so_drift` — repair the gap between a ScriptableObject class and
 * the assets that instance it.
 *
 * The three drifts and why only one of them is urgent:
 *
 *   - **renamed** — the class calls a field `weight`, the assets still store
 *     `mass`. Unity cannot match them, so on the next load every tuned value
 *     becomes the type default. The value is still on disk right now; it stops
 *     existing the moment Unity reloads the asset. This is the one worth
 *     interrupting work for, and it is the reason this tool exists separately
 *     from `unity_asset_edit`.
 *   - **added** — a field declared in code that no asset stores. Harmless
 *     (Unity supplies the default) but the value is never tuned, because
 *     nobody can see it exists.
 *   - **orphan** — a key no field claims. Harmless to Unity; it shows up in
 *     every diff forever.
 *
 * The repair itself is `so-drift.ts`'s `fixEditsFor`, the same code path the
 * Drift tab's one-click fix uses — a rename is an insert-new plus remove-old in
 * ONE batch, so a crash between them cannot lose the value.
 */

import { Type, type Static } from '@sinclair/typebox';
import { invoke } from '@tauri-apps/api/core';
import type { AgentTool } from '../vendor/types';
import { txt, cap } from './text-result';
import type { SoField, SoSchema } from '../../../unity-analyzers';
import type {
  DriftFinding,
  DriftKind,
  SoAssetSnapshot,
  SoEditResult,
  SoFieldEdit,
} from '../../../unity-scriptable-objects';
import type { SoTypeGroup } from './scriptable-objects-tool';

const KIND = Type.Union([
  Type.Literal('renamed'),
  Type.Literal('added'),
  Type.Literal('orphan'),
]);

const schema = Type.Object({
  type: Type.Optional(
    Type.String({ description: 'The ScriptableObject class name, e.g. "WeaponData".' }),
  ),
  path: Type.Optional(
    Type.String({ description: 'The class\'s .cs file. Alternative to `type`.' }),
  ),
  kinds: Type.Optional(
    Type.Array(KIND, {
      description:
        'Which drifts to act on. Defaults to all three. "renamed" is the only one that loses data.',
    }),
  ),
  apply: Type.Optional(
    Type.Boolean({
      description:
        'Actually write the repairs. Off by default: this rewrites values in every affected asset, so report first and apply once the user has seen what would change.',
    }),
  ),
});
type Params = Static<typeof schema>;

export interface SoDriftToolDeps {
  /** Called per asset actually written — see `asset-edit-tool.ts`'s `onWrite`. */
  onWrite?: (path: string) => void;
  listTypes: (workspacePath: string) => Promise<SoTypeGroup[]>;
  readFile: (path: string) => Promise<string>;
  readMany: (paths: string[]) => Promise<Array<{ path: string; snapshot: SoAssetSnapshot }>>;
  buildSchema: (source: string, className?: string) => Promise<SoSchema | null>;
  computeDrift: (input: {
    schema: SoSchema;
    instances: Array<{ path: string; name: string; snapshot: SoAssetSnapshot }>;
  }) => Promise<DriftFinding[]>;
  describeDrift: (finding: DriftFinding) => Promise<string>;
  fixEditsFor: (
    finding: DriftFinding,
    field: SoField | null,
  ) => Promise<Map<string, SoFieldEdit[]>>;
  write: (path: string, edits: SoFieldEdit[], expectedSha1: string) => Promise<SoEditResult>;
}

/** Every default reaches its feature through a dynamic import — see `asset-edit-tool.ts`. */
export const defaultSoDriftDeps: SoDriftToolDeps = {
  listTypes: (workspacePath) =>
    invoke<SoTypeGroup[]>('unity_scriptable_object_types', { workspacePath }),
  readFile: (path) => invoke<string>('read_file', { path }),
  readMany: (paths) =>
    invoke<Array<{ path: string; snapshot: SoAssetSnapshot }>>('unity_asset_read_many', { paths }),
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
  async fixEditsFor(finding, field) {
    const { fixEditsFor } = await import('../../../unity-scriptable-objects');
    return fixEditsFor(finding, field);
  },
  async write(path, edits, expectedSha1) {
    const { writeAssetFields } = await import('../../../unity-scriptable-objects');
    return writeAssetFields(path, edits, expectedSha1);
  },
};

function assetName(path: string): string {
  return path.split('/').pop()?.replace(/\.asset$/i, '') ?? path;
}

/** Findings ordered as `computeDrift` orders them: renames first. */
export function renderReport(
  typeName: string,
  findings: readonly DriftFinding[],
  described: readonly string[],
  applied: boolean,
): string {
  if (findings.length === 0) {
    return `No drift for ${typeName}: every asset matches the class as declared.`;
  }
  const out = [
    applied
      ? `Repaired ${findings.length} drift finding(s) for ${typeName}:`
      : `${findings.length} drift finding(s) for ${typeName} (nothing written — pass apply:true to repair):`,
  ];
  findings.forEach((f, i) => {
    out.push('', `${f.kind.toUpperCase()}  ${f.key}${f.formerKey ? ` (stored as "${f.formerKey}")` : ''}`);
    out.push(`  ${described[i]}`);
    if (!f.fixable) out.push('  Not automatically repairable — describe the fix to the user.');
  });
  return out.join('\n');
}

export function createUnityFixSoDriftTool(
  workspacePath: string,
  deps: SoDriftToolDeps = defaultSoDriftDeps,
): AgentTool {
  return {
    name: 'unity_fix_so_drift',
    label: 'unity fix scriptable object drift',
    description:
      'Find and repair drift between a ScriptableObject class and the .asset files that instance it: ' +
      'fields renamed in code (every tuned value silently reverts to its default on next load), fields ' +
      'added in code (present in no asset, so never tuned), and stale keys the class no longer declares. ' +
      'Reports by default; pass apply:true to write the repairs. A rename is repaired as one atomic ' +
      'insert-plus-remove per asset, so the tuned value moves to the new key rather than being lost. ' +
      'Run this after ANY serialized-field rename you make on a ScriptableObject.',
    parameters: schema,
    async execute(_id, params) {
      const { type, path, kinds, apply = false } = params as Params;
      if (!type && !path) {
        return txt('Pass either type ("WeaponData") or path (the class\'s .cs file).');
      }

      let groups: SoTypeGroup[];
      try {
        groups = await deps.listTypes(workspacePath);
      } catch {
        return txt('Could not enumerate ScriptableObject types — the Unity asset index is unavailable.');
      }

      const group = type
        ? groups.find((g) => g.typeName === type) ??
          groups.find((g) => g.typeName.toLowerCase() === type.toLowerCase())
        : groups.find((g) => g.scriptPath === path || g.scriptPath?.endsWith(path!));
      if (!group) {
        const known = groups.map((g) => g.typeName).join(', ') || '(none)';
        return txt(
          `No ScriptableObject type matching ${type ?? path} has assets in this project. ` +
            `Types with assets: ${known}. A class with no instances cannot drift.`,
        );
      }
      const scriptPath = group.scriptPath ?? path;
      if (!scriptPath) {
        return txt(`${group.typeName}'s script could not be resolved, so its schema is unavailable.`);
      }

      const source = await deps.readFile(scriptPath).catch(() => null);
      if (source === null) return txt(`Could not read ${scriptPath}.`);
      const soSchema = await deps.buildSchema(source, group.typeName);
      if (!soSchema) return txt(`No class named ${group.typeName} in ${scriptPath}.`);

      const read = await deps.readMany(group.instances.map((i) => i.path));
      const all = await deps.computeDrift({
        schema: soSchema,
        instances: read.map((r) => ({ path: r.path, name: assetName(r.path), snapshot: r.snapshot })),
      });
      const wanted: DriftKind[] = kinds ?? ['renamed', 'added', 'orphan'];
      const findings = all.filter((f) => wanted.includes(f.kind));
      const described = await Promise.all(findings.map((f) => deps.describeDrift(f)));

      if (!apply) return txt(cap(renderReport(group.typeName, findings, described, false)));

      // Apply: batch every finding's edits per asset, so one asset takes one
      // write. `fixEditsFor` already pairs a rename's insert and remove inside
      // one batch; grouping across findings keeps that property.
      const byPath = new Map<string, SoFieldEdit[]>();
      for (const f of findings) {
        if (!f.fixable) continue;
        const field = soSchema.fields.find((x) => x.name === f.key) ?? null;
        const edits = await deps.fixEditsFor(f, field);
        for (const [assetPath, list] of edits) {
          byPath.set(assetPath, [...(byPath.get(assetPath) ?? []), ...list]);
        }
      }

      const sha1 = new Map(read.map((r) => [r.path, r.snapshot.sha1]));
      const outcomes: string[] = [];
      for (const [assetPath, edits] of byPath) {
        const expected = sha1.get(assetPath);
        if (!expected) {
          outcomes.push(`  ${assetName(assetPath)}: skipped — it was not read in this pass.`);
          continue;
        }
        try {
          const result = await deps.write(assetPath, edits, expected);
          if (result.written) deps.onWrite?.(assetPath);
          outcomes.push(
            result.written
              ? `  ${assetName(assetPath)}: ${edits.length} edit(s) written.`
              : `  ${assetName(assetPath)}: nothing written (${result.rejections.length} refused).`,
          );
        } catch (e) {
          outcomes.push(
            `  ${assetName(assetPath)}: failed — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const report = renderReport(group.typeName, findings, described, true);
      return txt(
        cap(
          outcomes.length > 0
            ? `${report}\n\nPer asset:\n${outcomes.join('\n')}`
            : `${report}\n\nNothing was writable, so no asset changed.`,
        ),
      );
    },
  };
}
