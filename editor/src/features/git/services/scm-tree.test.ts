import { describe, it, expect } from 'bun:test';
import { buildScmTree, type ScmTreeNode } from './scm-tree';
import type { GitFileStatus } from '../../../stores/git';

function f(path: string): GitFileStatus {
  return { path, absolute_path: `/repo/${path}`, status: 'modified', staged: false };
}

/** Render the tree as indented lines, so structure assertions stay readable. */
function render(nodes: ScmTreeNode[], depth = 0): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'folder') {
      out.push(`${'  '.repeat(depth)}${n.label}/`);
      out.push(...render(n.children, depth + 1));
    } else {
      out.push(`${'  '.repeat(depth)}${n.file.path.split('/').pop()}`);
    }
  }
  return out;
}

describe('buildScmTree', () => {
  it('puts root-level files at the top level with no folder row', () => {
    expect(render(buildScmTree([f('README.md'), f('bun.lock')]))).toEqual([
      'README.md',
      'bun.lock',
    ]);
  });

  it('groups files under their directory', () => {
    expect(render(buildScmTree([f('src/a.ts'), f('src/b.ts')]))).toEqual([
      'src/',
      '  a.ts',
      '  b.ts',
    ]);
  });

  it('compacts a chain of single-child folders into one row', () => {
    // Otherwise reaching one file costs four rows of indentation.
    expect(render(buildScmTree([f('Assets/Scripts/Player/Fire.cs')]))).toEqual([
      'Assets/Scripts/Player/',
      '  Fire.cs',
    ]);
  });

  it('stops compacting where a folder branches', () => {
    expect(
      render(buildScmTree([f('Assets/Scripts/Player/Fire.cs'), f('Assets/Scripts/Enemy/AI.cs')])),
    ).toEqual([
      'Assets/Scripts/',
      '  Player/',
      '    Fire.cs',
      '  Enemy/',
      '    AI.cs',
    ]);
  });

  it('does not compact past a folder that holds files of its own', () => {
    // Compacting `Assets` into `Assets/Scripts` would orphan `Assets/top.meta`.
    expect(
      render(buildScmTree([f('Assets/Scripts/Fire.cs'), f('Assets/top.meta')])),
    ).toEqual(['Assets/', '  Scripts/', '    Fire.cs', '  top.meta']);
  });

  it('sorts folders before files at each level', () => {
    const rendered = render(buildScmTree([f('zzz.txt'), f('src/a.ts')]));
    expect(rendered).toEqual(['src/', '  a.ts', 'zzz.txt']);
  });

  it('gives every folder its full path, which is what drives collapse state', () => {
    const [assets] = buildScmTree([f('Assets/Scripts/Fire.cs'), f('Assets/top.meta')]);
    expect(assets.kind).toBe('folder');
    if (assets.kind !== 'folder') return;
    expect(assets.path).toBe('Assets');
    const scripts = assets.children[0];
    expect(scripts.kind).toBe('folder');
    if (scripts.kind !== 'folder') return;
    // Compacted or not, the path is the real one — two folders can share a
    // label but never a path.
    expect(scripts.path).toBe('Assets/Scripts');
  });

  it('keeps the compacted path complete so collapse state stays unique', () => {
    const [node] = buildScmTree([f('a/b/c/deep.ts')]);
    expect(node.kind).toBe('folder');
    if (node.kind !== 'folder') return;
    expect(node.label).toBe('a/b/c');
    expect(node.path).toBe('a/b/c');
  });

  it('preserves input order among files (git status is already sorted)', () => {
    const rendered = render(buildScmTree([f('src/b.ts'), f('src/a.ts')]));
    expect(rendered).toEqual(['src/', '  b.ts', '  a.ts']);
  });

  it('returns an empty tree for no files', () => {
    expect(buildScmTree([])).toEqual([]);
  });

  it('carries the original file entry through, not just its path', () => {
    const file: GitFileStatus = {
      path: 'src/new.ts',
      absolute_path: '/repo/src/new.ts',
      status: 'renamed',
      staged: true,
      orig_path: 'src/old.ts',
    };
    const [folder] = buildScmTree([file]);
    if (folder.kind !== 'folder') throw new Error('expected a folder');
    const leaf = folder.children[0];
    if (leaf.kind !== 'file') throw new Error('expected a file');
    // The row still needs status, staged and orig_path to render and act.
    expect(leaf.file).toBe(file);
  });
});
