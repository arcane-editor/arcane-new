import { describe, it, expect } from 'bun:test';
import { formatKeybinding } from './format-keybinding';

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
