import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useNotificationsStore } from '../../../stores/notifications';

export interface UpdateReadyPayload {
  version: string;
  /** True when the new version is in place and only a relaunch is outstanding. */
  installed: boolean;
}

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
    ? `Arcane ${version} is installed — restart whenever you're ready.`
    : `Arcane ${version} is available — restarting will download and install it.`;
}

/**
 * Show a sticky toast whenever the backend stages an update.
 *
 * `persistent` because an update notice that auto-dismisses after four seconds
 * is one the user will miss; they should be able to act on it whenever they
 * reach a natural stopping point.
 */
export async function startUpdateNotices(): Promise<UnlistenFn> {
  return listen<UpdateReadyPayload>('arcane-update-ready', (event) => {
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
