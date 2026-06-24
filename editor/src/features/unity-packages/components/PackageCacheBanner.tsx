import { Lock } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { notify } from '../../../stores/notifications';

/**
 * True for files living under a Unity `Library/PackageCache/` directory — these
 * are immutable resolved-package copies that Unity regenerates, so editing them
 * is pointless and lost on the next resolve.
 */
export function isPackageCachePath(path: string | null | undefined): boolean {
  if (!path) return false;
  return /\/library\/packagecache\//i.test(path.replace(/\\/g, '/'));
}

/**
 * Read-only banner shown above the editor when the active file is a Unity
 * PackageCache file. The actual edit-blocking (Monaco `readOnly`) is wired in
 * EditorPanel; this is the visible explanation + the (stubbed) embed action.
 *
 * Renders nothing outside Unity projects or for non-PackageCache files.
 */
export function PackageCacheBanner() {
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  if (!isUnityProject || !isPackageCachePath(activeFilePath)) return null;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px',
        fontSize: 12,
        color: 'var(--text-secondary)',
        background: 'var(--warning-bg)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <Lock size={13} style={{ color: 'var(--warning)', flexShrink: 0 }} />
      <span>
        Package cache file &mdash; read-only.
      </span>
      <button
        type="button"
        onClick={() => {
          // Honest stub: embedding packages (copying from PackageCache into
          // Packages/ and rewriting the manifest) is not implemented yet.
          notify.info('Embedding packages is not yet supported.');
        }}
        style={{
          marginLeft: 'auto',
          background: 'transparent',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
          borderRadius: 4,
          padding: '2px 8px',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        Embed package to edit
      </button>
    </div>
  );
}
