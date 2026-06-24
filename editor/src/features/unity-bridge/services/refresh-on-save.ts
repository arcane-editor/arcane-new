import { bridgeRpc } from './bridge-rpc';
import { useUnityStore } from '../../../stores/unity';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';

/**
 * After a successful in-IDE save of a C# file, ask the connected Unity Editor to
 * refresh its asset database (which triggers a recompile of the changed script).
 *
 * Fire-and-forget and fully gated — a no-op unless ALL of:
 *   • this is a Unity project,
 *   • a `.cs` file was saved,
 *   • the bridge is currently connected,
 *   • the `unity.bridge.refreshOnSave` setting is on.
 *
 * A rejection (bridge busy/disconnected) is swallowed: refresh-on-save is a
 * convenience, never a hard dependency.
 */
export function maybeRefreshUnityAfterSave(path: string): void {
  if (!path.toLowerCase().endsWith('.cs')) return;
  if (!useProjectContextStore.getState().isUnityProject) return;
  if (!useUnityStore.getState().connected) return;
  if (useSettingsStore.getState().getSetting('unity.bridge.refreshOnSave') !== true) return;
  void bridgeRpc.refreshAssets().catch(() => {
    /* bridge unavailable / busy — best-effort */
  });
}
