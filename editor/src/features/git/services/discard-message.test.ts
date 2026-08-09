import { describe, it, expect } from 'bun:test';
import { buildDiscardMessage } from './discard-message';

/**
 * "Discard All Changes" ran `git checkout -- .` plus `git clean -fd` on a
 * single click, from a button sitting directly beside "Stage All". Untracked
 * files are in no commit and no stash, so a misclick destroyed a day of new
 * prefabs and scripts with no dialog, no toast and no undo.
 *
 * The counts and the untracked warning are the whole point of the prompt, so
 * they are what gets tested.
 */
describe('buildDiscardMessage', () => {
  it('names the tracked file count for a discard-all with no untracked files', () => {
    const m = buildDiscardMessage({ scope: 'all', tracked: 7, untracked: 0 });
    expect(m).toContain('7');
    expect(m.toLowerCase()).toContain('revert');
    expect(m.toLowerCase()).not.toContain('permanently delete');
  });

  it('warns separately and explicitly about untracked files', () => {
    const m = buildDiscardMessage({ scope: 'all', tracked: 2, untracked: 3 });
    expect(m).toContain('3');
    expect(m.toLowerCase()).toContain('permanently delete');
    expect(m.toLowerCase()).toContain('cannot be recovered');
  });

  it('names the file for a single-file discard', () => {
    const m = buildDiscardMessage({
      scope: 'file',
      fileName: 'PlayerController.cs',
      tracked: 1,
      untracked: 0,
    });
    expect(m).toContain('PlayerController.cs');
  });

  it('treats a single untracked file as a deletion, not a revert', () => {
    const m = buildDiscardMessage({
      scope: 'file',
      fileName: 'Enemy.prefab',
      tracked: 0,
      untracked: 1,
    });
    expect(m).toContain('Enemy.prefab');
    expect(m.toLowerCase()).toContain('permanently delete');
    expect(m.toLowerCase()).toContain('cannot be recovered');
  });

  it('is never empty, whatever the counts', () => {
    expect(buildDiscardMessage({ scope: 'all', tracked: 0, untracked: 0 }).length).toBeGreaterThan(
      0,
    );
  });
});
