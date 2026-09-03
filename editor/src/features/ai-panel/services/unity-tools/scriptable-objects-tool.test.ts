// The failure this tool exists to prevent is a rename that silently reverts
// tuned data, so the cases that matter are the ones where the tool has to say
// something the file alone cannot: which fields carry [FormerlySerializedAs],
// which assets have fallen behind the class, and what a value currently is.
//
// Everything is driven through the DI seam, for the reason the module header
// gives: the real deps reach `unity-analyzers` and `unity-scriptable-objects`,
// whose barrels pull Monaco and React and die under Bun on import alone.

import { describe, it, expect } from 'bun:test';
import {
  createUnityScriptableObjectsTool,
  renderInventory,
  renderSchema,
  type ScriptableObjectsToolDeps,
  type SoTypeGroup,
} from './scriptable-objects-tool';
import type { SoField, SoSchema } from '../../../unity-analyzers';
import type { SoAssetSnapshot, DriftFinding } from '../../../unity-scriptable-objects';

const WS = '/proj';

function field(over: Partial<SoField> = {}): SoField {
  return {
    name: 'damage',
    csharpType: 'int',
    bareType: 'int',
    widget: 'int',
    isArray: false,
    elementType: null,
    elementWidget: null,
    header: null,
    tooltip: null,
    range: null,
    min: null,
    hiddenInInspector: false,
    serializeReference: false,
    formerNames: [],
    enumMembers: null,
    enumIsFlags: false,
    editable: true,
    declLine: 4,
    nameOffset: 0,
    declSpan: { start: 0, end: 1 },
    attributes: [],
    ...over,
  };
}

const SCHEMA: SoSchema = {
  className: 'WeaponData',
  baseTypes: ['ScriptableObject'],
  baseKind: 'scriptableObject',
  unresolvedBase: null,
  menuPath: 'Game/Weapon Data',
  defaultFileName: 'NewWeapon',
  fields: [field(), field({ name: 'weight', csharpType: 'float', widget: 'float', formerNames: ['mass'] })],
  groups: [
    {
      header: 'Stats',
      fields: [field(), field({ name: 'weight', csharpType: 'float', widget: 'float', formerNames: ['mass'] })],
    },
  ],
};

const GROUPS: SoTypeGroup[] = [
  {
    scriptGuid: 'g1',
    scriptPath: `${WS}/Assets/Scripts/WeaponData.cs`,
    typeName: 'WeaponData',
    instances: [
      { path: `${WS}/Assets/Data/Sword.asset`, name: 'Sword' },
      { path: `${WS}/Assets/Data/Bow.asset`, name: 'Bow' },
    ],
  },
];

function snapshot(fields: Array<{ key: string; raw: string }>): SoAssetSnapshot {
  return {
    documentFileId: '11400000',
    classId: '114',
    scriptGuid: 'g1',
    sha1: 'sha',
    fields: fields.map((f) => ({ ...f, kind: 'scalar', editable: true, reason: null, members: [] })),
  };
}

function deps(over: Partial<ScriptableObjectsToolDeps> = {}): ScriptableObjectsToolDeps {
  return {
    listTypes: async () => GROUPS,
    readFile: async () => 'class WeaponData : ScriptableObject {}',
    readMany: async (paths) =>
      paths.map((path) => ({ path, snapshot: snapshot([{ key: 'damage', raw: '7' }]) })),
    readFields: async () => snapshot([{ key: 'damage', raw: '7' }]),
    buildSchema: async () => SCHEMA,
    computeDrift: async () => [],
    describeDrift: async () => 'described',
    pickColumns: async (s) => s.fields.filter((f) => f.widget === 'int' || f.widget === 'float'),
    formatCell: async (raw) => raw ?? '—',
    ...over,
  };
}

async function run(params: object, over?: Partial<ScriptableObjectsToolDeps>): Promise<string> {
  const tool = createUnityScriptableObjectsTool(WS, deps(over));
  const result = await tool.execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('unity_scriptable_objects — inventory', () => {
  it('lists every type with its script and instance count, workspace-relative', async () => {
    const out = await run({});
    expect(out).toContain('WeaponData — 2 assets');
    expect(out).toContain('Assets/Scripts/WeaponData.cs');
    expect(out).not.toContain(`${WS}/Assets/Scripts`);
  });

  it('tells a project with no instanced types what that means, instead of showing an empty list', async () => {
    const out = await run({}, { listTypes: async () => [] });
    expect(out).toContain('No ScriptableObject types with instances');
    expect(out).toContain('do not hand-write');
  });

  it('degrades to a hint rather than throwing when the index is unavailable', async () => {
    const out = await run(
      {},
      {
        listTypes: async () => {
          throw new Error('no index');
        },
      },
    );
    expect(out).toContain('Could not enumerate');
  });
});

describe('unity_scriptable_objects — schema', () => {
  it('reports the fields, the CreateAssetMenu path and the instance count', async () => {
    const out = await run({ type: 'WeaponData' });
    expect(out).toContain('Game/Weapon Data');
    expect(out).toContain('damage');
    expect(out).toContain('instances: 2');
  });

  it('surfaces [FormerlySerializedAs], which is the whole point of reading the class', async () => {
    const out = await run({ type: 'WeaponData' });
    expect(out).toContain('FormerlySerializedAs');
    expect(out).toContain('"mass"');
  });

  it('states the data-loss consequence of a rename in the same breath', async () => {
    const out = await run({ type: 'WeaponData' });
    expect(out).toContain('reverts to its default');
    expect(out).toContain('no compiler error');
  });

  it('resolves a type case-insensitively rather than reporting it missing', async () => {
    expect(await run({ type: 'weapondata' })).toContain('WeaponData');
  });

  it('refuses an unknown type and names the ones that exist', async () => {
    const out = await run({ type: 'Nope' });
    expect(out).toContain('No ScriptableObject type named "Nope"');
    expect(out).toContain('WeaponData');
  });
});

describe('unity_scriptable_objects — instances and drift', () => {
  it('does not read every asset unless asked', async () => {
    let called = false;
    await run(
      { type: 'WeaponData' },
      {
        readMany: async () => {
          called = true;
          return [];
        },
      },
    );
    expect(called).toBe(false);
  });

  it('tabulates values across instances when asked', async () => {
    const out = await run({ type: 'WeaponData', instances: true });
    expect(out).toContain('Values across 2 assets');
    expect(out).toContain('Sword');
  });

  it('shows a value still stored under a former name rather than a blank', async () => {
    const out = await run(
      { type: 'WeaponData', instances: true },
      {
        readMany: async (paths) =>
          paths.map((path) => ({ path, snapshot: snapshot([{ key: 'mass', raw: '4.5' }]) })),
      },
    );
    expect(out).toContain('4.5');
  });

  it('reports drift with the destructive case named first', async () => {
    const drift: DriftFinding[] = [
      {
        kind: 'renamed',
        key: 'weight',
        formerKey: 'mass',
        csharpType: 'float',
        fixable: true,
        assets: [
          {
            path: `${WS}/Assets/Data/Sword.asset`,
            name: 'Sword',
            fileId: '1',
            currentRaw: '4.5',
            insertAfter: 'damage',
          },
        ],
      },
    ];
    const out = await run({ type: 'WeaponData', drift: true }, { computeDrift: async () => drift });
    expect(out).toContain('RENAMED  weight');
    expect(out).toContain('assets still store "mass"');
    expect(out).toContain('unity_fix_so_drift');
  });

  it('says plainly when there is no drift, rather than saying nothing', async () => {
    const out = await run({ type: 'WeaponData', drift: true });
    expect(out).toContain('No schema drift');
  });
});

describe('unity_scriptable_objects — one asset', () => {
  it('reads an instance without needing the type inventory at all', async () => {
    let listed = false;
    const out = await run(
      { path: `${WS}/Assets/Data/Sword.asset` },
      {
        listTypes: async () => {
          listed = true;
          return GROUPS;
        },
      },
    );
    expect(listed).toBe(false);
    expect(out).toContain('damage');
    expect(out).toContain('unity_asset_edit');
  });

  it('warns off editing the YAML by hand', async () => {
    const out = await run({ path: `${WS}/Assets/Data/Sword.asset` });
    expect(out).toContain('Do NOT edit this file with the edit tool');
  });
});

describe('pure renderers', () => {
  it('renderInventory reports paths relative to the workspace', () => {
    expect(renderInventory(GROUPS, WS)).toContain('Assets/Data/Sword.asset');
  });

  it('renderSchema says so when a class serializes nothing', () => {
    const empty = { ...SCHEMA, fields: [], groups: [] };
    expect(renderSchema(empty, null, 0, WS)).toContain('No serialized fields');
  });
});
