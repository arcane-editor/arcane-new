import { describe, it, expect } from 'bun:test';
import { ariaKeyshortcuts, formatKeybinding } from './format-keybinding';

// The platform is passed explicitly rather than sniffed, so these assert both
// platforms deterministically on any host. This matters: bun defines
// `navigator`, so `isMac()` returns true under `bun test` on a macOS machine
// and false on a Windows CI box — sniffing would make the same assertions
// pass on one and fail on the other.
describe('formatKeybinding', () => {
  describe('windows / linux', () => {
    it('renders mod as Ctrl and joins with +', () => {
      expect(formatKeybinding('mod+p', false)).toBe('Ctrl+P');
    });

    it('renders multi-modifier chords', () => {
      expect(formatKeybinding('mod+shift+a', false)).toBe('Ctrl+Shift+A');
    });

    it('maps named key tokens to their symbols', () => {
      expect(formatKeybinding('mod+backquote', false)).toBe('Ctrl+`');
      expect(formatKeybinding('mod+shift+bracketright', false)).toBe('Ctrl+Shift+]');
      expect(formatKeybinding('mod+backslash', false)).toBe('Ctrl+\\');
    });

    it('renders arrow keys as the glyphs printed on them', () => {
      expect(formatKeybinding('mod+left', false)).toBe('Ctrl+←');
      expect(formatKeybinding('mod+right', false)).toBe('Ctrl+→');
      expect(formatKeybinding('mod+up', false)).toBe('Ctrl+↑');
      expect(formatKeybinding('mod+down', false)).toBe('Ctrl+↓');
    });

    // These four had no entry in NAMED_KEY_LABELS, so the fallback
    // title-cased the token and every Windows tooltip, coach mark, signpost
    // and palette row read 'Ctrl+Equal' / 'Ctrl+Minus'.
    it('renders punctuation and paging keys as their printed symbols', () => {
      expect(formatKeybinding('mod+equal', false)).toBe('Ctrl+=');
      expect(formatKeybinding('mod+minus', false)).toBe('Ctrl+-');
      expect(formatKeybinding('mod+comma', false)).toBe('Ctrl+,');
      expect(formatKeybinding('mod+shift+slash', false)).toBe('Ctrl+Shift+/');
      expect(formatKeybinding('mod+pagedown', false)).toBe('Ctrl+PgDn');
      expect(formatKeybinding('mod+pageup', false)).toBe('Ctrl+PgUp');
    });

    it('renders bare function keys', () => {
      expect(formatKeybinding('f5', false)).toBe('F5');
      expect(formatKeybinding('shift+f5', false)).toBe('Shift+F5');
    });

    it('passes a literal backtick through', () => {
      expect(formatKeybinding('mod+`', false)).toBe('Ctrl+`');
    });
  });

  describe('macos', () => {
    it('renders modifier symbols with no separator', () => {
      expect(formatKeybinding('mod+p', true)).toBe('⌘P');
      expect(formatKeybinding('mod+shift+a', true)).toBe('⌘⇧A');
      expect(formatKeybinding('mod+alt+right', true)).toBe('⌘⌥→');
    });
  });
});

// aria-keyshortcuts is a token grammar a screen reader parses, not the glyphs
// a person reads off a keycap — so it gets its own renderer over the same
// registry string. Both call sites used to hardcode 'Meta+...', announcing a
// Cmd key to every Windows user.
describe('ariaKeyshortcuts', () => {
  it('names the platform modifier', () => {
    expect(ariaKeyshortcuts('mod+d', false)).toBe('Control+D');
    expect(ariaKeyshortcuts('mod+d', true)).toBe('Meta+D');
  });

  it('spells arrows and paging keys the way the spec does', () => {
    expect(ariaKeyshortcuts('mod+pagedown', false)).toBe('Control+PageDown');
    expect(ariaKeyshortcuts('mod+alt+right', true)).toBe('Meta+Alt+ArrowRight');
  });

  it('keeps function keys upper-case', () => {
    expect(ariaKeyshortcuts('shift+f5', false)).toBe('Shift+F5');
  });
});
