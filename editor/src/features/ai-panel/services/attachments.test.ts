import { describe, it, expect } from 'bun:test';
import { formatUnityAssetBlock, type UnityAssetModel } from './attachments';

// NOTE: only the pure formatter is unit-tested here (per the brief). Full
// `resolveAttachments` / `resolveUnityAsset` resolution touches Tauri's
// `invoke` + Zustand stores and isn't exercised by `bun test` (no Tauri
// runtime, no DOM — see the file-header comment in `attachments.ts`).

describe('formatUnityAssetBlock', () => {
  it('wraps a parsed GameObject tree in a <unity-asset> tag with the reference count', () => {
    const model: UnityAssetModel = {
      documents: [],
      gameObjects: [
        {
          name: 'Player',
          isActive: true,
          components: [{ typeName: 'Transform' }, { typeName: 'PlayerController' }],
          children: [
            {
              name: 'Weapon',
              isActive: false,
              components: [{ typeName: 'Transform' }],
              children: [],
            },
          ],
        },
      ],
    };

    const out = formatUnityAssetBlock({
      relPath: 'Assets/Prefabs/Player.prefab',
      model,
      refCount: 3,
    });

    expect(out.startsWith('<unity-asset path="Assets/Prefabs/Player.prefab">\n')).toBe(true);
    expect(out.endsWith('\n</unity-asset>')).toBe(true);
    expect(out).toContain('Player [Transform, PlayerController]');
    expect(out).toContain('  Weapon (inactive) [Transform]');
    expect(out).toContain('referenced by 3 assets');
  });

  it('singularizes the reference count for exactly one reference', () => {
    const model: UnityAssetModel = { documents: [], gameObjects: [] };
    const out = formatUnityAssetBlock({ relPath: 'Assets/Foo.asset', model, refCount: 1 });
    expect(out).toContain('referenced by 1 asset');
    expect(out).not.toContain('referenced by 1 assets');
  });

  it('falls back to a document/property summary when there is no GameObject hierarchy', () => {
    const model: UnityAssetModel = {
      documents: [
        {
          typeName: 'Material',
          properties: [
            ['m_Shader', 'Standard'],
            ['_Color', '1,1,1,1'],
          ],
        },
      ],
      gameObjects: [],
    };

    const out = formatUnityAssetBlock({ relPath: 'Assets/Mat/Red.mat', model, refCount: 0 });
    expect(out).toContain('Material');
    expect(out).toContain('  m_Shader: Standard');
    expect(out).toContain('  _Color: 1,1,1,1');
    expect(out).toContain('referenced by 0 assets');
  });

  it('reports an empty asset when there is neither a GameObject tree nor documents', () => {
    const model: UnityAssetModel = { documents: [], gameObjects: [] };
    const out = formatUnityAssetBlock({ relPath: 'Assets/Empty.asset', model, refCount: 0 });
    expect(out).toContain('(empty asset — no structured content)');
  });

  it('falls back to a graceful one-liner on parse failure — path only, no crash', () => {
    const out = formatUnityAssetBlock({
      relPath: 'Assets/Scenes/Corrupt.unity',
      model: null,
      parseError: 'invalid YAML',
      refCount: 0,
    });
    expect(out).toBe(
      '<unity-asset path="Assets/Scenes/Corrupt.unity">\ncould not parse asset — path only\n</unity-asset>',
    );
  });

  it('falls back gracefully when model is null even without an explicit parseError', () => {
    const out = formatUnityAssetBlock({ relPath: 'Assets/Whatever.prefab', model: null, refCount: 0 });
    expect(out).toContain('could not parse asset — path only');
  });

  it('escapes double quotes in the path attribute', () => {
    const out = formatUnityAssetBlock({
      relPath: 'Assets/Weird "Name".prefab',
      model: null,
      refCount: 0,
    });
    expect(out).toContain('path="Assets/Weird &quot;Name&quot;.prefab"');
  });

  it('truncates the node walk at the first-N-nodes cap on a deep/wide tree', () => {
    const gameObjects = Array.from({ length: 5000 }, (_, i) => ({
      name: `GameObject_${i}`,
      isActive: true,
      components: [{ typeName: 'Transform' }, { typeName: 'MeshRenderer' }],
      children: [],
    }));
    const model: UnityAssetModel = { documents: [], gameObjects };

    const out = formatUnityAssetBlock({ relPath: 'Assets/Scenes/Huge.unity', model, refCount: 42 });

    expect(out).toContain('…(truncated at 40 nodes)');
    expect(out).toContain('referenced by 42 assets');
    expect(out.endsWith('\n</unity-asset>')).toBe(true);
    // Only the first 40 GameObjects should actually appear.
    expect(out).toContain('GameObject_39');
    expect(out).not.toContain('GameObject_40 ');
  });

  it('truncates the body to stay within the ~8KB cap while always preserving the reference-count line', () => {
    // Exactly 40 nodes (at the node-count cap) but each individually huge, so
    // the *byte* cap — not the node-count cap — is what has to kick in here.
    const gameObjects = Array.from({ length: 40 }, (_, i) => ({
      name: `GO_${i}_${'x'.repeat(300)}`,
      isActive: true,
      components: [{ typeName: 'Transform' }],
      children: [],
    }));
    const model: UnityAssetModel = { documents: [], gameObjects };

    const out = formatUnityAssetBlock({ relPath: 'Assets/Scenes/Huge.unity', model, refCount: 42 });

    const byteLen = new TextEncoder().encode(out).length;
    expect(byteLen).toBeLessThan(8 * 1024 + 512); // tag wrapper + ref line add a little slack
    expect(out).toContain('\n…(truncated)\n\nreferenced by 42 assets\n</unity-asset>');
    expect(out).not.toContain('truncated at 40 nodes'); // this is the byte cap, not the node cap
  });

  it('is pure — identical input produces an identical string every time', () => {
    const model: UnityAssetModel = {
      documents: [],
      gameObjects: [{ name: 'A', isActive: true, components: [], children: [] }],
    };
    const args = { relPath: 'Assets/A.prefab', model, refCount: 2 };
    expect(formatUnityAssetBlock(args)).toBe(formatUnityAssetBlock(args));
  });
});
