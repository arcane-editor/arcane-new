import type { TreeNode } from '../../../types';

export interface UnityTreeViewOptions {
  isUnityProject: boolean;
  /** Hide `.meta` files from the tree (they stay on disk + tracked by git). */
  hideMeta: boolean;
  /** Pin Assets / Packages / ProjectSettings to the top of the root level. */
  assetsFirst: boolean;
}

// Root folders pinned (in this order) when "Assets First" is on.
const PINNED_ROOTS = ['Assets', 'Packages', 'ProjectSettings'];

function isMeta(name: string): boolean {
  return name.toLowerCase().endsWith('.meta');
}

/** Recursively drop `.meta` file nodes, preserving directories + identity. */
function stripMeta(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (!n.isDir && isMeta(n.name)) continue;
    if (n.children && n.children.length > 0) {
      out.push({ ...n, children: stripMeta(n.children) });
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Stable sort that pins the Unity folders to the front of the root level. */
function pinRoots(nodes: TreeNode[]): TreeNode[] {
  const rank = (name: string): number => {
    const i = PINNED_ROOTS.indexOf(name);
    return i === -1 ? PINNED_ROOTS.length : i;
  };
  return [...nodes].sort((a, b) => {
    const ra = rank(a.name);
    const rb = rank(b.name);
    if (ra !== rb) return ra - rb;
    return 0; // keep original order within a rank (read_directory order)
  });
}

/**
 * Apply the Unity explorer view options to a tree. Pure — returns a new tree,
 * leaving the store's source tree untouched (so lazy-loaded children, identity,
 * and the un-filtered model are preserved). A no-op for non-Unity projects.
 */
export function applyUnityTreeView(tree: TreeNode[], opts: UnityTreeViewOptions): TreeNode[] {
  if (!opts.isUnityProject) return tree;
  let out = opts.hideMeta ? stripMeta(tree) : tree;
  if (opts.assetsFirst) out = pinRoots(out);
  return out;
}
