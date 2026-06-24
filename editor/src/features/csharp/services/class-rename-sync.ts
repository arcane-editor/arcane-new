import { invoke } from '@tauri-apps/api/core';
import { useNotificationsStore } from '../../../stores/notifications';
import { useWorkspaceStore } from '../../../stores/workspace';

function stem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.cs$/i, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * After a `.cs` file is renamed via the IDE, if it declares a class matching the
 * OLD file name, offer to rename the class to match the NEW name (Unity requires
 * a MonoBehaviour's class name to equal its file name). Non-intrusive: a
 * dismissible notification, applied only if the user clicks. Reassures the user
 * that the paired `.meta` moved too, so the GUID — and all references — survive.
 */
export function offerClassRenameSync(oldPath: string, newPath: string): void {
  if (!newPath.toLowerCase().endsWith('.cs')) return;
  const oldStem = stem(oldPath);
  const newStem = stem(newPath);
  if (oldStem === newStem || !/^[A-Za-z_]\w*$/.test(newStem)) return;

  void invoke<string>('read_file', { path: newPath })
    .then((content) => {
      const classRe = new RegExp(`\\bclass\\s+${escapeRe(oldStem)}\\b`);
      if (!classRe.test(content)) return;

      useNotificationsStore.getState().addNotification({
        type: 'info',
        message: `Rename class "${oldStem}" → "${newStem}" to match the file? The .meta moved with it, so the GUID and all scene/prefab references are preserved.`,
        persistent: true,
        actions: [
          {
            label: 'Rename class',
            run: () => {
              const updated = content.replace(classRe, `class ${newStem}`);
              void invoke('write_file', { path: newPath, contents: updated }).then(() => {
                const ws = useWorkspaceStore.getState();
                if (ws.openFiles.find((f) => f.path === newPath)) {
                  void ws.reloadFileFromDisk(newPath);
                }
              });
            },
          },
        ],
      });
    })
    .catch(() => {
      /* unreadable — skip the offer */
    });
}
