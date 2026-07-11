import { describe, it, expect } from 'bun:test';
import { toRelativePath } from './relative-path';

describe('toRelativePath', () => {
  it('strips the workspace path prefix', () => {
    expect(toRelativePath('/Users/dev/project/Assets/Foo.cs', '/Users/dev/project')).toBe(
      'Assets/Foo.cs',
    );
  });

  it('handles a workspace path that already ends with a slash', () => {
    expect(toRelativePath('/Users/dev/project/Assets/Foo.cs', '/Users/dev/project/')).toBe(
      'Assets/Foo.cs',
    );
  });

  it('returns the absolute path unchanged when workspacePath is null', () => {
    expect(toRelativePath('/Users/dev/project/Assets/Foo.cs', null)).toBe(
      '/Users/dev/project/Assets/Foo.cs',
    );
  });

  it('returns the absolute path unchanged when it is not under the workspace root', () => {
    expect(toRelativePath('/Users/dev/other/Foo.cs', '/Users/dev/project')).toBe(
      '/Users/dev/other/Foo.cs',
    );
  });

  it('does not falsely match a sibling directory sharing a prefix', () => {
    // "/Users/dev/project-extra" starts with "/Users/dev/project" but is not
    // actually inside the workspace — the trailing "/" in the prefix check
    // must prevent this from being treated as a relative path.
    expect(toRelativePath('/Users/dev/project-extra/Foo.cs', '/Users/dev/project')).toBe(
      '/Users/dev/project-extra/Foo.cs',
    );
  });

  it('returns the workspace root file itself as just its name', () => {
    expect(toRelativePath('/Users/dev/project/README.md', '/Users/dev/project')).toBe(
      'README.md',
    );
  });
});
