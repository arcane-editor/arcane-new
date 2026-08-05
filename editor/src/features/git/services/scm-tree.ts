import type { GitFileStatus } from '../../../stores/git';

/**
 * Folder/file tree for the SCM panel's "view as tree" mode.
 *
 * The flat list is the default (and what VS Code defaults to), but once a
 * change set spans many directories — routine in a Unity project, where a
 * single import rewrites whole folders — a flat list of basenames is hard to
 * scan. This groups by directory instead.
 */
export type ScmTreeNode =
  | {
      kind: 'folder';
      /** Full repo-root-relative path of this folder, e.g. `Assets/Scripts`. */
      path: string;
      /** Displayed segment(s) — several when a single-child chain was compacted. */
      label: string;
      children: ScmTreeNode[];
    }
  | { kind: 'file'; file: GitFileStatus };

interface MutableFolder {
  folders: Map<string, MutableFolder>;
  files: GitFileStatus[];
}

function emptyFolder(): MutableFolder {
  return { folders: new Map(), files: [] };
}

/**
 * Collapse a chain of single-child folders into one row (`a` > `b` > `c`
 * becomes `a/b/c`), matching VS Code's compact-folders behavior. Without it a
 * path like `Assets/Scripts/Player/Abilities/Fire.cs` costs four rows of
 * indentation to reach one file.
 *
 * A folder is only compacted into its single child when it holds no files of
 * its own — otherwise those files would be orphaned from their real directory.
 */
function toNodes(folder: MutableFolder, prefix: string): ScmTreeNode[] {
  const nodes: ScmTreeNode[] = [];

  for (const [name, child] of folder.folders) {
    let label = name;
    let path = prefix ? `${prefix}/${name}` : name;
    let current = child;

    while (current.files.length === 0 && current.folders.size === 1) {
      const [onlyName, onlyChild] = [...current.folders][0];
      label = `${label}/${onlyName}`;
      path = `${path}/${onlyName}`;
      current = onlyChild;
    }

    nodes.push({ kind: 'folder', path, label, children: toNodes(current, path) });
  }

  for (const file of folder.files) {
    nodes.push({ kind: 'file', file });
  }

  return nodes;
}

/**
 * Group `files` (each carrying a repo-root-relative `path`) into a tree.
 *
 * Folders sort before files at every level, and input order is otherwise
 * preserved — `git status` already emits paths sorted, so this keeps the tree
 * stable across refreshes rather than reshuffling under the user.
 */
export function buildScmTree(files: GitFileStatus[]): ScmTreeNode[] {
  const root = emptyFolder();

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    // A path with no directory part (or a malformed empty one) belongs at the
    // root rather than creating a blank folder row.
    const dirs = segments.slice(0, -1);
    let node = root;
    for (const dir of dirs) {
      let next = node.folders.get(dir);
      if (!next) {
        next = emptyFolder();
        node.folders.set(dir, next);
      }
      node = next;
    }
    node.files.push(file);
  }

  return toNodes(root, '');
}
