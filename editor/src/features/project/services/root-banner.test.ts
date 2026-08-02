import { describe, it, expect } from 'bun:test';
import { rootBannerFor } from './root-banner';

const base = {
  isUnityProject: false,
  ancestorProjectPath: null,
  nestedProjectPath: null,
  workspacePath: '/ws/Assets/Scripts',
  dismissedPaths: [] as string[],
};

describe('rootBannerFor', () => {
  it('offers the enclosing project when the workspace is inside one', () => {
    expect(rootBannerFor({ ...base, ancestorProjectPath: '/ws' })).toEqual({
      kind: 'inside',
      projectPath: '/ws',
      projectName: 'ws',
    });
  });

  it('offers a contained project when the workspace holds one', () => {
    expect(
      rootBannerFor({
        ...base,
        workspacePath: '/code',
        nestedProjectPath: '/code/MyGame',
      }),
    ).toEqual({ kind: 'contains', projectPath: '/code/MyGame', projectName: 'MyGame' });
  });

  // The user is standing inside a project — the more specific situation, and
  // the one that explains why Unity features are off right now.
  it('prefers the enclosing project when both are present', () => {
    const banner = rootBannerFor({
      ...base,
      ancestorProjectPath: '/ws',
      nestedProjectPath: '/ws/Assets/Scripts/Sample',
    });
    expect(banner?.kind).toBe('inside');
    expect(banner?.projectPath).toBe('/ws');
  });

  it('shows nothing when the workspace is already a Unity root', () => {
    expect(
      rootBannerFor({ ...base, isUnityProject: true, ancestorProjectPath: '/ws' }),
    ).toBeNull();
  });

  it('shows nothing when no Unity project is nearby', () => {
    expect(rootBannerFor(base)).toBeNull();
  });

  it('stays dismissed for a folder the user already declined', () => {
    expect(
      rootBannerFor({
        ...base,
        ancestorProjectPath: '/ws',
        dismissedPaths: ['/ws/Assets/Scripts'],
      }),
    ).toBeNull();
  });

  it('dismissal is scoped to the folder, not global', () => {
    expect(
      rootBannerFor({
        ...base,
        ancestorProjectPath: '/ws',
        dismissedPaths: ['/some/other/folder'],
      }),
    ).not.toBeNull();
  });

  it('shows nothing before a workspace is open', () => {
    expect(
      rootBannerFor({ ...base, workspacePath: null, ancestorProjectPath: '/ws' }),
    ).toBeNull();
  });

  it('derives the project name from the last path segment', () => {
    const banner = rootBannerFor({
      ...base,
      ancestorProjectPath: 'D:/Unity/UnityProject/Private Investigator',
    });
    expect(banner?.projectName).toBe('Private Investigator');
  });

  it('tolerates a trailing slash on the project path', () => {
    expect(rootBannerFor({ ...base, ancestorProjectPath: '/ws/' })?.projectName).toBe('ws');
  });
});
