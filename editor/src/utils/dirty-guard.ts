import { ask } from '@tauri-apps/plugin-dialog';
import { useWorkspaceStore } from '../stores/workspace';

function isVirtualPath(path: string): boolean {
  return path.startsWith('diff://') || path.startsWith('auth://');
}

/**
 * Prompt before closing tabs that have unsaved changes.
 * Returns true when the close should proceed, false when the user cancels.
 *
 * Virtual tabs (diff/auth) are never considered dirty for this purpose.
 */
export async function confirmCloseDirty(paths: string[]): Promise<boolean> {
  const openFiles = useWorkspaceStore.getState().openFiles;
  const dirty = openFiles.filter(
    (f) => paths.includes(f.path) && f.isDirty && !isVirtualPath(f.path),
  );
  if (dirty.length === 0) return true;

  const names = dirty.slice(0, 5).map((f) => f.name).join(', ');
  const more = dirty.length > 5 ? ` and ${dirty.length - 5} more` : '';
  const message =
    dirty.length === 1
      ? `${dirty[0].name} has unsaved changes.\n\nClose anyway? Unsaved changes will be lost.`
      : `${dirty.length} files have unsaved changes: ${names}${more}.\n\nClose all anyway? Unsaved changes will be lost.`;

  return ask(message, {
    title: 'Unsaved Changes',
    kind: 'warning',
    okLabel: 'Close Anyway',
    cancelLabel: 'Cancel',
  });
}
