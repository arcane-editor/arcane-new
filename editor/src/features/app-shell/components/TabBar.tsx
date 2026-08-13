import { useState } from 'react';
import { X, GitCompare, Copy, FolderSymlink, Search } from 'lucide-react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUiStore, getFlatDiagnosticsForUri } from '../../../stores/ui';
import { useCommandsStore } from '../../../stores/commands';
import { getFileIcon } from '../../../utils/file-icons';
import { confirmCloseDirty } from '../../../utils/dirty-guard';
import { toRelativePath } from '../../../utils/relative-path';
import { isVirtualPath } from '../../../utils/virtual-path';
import { isMac } from '../../../utils/platform';
import { ARCANE_FILE_MIME, serializeFileDrag } from '../../../utils/drag-mime';
import { useClampedMenuPosition } from '../../../hooks/useClampedMenuPosition';
import type { OpenFile } from '../../../types';
import { fileUri } from '../../lsp';

const DRAG_MIME = 'application/x-editor-tab-path';

interface TabContextMenu {
  x: number;
  y: number;
  path: string;
}

/**
 * Resolves the real, on-disk filesystem path backing a tab so it can be
 * copied or revealed in the OS file manager. Returns null for tabs that
 * have no real underlying file (e.g. `auth://`/`search://` virtual tabs) or
 * when a `diff://` tab's target can't be resolved because no workspace is
 * open.
 *
 * `file.diff` is checked BEFORE `isVirtualPath`, not after: `diff://` is
 * also a virtual scheme (it names no real on-disk file by itself), but a
 * diff tab's `.diff.filePath` DOES resolve to one, via `workspacePath` —
 * checking virtualness first would wrongly return null for every diff tab
 * instead of its real target.
 */
/** A search results tab. It gets a magnifier rather than a file-type icon —
 *  `getFileIcon` would resolve its display name ("Search") to the generic
 *  document glyph, which reads as an untitled text file. */
function isSearchTab(path: string): boolean {
  return path.startsWith('search://');
}

function resolveRealPath(file: OpenFile | undefined, workspacePath: string | null): string | null {
  if (!file) return null;
  if (file.diff) {
    return workspacePath ? `${workspacePath}/${file.diff.filePath}` : null;
  }
  if (isVirtualPath(file.path)) return null;
  return file.path;
}

function TabBar() {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const reorderTabs = useWorkspaceStore((s) => s.reorderTabs);
  const diagnosticsMap = useUiStore((s) => s.diagnostics);
  const executeCommand = useCommandsStore((s) => s.executeCommand);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenu | null>(null);

  if (openFiles.length === 0) return null;

  return (
    <>
      <div className="tab-bar">
        {openFiles.map((file) => {
          // `fileUri`, not a raw template: unencoded and drive-unaware, this
          // key never matched the URI diagnostics are actually stored under,
          // so tab error/warning badges silently fell through to the
          // path-keyed fallback below — and showed nothing on Windows.
          const uri = fileUri(file.path);
          const byUri = getFlatDiagnosticsForUri(diagnosticsMap, uri);
          const fileDiags = byUri.length > 0 ? byUri : getFlatDiagnosticsForUri(diagnosticsMap, file.path);
          const errorCount = fileDiags.filter((d) => d.severity === 'error').length;
          const diagCount = fileDiags.length;
          const badgeClass = errorCount > 0 ? 'tab-badge tab-badge--error' : 'tab-badge tab-badge--warning';
          const isDropTarget = dropTargetPath === file.path;

          return (
            <div
              key={file.path}
              className={`tab${file.path === activeFilePath ? ' active' : ''}${isDropTarget ? ' drop-target' : ''}`}
              onClick={() => setActiveFile(file.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setActiveFile(file.path);
                setContextMenu({ x: e.clientX, y: e.clientY, path: file.path });
              }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, file.path);
                // Second payload, for drop zones outside the tab strip (the AI
                // panel takes it as context). Carried alongside rather than
                // instead of DRAG_MIME so reordering is unaffected: each drop
                // zone checks for the MIME it understands and ignores the
                // other, which is also what stops an explorer drag from
                // reordering tabs.
                const real = resolveRealPath(file, workspacePath);
                if (real) {
                  e.dataTransfer.setData(
                    ARCANE_FILE_MIME,
                    serializeFileDrag({ path: real, isDir: false }),
                  );
                }
                e.dataTransfer.effectAllowed = 'copyMove';
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dropTargetPath !== file.path) setDropTargetPath(file.path);
              }}
              onDragLeave={() => {
                if (dropTargetPath === file.path) setDropTargetPath(null);
              }}
              onDrop={(e) => {
                const fromPath = e.dataTransfer.getData(DRAG_MIME);
                setDropTargetPath(null);
                if (fromPath && fromPath !== file.path) {
                  e.preventDefault();
                  reorderTabs(fromPath, file.path);
                }
              }}
              onDragEnd={() => setDropTargetPath(null)}
              title=""
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {!file.diff && !isSearchTab(file.path) && getFileIcon(file.name, 14)}
                {isSearchTab(file.path) && <Search size={13} aria-hidden="true" />}
                {file.diff && <GitCompare size={12} style={{ opacity: 0.7 }} aria-hidden="true" />}
                {file.name}
                {file.isDirty && <span className="dirty-dot"> *</span>}
                {diagCount > 0 && <span className={badgeClass}>{diagCount}</span>}
              </span>
              <button
                className="tab-close"
                aria-label="Close tab"
                onClick={async (e) => {
                  e.stopPropagation();
                  const proceed = await confirmCloseDirty([file.path]);
                  if (proceed) closeFile(file.path);
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {contextMenu && (
        <TabMenu
          x={contextMenu.x}
          y={contextMenu.y}
          realPath={resolveRealPath(
            openFiles.find((f) => f.path === contextMenu.path),
            workspacePath,
          )}
          workspacePath={workspacePath}
          onClose={() => setContextMenu(null)}
          onAction={(commandId) => {
            executeCommand(commandId);
            setContextMenu(null);
          }}
          onCloseTab={async () => {
            const proceed = await confirmCloseDirty([contextMenu.path]);
            if (proceed) closeFile(contextMenu.path);
            setContextMenu(null);
          }}
        />
      )}
    </>
  );
}

interface TabMenuProps {
  x: number;
  y: number;
  /** Real, on-disk path backing the tab; null hides the path/reveal actions. */
  realPath: string | null;
  workspacePath: string | null;
  onClose: () => void;
  onAction: (commandId: string) => void;
  onCloseTab: () => void;
}

interface TabMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
}

function TabMenu({ x, y, realPath, workspacePath, onClose, onAction, onCloseTab }: TabMenuProps) {
  // Right-clicking a tab far along the bar used to run the menu off the right
  // edge of the window; clamp it back on screen.
  const { ref: menuRef, style: menuPos } = useClampedMenuPosition(x, y);

  function handleItem(cb: () => void) {
    cb();
    onClose();
  }

  const closeItems: TabMenuItem[] = [
    { label: 'Close', onClick: onCloseTab },
    { label: 'Close Others', onClick: () => onAction('tab.closeOthers') },
    { label: 'Close to the Right', onClick: () => onAction('tab.closeToRight') },
    { label: 'Close All', onClick: () => onAction('tab.closeAll') },
  ];
  const pathItems: TabMenuItem[] = realPath
    ? [
        {
          label: 'Copy Path',
          icon: Copy,
          onClick: () => {
            void navigator.clipboard.writeText(realPath).catch((err) => {
              console.error('[TabBar] Failed to copy path:', err);
            });
          },
        },
        {
          label: 'Copy Relative Path',
          icon: Copy,
          onClick: () => {
            void navigator.clipboard.writeText(toRelativePath(realPath, workspacePath)).catch((err) => {
              console.error('[TabBar] Failed to copy relative path:', err);
            });
          },
        },
        {
          label: isMac() ? 'Reveal in Finder' : 'Reveal in File Manager',
          icon: FolderSymlink,
          onClick: () => {
            revealItemInDir(realPath).catch((err) => {
              console.error('[TabBar] Failed to reveal item:', err);
            });
          },
        },
      ]
    : [];
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 900 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          ...menuPos,
          zIndex: 901,
          background: 'var(--bg-sidebar)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '4px 0',
          minWidth: '180px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          fontSize: '13px',
          color: 'var(--text-primary)',
        }}
      >
        {closeItems.map((item) => (
          <button
            key={item.label}
            onClick={item.onClick}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              padding: '5px 12px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '13px',
              color: item.danger ? 'var(--error-text)' : 'inherit',
              textAlign: 'left',
              fontFamily: 'inherit',
            }}
          >
            {item.label}
          </button>
        ))}
        {pathItems.length > 0 && (
          <>
            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            {pathItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  onClick={() => handleItem(item.onClick)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    width: '100%',
                    padding: '5px 12px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: 'inherit',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                  }}
                >
                  {Icon && <Icon size={14} style={{ marginRight: 8, flexShrink: 0 }} />}
                  {item.label}
                </button>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}

export default TabBar;
