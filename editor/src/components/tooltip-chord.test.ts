import { describe, it, expect } from 'bun:test';
import { tooltipParts } from './tooltip-chord';

type Cmd = { keybinding?: string };
const registry = (entries: Record<string, Cmd>) => (id: string) => entries[id];

/**
 * 149 native `title=` attributes existed and only one of them showed a keyboard
 * chord — the rest left every shortcut undiscoverable. Five hardcoded `⌘`/`⇧`
 * and rendered those glyphs verbatim on Windows and Linux.
 *
 * The chord is always read from the command registry and formatted by the
 * shared `formatKeybinding`, so a rebinding cannot leave a stale chord on a
 * button, and no surface can spell one for the wrong platform.
 */
describe('tooltipParts', () => {
  const reg = registry({
    'view.aiPanel': { keybinding: 'mod+shift+a' },
    'view.explorer': { keybinding: 'mod+shift+e' },
    'settings.open': {},
  });

  it('renders the chord in macOS glyphs on a Mac', () => {
    expect(tooltipParts('AI Assistant', 'view.aiPanel', reg, true)).toEqual({
      label: 'AI Assistant',
      chord: '⌘⇧A',
    });
  });

  it('renders the chord in words off a Mac', () => {
    expect(tooltipParts('AI Assistant', 'view.aiPanel', reg, false)).toEqual({
      label: 'AI Assistant',
      chord: 'Ctrl+Shift+A',
    });
  });

  it('omits the chord when the command has none', () => {
    expect(tooltipParts('Settings', 'settings.open', reg, true)).toEqual({
      label: 'Settings',
      chord: null,
    });
  });

  it('omits the chord when the command is not registered', () => {
    expect(tooltipParts('Nothing', 'no.such.command', reg, true)).toEqual({
      label: 'Nothing',
      chord: null,
    });
  });

  it('omits the chord when no command id is given', () => {
    expect(tooltipParts('Plain', undefined, reg, true)).toEqual({
      label: 'Plain',
      chord: null,
    });
  });
});
