import { describe, expect, it } from 'bun:test';
import * as explorer from './unity-tree-view';

interface ExplorerRoot {
  treeRoot: string;
  workspaceName: string;
}

type ExplorerRootFor = (workspacePath: string, assetsRootPath: string | null) => ExplorerRoot;

function getExplorerRootFor(): ExplorerRootFor | undefined {
  return (explorer as { explorerRootFor?: ExplorerRootFor }).explorerRootFor;
}

describe('explorerRootFor', () => {
  it('labels a Unity Assets tree with its project folder name', () => {
    const explorerRootFor = getExplorerRootFor();
    expect(explorerRootFor).toBeTypeOf('function');
    if (!explorerRootFor) return;

    expect(explorerRootFor('/Games/MyGame', '/Games/MyGame/Assets')).toEqual({
      treeRoot: '/Games/MyGame/Assets',
      workspaceName: 'MyGame',
    });
  });

  it('keeps a non-Unity workspace rooted and labeled at the opened folder', () => {
    const explorerRootFor = getExplorerRootFor();
    expect(explorerRootFor).toBeTypeOf('function');
    if (!explorerRootFor) return;

    expect(explorerRootFor('/Repositories/Tooling', null)).toEqual({
      treeRoot: '/Repositories/Tooling',
      workspaceName: 'Tooling',
    });
  });
});
