import { Search, Settings, Loader2 } from 'lucide-react';
import { isMac } from '../../../utils/platform';
import Tooltip from '../../../components/Tooltip';
import WindowControls from './WindowControls';
import { useAuthStore } from '../../../stores/auth';
import { useCommandsStore } from '../../../stores/commands';
import { useUnityStore } from '../../../stores/unity';
import { useProjectContextStore } from '../../../stores/project-context';
import { UnityPlayControls } from '../../unity-toolbar';

function TitleBar() {
  const authEmail = useAuthStore((s) => s.email);
  const authLoggedIn = useAuthStore((s) => s.loggedIn);
  const unityConnected = useUnityStore((s) => s.connected);
  const unityCompiling = useUnityStore((s) => s.isCompiling);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  // Compiling outranks the link state: while Unity is rebuilding, "connected"
  // is true but nothing you press will do anything, so the segment says why.
  const status = unityCompiling
    ? { key: 'compiling', label: 'Compiling' }
    : unityConnected
      ? { key: 'connected', label: 'Connected' }
      : { key: 'disconnected', label: 'Disconnected' };

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar-left" data-tauri-drag-region>
        <span className="title-bar-app-name" data-tauri-drag-region>UNITYIDE</span>
      </div>
      <div className="title-bar-center" data-tauri-drag-region>
        {isUnityProject && (
          /* Transport and link state are one instrument, not two widgets that
             happen to sit near each other — the buttons are meaningless
             without the state and the state is unactionable without them. */
          <div className="unity-deck" data-status={status.key}>
            <UnityPlayControls />
            <span className="unity-deck__divider" aria-hidden="true" />
            <Tooltip
              label={unityCompiling ? 'Unity is compiling' : unityConnected ? 'Unity bridge connected' : 'Unity bridge disconnected'}
              side="bottom"
            >
              <div className="unity-deck__status" role="status">
                {unityCompiling
                  ? <Loader2 size={11} className="unity-deck__spinner" aria-hidden="true" />
                  : <span className="unity-deck__dot" aria-hidden="true" />}
                <span className="unity-deck__status-label">{status.label}</span>
              </div>
            </Tooltip>
          </div>
        )}
      </div>
      <div className="title-bar-right" data-tauri-drag-region>
        <Tooltip label="Quick Open" commandId="palette.quickOpen" side="bottom">
          <button
            className="title-bar-btn"
            aria-label="Quick Open"
            onClick={() => useCommandsStore.getState().executeCommand('palette.quickOpen')}
          >
            <Search size={15} />
          </button>
        </Tooltip>
        <Tooltip label="Settings" commandId="settings.open" side="bottom">
          <button
            className="title-bar-btn"
            aria-label="Settings"
            onClick={() => useCommandsStore.getState().executeCommand('settings.open')}
          >
            <Settings size={15} />
          </button>
        </Tooltip>
        <span className="title-bar-divider" aria-hidden="true" />
        {authLoggedIn ? (
          <Tooltip label={authEmail ? `Signed in as ${authEmail}` : 'Signed in'} side="bottom">
            <button
              className="title-bar-avatar"
              aria-label={authEmail ? `Account: ${authEmail}` : 'Account'}
              onClick={() => useCommandsStore.getState().executeCommand('auth.account')}
            >
              {authEmail ? authEmail.charAt(0).toUpperCase() : '·'}
            </button>
          </Tooltip>
        ) : (
          <button
            className="title-bar-signin"
            onClick={() => useCommandsStore.getState().executeCommand('auth.account')}
          >
            Sign in
          </button>
        )}
        {/* macOS overlays its own traffic lights; everywhere else decorations
            are off, so the window owes the user these. */}
        {!isMac() && <WindowControls />}
      </div>
    </div>
  );
}

export default TitleBar;
