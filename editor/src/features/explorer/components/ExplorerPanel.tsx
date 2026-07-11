import { useRef, useState, useEffect, useMemo } from 'react';
import { Tree, NodeRendererProps, TreeApi } from 'react-arborist';
import {
  ChevronRight,
  ChevronDown,
  RefreshCw,
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
} from 'lucide-react';
import { getFileIcon, getFolderIcon } from '../../../utils/file-icons';
import { ask } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useGitStore } from '../../../stores/git';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { useUiStore } from '../../../stores/ui';
import { toRelativePath } from '../../../utils/relative-path';
import type { TreeNode } from '../../../types';
import ContextMenu from './ContextMenu';
import InlineInput from './InlineInput';
import TypedConfirmDialog from './TypedConfirmDialog';
import ImpactDeleteDialog from './ImpactDeleteDialog';
import { applyUnityTreeView } from '../services/unity-tree-view';
import { ancestorDirs, consumePendingReveal } from '../services/reveal';

// Asset/script kinds whose deletion can leave dangling references in scenes/prefabs.
const REFABLE_DELETE_EXTS = ['.cs', '.prefab', '.asset', '.mat', '.anim', '.controller'];

// Depth-first lookup of a node by id (full path) in the raw (non-view-
// filtered) store tree. Shared by the toggle handler and reveal's ancestor
// walk, both of which need to inspect a directory's already-loaded state.
function findTreeNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findTreeNode(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function statusBadge(status: string): { letter: string; className: string } | null {
  switch (status) {
    case 'modified': return { letter: 'M', className: 'modified' };
    case 'added': return { letter: 'A', className: 'added' };
    case 'deleted': return { letter: 'D', className: 'deleted' };
    case 'untracked': return { letter: 'U', className: 'untracked' };
    case 'renamed': return { letter: 'R', className: 'modified' };
    default: return null;
  }
}

interface NodeRendererExtProps extends NodeRendererProps<TreeNode> {
  renamingNodeId: string | null;
  setRenamingNodeId: (id: string | null) => void;
  setContextMenu: (menu: { x: number; y: number; nodeId: string; isDir: boolean; path: string } | null) => void;
  renamePath: (oldPath: string, newPath: string) => Promise<void>;
}

function NodeRenderer({
  node,
  style,
  renamingNodeId,
  setRenamingNodeId,
  setContextMenu,
  renamePath,
}: NodeRendererExtProps) {
  const loadChildren = useWorkspaceStore((s) => s.loadChildren);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const gitStatus = useGitStore((s) => s.getFileStatus(node.data.id));

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (node.data.isDir) {
      node.toggle();
      if (!node.isOpen && node.data.children && node.data.children.length === 0) {
        loadChildren(node.data.id);
      }
    } else {
      openFile(node.data.id, node.data.name);
    }
  }

  const isRenaming = renamingNodeId === node.data.id;

  function handleRenameSubmit(newName: string) {
    const oldPath = node.data.id;
    const lastSlash = oldPath.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? oldPath.slice(0, lastSlash) : '';
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;
    renamePath(oldPath, newPath);
    setRenamingNodeId(null);
  }

  return (
    <div
      className={`tree-node${node.isSelected ? ' selected' : ''}`}
      style={isRenaming ? { ...style, zIndex: 20, overflow: 'visible' } : style}
      onClick={isRenaming ? undefined : handleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.data.id, isDir: node.data.isDir, path: node.data.id });
      }}
    >
      {node.data.isDir ? (
        <span className="icon-chevron">
          {node.isOpen ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </span>
      ) : (
        <span className="chevron-placeholder" />
      )}
      {node.data.isDir ? (
        <span className="icon-folder">
          {getFolderIcon(node.isOpen, 16, node.data.name)}
        </span>
      ) : (
        <span className="icon-file">
          {getFileIcon(node.data.name, 16)}
        </span>
      )}
      {isRenaming ? (
        <InlineInput
          defaultValue={node.data.name}
          siblingNames={node.parent?.children?.map((c) => c.data.name) ?? []}
          onSubmit={handleRenameSubmit}
          onCancel={() => setRenamingNodeId(null)}
        />
      ) : (
        <span className="node-name">{node.data.name}</span>
      )}
      {!isRenaming && gitStatus && (() => {
        const badge = statusBadge(gitStatus.status);
        return badge ? (
          <span className={`git-badge ${badge.className}`}>{badge.letter}</span>
        ) : null;
      })()}
    </div>
  );
}

function ExplorerPanel() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const assetsRootPath = useWorkspaceStore((s) => s.assetsRootPath);
  const tree = useWorkspaceStore((s) => s.tree);
  const isLoadingTree = useWorkspaceStore((s) => s.isLoadingTree);
  const loadChildren = useWorkspaceStore((s) => s.loadChildren);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const createDirectory = useWorkspaceStore((s) => s.createDirectory);
  const renamePath = useWorkspaceStore((s) => s.renamePath);
  const deletePath = useWorkspaceStore((s) => s.deletePath);

  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const hideMeta = useSettingsStore((s) => s.settings['unity.explorer.hideMeta']);
  const assetsFirst = useSettingsStore((s) => s.settings['unity.explorer.assetsFirst']);
  const templatesEnabled = useSettingsStore((s) => s.settings['unity.templates.enabled']);
  const indexEnabled = useSettingsStore((s) => s.settings['unity.index.enabled']);
  // View-only transform: hide `.meta` + pin Unity folders per settings, without
  // mutating the store's source tree (lazy children / identity stay intact).
  const displayTree = useMemo(
    () => applyUnityTreeView(tree, { isUnityProject, hideMeta, assetsFirst }),
    [tree, isUnityProject, hideMeta, assetsFirst],
  );

  const treeRef = useRef<HTMLDivElement>(null);
  // react-arborist's imperative handle — used by `revealPath` to open
  // ancestor dirs and select/scroll to the active file. `undefined` (not
  // `null`) to match the `Ref<TreeApi<T> | undefined>` type `<Tree>` forwards.
  const treeApiRef = useRef<TreeApi<TreeNode> | undefined>(undefined);
  // Bumped at the start of every `revealPath` call; every async checkpoint
  // inside it re-checks this against the ref before acting, so a rapid
  // sequence of reveals (e.g. quick successive file switches) can't let a
  // slower, superseded call land its open/select/scroll after a newer one.
  const revealGenRef = useRef(0);
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  // Path of a lone `.meta` pending typed-confirm deletion (F-6.1).
  const [metaConfirm, setMetaConfirm] = useState<string | null>(null);
  // Path of an asset pending safe-delete impact preview (F-6.3).
  const [impactDelete, setImpactDelete] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    isDir: boolean;
    path: string;
  } | null>(null);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<{ parentPath: string; type: 'file' | 'folder' } | null>(null);

  // Expands every ancestor directory of `path` (lazy-loading children as
  // needed), then selects + scrolls to it. Reads store state fresh at each
  // step via `getState()` rather than closed-over hook values, since this
  // is invoked from long-lived subscriptions/listeners set up once at mount.
  //
  // Caveat: if `path` is filtered out of the *displayed* tree (e.g. a
  // `.meta` file hidden by `unity.explorer.hideMeta` via
  // `applyUnityTreeView`), react-arborist has no node for that id —
  // `select`/`scrollTo` below silently no-op. There is nothing more to do
  // in that case: revealing a file the tree doesn't show isn't meaningful.
  async function revealPath(path: string): Promise<void> {
    const myGen = ++revealGenRef.current;

    const { assetsRootPath: root0, workspacePath: wp0, loadChildren: load } =
      useWorkspaceStore.getState();
    const root = root0 ?? wp0;
    if (!root) return;

    const dirs = ancestorDirs(root, path);
    if (dirs === null) return; // path isn't under this tree's root — nothing to reveal

    for (const dir of dirs) {
      if (myGen !== revealGenRef.current) return; // superseded by a newer reveal
      const node = findTreeNode(useWorkspaceStore.getState().tree, dir);
      // Mirrors the lazy-load check used elsewhere in this file (onToggle,
      // NodeRenderer's handleClick): an empty/missing children array means
      // "not loaded yet" (a genuinely empty dir just reloads harmlessly).
      if (!node?.children || node.children.length === 0) {
        try {
          await load(dir);
        } catch (err) {
          console.warn('[Explorer] revealPath: loadChildren failed for', dir, err);
          return;
        }
      }
      if (myGen !== revealGenRef.current) return;
      treeApiRef.current?.open(dir);
    }

    // Give React a frame to flush the tree-data/open-state updates from the
    // loop above into react-arborist's internal node list before selecting.
    // Not strictly required — `select`/`scrollTo` internally poll for up to
    // ~1s for the target id to appear — but avoids relying on that solely.
    requestAnimationFrame(() => {
      if (myGen !== revealGenRef.current) return;
      const api = treeApiRef.current;
      if (!api) return;
      api.select(path, { align: 'center' });
      api.scrollTo(path, 'center');
    });
  }

  useEffect(() => {
    if (!treeRef.current) return;
    const obs = new ResizeObserver((entries) => {
      setHeight(entries[0].contentRect.height);
      setWidth(entries[0].contentRect.width);
    });
    obs.observe(treeRef.current);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    function onRequestNew() {
      const wp = useWorkspaceStore.getState().workspacePath;
      if (!wp) return;
      const isUnity = useProjectContextStore.getState().isUnityProject;
      const parent = isUnity ? `${wp}/Assets/Scripts` : wp;
      setCreatingIn({ parentPath: parent, type: 'file' });
    }
    function onReveal(e: Event) {
      // Prefer the pending slot over the event's own `detail` — App.tsx
      // always stashes the path there immediately before dispatching, so
      // this is the single source of truth for both the already-mounted
      // case (this listener) and the mount-time consume below. Falling
      // back to `detail` only guards a future caller that dispatches this
      // event directly without going through the pending-reveal slot.
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      const path = consumePendingReveal() ?? detail?.path ?? null;
      if (path) void revealPath(path);
    }
    window.addEventListener('request-new-file', onRequestNew);
    window.addEventListener('reveal-in-tree', onReveal);

    // Pick up a reveal request that was stashed before this panel mounted
    // (e.g. the sidebar was showing a different view when the command ran).
    const pending = consumePendingReveal();
    if (pending) void revealPath(pending);

    return () => {
      window.removeEventListener('request-new-file', onRequestNew);
      window.removeEventListener('reveal-in-tree', onReveal);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-reveal: expand/select the active file whenever it changes, gated
  // on the `explorer.autoReveal` setting and the explorer actually being
  // the visible sidebar view. Both are read fresh inside the listener (not
  // captured here) so flipping the setting or switching sidebar views takes
  // effect on the very next file switch without needing to re-subscribe.
  useEffect(() => {
    const unsub = useWorkspaceStore.subscribe((state, prevState) => {
      if (state.activeFilePath === prevState.activeFilePath) return;
      const path = state.activeFilePath;
      if (!path) return;
      if (path.startsWith('diff://') || path.startsWith('auth://')) return;
      if (useSettingsStore.getState().getSetting('explorer.autoReveal') === false) return;
      const ui = useUiStore.getState();
      if (!ui.sidebarVisible || ui.activeSidebarView !== 'explorer') return;
      void revealPath(path);
    });
    return unsub;
  }, []);

  if (!workspacePath) {
    return <div className="sidebar-empty">No folder open</div>;
  }

  // The directory the tree is rooted at. For Unity projects this is <root>/Assets
  // (so the explorer shows only Assets contents); otherwise the project root.
  const treeRoot = assetsRootPath ?? workspacePath;
  const workspaceName = treeRoot.split('/').pop() || treeRoot;

  function handleRefresh() {
    if (workspacePath) setWorkspace(workspacePath);
  }

  async function handleDelete(path: string) {
    const name = path.split('/').pop() || path;
    // Deleting a `.meta` directly orphans its asset's GUID + import settings —
    // require a typed confirmation rather than a one-click yes/no.
    const lower = name.toLowerCase();
    if (isUnityProject && lower.endsWith('.meta')) {
      setMetaConfirm(path);
      return;
    }
    // Deleting a referenced asset/script — show the impact (blast radius) first.
    if (isUnityProject && indexEnabled && REFABLE_DELETE_EXTS.some((e) => lower.endsWith(e))) {
      setImpactDelete(path);
      return;
    }
    const confirmed = await ask(`Are you sure you want to delete "${name}"?`, {
      title: 'Delete',
      kind: 'warning',
    });
    if (confirmed) {
      await deletePath(path);
    }
  }

  function getParentDir(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash >= 0 ? path.slice(0, lastSlash) : path;
  }

  // Names of entries already living directly under `parentPath`, used to flag
  // duplicate names while creating a new file/folder. Reads the source tree so
  // view-hidden entries (e.g. `.meta`) still count as collisions.
  function getDirChildrenNames(parentPath: string): string[] {
    if (!parentPath || parentPath === treeRoot) {
      return tree.map((n) => n.name);
    }
    const find = (nodes: TreeNode[]): TreeNode[] | null => {
      for (const n of nodes) {
        if (n.id === parentPath) return n.children ?? [];
        if (n.children) {
          const found = find(n.children);
          if (found) return found;
        }
      }
      return null;
    };
    return (find(tree) ?? []).map((n) => n.name);
  }

  async function handleCreateSubmit(name: string) {
    if (!creatingIn) return;
    const { parentPath, type } = creatingIn;
    if (type === 'file') {
      const newPath = await createFile(parentPath, name);
      if (newPath) {
        setCreatingIn(null);
        openFile(newPath, name);
      }
      // On failure, leave the input open so the user can correct the name.
    } else {
      const newPath = await createDirectory(parentPath, name);
      if (newPath) {
        setCreatingIn(null);
      }
    }
  }

  // Wrap NodeRenderer to inject extra props
  function BoundNodeRenderer(props: NodeRendererProps<TreeNode>) {
    return (
      <NodeRenderer
        {...props}
        renamingNodeId={renamingNodeId}
        setRenamingNodeId={setRenamingNodeId}
        setContextMenu={setContextMenu}
        renamePath={renamePath}
      />
    );
  }

  return (
    <div className="sidebar">
      <div className="explorer-header">
        <span className="explorer-header-title">{workspaceName}</span>
        <div className="explorer-header-actions">
          <button
            className="explorer-action-btn"
            title="New File"
            onClick={() => setCreatingIn({ parentPath: treeRoot, type: 'file' })}
          >
            <FilePlus size={14} />
          </button>
          <button
            className="explorer-action-btn"
            title="New Folder"
            onClick={() => setCreatingIn({ parentPath: treeRoot, type: 'folder' })}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="explorer-action-btn"
            title="Refresh Explorer"
            onClick={handleRefresh}
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="explorer-action-btn"
            title="Collapse All"
            onClick={() => {
              // Collapse all by re-setting workspace (reloads root)
              if (workspacePath) setWorkspace(workspacePath);
            }}
          >
            <ChevronsDownUp size={14} />
          </button>
        </div>
      </div>
      <div className="sidebar-tree" ref={treeRef}>
        {creatingIn && (
          <div style={{ padding: '2px 8px' }}>
            <InlineInput
              defaultValue=""
              siblingNames={getDirChildrenNames(creatingIn.parentPath)}
              onSubmit={handleCreateSubmit}
              onCancel={() => setCreatingIn(null)}
            />
          </div>
        )}
        {isLoadingTree && tree.length === 0 && (
          <div style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: 12 }}>
            Loading…
          </div>
        )}
        {height > 0 && width > 0 && (
          <Tree<TreeNode>
            ref={treeApiRef}
            data={displayTree}
            openByDefault={false}
            indent={16}
            rowHeight={24}
            height={height}
            width={width}
            disableDrag={true}
            disableDrop={true}
            onToggle={(id: string) => {
              const node = findTreeNode(tree, id);
              if (node && node.isDir && node.children && node.children.length === 0) {
                loadChildren(node.id);
              }
            }}
          >
            {BoundNodeRenderer}
          </Tree>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isDir={contextMenu.isDir}
          onNewFile={() => {
            const parent = contextMenu.isDir ? contextMenu.path : getParentDir(contextMenu.path);
            setCreatingIn({ parentPath: parent, type: 'file' });
          }}
          onNewFolder={() => {
            const parent = contextMenu.isDir ? contextMenu.path : getParentDir(contextMenu.path);
            setCreatingIn({ parentPath: parent, type: 'folder' });
          }}
          onNewScript={
            isUnityProject && templatesEnabled
              ? () => {
                  const dir = contextMenu.isDir ? contextMenu.path : getParentDir(contextMenu.path);
                  window.dispatchEvent(new CustomEvent('new-csharp-script', { detail: { dir } }));
                }
              : undefined
          }
          onRename={() => setRenamingNodeId(contextMenu.nodeId)}
          onDelete={() => handleDelete(contextMenu.path)}
          onCopyPath={() => {
            void navigator.clipboard.writeText(contextMenu.path).catch((err) => {
              console.error('[Explorer] Failed to copy path:', err);
            });
          }}
          onCopyRelativePath={() => {
            void navigator.clipboard.writeText(toRelativePath(contextMenu.path, workspacePath)).catch((err) => {
              console.error('[Explorer] Failed to copy relative path:', err);
            });
          }}
          onRevealInOs={() => {
            revealItemInDir(contextMenu.path).catch((err) => {
              console.error('[Explorer] Failed to reveal item:', err);
            });
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {metaConfirm && (
        <TypedConfirmDialog
          title="Delete .meta file?"
          message={`Deleting "${metaConfirm.split('/').pop()}" without its asset orphans the asset's GUID and import settings — Unity regenerates a new GUID, breaking every scene/prefab reference to it. Type the file name to confirm.`}
          confirmText={metaConfirm.split('/').pop() || ''}
          onConfirm={() => {
            const p = metaConfirm;
            setMetaConfirm(null);
            void deletePath(p);
          }}
          onCancel={() => setMetaConfirm(null)}
        />
      )}
      {impactDelete && (
        <ImpactDeleteDialog
          path={impactDelete}
          onConfirm={() => {
            const p = impactDelete;
            setImpactDelete(null);
            void deletePath(p);
          }}
          onCancel={() => setImpactDelete(null)}
        />
      )}
    </div>
  );
}

export default ExplorerPanel;
