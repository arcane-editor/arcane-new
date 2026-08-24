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
    expect(isPlanPath('/Users/me/Game/.arcane/plans/20260810-1432-add-enemy.aplan')).toBe(true);
  });

  /** The extension is the signal, so a plan stays a plan wherever it is moved. */
  it('matches a .aplan anywhere, case-insensitively', () => {
    expect(isPlanPath('/Users/me/Game/Assets/notes.aplan')).toBe(true);
    expect(isPlanPath(String.raw`C:\Game\scratch\draft.APLAN`)).toBe(true);
  });

  // Plans written before the extension existed still open as plans: they parse
  // identically, and demoting them to prose would take Execute away from work
  // that was already planned.
  it('still matches a legacy .md plan inside .arcane/plans/', () => {
    expect(isPlanPath('/Users/me/Game/.arcane/plans/20260810-1432-add-enemy.md')).toBe(true);
    expect(isPlanPath(String.raw`C:\Game\.arcane\plans\20260810-1432-add-enemy.md`)).toBe(true);
  });

  /** A user's own plan.md has no steps to execute and no session to attach to. */
  it('does not match a markdown file elsewhere in the project', () => {
    expect(isPlanPath('/Users/me/Game/Assets/plan.md')).toBe(false);
    expect(isPlanPath('/Users/me/Game/docs/plans/thing.md')).toBe(false);
  });

  it('does not match some other file inside the plans folder', () => {
    expect(isPlanPath('/Users/me/Game/.arcane/plans/notes.txt')).toBe(false);
  });

  /** `.aplan` is not markdown by name — EditorPanel must route on isPlanPath. */
  it('is not reported as a markdown path', () => {
    expect(isMarkdownPath('20260810-1432-add-enemy.aplan')).toBe(false);
  });
});
