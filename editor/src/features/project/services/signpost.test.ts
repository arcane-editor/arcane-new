import { describe, it, expect } from 'bun:test';
import { signpostShortcuts } from './signpost';

const ALL = [
  { id: 'palette.quickOpen', keybinding: 'mod+p' },
  { id: 'terminal.toggle', keybinding: 'mod+`' },
  { id: 'view.aiPanel', keybinding: 'mod+shift+a' },
  { id: 'palette.commands', keybinding: 'mod+shift+p' },
  { id: 'file.save', keybinding: 'mod+s' },
];

// Platform pinned to false (Windows/Linux chords) so assertions hold on any
// test host — see the note in format-keybinding.test.ts.
describe('signpostShortcuts', () => {
  it('returns the four signposted commands in a stable order', () => {
    expect(signpostShortcuts(ALL, false).map((s) => s.id)).toEqual([
      'palette.quickOpen',
      'terminal.toggle',
      'view.aiPanel',
      'palette.commands',
    ]);
  });

  it('labels each shortcut for a newcomer', () => {
    const byId = Object.fromEntries(signpostShortcuts(ALL, false).map((s) => [s.id, s.label]));
    expect(byId['palette.quickOpen']).toBe('Go to file');
    expect(byId['terminal.toggle']).toBe('Terminal');
    expect(byId['view.aiPanel']).toBe('Ask the AI');
    expect(byId['palette.commands']).toBe('Commands');
  });

  it('formats the keys for display', () => {
    const terminal = signpostShortcuts(ALL, false).find((s) => s.id === 'terminal.toggle');
    expect(terminal?.keys).toBe('Ctrl+`');
  });

  // Guards the reason this is registry-driven: the tester was told "Ctrl+J
  // opens the terminal", but mod+j is view.toggleBottomPanel — the terminal
  // just lives in that panel. Hardcoding would ship that same confusion.
  it('reads the real binding rather than a hardcoded one', () => {
    const rebound = signpostShortcuts(
      [
        ...ALL.filter((b) => b.id !== 'terminal.toggle'),
        { id: 'terminal.toggle', keybinding: 'mod+shift+t' },
      ],
      false,
    );
    expect(rebound.find((s) => s.id === 'terminal.toggle')?.keys).toBe('Ctrl+Shift+T');
  });

  it('omits a command that has no binding rather than showing an empty key', () => {
    const partial = signpostShortcuts(ALL.filter((b) => b.id !== 'view.aiPanel'), false);
    expect(partial.map((s) => s.id)).not.toContain('view.aiPanel');
    expect(partial).toHaveLength(3);
  });

  it('returns nothing when no commands are registered yet', () => {
    expect(signpostShortcuts([], false)).toEqual([]);
  });
});
