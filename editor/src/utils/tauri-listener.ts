import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event';

export type UnlistenLike = (() => void | Promise<void>) | null | undefined;

/**
 * listen() scoped to the current window. Module-level listen() registers an
 * Any-target listener, which also receives emit_to() events aimed at OTHER
 * windows — with multi-window support that means cross-window crosstalk.
 * Scoped listeners receive global emit() events AND emit_to(ownLabel) only.
 */
export function listenScoped<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<T>(event, handler);
}

function isKnownTauriListenerRaceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    msg.includes("listeners[eventId].handlerId") ||
    /Cannot read (properties|property) of undefined.*handlerId/i.test(msg)
  );
}

export function safeUnlisten(unlisten: UnlistenLike): void {
  if (!unlisten) return;
  try {
    const out = unlisten();
    if (out && typeof (out as Promise<void>).then === 'function') {
      void (out as Promise<void>).catch((err) => {
        if (isKnownTauriListenerRaceError(err)) return;
        console.warn('[tauri] Failed to unlisten:', err);
      });
    }
  } catch (err) {
    if (isKnownTauriListenerRaceError(err)) return;
    console.warn('[tauri] Failed to unlisten:', err);
  }
}
