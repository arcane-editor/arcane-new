import { describe, expect, it } from 'bun:test';
import { isolateFromTree } from './tree-key-isolation';

const plain = { ctrlKey: false, metaKey: false, altKey: false };

describe('isolateFromTree', () => {
  // The tree's whole keyboard vocabulary is unmodified keys: arrows, Home/End,
  // Enter, Escape, Space, and letters for type-ahead. All of it must be
  // withheld or renaming a file drives the tree selection instead.
  it('withholds unmodified keystrokes from the tree', () => {
    expect(isolateFromTree(plain)).toBe(true);
  });

  // These are app chords (mod+b, mod+p, ...). They have to reach `document`,
  // where react-hotkeys-hook listens — React's own listeners sit on #root,
  // below it, so stopping propagation here would kill them outright.
  it('lets modifier chords through to the document-level hotkey listener', () => {
    expect(isolateFromTree({ ...plain, metaKey: true })).toBe(false);
    expect(isolateFromTree({ ...plain, ctrlKey: true })).toBe(false);
    expect(isolateFromTree({ ...plain, altKey: true })).toBe(false);
  });

  it('lets a chord through whichever combination of modifiers it carries', () => {
    expect(isolateFromTree({ ctrlKey: true, metaKey: true, altKey: false })).toBe(false);
    expect(isolateFromTree({ ctrlKey: false, metaKey: true, altKey: true })).toBe(false);
    expect(isolateFromTree({ ctrlKey: true, metaKey: true, altKey: true })).toBe(false);
  });

  // Shift alone is not a chord modifier — Shift+letter is just typing a
  // capital, and Shift+Home is a selection the field owns. Bound to a variable
  // so the extra property doesn't trip object-literal excess property checking.
  it('treats shift alone as ordinary typing', () => {
    const withShift = { ...plain, shiftKey: true };
    expect(isolateFromTree(withShift)).toBe(true);
  });
});
