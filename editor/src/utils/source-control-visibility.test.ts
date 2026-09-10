import { describe, it, expect } from 'bun:test';
import { showSourceControl } from './source-control-visibility';

describe('showSourceControl', () => {
  it('shows the icon in a git repository', () => {
    expect(showSourceControl({ isGitRepo: true, repoChecked: true })).toBe(true);
  });

  it('hides the icon once a status verdict says the folder is not a repository', () => {
    expect(showSourceControl({ isGitRepo: false, repoChecked: true })).toBe(false);
  });

  it('keeps the icon while detection is still in flight, so a git project never flashes it in', () => {
    expect(showSourceControl({ isGitRepo: false, repoChecked: false })).toBe(true);
  });

  it('does not hide the icon on a transient git failure, which leaves both fields alone', () => {
    // `doRefreshStatus` only clears `isGitRepo` for a literal "not a git
    // repository" error; any other failure keeps the last known verdict.
    expect(showSourceControl({ isGitRepo: true, repoChecked: false })).toBe(true);
  });
});
