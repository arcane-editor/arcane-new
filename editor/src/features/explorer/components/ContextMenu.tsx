import { FilePlus, FolderPlus, FileCode, Pencil, Trash2, Copy, FolderSymlink, Search } from 'lucide-react';
import { isMac } from '../../../utils/platform';
import { useClampedMenuPosition } from '../../../hooks/useClampedMenuPosition';

interface ContextMenuProps {
  x: number;
  y: number;
  isDir: boolean;
  onNewFile: () => void;
  onNewFolder: () => void;
  /** Optional Unity "New C# Script…" action (shown when provided). */
  onNewScript?: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** Copies the absolute filesystem path (shown when provided). */
  onCopyPath?: () => void;
  /** Copies the path relative to the workspace root (shown when provided). */
  onCopyRelativePath?: () => void;
  /** Reveals the item in the OS file manager (shown when provided). */
  onRevealInOs?: () => void;
  /** Opens a search tab scoped to this directory (shown when provided). */
  onSearchInFolder?: () => void;
  onClose: () => void;
}

function ContextMenu({
  x,
  y,
  onNewFile,
  onNewFolder,
  onNewScript,
  onRename,
  onDelete,
  onCopyPath,
  onCopyRelativePath,
  onRevealInOs,
  onSearchInFolder,
  onClose,
}: ContextMenuProps) {
  // Keeps the menu on screen when opened near a viewport edge — without this,
  // right-clicking near the bottom of the tree pushed Delete / Copy Path /
  // Reveal below the window, where a fixed-position menu can't be scrolled to.
  const { ref: menuRef, style: menuPos } = useClampedMenuPosition(x, y);

  function handleItem(cb: () => void) {
    cb();
    onClose();
  }

  return (
    <>
      {/* Transparent overlay to close menu on outside click */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 900,
        }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      {/* Menu */}
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
          minWidth: '160px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          fontSize: '13px',
          color: 'var(--text-primary)',
        }}
      >
        <button
          className="context-menu-item"
          onClick={() => handleItem(onNewFile)}
          style={menuItemStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <FilePlus size={14} style={{ marginRight: 8, flexShrink: 0 }} />
          New File
        </button>
        <button
          className="context-menu-item"
          onClick={() => handleItem(onNewFolder)}
          style={menuItemStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <FolderPlus size={14} style={{ marginRight: 8, flexShrink: 0 }} />
          New Folder
        </button>
        {onNewScript && (
          <button
            className="context-menu-item"
            onClick={() => handleItem(onNewScript)}
            style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <FileCode size={14} style={{ marginRight: 8, flexShrink: 0 }} />
            New C# Script…
          </button>
        )}
        {onSearchInFolder && (
          <button
            className="context-menu-item"
            onClick={() => handleItem(onSearchInFolder)}
            style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Search size={14} style={{ marginRight: 8, flexShrink: 0 }} />
            Search in Folder
          </button>
        )}
        <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
        <button
          className="context-menu-item"
          onClick={() => handleItem(onRename)}
          style={menuItemStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <Pencil size={14} style={{ marginRight: 8, flexShrink: 0 }} />
          Rename
        </button>
        <button
          className="context-menu-item"
          onClick={() => handleItem(onDelete)}
          style={{ ...menuItemStyle, color: 'var(--error-text)' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <Trash2 size={14} style={{ marginRight: 8, flexShrink: 0 }} />
          Delete
        </button>
        {(onCopyPath || onCopyRelativePath || onRevealInOs) && (
          <>
            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            {onCopyPath && (
              <button
                className="context-menu-item"
                onClick={() => handleItem(onCopyPath)}
                style={menuItemStyle}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Copy size={14} style={{ marginRight: 8, flexShrink: 0 }} />
                Copy Path
              </button>
            )}
            {onCopyRelativePath && (
              <button
                className="context-menu-item"
                onClick={() => handleItem(onCopyRelativePath)}
                style={menuItemStyle}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Copy size={14} style={{ marginRight: 8, flexShrink: 0 }} />
                Copy Relative Path
              </button>
            )}
            {onRevealInOs && (
              <button
                className="context-menu-item"
                onClick={() => handleItem(onRevealInOs)}
                style={menuItemStyle}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <FolderSymlink size={14} style={{ marginRight: 8, flexShrink: 0 }} />
                {isMac() ? 'Reveal in Finder' : 'Reveal in File Manager'}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

const menuItemStyle: React.CSSProperties = {
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
};

export default ContextMenu;
