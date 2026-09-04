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

import { extractGuidFromMeta } from './meta-guid';

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

// ── Post-import verification (Task 15, `unity_ui_layout`) ──────────────────

export type GuidCheckOutcome =
  /** Unity kept the GUID this session assigned. */
  | { kind: 'match' }
  /** Unity assigned a different one -- a collision it resolved on import (`meta-guid.ts`'s header). */
  | { kind: 'mismatched'; actual: string }
  /** The `.meta` exists but carries no readable `guid:` line. */
  | { kind: 'unreadable' };

/**
 * Compare an allocated GUID against the `.meta` Unity actually wrote for that
 * asset. Pure: `metaText` is already read off disk by the caller (`readFile`
 * is an I/O concern the tool owns, per this module's DI-free-by-design
 * header); a missing `.meta` altogether (Unity has not imported the asset
 * yet) is the caller's concern too, since there is no text to compare here.
 */
export function compareMetaGuid(expected: string, metaText: string): GuidCheckOutcome {
  const actual = extractGuidFromMeta(metaText);
  if (actual === null) return { kind: 'unreadable' };
  if (actual === expected.toLowerCase()) return { kind: 'match' };
  return { kind: 'mismatched', actual };
}
