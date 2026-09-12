import { ArrowUp } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import Tooltip from '../../../components/Tooltip';
import { useUpdatesStore } from '../../../stores/updates';
import { updateReadyMessage } from '../services/update-notice';

/**
 * The staged-update control in the title bar.
 *
 * Renders nothing until an update is staged, which is most of the app's life —
 * this is a state that arrives, not a permanent control, and a dimmed
 * "check for updates" button sitting there forever would cost every user
 * attention for an event that happens monthly.
 *
 * The label names the action, not the state: clicking restarts. "Update" alone
 * would suggest the download starts on click, and on macOS it has already
 * finished. The tooltip carries the version and the platform difference, and
 * comes from `updateReadyMessage` — the same function the toast uses, so the
 * two surfaces cannot drift into disagreeing about what is about to happen.
 */
function UpdateButton() {
  const pending = useUpdatesStore((s) => s.pending);
  if (!pending) return null;

  return (
    <Tooltip label={updateReadyMessage(pending)} side="bottom">
      <button
        className="titlebar-update"
        onClick={() => {
          // Rejection is not worth surfacing: on Windows the process is
          // terminated by the installer mid-call, so the promise never settles
          // in the success case either.
          invoke('updates_apply_and_restart').catch(() => {});
        }}
      >
        <ArrowUp size={12} strokeWidth={2.5} className="titlebar-update__glyph" aria-hidden="true" />
        <span className="titlebar-update__label">Restart to update</span>
      </button>
    </Tooltip>
  );
}

export default UpdateButton;
