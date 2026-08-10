import { describe, it, expect } from 'bun:test';
import { hierarchyHasScriptIdentity, scriptsOf } from './hierarchy-scripts';
import type { HierarchyNode } from '../../unity-bridge';

function node(name: string, components: HierarchyNode['components']): HierarchyNode {
  return { name, active: true, tag: 'Untagged', layer: 0, instanceId: 1, components, children: [] };
}

/**
 * The panel used to list EVERY component — Transform, BoxCollider,
 * MeshRenderer — and made all of them look clickable, while the click only
 * ever did anything for a project script (and, because of a bad invoke, not
 * even then). What a Unity developer wants from an IDE's hierarchy is the
 * scripts they can actually open.
 */
describe('scriptsOf', () => {
  it('keeps only components the bridge resolved to an Assets/ script', () => {
    const n = node('Player', [
      { type: 'Transform' },
      { type: 'Rigidbody' },
      { type: 'PlayerController', script: { path: 'Assets/Scripts/PlayerController.cs', guid: 'a' } },
      { type: 'BoxCollider' },
      { type: 'Health', script: { path: 'Assets/Scripts/Health.cs', guid: 'b' } },
    ]);
    expect(scriptsOf(n).map((c) => c.type)).toEqual(['PlayerController', 'Health']);
  });

  it('returns nothing for a GameObject of pure built-ins', () => {
    expect(scriptsOf(node('Cube', [{ type: 'Transform' }, { type: 'MeshRenderer' }]))).toEqual([]);
  });

  it('drops a script entry with no usable path', () => {
    const n = node('Odd', [{ type: 'Broken', script: { path: '', guid: 'x' } }]);
    expect(scriptsOf(n)).toEqual([]);
  });

  it('keeps a missing-script placeholder out of the list', () => {
    expect(scriptsOf(node('Broken', [{ type: 'MissingComponent' }]))).toEqual([]);
  });
});

describe('hierarchyHasScriptIdentity', () => {
  const withScript = node('A', [
    { type: 'Transform' },
    { type: 'Foo', script: { path: 'Assets/Foo.cs', guid: 'g' } },
  ]);
  const withoutScript = node('B', [{ type: 'Transform' }, { type: 'Foo' }]);

  it('is true when any component anywhere carries script identity', () => {
    expect(
      hierarchyHasScriptIdentity({ scenes: [{ name: 's', path: 'p', roots: [withScript] }], truncated: false }),
    ).toBe(true);
  });

  /**
   * An older installed Unity package sends no `script` key at all. That is
   * indistinguishable, per-GameObject, from "this object genuinely has no
   * scripts" — so the panel must decide across the WHOLE hierarchy, and say
   * "update the package" rather than silently showing every object as empty.
   */
  it('is false when no component anywhere carries it', () => {
    expect(
      hierarchyHasScriptIdentity({ scenes: [{ name: 's', path: 'p', roots: [withoutScript] }], truncated: false }),
    ).toBe(false);
  });

  it('descends into children', () => {
    const parent = { ...node('P', [{ type: 'Transform' }]), children: [withScript] };
    expect(
      hierarchyHasScriptIdentity({ scenes: [{ name: 's', path: 'p', roots: [parent] }], truncated: false }),
    ).toBe(true);
  });

  it('is false for an empty hierarchy rather than throwing', () => {
    expect(hierarchyHasScriptIdentity({ scenes: [], truncated: false })).toBe(false);
    expect(hierarchyHasScriptIdentity(null)).toBe(false);
  });
});
