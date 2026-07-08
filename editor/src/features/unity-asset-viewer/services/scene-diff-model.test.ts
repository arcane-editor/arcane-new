import { describe, it, expect } from 'bun:test';
import {
  formatSceneDiffForPrompt,
  summarizeDiffCounts,
  humanizeInlineMap,
  groupPrefabOverrides,
  formatPrefabOverrideGroupHeader,
  type SceneDiff,
  type ObjectDiff,
  type PrefabOverrideDiff,
} from './scene-diff-model';

const EMPTY_SUMMARY = {
  addedObjects: 0,
  removedObjects: 0,
  modifiedObjects: 0,
  movedObjects: 0,
  componentChanges: 0,
  propertyChanges: 0,
};

function baseObjectDiff(overrides: Partial<ObjectDiff>): ObjectDiff {
  return {
    fileId: '1',
    name: 'Object',
    status: 'modified',
    hierarchyPath: 'Object',
    oldName: null,
    newName: null,
    oldParentName: null,
    newParentName: null,
    propertyDiffs: [],
    componentDiffs: [],
    subtreeSummary: null,
    ...overrides,
  };
}

function basePrefabOverrideDiff(overrides: Partial<PrefabOverrideDiff>): PrefabOverrideDiff {
  return {
    prefabInstanceFileId: '100100000',
    prefabAssetName: null,
    prefabAssetGuid: null,
    targetFileId: '400000',
    targetGuid: '11111111111111111111111111111111',
    propertyPath: 'speed',
    oldValue: null,
    newValue: null,
    oldObjectReference: null,
    newObjectReference: null,
    objectReferenceAssetName: null,
    objectReferenceGuid: null,
    status: 'modified',
    ...overrides,
  };
}

describe('summarizeDiffCounts', () => {
  it('omits zero counters and pluralizes correctly', () => {
    expect(summarizeDiffCounts(EMPTY_SUMMARY)).toEqual([]);
    expect(
      summarizeDiffCounts({ ...EMPTY_SUMMARY, addedObjects: 2, removedObjects: 1, propertyChanges: 14 }),
    ).toEqual(['2 added', '1 removed', '14 properties changed']);
    expect(summarizeDiffCounts({ ...EMPTY_SUMMARY, componentChanges: 1, propertyChanges: 1 })).toEqual([
      '1 component change',
      '1 property changed',
    ]);
  });
});

describe('formatSceneDiffForPrompt — happy path', () => {
  it('renders a single scalar component-property change on a modified object', () => {
    const diff: SceneDiff = {
      objectDiffs: [
        baseObjectDiff({
          fileId: '100',
          name: 'Player',
          status: 'modified',
          hierarchyPath: 'Player',
          componentDiffs: [
            {
              fileId: '114',
              classId: '114',
              typeName: 'PlayerController',
              scriptGuid: 'abcdef0123456789abcdef0123456789',
              status: 'modified',
              propertyDiffs: [{ key: 'speed', old: '5', new: '7' }],
            },
          ],
        }),
      ],
      prefabOverrideDiffs: [],
      summary: { ...EMPTY_SUMMARY, modifiedObjects: 1, componentChanges: 1, propertyChanges: 1 },
      truncated: false,
    };

    expect(formatSceneDiffForPrompt(diff)).toBe(
      "1 modified · 1 component change · 1 property changed\nModified 'Player' (Player): PlayerController speed: 5 → 7",
    );
  });

  it('renders an added GameObject subtree with component/child counts', () => {
    const diff: SceneDiff = {
      objectDiffs: [
        baseObjectDiff({
          fileId: '10',
          name: 'Wall',
          status: 'added',
          hierarchyPath: 'Root/Wall',
          subtreeSummary: { childCount: 2, componentTypes: ['BoxCollider', 'MeshRenderer', 'Transform'] },
        }),
      ],
      prefabOverrideDiffs: [],
      summary: { ...EMPTY_SUMMARY, addedObjects: 3 },
      truncated: false,
    };

    expect(formatSceneDiffForPrompt(diff)).toBe(
      "3 added\nAdded GameObject 'Wall' (3 components, 2 children)",
    );
  });

  it('renders a pure reparent (moved, not renamed) with old/new parent names', () => {
    const diff: SceneDiff = {
      objectDiffs: [
        baseObjectDiff({
          fileId: '5',
          name: 'Enemy',
          status: 'moved',
          hierarchyPath: 'Enemies/Enemy',
          oldParentName: 'Root',
          newParentName: 'Enemies',
        }),
      ],
      prefabOverrideDiffs: [],
      summary: { ...EMPTY_SUMMARY, movedObjects: 1 },
      truncated: false,
    };

    expect(formatSceneDiffForPrompt(diff)).toBe("1 moved\nMoved 'Enemy' from 'Root' to 'Enemies'");
  });
});

describe('formatSceneDiffForPrompt — truncated flag', () => {
  it('marks a truncated diff in the summary line', () => {
    const diff: SceneDiff = {
      objectDiffs: [],
      prefabOverrideDiffs: [],
      summary: { ...EMPTY_SUMMARY, modifiedObjects: 600 },
      truncated: true,
    };

    // With no object/prefab-override diffs, formatSceneDiffForPrompt's
    // output is exactly the summary line — asserting through the function
    // this describe block names, per the P6.2 minor fix.
    expect(formatSceneDiffForPrompt(diff)).toBe('600 modified (truncated — showing first 500 objects)');
  });
});

describe('formatSceneDiffForPrompt — prefab override reference change', () => {
  it('describes a reference-type override change (not the scalar value), grouped under the source prefab', () => {
    const diff: SceneDiff = {
      objectDiffs: [],
      prefabOverrideDiffs: [
        basePrefabOverrideDiff({
          prefabAssetName: 'Enemy',
          prefabAssetGuid: 'abcdef0123456789abcdef0123456789',
          propertyPath: 'm_Sprite',
          oldValue: '',
          newValue: '',
          oldObjectReference: '{fileID: 21300000, guid: 22222222222222222222222222222222, type: 3}',
          newObjectReference: '{fileID: 21300000, guid: 33333333333333333333333333333333, type: 3}',
          objectReferenceAssetName: 'NewSprite',
          objectReferenceGuid: '33333333333333333333333333333333',
          status: 'modified',
        }),
      ],
      summary: EMPTY_SUMMARY,
      truncated: false,
    };

    expect(formatSceneDiffForPrompt(diff)).toBe(
      "1 prefab override\nOverrides on 'Enemy.prefab' instance\n  m_Sprite: reference → NewSprite",
    );
  });

  it('falls back to the scalar value change when there is no reference payload', () => {
    const diff: SceneDiff = {
      objectDiffs: [],
      prefabOverrideDiffs: [
        basePrefabOverrideDiff({
          prefabAssetName: 'Enemy',
          propertyPath: 'speed',
          oldValue: '5',
          newValue: '9',
        }),
      ],
      summary: EMPTY_SUMMARY,
      truncated: false,
    };

    expect(formatSceneDiffForPrompt(diff)).toBe(
      "1 prefab override\nOverrides on 'Enemy.prefab' instance\n  speed: 5 → 9",
    );
  });

  it('pretty-prints a vector/color value inside a prefab override row', () => {
    const diff: SceneDiff = {
      objectDiffs: [],
      prefabOverrideDiffs: [
        basePrefabOverrideDiff({
          prefabAssetName: 'Enemy',
          propertyPath: 'm_LocalPosition',
          oldValue: '{x: 0, y: 0, z: 0}',
          newValue: '{x: 1, y: 2.5, z: 0}',
        }),
      ],
      summary: EMPTY_SUMMARY,
      truncated: false,
    };

    expect(formatSceneDiffForPrompt(diff)).toBe(
      "1 prefab override\nOverrides on 'Enemy.prefab' instance\n  m_LocalPosition: (0, 0, 0) → (1, 2.5, 0)",
    );
  });
});

describe('groupPrefabOverrides', () => {
  it('groups multiple rows on the same source prefab into one section, in first-seen order', () => {
    const rows: PrefabOverrideDiff[] = [
      basePrefabOverrideDiff({
        prefabAssetName: 'Enemy',
        prefabAssetGuid: 'abcdef0123456789abcdef0123456789',
        propertyPath: 'health',
      }),
      basePrefabOverrideDiff({
        prefabAssetName: 'Turret',
        prefabAssetGuid: '99999999999999999999999999999999',
        propertyPath: 'range',
      }),
      basePrefabOverrideDiff({
        prefabAssetName: 'Enemy',
        prefabAssetGuid: 'abcdef0123456789abcdef0123456789',
        propertyPath: 'speed',
      }),
    ];

    const groups = groupPrefabOverrides(rows);
    expect(groups.length).toBe(2);
    expect(groups[0].prefabAssetName).toBe('Enemy');
    expect(groups[0].rows.map((r) => r.propertyPath)).toEqual(['health', 'speed']);
    expect(groups[1].prefabAssetName).toBe('Turret');
    expect(groups[1].rows.map((r) => r.propertyPath)).toEqual(['range']);
  });

  it('falls back to the prefab instance fileID when the source prefab name is unresolved', () => {
    const rows: PrefabOverrideDiff[] = [
      basePrefabOverrideDiff({
        prefabInstanceFileId: '777000',
        prefabAssetName: null,
        prefabAssetGuid: null,
      }),
    ];
    const groups = groupPrefabOverrides(rows);
    expect(groups.length).toBe(1);
    expect(formatPrefabOverrideGroupHeader(groups[0])).toBe('Overrides on prefab instance 777000');
  });

  it('formats the header with the .prefab extension appended', () => {
    const groups = groupPrefabOverrides([
      basePrefabOverrideDiff({ prefabAssetName: 'Enemy', prefabAssetGuid: 'abcdef0123456789abcdef0123456789' }),
    ]);
    expect(formatPrefabOverrideGroupHeader(groups[0])).toBe("Overrides on 'Enemy.prefab' instance");
  });
});

describe('humanizeInlineMap', () => {
  it('formats a Vector3-shaped map as (x, y, z)', () => {
    expect(humanizeInlineMap('{x: 0, y: 1.5, z: 0}')).toBe('(0, 1.5, 0)');
  });

  it('formats a Vector2-shaped map as (x, y)', () => {
    expect(humanizeInlineMap('{x: 3, y: -2}')).toBe('(3, -2)');
  });

  it('formats a Quaternion-shaped map (x, y, z, w) as (x, y, z, w)', () => {
    expect(humanizeInlineMap('{x: 0, y: 0, z: 0, w: 1}')).toBe('(0, 0, 0, 1)');
  });

  it('formats a Color-shaped map as rgba(r, g, b, a)', () => {
    expect(humanizeInlineMap('{r: 1, g: 0.5, b: 0, a: 1}')).toBe('rgba(1, 0.5, 0, 1)');
  });

  it('leaves a malformed map (missing coordinate) raw', () => {
    expect(humanizeInlineMap('{x: 0, y: 1}').length).toBeGreaterThan(0);
    // {x, y} alone IS a valid Vector2 — use a genuinely malformed shape instead.
    expect(humanizeInlineMap('{x: 0, y:}')).toBe('{x: 0, y:}');
  });

  it('leaves a map with unrecognized keys raw', () => {
    expect(humanizeInlineMap('{fileID: 0}')).toBe('{fileID: 0}');
    expect(humanizeInlineMap('{fileID: 123, guid: abcdef0123456789abcdef0123456789, type: 3}')).toBe(
      '{fileID: 123, guid: abcdef0123456789abcdef0123456789, type: 3}',
    );
  });

  it('leaves plain scalars untouched', () => {
    expect(humanizeInlineMap('5')).toBe('5');
    expect(humanizeInlineMap('Untagged')).toBe('Untagged');
    expect(humanizeInlineMap('')).toBe('');
  });
});

describe('formatSceneDiffForPrompt — rename + reparent together', () => {
  it('shows BOTH the rename and the reparent aspects on one line', () => {
    const diff: SceneDiff = {
      objectDiffs: [
        baseObjectDiff({
          fileId: '5',
          name: 'SuperMover',
          status: 'renamed',
          hierarchyPath: 'Right/SuperMover',
          oldName: 'Mover',
          newName: 'SuperMover',
          oldParentName: 'Left',
          newParentName: 'Right',
        }),
      ],
      prefabOverrideDiffs: [],
      summary: { ...EMPTY_SUMMARY, modifiedObjects: 1 },
      truncated: false,
    };

    const out = formatSceneDiffForPrompt(diff);
    expect(out).toBe(
      "1 modified\nRenamed 'Mover' → 'SuperMover' (Right/SuperMover); moved from 'Left' to 'Right'",
    );
    // Explicitly lock in both aspects independently, in case the joined
    // format above ever changes shape.
    expect(out).toContain("Renamed 'Mover' → 'SuperMover'");
    expect(out).toContain("moved from 'Left' to 'Right'");
  });
});
