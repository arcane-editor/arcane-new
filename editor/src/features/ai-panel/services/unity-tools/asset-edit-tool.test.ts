// The whole reason this tool exists instead of the generic `edit` is that Unity
// YAML punishes a plausible-looking write. So the cases that matter are the
// refusals: a field name the asset does not store, a value that changed under
// us, and the sha1 the model must never be asked to supply.

import { describe, it, expect } from 'bun:test';
import { createUnityAssetEditTool, type AssetEditToolDeps } from './asset-edit-tool';
import type { SoAssetSnapshot, SoEditResult, SoFieldEdit } from '../../../unity-scriptable-objects';

const SNAPSHOT: SoAssetSnapshot = {
  documentFileId: '11400000',
  classId: '114',
  scriptGuid: 'g1',
  sha1: 'sha-at-read-time',
  fields: [
    { key: 'damage', raw: '7', kind: 'scalar', editable: true, reason: null, members: [] },
    { key: 'tint', raw: '{r: 1, g: 0, b: 0}', kind: 'inlineMap', editable: true, reason: null, members: [] },
  ],
};

const OK: SoEditResult = {
  written: true,
  unchanged: false,
  rejections: [],
  sha1: 'sha-after',
  path: 'Assets/Data/Sword.asset',
};

function deps(over: Partial<AssetEditToolDeps> = {}): AssetEditToolDeps {
  return {
    read: async () => SNAPSHOT,
    write: async () => OK,
    describeRejection: async () => 'described',
    ...over,
  };
}

async function run(params: object, over?: Partial<AssetEditToolDeps>): Promise<string> {
  const result = await createUnityAssetEditTool(deps(over)).execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('unity_asset_edit', () => {
  it('writes a field and reports what changed', async () => {
    const out = await run({
      path: 'Assets/Data/Sword.asset',
      edits: [{ field: 'damage', value: '9' }],
    });
    expect(out).toContain('Wrote 1 field(s)');
    expect(out).toContain('damage = 9');
  });

  it('supplies the fileID and sha1 itself — the model is never asked for a checksum', async () => {
    let seen: { edits: SoFieldEdit[]; sha1: string } | undefined;
    await run(
      { path: 'Assets/Data/Sword.asset', edits: [{ field: 'damage', value: '9' }] },
      {
        write: async (_p, edits, sha1) => {
          seen = { edits, sha1 };
          return OK;
        },
      },
    );
    expect(seen!.sha1).toBe('sha-at-read-time');
    expect(seen!.edits[0].fileId).toBe('11400000');
  });

  it('refuses a field the asset does not store, and lists the ones it does', async () => {
    const out = await run({
      path: 'Assets/Data/Sword.asset',
      edits: [{ field: 'damag', value: '9' }],
    });
    expect(out).toContain('not');
    expect(out).toContain('damage, tint');
    expect(out).toContain('insertMissing:true');
  });

  it('never inserts a key by accident — ifMissing is absent unless asked', async () => {
    let edits: SoFieldEdit[] = [];
    await run(
      { path: 'Assets/Data/Sword.asset', edits: [{ field: 'damage', value: '9' }] },
      {
        write: async (_p, e) => {
          edits = e;
          return OK;
        },
      },
    );
    expect(edits[0].ifMissing).toBeUndefined();
  });

  it('allows an insert when the caller opts in', async () => {
    let edits: SoFieldEdit[] = [];
    await run(
      {
        path: 'Assets/Data/Sword.asset',
        edits: [{ field: 'newField', value: '0' }],
        insertMissing: true,
      },
      {
        write: async (_p, e) => {
          edits = e;
          return OK;
        },
      },
    );
    expect(edits[0].ifMissing).toEqual({ mode: 'insertAtEnd' });
  });

  it('addresses one member of an inline map without rejecting the parent key', async () => {
    const out = await run({
      path: 'Assets/Data/Sword.asset',
      edits: [{ field: 'tint.g', value: '0.5' }],
    });
    expect(out).toContain('Wrote 1 field(s)');
  });

  it('passes an expected value through so a changed-on-disk write is refused, not clobbered', async () => {
    let edits: SoFieldEdit[] = [];
    await run(
      {
        path: 'Assets/Data/Sword.asset',
        edits: [{ field: 'damage', value: '9', expected: '7' }],
      },
      {
        write: async (_p, e) => {
          edits = e;
          return OK;
        },
      },
    );
    expect(edits[0].expected).toBe('7');
  });

  it('reports every rejection in the writer’s own words', async () => {
    const out = await run(
      { path: 'Assets/Data/Sword.asset', edits: [{ field: 'damage', value: '9' }] },
      {
        write: async () => ({
          ...OK,
          written: false,
          rejections: [{ kind: 'valueMismatch', path: 'damage' }],
        }),
        describeRejection: async () => 'The value changed on disk — reload before saving.',
      },
    );
    expect(out).toContain('1 edit(s) refused');
    expect(out).toContain('changed on disk');
    expect(out).toContain('protecting the file');
  });

  it('distinguishes "nothing to do" from "nothing written"', async () => {
    const out = await run(
      { path: 'Assets/Data/Sword.asset', edits: [{ field: 'damage', value: '7' }] },
      { write: async () => ({ ...OK, written: false, unchanged: true }) },
    );
    expect(out).toContain('already matched');
  });

  it('explains an unreadable asset instead of failing opaquely', async () => {
    const out = await run(
      { path: 'Assets/Data/Sword.asset', edits: [{ field: 'damage', value: '9' }] },
      {
        read: async () => {
          throw new Error('not a Unity document');
        },
      },
    );
    expect(out).toContain('Could not read');
    expect(out).toContain('unity_scriptable_objects');
  });

  it('reports the write only when one actually happened', async () => {
    const written: string[] = [];
    await run(
      { path: 'Assets/Data/Sword.asset', edits: [{ field: 'damage', value: '9' }] },
      { onWrite: (p) => written.push(p), write: async () => ({ ...OK, written: false }) },
    );
    expect(written).toEqual([]);

    await run(
      { path: 'Assets/Data/Sword.asset', edits: [{ field: 'damage', value: '9' }] },
      { onWrite: (p) => written.push(p) },
    );
    expect(written).toEqual(['Assets/Data/Sword.asset']);
  });
});

describe('unity_asset_edit — reporting what actually landed', () => {
  it('names the applied field by name, not by position', async () => {
    // Rejections are not necessarily the trailing edits. Counting them and
    // slicing reported the REFUSED field as the written one whenever the
    // refusal came first.
    const out = await run(
      {
        path: 'Assets/Data/Sword.asset',
        edits: [
          { field: 'damage', value: '9', expected: 'stale' },
          { field: 'tint.g', value: '0.5' },
        ],
      },
      {
        write: async () => ({
          ...OK,
          written: true,
          rejections: [{ kind: 'valueMismatch', path: 'damage' }],
        }),
      },
    );
    expect(out).toContain('tint.g = 0.5');
    expect(out).not.toContain('damage = 9');
    expect(out).toContain('1 edit(s) refused');
  });
});
