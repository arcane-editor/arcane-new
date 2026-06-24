import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useNotificationsStore } from '../../../stores/notifications';
import { installBridge, BRIDGE_DOCS_URL } from '../services/bridge-installer';

/**
 * Non-nagging banner shown in Unity panels (console, hierarchy) when the bridge
 * isn't connected. Offers a one-click install + docs. Renders nothing when the
 * bridge is connected, so it stays out of the way once things work.
 */
export function BridgeInstallBanner() {
  const bridgeState = useUnityStore((s) => s.bridgeState);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const refreshBridgeInstalled = useUnityStore((s) => s.refreshBridgeInstalled);
  const notify = useNotificationsStore((s) => s.addNotification);
  const [installing, setInstalling] = useState(false);

  if (bridgeState === 'connected') return null;

  const isReloading = bridgeState === 'reloading';
  const notInstalled = bridgeState === 'not-installed';

  const label = isReloading
    ? 'Unity reloading…'
    : notInstalled
      ? 'Unity Editor not connected — bridge not installed'
      : 'Unity Editor not connected';

  const handleInstall = async () => {
    if (!workspacePath) return;
    setInstalling(true);
    try {
      await installBridge(workspacePath);
      await refreshBridgeInstalled(workspacePath);
      notify({
        type: 'info',
        message: 'Bridge installed. Refocus Unity to import it and connect.',
      });
    } catch (err) {
      notify({ type: 'error', message: `Bridge install failed: ${String(err)}` });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="unity-bridge-banner">
      <span className="unity-bridge-banner__label">{label}</span>
      {notInstalled && (
        <button
          className="unity-bridge-banner__action"
          onClick={handleInstall}
          disabled={installing || !workspacePath}
        >
          {installing ? 'Installing…' : 'Install bridge'}
        </button>
      )}
      <button
        className="unity-bridge-banner__action unity-bridge-banner__action--ghost"
        onClick={() => void openUrl(BRIDGE_DOCS_URL)}
      >
        Docs
      </button>
    </div>
  );
}
