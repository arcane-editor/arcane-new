import { Search, Settings } from 'lucide-react';
import { formatKeybinding } from '../../../utils/format-keybinding';
import { isMac } from '../../../utils/platform';
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
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  // Read the chords out of the registry rather than writing them here: these
  // two said "Cmd+P" / "Cmd+," verbatim on Windows and Linux.
  const quickOpenChord = useCommandsStore((s) => s.commands.get('palette.quickOpen')?.keybinding);
  const settingsChord = useCommandsStore((s) => s.commands.get('settings.open')?.keybinding);

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar-left" data-tauri-drag-region>
        <span className="title-bar-app-name" data-tauri-drag-region>ARCANE</span>
      </div>
      <div className="title-bar-center" data-tauri-drag-region>
        {isUnityProject && (
          <>
            <UnityPlayControls />
            <div className="title-bar-connection" data-tauri-drag-region>
              <span className={`connection-dot ${unityConnected ? 'connected' : 'disconnected'}`} />
              <span className="connection-label" data-tauri-drag-region>{unityConnected ? 'CONNECTED' : 'DISCONNECTED'}</span>
            </div>
          </>
        )}
      </div>
      <div className="title-bar-right" data-tauri-drag-region>
        <button
          className="title-bar-btn"
          title={quickOpenChord ? `Quick Open (${formatKeybinding(quickOpenChord)})` : 'Quick Open'}
          onClick={() => useCommandsStore.getState().executeCommand('palette.quickOpen')}
        >
          <Search size={16} />
        </button>
        <button
          className="title-bar-btn"
          title={settingsChord ? `Settings (${formatKeybinding(settingsChord)})` : 'Settings'}
          onClick={() => useCommandsStore.getState().executeCommand('settings.open')}
        >
          <Settings size={16} />
        </button>
        {authLoggedIn ? (
          <button
            className="title-bar-avatar"
            title={authEmail ? `Signed in as ${authEmail}` : 'Signed in'}
            onClick={() => useCommandsStore.getState().executeCommand('auth.account')}
          >
            {authEmail ? authEmail.charAt(0).toUpperCase() : '·'}
          </button>
        ) : (
          <button
            className="title-bar-signin"
            title="Sign in to Arcane"
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
