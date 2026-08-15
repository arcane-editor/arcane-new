/**
 * Synchronous memory-digest cache — the bridge between the async file-backed
 * store and the synchronous prompt builder (same shape as unity-facts.ts's
 * facts cache). Primed at workspace open and re-primed after distillation;
 * `getMemoryDigestSync` never blocks the prompt build.
 */

import { loadEntries, buildMemoryDigest } from './memory-store';
import { tauriMemoryFs } from './tauri-memory-fs';
import type { MemoryFs } from './memory-types';
import { useWorkspaceStore } from '../../../../stores/workspace';

/** Digest char budget inside the context pack (~700 tokens). */
export const MEMORY_DIGEST_MAX_CHARS = 2800;

let cachedWorkspace: string | null = null;
let cachedDigest: string | null = null;
let priming: string | null = null;

export async function primeMemory(
  workspacePath: string,
  fs: MemoryFs = tauriMemoryFs,
): Promise<void> {
  if (!workspacePath || workspacePath === '/' || priming === workspacePath) return;
  priming = workspacePath;
  try {
    const entries = await loadEntries(fs, workspacePath);
    cachedWorkspace = workspacePath;
    cachedDigest = buildMemoryDigest(entries, MEMORY_DIGEST_MAX_CHARS);
  } catch {
    cachedWorkspace = workspacePath;
    cachedDigest = null;
  } finally {
    priming = null;
  }
}

/**
 * The current workspace's digest, or null when cold (a background prime is
 * kicked off so the NEXT conversation gets it).
 */
export function getMemoryDigestSync(workspacePath: string): string | null {
  if (!workspacePath || workspacePath === '/') return null;
  if (cachedWorkspace === workspacePath) return cachedDigest;
  void primeMemory(workspacePath);
  return null;
}

/** Test seam. */
export function resetMemoryCache(): void {
  cachedWorkspace = null;
  cachedDigest = null;
  priming = null;
}

// Keep the cache warm: prime whenever a workspace becomes active (same
// deferred-subscription pattern as unity-facts.ts — see its comment on TDZ
// safety), and immediately for a workspace already open at module load.
queueMicrotask(() => {
  useWorkspaceStore.subscribe((state) => {
    if (state.workspacePath) void primeMemory(state.workspacePath);
  });
  const wp = useWorkspaceStore.getState().workspacePath;
  if (wp) void primeMemory(wp);
});
