import { describe, it, expect } from 'bun:test';
import { parseSlashQuery } from './slash-command';

// Real names taken from a live `available_commands_update` (2026-08-24).
const REAL = [
  'superpowers:using-superpowers',
  'frontend-design:frontend-design',
  'code-review:code-review',
  'grill-me',
  'deep-research',
];

describe('parseSlashQuery', () => {
  it('opens the full list on a bare slash', () => {
    expect(parseSlashQuery('/')).toBe('');
  });

  it('keeps the popover open through a hyphen', () => {
    // The regression: `\w` stopped here and the popover vanished mid-word.
    expect(parseSlashQuery('/using-superpowers')).toBe('using-superpowers');
  });

  it('keeps it open through a plugin colon', () => {
    expect(parseSlashQuery('/superpowers:using')).toBe('superpowers:using');
  });

  it('parses every real advertised command name', () => {
    for (const name of REAL) {
      expect(parseSlashQuery(`/${name}`)).toBe(name);
    }
  });

  it('closes once the command is followed by a space', () => {
    // Picking a command rewrites the composer to `/name ` — the popover must
    // close so the user can type the rest of the prompt.
    expect(parseSlashQuery('/grill-me ')).toBeNull();
    expect(parseSlashQuery('/grill-me do the thing')).toBeNull();
  });

  it('does not fire on a slash mid-sentence', () => {
    expect(parseSlashQuery('look at src/index.ts')).toBeNull();
    expect(parseSlashQuery('a/b')).toBeNull();
  });

  it('does not fire on empty or plain text', () => {
    expect(parseSlashQuery('')).toBeNull();
    expect(parseSlashQuery('hello')).toBeNull();
  });
});
