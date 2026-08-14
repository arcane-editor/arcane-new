import { describe, it, expect } from 'bun:test';
import { effortChordLabel } from './effort-chord';

describe('effortChordLabel', () => {
  it('collapses the pair into one cap on macOS', () => {
    expect(effortChordLabel('mod+left', 'mod+right', true)).toBe('⌘←→');
  });

  it('keeps the spelled modifier and its separator on Windows/Linux', () => {
    expect(effortChordLabel('mod+left', 'mod+right', false)).toBe('Ctrl+←→');
  });

  it('carries extra modifiers through', () => {
    expect(effortChordLabel('mod+alt+left', 'mod+alt+right', true)).toBe('⌘⌥←→');
  });

  /**
   * The cap is permanent furniture in the toolbar, so a wrong one would sit
   * there misinforming indefinitely. Every shape it cannot faithfully compress
   * resolves to null, and the caller renders nothing.
   */
  it('refuses to render anything it cannot state honestly', () => {
    // A binding moved off the arrows entirely.
    expect(effortChordLabel('mod+comma', 'mod+period', true)).toBeNull();
    // Left/right swapped — the cap reads ←→, so down must be the left one.
    expect(effortChordLabel('mod+right', 'mod+left', true)).toBeNull();
    // The two halves disagree about their modifiers.
    expect(effortChordLabel('mod+left', 'mod+shift+right', true)).toBeNull();
    // A command lost its binding, or never had one.
    expect(effortChordLabel(undefined, 'mod+right', true)).toBeNull();
    expect(effortChordLabel('mod+left', undefined, true)).toBeNull();
    expect(effortChordLabel('', '', true)).toBeNull();
  });

  it('tolerates spacing and casing in the registry strings', () => {
    expect(effortChordLabel('Mod + Left', 'MOD+right', true)).toBe('⌘←→');
  });
});
