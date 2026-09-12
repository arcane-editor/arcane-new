import { describe, it, expect } from 'bun:test';
import { toRelativePath, isAbsolutePath, toAbsolutePath } from './relative-path';

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

describe('isAbsolutePath', () => {
  it('accepts POSIX and Windows drive paths', () => {
    expect(isAbsolutePath('/Users/dev/project')).toBe(true);
    expect(isAbsolutePath('D:/Unity/Proj')).toBe(true);
    expect(isAbsolutePath('D:\\Unity\\Proj')).toBe(true);
    expect(isAbsolutePath('c:/unity/proj')).toBe(true);
  });

  it('rejects workspace-relative paths', () => {
    expect(isAbsolutePath('Assets/UI/Theme.uss')).toBe(false);
    expect(isAbsolutePath('Theme.uss')).toBe(false);
  });
});

describe('toAbsolutePath', () => {
  it('joins a relative path onto the workspace', () => {
    expect(toAbsolutePath('Assets/UI/Theme.uss', 'D:/Unity/Proj'))
      .toBe('D:/Unity/Proj/Assets/UI/Theme.uss');
  });

  it('leaves an already-absolute path alone on either platform', () => {
    expect(toAbsolutePath('D:/Unity/Proj/Assets/UI/Theme.uss', 'D:/Unity/Proj'))
      .toBe('D:/Unity/Proj/Assets/UI/Theme.uss');
    expect(toAbsolutePath('/Users/dev/project/Assets/UI/Theme.uss', '/Users/dev/project'))
      .toBe('/Users/dev/project/Assets/UI/Theme.uss');
  });

  it('does not double the separator on a workspace with a trailing slash', () => {
    expect(toAbsolutePath('Assets/UI/Theme.uss', 'D:/Unity/Proj/'))
      .toBe('D:/Unity/Proj/Assets/UI/Theme.uss');
  });

  it('returns the path unchanged when no workspace is open', () => {
    expect(toAbsolutePath('Assets/UI/Theme.uss', null)).toBe('Assets/UI/Theme.uss');
  });
});
