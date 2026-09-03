/**
 * `unity_asset_edit` — change a value inside a Unity serialized asset.
 *
 * Before this the agent's only route to a `.asset` was the generic `edit` tool
 * on raw YAML — which is precisely the operation the human UI refuses to offer,
 * because Unity YAML carries `fileID`s, GUIDs, anchors and block scalars that a
 * plausible-looking text edit silently breaks. A corrupted asset does not fail
 * to compile; it fails to load, later, in the Editor.
 *
 * So this routes through `unity_asset_apply_edits`, the byte-exact Rust writer
 * the ScriptableObject inspector already uses. It splices value spans rather
 * than re-serializing, refuses anything it cannot write safely, and is guarded
 * by the file's sha1 so "Unity re-saved this while you were working" becomes a
 * rejected write instead of a clobber.
 *
 * The model is never asked for the fileID or the sha1: this tool reads the
 * snapshot itself immediately before writing. Asking would invite an invented
 * value for the one field whose whole purpose is to be a checksum.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { txt, cap } from './text-result';
import type {
  SoAssetSnapshot,
  SoEditResult,
  SoFieldEdit,
} from '../../../unity-scriptable-objects';

const schema = Type.Object({
  path: Type.String({
    description: 'The .asset file to edit, e.g. "Assets/Data/Weapons/Sword.asset".',
  }),
  edits: Type.Array(
    Type.Object({
      field: Type.String({
        description:
          'The serialized field name, exactly as the C# class declares it. Use "tint.g" to set one member of an inline map such as a Color.',
      }),
      value: Type.String({
        description:
          'The exact value to write, in Unity\'s own serialized form: a number for int/float, 0 or 1 for bool, the ordinal for an enum, a quoted string for text.',
      }),
      expected: Type.Optional(
        Type.String({
          description:
            'Refuse the write unless the value currently on disk is exactly this. Use it when you are changing a value you previously read.',
        }),
      ),
    }),
    { minItems: 1, description: 'The field writes to apply together, atomically.' },
  ),
  insertMissing: Type.Optional(
    Type.Boolean({
      description:
        'Allow writing a field the asset does not store yet (a field added to the class after the asset was created). Off by default, so a typo in a field name is refused rather than adding a key Unity will ignore.',
    }),
  ),
});
type Params = Static<typeof schema>;

/**
 * Injectable I/O.
 *
 * Reached through a dynamic `import()` for the reason `input-actions-tool.ts`
 * documents at the same seam: the `unity-scriptable-objects` barrel exports
 * React components, so a static import drags `stores/theme.ts` into Bun's
 * DOM-less runtime and kills the suite on import alone.
 */
export interface AssetEditToolDeps {
  /**
   * Called with the path of every asset actually written.
   *
   * The same contract `createWriteTool`'s `onFileWritten` has, and it exists
   * for the same two consumers: the verified pass's touched-file registry and
   * the editor's open-buffer reload. Inferring a write from the result text
   * would be guessing at our own output.
   */
  onWrite?: (path: string) => void;
  read: (path: string) => Promise<SoAssetSnapshot>;
  write: (path: string, edits: SoFieldEdit[], expectedSha1: string) => Promise<SoEditResult>;
  describeRejection: (r: { kind: string }) => Promise<string>;
}

export const defaultAssetEditDeps: AssetEditToolDeps = {
  async read(path) {
    const { readAssetFields } = await import('../../../unity-scriptable-objects');
    return readAssetFields(path);
  },
  async write(path, edits, expectedSha1) {
    const { writeAssetFields } = await import('../../../unity-scriptable-objects');
    return writeAssetFields(path, edits, expectedSha1);
  },
  async describeRejection(r) {
    const { describeRejection } = await import('../../../unity-scriptable-objects');
    return describeRejection(r as Parameters<typeof describeRejection>[0]);
  },
};

/** Human-readable outcome, including every refusal and why. */
export function renderResult(
  result: SoEditResult,
  applied: readonly { field: string; value: string }[],
  rejectionText: readonly string[],
): string {
  const out: string[] = [];
  if (result.written) {
    out.push(`Wrote ${applied.length} field(s) to ${result.path}:`);
    for (const e of applied) out.push(`  ${e.field} = ${e.value}`);
  } else if (result.unchanged) {
    out.push(`No change: every value already matched what you asked for (${result.path}).`);
  } else {
    out.push(`Nothing was written to ${result.path}.`);
  }

  if (rejectionText.length > 0) {
    out.push('', `${rejectionText.length} edit(s) refused:`);
    for (const r of rejectionText) out.push(`  ${r}`);
    out.push(
      '',
      'A refusal is the writer protecting the file, not a transient failure — re-read the asset with ' +
        'unity_scriptable_objects before trying a different value.',
    );
  }

  if (result.written) {
    out.push(
      '',
      'Unity picks the change up on its next asset refresh. If the Editor is open and the asset is ' +
        'selected, the Inspector may need a reselect to redraw.',
    );
  }
  return out.join('\n');
}

export function createUnityAssetEditTool(deps: AssetEditToolDeps = defaultAssetEditDeps): AgentTool {
  return {
    name: 'unity_asset_edit',
    label: 'unity asset edit',
    description:
      'Change field values inside a Unity serialized asset (.asset) — ScriptableObject data, tuning ' +
      'values, settings. Writes byte-exactly through the same guarded writer the inspector uses, ' +
      'atomically and only if the file has not changed since it was read. ' +
      'Use this INSTEAD of the edit tool for any .asset: Unity YAML carries fileIDs, GUIDs and block ' +
      'scalars, and a text edit that looks right can break the asset with no compiler error — it fails ' +
      'to load in the Editor instead. Call unity_scriptable_objects first to see the exact field names ' +
      'and their current values.',
    parameters: schema,
    async execute(_id, params) {
      const { path, edits, insertMissing = false } = params as Params;

      let snapshot: SoAssetSnapshot;
      try {
        snapshot = await deps.read(path);
      } catch (e) {
        return txt(
          `Could not read ${path} as a Unity asset: ${e instanceof Error ? e.message : String(e)}. ` +
            'Check the path, and use unity_scriptable_objects to list the assets of a type.',
        );
      }

      const known = new Set(snapshot.fields.map((f) => f.key));
      const unknown = edits.filter((e) => !known.has(e.field.split('.')[0]));
      if (unknown.length > 0 && !insertMissing) {
        return txt(
          `${unknown.map((e) => `"${e.field}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ` +
            `stored in ${path}. Fields it does store: ${[...known].join(', ')}. ` +
            'If the field was added to the class after this asset was created, pass insertMissing:true; ' +
            'otherwise fix the name — Unity would ignore a key the class does not declare.',
        );
      }

      const fieldEdits: SoFieldEdit[] = edits.map((e) => ({
        fileId: snapshot.documentFileId,
        path: e.field,
        value: e.value,
        ...(e.expected !== undefined ? { expected: e.expected } : {}),
        // Omitted means reject, so the writer never invents a key by accident.
        ...(insertMissing ? { ifMissing: { mode: 'insertAtEnd' as const } } : {}),
      }));

      let result: SoEditResult;
      try {
        result = await deps.write(path, fieldEdits, snapshot.sha1);
      } catch (e) {
        return txt(`The write to ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      const rejectionText = await Promise.all(
        result.rejections.map(async (r) => {
          const described = await deps.describeRejection(r);
          return `${r.path ?? '(document)'}: ${described}`;
        }),
      );
      if (result.written) deps.onWrite?.(path);
      // By field, not by count. Rejections are not necessarily the TRAILING
      // edits, so slicing by `edits.length - rejections.length` reports the
      // wrong field as written whenever the refused one is not last.
      const rejectedFields = new Set(
        result.rejections.map((r) => r.path).filter((p): p is string => !!p),
      );
      const applied = result.written ? edits.filter((e) => !rejectedFields.has(e.field)) : [];
      return txt(cap(renderResult(result, applied, rejectionText)));
    },
  };
}
