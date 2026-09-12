import { useUnityStore } from '../../../../stores/unity';

export { txt, cap, NOT_CONNECTED } from './text-result';

/** Whether a Unity bridge is currently connected (engine-backed tools need it). */
export function bridgeConnected(): boolean {
  return useUnityStore.getState().connected;
}
