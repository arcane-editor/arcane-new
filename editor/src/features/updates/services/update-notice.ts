import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useNotificationsStore } from '../../../stores/notifications';
import { useUpdatesStore, type PendingUpdate } from '../../../stores/updates';

/** The Tauri event payload. Identical to what the store holds, by design. */
export type UpdateReadyPayload = PendingUpdate;

/**
 * Copy for the update toast.
 *
 * Split from the listener so it is testable without a Tauri runtime, and so
 * the platform difference is stated in one place: on macOS the work is done
 * and restarting is instant; on Windows restarting still has to download and
 * run an installer, and promising otherwise would be a lie the user notices.
 */
export function updateReadyMessage({ version, installed }: UpdateReadyPayload): string {
  return installed
    ? `UnityIDE ${version} is installed — restart whenever you're ready.`
    : `UnityIDE ${version} is available — restarting will download and install it.`;
}

/**
 * Show a sticky toast whenever the backend stages an update.
 *
 * `persistent` because an update notice that auto-dismisses after four seconds
 * is one the user will miss; they should be able to act on it whenever they
 * reach a natural stopping point.
 */
export async function startUpdateNotices(): Promise<UnlistenFn> {
  return listen<UpdateReadyPayload>('unityide-update-ready', (event) => {
    // The store first: the title-bar control is the surface that persists, and
    // it must be correct even if the user dismisses the toast — or never sees
    // it, having been in another window when it arrived.
    useUpdatesStore.getState().setPending(event.payload);

    useNotificationsStore.getState().addNotification({
      type: 'info',
      message: updateReadyMessage(event.payload),
      persistent: true,
      actions: [
        {
          label: 'Restart',
          run: () => {
            // Rejection is not worth a second toast: on Windows the process is
            // terminated by the installer mid-call, so the promise never
            // settles in the success case either.
            invoke('updates_apply_and_restart').catch(() => {});
          },
        },
      ],
    });
  });
}
