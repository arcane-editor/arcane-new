import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ownsTextFieldChord, textFieldClash } from './text-field-chords';

describe('ownsTextFieldChord', () => {
  it('claims the chords that broke the composer', () => {
    // The reported bug: line start/end on macOS, word jump on Windows.
    expect(ownsTextFieldChord('mod+left')).toBe(true);
    expect(ownsTextFieldChord('mod+right')).toBe(true);
  });

  it('claims alt+HORIZONTAL — that is word navigation on macOS', () => {
    expect(ownsTextFieldChord('alt+left')).toBe(true);
    expect(ownsTextFieldChord('alt+right')).toBe(true);
  });

  // The deliberate trade: macOS paragraph movement, free on Windows, and in a
  // one-paragraph composer `mod+up/down` already reaches both ends.
  it('rates alt+VERTICAL as the cheap clash, not a caret one', () => {
    expect(textFieldClash('alt+up')).toBe('paragraph');
    expect(textFieldClash('alt+down')).toBe('paragraph');
    expect(ownsTextFieldChord('alt+up')).toBe(false);
  });

  it('still rates every other vertical as caret movement', () => {
    expect(textFieldClash('up')).toBe('caret');
    expect(textFieldClash('shift+down')).toBe('caret');
    expect(textFieldClash('mod+up')).toBe('caret');
  });

  it('reports no clash for a chord text editing does not want', () => {
    expect(textFieldClash('mod+alt+up')).toBeNull();
    expect(textFieldClash('mod+m')).toBeNull();
  });

  it('claims bare and shifted arrows', () => {
    expect(ownsTextFieldChord('left')).toBe(true);
    expect(ownsTextFieldChord('shift+left')).toBe(true);
    expect(ownsTextFieldChord('mod+shift+right')).toBe(true);
  });

  it('claims home/end and the page keys', () => {
    expect(ownsTextFieldChord('home')).toBe(true);
    expect(ownsTextFieldChord('mod+end')).toBe(true);
    expect(ownsTextFieldChord('pagedown')).toBe(true);
  });

  it('leaves mod+alt+arrow free — neither platform edits text with it', () => {
    expect(ownsTextFieldChord('mod+alt+up')).toBe(false);
    expect(ownsTextFieldChord('mod+alt+down')).toBe(false);
    expect(ownsTextFieldChord('mod+alt+left')).toBe(false);
  });

  it('ignores chords that are not navigation keys at all', () => {
    expect(ownsTextFieldChord('mod+m')).toBe(false);
    expect(ownsTextFieldChord('mod+shift+p')).toBe(false);
  });
});

/**
 * The class-level guard. Scoping a chord to the composer makes a
 * text-navigation binding WORSE, not safer, so no composer-scoped command may
 * take one — this is what stops the next `mod+right` from shipping.
 */
describe('composer-scoped commands never take a text-field chord', () => {
  const APP = readFileSync(path.resolve(import.meta.dir, '../../../App.tsx'), 'utf8');

  // Each registry entry is an object literal; find the ones gated on the
  // composer and read the keybinding out of the same block.
  const scoped = APP.split(/\n    \{\n/)
    .filter((block) => block.includes('isAiComposerFocused()'))
    .map((block) => ({
      id: block.match(/id: '([^']+)'/)?.[1] ?? '(unknown)',
      keybinding: block.match(/keybinding: '([^']+)'/)?.[1] ?? '',
    }))
    .filter((c) => c.keybinding);

  it('finds the composer-scoped commands to check', () => {
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    // Effort is one cycling chord now, not a pair of steppers.
    expect(scoped.map((c) => c.id)).toContain('ai.effortCycle');
    expect(scoped.map((c) => c.id)).toContain('ai.cycleMode');
  });

  for (const cmd of scoped) {
    it(`${cmd.id} (${cmd.keybinding}) leaves the caret keys alone`, () => {
      expect(ownsTextFieldChord(cmd.keybinding)).toBe(false);
    });
  }
});
