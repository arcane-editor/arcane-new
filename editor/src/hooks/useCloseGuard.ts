import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { useWorkspaceStore } from '../stores/workspace';
import { useAiStore } from '../stores/ai';
import { useCheckpointsStore } from '../stores/checkpoints';
import { safeUnlisten } from '../utils/tauri-listener';

export function useCloseGuard() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const win = getCurrentWindow();
      const fn = await win.onCloseRequested(async (event) => {
        // Persist any pending chat-session (and checkpoint) changes before the window goes away.
        await useAiStore.getState().flushSessionNow();
        await useCheckpointsStore.getState().flushCheckpointsNow();

        const dirty = useWorkspaceStore.getState().openFiles.filter(
          (f) => f.isDirty && !f.path.startsWith('diff://') && !f.path.startsWith('auth://'),
        );
        if (dirty.length === 0) return;

        event.preventDefault();

        const names = dirty.slice(0, 5).map((f) => f.name).join(', ');
        const more = dirty.length > 5 ? ` and ${dirty.length - 5} more` : '';
        const confirmed = await ask(
          `You have unsaved changes in: ${names}${more}.\n\nClose anyway? Unsaved changes will be lost.`,
          {
            title: 'Unsaved Changes',
            kind: 'warning',
            okLabel: 'Close Anyway',
            cancelLabel: 'Cancel',
          },
        );

        if (confirmed) {
          await win.destroy();
        }
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();

    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);
}
