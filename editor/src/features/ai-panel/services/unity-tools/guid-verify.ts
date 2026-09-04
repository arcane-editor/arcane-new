// A small in-memory registry of GUIDs `unity_ui_write` allocated this send.
//
// `unity_ui_write` assigns a `.uxml`/`.uss` its GUID itself (`meta-guid.ts`)
// so `<Style src>` and `unity_attach_ui_document` can resolve it the same
// turn, ahead of Unity ever importing the file. Task 15's verifier is what
// closes the loop: once Unity HAS imported it, confirm the GUID it assigned
// matches the one this module handed out (Unity reassigns on collision, per
// `meta-guid.ts`'s header — rare, but a written `<Style src>` or attach call
// would silently point at nothing if it happened and nobody checked).
//
// Pure and store/RPC-free by design, mirroring the other small per-send
// registries in this codebase (`test-run-registry.ts`, `markConsoleTurnStart`).

let pending = new Map<string, string>(); // path -> guid

/** Record a GUID `unity_ui_write` just allocated (or reused) for `path`. */
export function registerPendingGuidCheck(path: string, guid: string): void {
  pending.set(path, guid);
}

/** Drain and return every path/guid pair recorded since the last take/reset. */
export function takePendingGuidChecks(): Array<{ path: string; guid: string }> {
  const out = [...pending].map(([path, guid]) => ({ path, guid }));
  pending.clear();
  return out;
}

/** Clear the registry. Call at the start of every send, next to `resetTestRunRegistry()`. */
export function resetPendingGuidChecks(): void {
  pending.clear();
}
