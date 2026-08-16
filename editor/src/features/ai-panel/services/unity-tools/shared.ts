import { useUnityStore } from '../../../../stores/unity';

export { txt, cap } from './text-result';

/** Whether a Unity bridge is currently connected (engine-backed tools need it). */
export function bridgeConnected(): boolean {
  return useUnityStore.getState().connected;
}

export const NOT_CONNECTED =
  'Unity bridge not connected — this needs a running Unity Editor with the Arcane bridge installed. ' +
  'If Unity is running, the connection drops briefly during every script recompile/domain reload and ' +
  'reconnects automatically — do any remaining file creation/editing first, then retry this. ' +
  'The IDE can still read project files statically with the read/list tools.';
