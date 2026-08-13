import { describe, it, expect } from 'bun:test';
import { SearchModelRegistry } from './model-ownership';

describe('SearchModelRegistry', () => {
  it('owns a model it claimed', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    expect(registry.owns('/w/a.cs')).toBe(true);
  });

  it('owns nothing it did not claim — a model backing an open tab is the tab\'s', () => {
    const registry = new SearchModelRegistry();
    expect(registry.owns('/w/a.cs')).toBe(false);
  });

  it('release reports whether the caller should dispose', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    expect(registry.release('/w/a.cs')).toBe(true);
    expect(registry.owns('/w/a.cs')).toBe(false);
  });

  it('release of an unowned path reports false so a tab\'s model is never disposed', () => {
    const registry = new SearchModelRegistry();
    expect(registry.release('/w/a.cs')).toBe(false);
  });

  it('transfer drops ownership WITHOUT authorising disposal', () => {
    // The first edit opens a tab; the tab now owns the model and its unsaved
    // changes. Disposing here would discard them.
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    registry.transfer('/w/a.cs');
    expect(registry.owns('/w/a.cs')).toBe(false);
    expect(registry.release('/w/a.cs')).toBe(false);
  });

  it('transfer returns nothing — it must never hand back a disposal authorization', () => {
    // The brief distinguishes transfer from release specifically because
    // release's `true` return means "you may dispose this." An implementation
    // that aliased transfer to release internally (e.g. `transfer = release`,
    // or `transfer(path) { return this.owned.delete(path); }`) would pass
    // every other test in this file — owns() would still report false and a
    // *second* release() call would still report false — while silently
    // handing its own caller a `true` at the transfer call site itself. A
    // caller that copy-pasted a `if (registry.transfer(path)) dispose(path)`
    // guard from the release code path would then destroy a model a tab now
    // owns, on the very first edit. Asserting the return value directly is
    // the only way to catch that.
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    expect(registry.transfer('/w/a.cs')).toBeUndefined();
  });

  it('transferring a path search never claimed is a no-op, not a claim', () => {
    // Guards against a transfer implementation that toggles membership
    // (delete-if-present-else-add) instead of unconditionally deleting. Such
    // a bug is invisible to the test above, which only ever calls transfer on
    // an already-owned path — toggling looks identical to deleting there. On
    // an unowned path it would incorrectly start owning (and later disposing)
    // a model belonging to a tab search never touched.
    const registry = new SearchModelRegistry();
    registry.transfer('/w/a.cs');
    expect(registry.owns('/w/a.cs')).toBe(false);
  });

  it('releaseAll returns every owned path and empties the registry', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    registry.claim('/w/b.cs');
    expect(registry.releaseAll().sort()).toEqual(['/w/a.cs', '/w/b.cs']);
    expect(registry.owns('/w/a.cs')).toBe(false);
    expect(registry.releaseAll()).toEqual([]);
  });

  it('releaseAll does not return a transferred path', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    registry.claim('/w/b.cs');
    registry.transfer('/w/a.cs');
    expect(registry.releaseAll()).toEqual(['/w/b.cs']);
  });

  it('claiming twice does not double-register', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    registry.claim('/w/a.cs');
    expect(registry.releaseAll()).toEqual(['/w/a.cs']);
  });
});
