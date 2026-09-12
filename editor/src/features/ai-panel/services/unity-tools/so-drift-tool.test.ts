// A `renamed` finding moves real tuned values between keys, so the safety
// property under test is that nothing is written unless the caller explicitly
// asked, and that a write always carries the sha1 the asset was read at.

import { describe, it, expect } from 'bun:test';
import { createUnityFixSoDriftTool, type SoDriftToolDeps } from './so-drift-tool';
import type { SoField, SoSchema } from '../../../unity-analyzers';
import type { DriftFinding, SoAssetSnapshot, SoEditResult, SoFieldEdit } from '../../../unity-scriptable-objects';
import type { SoTypeGroup } from './scriptable-objects-tool';

const WS = '/proj';

const FIELD = {
  name: 'weight',
  csharpType: 'float',
  bareType: 'float',
  widget: 'float',
  isArray: false,
  elementType: null,
  elementWidget: null,
  header: null,
  tooltip: null,
  range: null,
  min: null,
  hiddenInInspector: false,
  serializeReference: false,
  formerNames: ['mass'],
  enumMembers: null,
  enumIsFlags: false,
  editable: true,
  declLine: 3,
  nameOffset: 0,
  declSpan: { start: 0, end: 1 },
  attributes: [],
} satisfies SoField;

const SCHEMA: SoSchema = {
  className: 'WeaponData',
  baseTypes: ['ScriptableObject'],
  baseKind: 'scriptableObject',
  unresolvedBase: null,
  menuPath: null,
  defaultFileName: null,
  fields: [FIELD],
  groups: [{ header: null, fields: [FIELD] }],
};

const GROUPS: SoTypeGroup[] = [
  {
    scriptGuid: 'g1',
    scriptPath: `${WS}/Assets/Scripts/WeaponData.cs`,
    typeName: 'WeaponData',
    instances: [{ path: `${WS}/Assets/Data/Sword.asset`, name: 'Sword' }],
  },
];

const SNAPSHOT: SoAssetSnapshot = {
  documentFileId: '11400000',
  classId: '114',
  scriptGuid: 'g1',
  sha1: 'sha-sword',
  fields: [{ key: 'mass', raw: '4.5', kind: 'scalar', editable: true, reason: null, members: [] }],
};

const RENAMED: DriftFinding = {
  kind: 'renamed',
  key: 'weight',
  formerKey: 'mass',
  csharpType: 'float',
  fixable: true,
  assets: [
    {
      path: `${WS}/Assets/Data/Sword.asset`,
      name: 'Sword',
      fileId: '11400000',
      currentRaw: '4.5',
      insertAfter: 'mass',
    },
  ],
};

const OK: SoEditResult = {
  written: true,
  unchanged: false,
  rejections: [],
  sha1: 'after',
  path: `${WS}/Assets/Data/Sword.asset`,
};

function deps(over: Partial<SoDriftToolDeps> = {}): SoDriftToolDeps {
  return {
    listTypes: async () => GROUPS,
    readFile: async () => 'class WeaponData : ScriptableObject {}',
    readMany: async (paths) => paths.map((path) => ({ path, snapshot: SNAPSHOT })),
    buildSchema: async () => SCHEMA,
    computeDrift: async () => [RENAMED],
    describeDrift: async () => 'every tuned value reverts to the default on next load',
    fixEditsFor: async () =>
      new Map<string, SoFieldEdit[]>([
        [
          `${WS}/Assets/Data/Sword.asset`,
          [
            { fileId: '11400000', path: 'weight', value: '4.5', ifMissing: { mode: 'insertAfter', anchor: 'mass' } },
            { fileId: '11400000', path: 'mass', value: '', remove: true, expected: '4.5' },
          ],
        ],
      ]),
    write: async () => OK,
    ...over,
  };
}

async function run(params: object, over?: Partial<SoDriftToolDeps>): Promise<string> {
  const result = await createUnityFixSoDriftTool(WS, deps(over)).execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('unity_fix_so_drift', () => {
  it('reports without writing by default', async () => {
    let wrote = false;
    const out = await run(
      { type: 'WeaponData' },
      {
        write: async () => {
          wrote = true;
          return OK;
        },
      },
    );
    expect(wrote).toBe(false);
    expect(out).toContain('nothing written');
    expect(out).toContain('apply:true');
  });

  it('writes only when apply is explicit, and carries the read-time sha1', async () => {
    let seen: { path: string; sha1: string } | undefined;
    const out = await run(
      { type: 'WeaponData', apply: true },
      {
        write: async (path, _e, sha1) => {
          seen = { path, sha1 };
          return OK;
        },
      },
    );
    expect(seen).toEqual({ path: `${WS}/Assets/Data/Sword.asset`, sha1: 'sha-sword' });
    expect(out).toContain('Repaired 1 drift finding');
    expect(out).toContain('2 edit(s) written');
  });

  it('pairs the rename’s insert and remove in one write per asset', async () => {
    let edits: SoFieldEdit[] = [];
    await run(
      { type: 'WeaponData', apply: true },
      {
        write: async (_p, e) => {
          edits = e;
          return OK;
        },
      },
    );
    expect(edits).toHaveLength(2);
    expect(edits[0].path).toBe('weight');
    expect(edits[1].remove).toBe(true);
  });

  it('filters to the kinds asked for', async () => {
    const added: DriftFinding = { ...RENAMED, kind: 'added', key: 'armour', formerKey: null };
    const out = await run(
      { type: 'WeaponData', kinds: ['added'] },
      { computeDrift: async () => [RENAMED, added] },
    );
    expect(out).toContain('ADDED  armour');
    expect(out).not.toContain('RENAMED');
  });

  it('says so plainly when there is nothing to repair', async () => {
    expect(await run({ type: 'WeaponData' }, { computeDrift: async () => [] })).toContain('No drift');
  });

  it('does not claim a repair it cannot make', async () => {
    const out = await run(
      { type: 'WeaponData', apply: true },
      { computeDrift: async () => [{ ...RENAMED, fixable: false }], fixEditsFor: async () => new Map() },
    );
    expect(out).toContain('Not automatically repairable');
    expect(out).toContain('no asset changed');
  });

  it('needs a type or a path, and says which', async () => {
    expect(await run({})).toContain('Pass either type');
  });

  it('names the types that do exist when the requested one has no assets', async () => {
    const out = await run({ type: 'Nope' });
    expect(out).toContain('WeaponData');
    expect(out).toContain('cannot drift');
  });

  it('reports a failed write per asset rather than aborting the run', async () => {
    const out = await run(
      { type: 'WeaponData', apply: true },
      {
        write: async () => {
          throw new Error('disk full');
        },
      },
    );
    expect(out).toContain('failed — disk full');
  });
});
