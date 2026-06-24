import { useState } from 'react';
import { X, GitCompare } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUiStore, getFlatDiagnosticsForUri } from '../../../stores/ui';
import { useCommandsStore } from '../../../stores/commands';
import { getFileIcon } from '../../../utils/file-icons';
import { confirmCloseDirty } from '../../../utils/dirty-guard';

const DRAG_MIME = 'application/x-editor-tab-path';

interface TabContextMenu {
  x: number;
  y: number;
  path: string;
}

function TabBar() {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
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
          const fileUri = `file://${file.path}`;
          const byUri = getFlatDiagnosticsForUri(diagnosticsMap, fileUri);
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
                e.dataTransfer.effectAllowed = 'move';
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
                {!file.diff && getFileIcon(file.name, 14)}
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
          path={contextMenu.path}
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
  path: string;
  onClose: () => void;
  onAction: (commandId: string) => void;
  onCloseTab: () => void;
}

function TabMenu({ x, y, onClose, onAction, onCloseTab }: TabMenuProps) {
  const items: Array<{ label: string; onClick: () => void; danger?: boolean }> = [
    { label: 'Close', onClick: onCloseTab },
    { label: 'Close Others', onClick: () => onAction('tab.closeOthers') },
    { label: 'Close to the Right', onClick: () => onAction('tab.closeToRight') },
    { label: 'Close All', onClick: () => onAction('tab.closeAll') },
  ];
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 900 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        style={{
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 901,
          background: 'var(--bg-dropdown, var(--bg-sidebar))',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '4px 0',
          minWidth: '180px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          fontSize: '13px',
          color: 'var(--text-primary)',
        }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            onClick={item.onClick}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            style={{
              display: 'block',
              width: '100%',
              padding: '5px 12px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '13px',
              color: item.danger ? 'var(--color-error, #f44747)' : 'inherit',
              textAlign: 'left',
              fontFamily: 'inherit',
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

export default TabBar;
