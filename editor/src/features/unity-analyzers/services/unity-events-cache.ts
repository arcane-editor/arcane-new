// Per-C#-file snapshot of the `UnityEvent` listeners wired to that script.
//
// The Rust side already does the hard half: `unity_method_usages(workspace,
// guid)` walks the reverse index, opens only the assets that mention the guid,
// and resolves each persistent call back to its owning GameObject. This module
// is the synchronous front for it, because analyzer rules cannot await.
//
// **On the ambiguity of an empty result.** `unity_method_usages` returns `[]`
// both when nothing wires the script and when the index is cold. That would
// matter if we ever reported "nothing references this" — we do not. An empty
// list yields zero findings either way, so the ambiguity is harmless here, and
// `trustworthy` records only the cases we genuinely could not read.
//
// Imports `invoke` and nothing else: no stores, so the rule that reads it stays
// loadable under Bun's DOM-less test runtime.

import { invoke } from '@tauri-apps/api/core';

export interface MethodUsage {
  methodName: string;
  path: string;
  gameObject: string | null;
  targetType: string | null;
}

export interface ListenerSnapshot {
  filePath: string;
  guid: string | null;
  usages: MethodUsage[];
  /** False when the `.meta` or the index could not be read at all. */
  trustworthy: boolean;
}

const snapshots = new Map<string, ListenerSnapshot>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let workspacePath: string | null = null;

/** Notified when a snapshot lands, so the engine can re-run its rules. */
export function onListenersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // One bad subscriber must not stop the others.
    }
  }
}

/** Point the cache at a workspace. Clears everything when it changes. */
export function setListenerWorkspace(path: string | null): void {
  if (path === workspacePath) return;
  workspacePath = path;
  snapshots.clear();
  inFlight.clear();
}

/** Drop every snapshot — call when the Unity index rebuilds or takes a delta. */
export function dropAllListenerSnapshots(): void {
  snapshots.clear();
  inFlight.clear();
}

const GUID_RE = /guid:\s*([0-9a-fA-F]{32})/;

/**
 * The snapshot for a file, or null if it is not loaded yet.
 *
 * A miss starts a background load and returns null. The rule then reports
 * nothing this pass, and `onListenersChanged` re-runs it when the answer
 * arrives — the same shape `usage-codelens.ts` uses for the same reason.
 */
export function getListenerSnapshot(filePath: string): ListenerSnapshot | null {
  const hit = snapshots.get(filePath);
  if (hit) return hit;
  if (workspacePath && !inFlight.has(filePath)) void warmListeners(filePath);
  return null;
}

async function warmListeners(filePath: string): Promise<void> {
  const workspace = workspacePath;
  if (!workspace) return;

  const task = (async () => {
    let snapshot: ListenerSnapshot = {
      filePath,
      guid: null,
      usages: [],
      trustworthy: false,
    };
    try {
      const meta = await invoke<string>('read_file', { path: `${filePath}.meta` });
      const guid = GUID_RE.exec(meta)?.[1]?.toLowerCase() ?? null;
      if (guid) {
        const usages = await invoke<MethodUsage[]>('unity_method_usages', {
          workspacePath: workspace,
          guid,
        });
        snapshot = { filePath, guid, usages, trustworthy: true };
      }
    } catch {
      // A script with no `.meta` (outside Assets/, or not yet imported) is not
      // an error — it simply cannot be wired to anything, so stay untrusted and
      // silent rather than guessing.
    } finally {
      inFlight.delete(filePath);
    }
    if (workspacePath !== workspace) return;
    snapshots.set(filePath, snapshot);
    if (snapshot.usages.length > 0) notify();
  })();

  inFlight.set(filePath, task);
  return task;
}

/** Test seam — set a snapshot without touching Tauri. */
export function __setListenerSnapshotForTest(snapshot: ListenerSnapshot | null): void {
  if (!snapshot) {
    snapshots.clear();
    workspacePath = null;
    return;
  }
  workspacePath = 'test';
  snapshots.set(snapshot.filePath, snapshot);
}
