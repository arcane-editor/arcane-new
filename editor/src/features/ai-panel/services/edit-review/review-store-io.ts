/**
 * Edit-review persistence (T6) — mirrors `checkpoints/checkpoint-store-io.ts`
 * exactly: one JSON file per session, this time at
 * `~/.unityide/reviews/<sessionId>.json`, written on whatever debounce cadence
 * the T7 review store schedules (this module stays synchronous-per-call,
 * same as the checkpoint io — debouncing is the STORE's job, not io's).
 *
 * GC note (mirrors checkpoint-store-io.ts's GC hook): when a session is
 * deleted, `deleteReviewsFile` should be called alongside
 * `deleteCheckpointsFile` from `session-persistence.ts`'s `deleteSession` —
 * wiring that is T7/T8's job, not this task's (nothing consumes this module
 * yet).
 *
 * `serializeReviews`/`parseReviews` are pure (no Tauri calls) so the
 * round-trip is directly Bun-testable without a Tauri runtime.
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir, join } from '@tauri-apps/api/path';
import type { PendingReviewEntry } from './review-core';

interface ReviewFileData {
  updatedAt: number;
  entries: Record<string, PendingReviewEntry>;
}

let reviewsDir: string | null = null;

async function ensureReviewsDirExists(path: string): Promise<void> {
  await invoke('create_directory_recursive', { path });
}

async function getReviewsDir(): Promise<string> {
  if (!reviewsDir) {
    const home = await homeDir();
    reviewsDir = await join(home, '.unityide', 'reviews');
    try {
      await ensureReviewsDirExists(reviewsDir);
    } catch (error) {
      console.warn('Failed to create reviews directory:', error);
    }
  }
  return reviewsDir;
}

/** Pure — no Tauri calls. */
export function serializeReviews(entries: Record<string, PendingReviewEntry>): string {
  const data: ReviewFileData = { updatedAt: Date.now(), entries };
  return JSON.stringify(data, null, 2);
}

/** Pure — no Tauri calls. Returns `{}` for malformed/legacy/foreign JSON. */
export function parseReviews(json: string): Record<string, PendingReviewEntry> {
  try {
    const data = JSON.parse(json) as Partial<ReviewFileData> | null;
    const entries = data?.entries;
    return entries !== null && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  } catch {
    return {};
  }
}

/** Saves the reviews JSON. Returns true on success, false if the write failed. */
export async function saveReviews(
  sessionId: string,
  entries: Record<string, PendingReviewEntry>,
): Promise<boolean> {
  const dir = await getReviewsDir();
  const filePath = `${dir}/${sessionId}.json`;
  const contents = serializeReviews(entries);

  try {
    await invoke('write_file', { path: filePath, contents });
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error ?? '');
    const missingDir = /No such file|os error 2|ENOENT/i.test(msg);
    if (missingDir) {
      try {
        await ensureReviewsDirExists(dir);
        await invoke('write_file', { path: filePath, contents });
        return true;
      } catch (retryError) {
        console.error('Failed to save reviews (retry):', retryError);
        return false;
      }
    }
    console.error('Failed to save reviews:', error);
    return false;
  }
}

export async function loadReviews(sessionId: string): Promise<Record<string, PendingReviewEntry>> {
  const dir = await getReviewsDir();
  const filePath = `${dir}/${sessionId}.json`;
  try {
    const content = await invoke<string>('read_file', { path: filePath });
    return parseReviews(content);
  } catch {
    return {};
  }
}

/** GC hook — call from `session-persistence.ts`'s `deleteSession` (T7/T8 wiring). Silently no-ops if there's no file. */
export async function deleteReviewsFile(sessionId: string): Promise<void> {
  const dir = await getReviewsDir();
  const filePath = `${dir}/${sessionId}.json`;
  try {
    await invoke('delete_path', { path: filePath });
  } catch {
    // no reviews for this session — fine
  }
}
