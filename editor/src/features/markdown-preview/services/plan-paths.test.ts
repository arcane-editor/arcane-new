import { describe, it, expect } from 'bun:test';
import { isMarkdownPath, isPlanPath } from './plan-paths';

describe('isMarkdownPath', () => {
  it('matches .md and .mdx, case-insensitively', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('notes.MD')).toBe(true);
    expect(isMarkdownPath('doc.mdx')).toBe(true);
  });

  it('does not match other files', () => {
    expect(isMarkdownPath('Player.cs')).toBe(false);
    expect(isMarkdownPath('mdfile')).toBe(false);
  });
});

describe('isPlanPath', () => {
  it('matches a plan written by plan mode', () => {
    expect(isPlanPath('/Users/me/Game/.arcane/plans/20260810-1432-add-enemy.md')).toBe(true);
  });

  it('matches the same path with Windows separators', () => {
    expect(isPlanPath(String.raw`C:\Game\.arcane\plans\20260810-1432-add-enemy.md`)).toBe(true);
  });

  /** A user's own plan.md has no steps to execute and no session to attach to. */
  it('does not match a markdown file elsewhere in the project', () => {
    expect(isPlanPath('/Users/me/Game/Assets/plan.md')).toBe(false);
    expect(isPlanPath('/Users/me/Game/docs/plans/thing.md')).toBe(false);
  });

  it('does not match a non-markdown file inside the plans folder', () => {
    expect(isPlanPath('/Users/me/Game/.arcane/plans/notes.txt')).toBe(false);
  });
});
