// What "Clear here and in Unity" actually did, as one line the panel can show.
//
// `clearLogs({ unity: true })` always empties this IDE's ring and returns
// whether Unity's own console went with it — the bridge may be gone, the
// installed package may predate the RPC, or Unity may refuse. The panel used
// to discard that answer entirely (`void clearLogs({ unity: true })`), so the
// rows vanished and the menu item read as though both consoles had been
// cleared while Unity's was untouched: a degraded path rendering as success
// (Global Constraint 2).
//
// Pure and store-free so it is directly Bun-testable, same discipline as
// `console-check.ts`'s row copy.

export interface ClearLogsOutcome {
  clearedUnity: boolean;
  /** Why Unity's console was not cleared — already a full sentence from `stores/unity.ts`. */
  unityReason?: string;
}

/**
 * The notice to show after a clear, or `null` when there is nothing to say.
 *
 * `null` on success: the emptied panel is its own confirmation, and a banner
 * saying so would be noise on the common path.
 */
export function describeClearOutcome(outcome: ClearLogsOutcome): string | null {
  if (outcome.clearedUnity) return null;
  // The store's reasons are already written as "Unity's console was not
  // cleared: …". A refusal relayed verbatim from Unity may not be, so the
  // fallback carries the fact itself rather than assuming the wording.
  return outcome.unityReason ?? "Unity's console was not cleared.";
}
