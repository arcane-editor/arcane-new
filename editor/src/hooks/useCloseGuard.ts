import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { useWorkspaceStore } from '../stores/workspace';
import { useAiStore } from '../stores/ai';
import { useCheckpointsStore } from '../stores/checkpoints';
import { useEditReviewStore } from '../stores/edit-review';
import { flushLayoutPersisters } from '../features/app-shell';
import { safeUnlisten } from '../utils/tauri-listener';
import { settleWorkspaceChanges } from '../features/lsp';
import { dapClient } from '../features/debugger';
import { notify } from '../stores/notifications';

export function useCloseGuard() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const win = getCurrentWindow();
      const fn = await win.onCloseRequested(async (event) => {
        await settleWorkspaceChanges();
        // Persist any pending chat-session (checkpoint, and edit-review)
        // changes, and any pending layout-size write, before the window goes away.
        await useAiStore.getState().flushSessionNow();
        await useCheckpointsStore.getState().flushCheckpointsNow();
        await useEditReviewStore.getState().flushNow();
        await flushLayoutPersisters();

        const dirty = useWorkspaceStore.getState().openFiles.filter(
          (f) => f.isDirty && !f.path.startsWith('diff://') && !f.path.startsWith('auth://'),
        );
        const detach = async () => {
          try { await dapClient.stop(); return true; }
          catch (error) {
            event.preventDefault();
            notify.error(`Window remains open because debugger shutdown was not confirmed: ${String(error)}`);
            return false;
          }
        };
        if (dirty.length === 0) { await detach(); return; }

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

        if (confirmed && await detach()) {
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
