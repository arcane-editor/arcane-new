import { describe, expect, it } from 'bun:test';
import { toCssPoint, targetDirFor, metaSiblingsOf } from './drop-target';

describe('toCssPoint', () => {
  it('divides the physical position by the device pixel ratio', () => {
    // Tauri hands us a PhysicalPosition while getBoundingClientRect() is in
    // CSS pixels; on a Retina display those differ by 2x, and skipping the
    // conversion puts every drop in the wrong quadrant of the window.
    expect(toCssPoint({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
    expect(toCssPoint({ x: 200, y: 100 }, 1)).toEqual({ x: 200, y: 100 });
  });

  it('treats a zero or missing ratio as 1 rather than dividing by zero', () => {
    expect(toCssPoint({ x: 50, y: 25 }, 0)).toEqual({ x: 50, y: 25 });
  });
});

describe('targetDirFor', () => {
  it('targets a directory row itself', () => {
    expect(targetDirFor({ path: '/w/Assets/Scripts', isDir: true }, '/w')).toBe(
      '/w/Assets/Scripts',
    );
  });

  it('targets the parent directory of a file row', () => {
    // Dropping onto a file means "put it next to this", not "inside it".
    expect(targetDirFor({ path: '/w/Assets/Scripts/Player.cs', isDir: false }, '/w')).toBe(
      '/w/Assets/Scripts',
    );
  });

  it('falls back to the tree root when the point is over no row', () => {
    expect(targetDirFor(null, '/w/Assets')).toBe('/w/Assets');
  });

  it('falls back to the tree root for a top-level file with no parent segment', () => {
    expect(targetDirFor({ path: 'Player.cs', isDir: false }, '/w')).toBe('/w');
  });
});

describe('metaSiblingsOf', () => {
  // A .meta carries a GUID unique to its origin project, so whether it should
  // travel with the asset depends on where the drop came from — the user's
  // call, which means we only prompt when there is actually something to ask.
  it('pairs each dropped asset with its sibling .meta path', () => {
    expect(metaSiblingsOf(['/a/Player.cs', '/a/Enemy.cs'])).toEqual([
      '/a/Player.cs.meta',
      '/a/Enemy.cs.meta',
    ]);
  });

  it('never proposes a .meta for a .meta', () => {
    // Dragging a .meta directly is explicit and copies without a prompt.
    expect(metaSiblingsOf(['/a/Player.cs.meta'])).toEqual([]);
  });

  it('is case-insensitive about the .meta suffix', () => {
    expect(metaSiblingsOf(['/a/Player.cs.META'])).toEqual([]);
  });

  it('returns nothing for an empty drop', () => {
    expect(metaSiblingsOf([])).toEqual([]);
  });
});
