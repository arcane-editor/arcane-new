export type UnlistenLike = (() => void | Promise<void>) | null | undefined;

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
