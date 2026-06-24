import type { AgentToolResult } from '../vendor/types';
import { useUnityStore } from '../../../../stores/unity';

/** Wrap a string as a text tool result. */
export function txt(s: string): AgentToolResult {
  return { content: [{ type: 'text', text: s }] };
}

/** Whether a Unity bridge is currently connected (engine-backed tools need it). */
export function bridgeConnected(): boolean {
  return useUnityStore.getState().connected;
}

export const NOT_CONNECTED =
  'Unity bridge not connected — this needs a running Unity Editor with the Arcane bridge installed. ' +
  'The IDE can still read project files statically with the read/list tools.';

/** Best-effort string-cap so a tool result never floods the context. */
export function cap(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + `\n…(${s.length - max} more chars truncated)` : s;
}
