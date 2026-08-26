/**
 * Checkpoint persistence (P5.2) — mirrors `session-persistence.ts`: one JSON
 * file per session at `~/.unityide/checkpoints/<sessionId>.json`, written on
 * the debounce cadence `stores/checkpoints.ts` schedules.
 *
 * GC: when a session is deleted (`deleteSession` in `session-persistence.ts`),
 * it also deletes this file — the checkpoint-file sibling of `coDeleteMeta`
 * co-deleting a `.meta` file.
 *
 * `serializeCheckpoints`/`parseCheckpoints` are pure (no Tauri calls) so the
 * round-trip is directly Bun-testable without a Tauri runtime.
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir, join } from '@tauri-apps/api/path';
import type { CheckpointTurn } from './restore-plan';

interface CheckpointFileData {
  sessionId: string;
  updatedAt: number;
  turns: CheckpointTurn[];
}

let checkpointsDir: string | null = null;

async function ensureCheckpointsDirExists(path: string): Promise<void> {
  await invoke('create_directory_recursive', { path });
}

async function getCheckpointsDir(): Promise<string> {
  if (!checkpointsDir) {
    const home = await homeDir();
    checkpointsDir = await join(home, '.unityide', 'checkpoints');
    try {
      await ensureCheckpointsDirExists(checkpointsDir);
    } catch (error) {
      console.warn('Failed to create checkpoints directory:', error);
    }
  }
  return checkpointsDir;
}

/** Pure — no Tauri calls. */
export function serializeCheckpoints(sessionId: string, turns: CheckpointTurn[]): string {
  const data: CheckpointFileData = { sessionId, updatedAt: Date.now(), turns };
  return JSON.stringify(data, null, 2);
}

/** Pure — no Tauri calls. Returns `[]` for malformed/empty JSON. */
export function parseCheckpoints(json: string): CheckpointTurn[] {
  try {
    const data = JSON.parse(json) as CheckpointFileData;
    return Array.isArray(data?.turns) ? data.turns : [];
  } catch {
    return [];
  }
}

/** Saves the checkpoints JSON. Returns true on success, false if the write failed. */
export async function saveCheckpoints(sessionId: string, turns: CheckpointTurn[]): Promise<boolean> {
  const dir = await getCheckpointsDir();
  const filePath = `${dir}/${sessionId}.json`;
  const contents = serializeCheckpoints(sessionId, turns);

  try {
    await invoke('write_file', { path: filePath, contents });
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error ?? '');
    const missingDir = /No such file|os error 2|ENOENT/i.test(msg);
    if (missingDir) {
      try {
        await ensureCheckpointsDirExists(dir);
        await invoke('write_file', { path: filePath, contents });
        return true;
      } catch (retryError) {
        console.error('Failed to save checkpoints (retry):', retryError);
        return false;
      }
    }
    console.error('Failed to save checkpoints:', error);
    return false;
  }
}

export async function loadCheckpoints(sessionId: string): Promise<CheckpointTurn[]> {
  const dir = await getCheckpointsDir();
  const filePath = `${dir}/${sessionId}.json`;
  try {
    const content = await invoke<string>('read_file', { path: filePath });
    return parseCheckpoints(content);
  } catch {
    return [];
  }
}

/** GC hook — called from `session-persistence.ts`'s `deleteSession`. Silently no-ops if there's no file. */
export async function deleteCheckpointsFile(sessionId: string): Promise<void> {
  const dir = await getCheckpointsDir();
  const filePath = `${dir}/${sessionId}.json`;
  try {
    await invoke('delete_path', { path: filePath });
  } catch {
    // no checkpoints for this session — fine
  }
}
