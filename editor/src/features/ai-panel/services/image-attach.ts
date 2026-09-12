/**
 * Staging an image as chat context, from any of the three ways one arrives.
 *
 * Extracted out of `ImageAttachButton` when the design dock needed the same
 * thing: a picker, a paste and an OS drop all have to produce a byte-identical
 * `Attachment`, and two copies of "read the file, cap it at 4MB, guess the mime
 * from the extension, base64 it" is two places for those to drift apart.
 *
 * Errors are RETURNED, not thrown and not surfaced here. Each caller shows
 * problems where its own user is looking — the panel has a banner, the dock has
 * a line under its composer — and a service that reached for one of them would
 * be wrong in the other.
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import type { Attachment } from './types';
import { encodeImageFromBlob } from './attachments';

export type ImageAttachment = Extract<Attachment, { kind: 'image' }>;

/** Past this an image costs more of the context window than it is worth. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Extensions the picker offers and the drop path accepts. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] as const;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** True when a path looks like an image this can stage. Used to filter an OS drop. */
export function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext in MIME_BY_EXT;
}

export function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'image/png';
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function newId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface StagedImages {
  attachments: ImageAttachment[];
  /** One line per image that could not be staged, already phrased for a user. */
  errors: string[];
}

/** Encode one in-memory blob — the paste and clipboard paths. */
export async function imageFromBlob(blob: Blob, sourceLabel: string): Promise<ImageAttachment> {
  const { dataUrl, mimeType } = await encodeImageFromBlob(blob);
  return { kind: 'image', id: newId(), dataUrl, mimeType, sourceLabel };
}

/**
 * Read image files off disk and encode them.
 *
 * Skips — rather than fails on — an oversized or unreadable file, so one bad
 * image in a multi-select does not lose the others.
 */
export async function imagesFromPaths(paths: readonly string[]): Promise<StagedImages> {
  const attachments: ImageAttachment[] = [];
  const errors: string[] = [];

  for (const path of paths) {
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        errors.push(`${basename(path)} is over 4MB and was skipped.`);
        continue;
      }
      const mimeType = mimeForPath(path);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      attachments.push(await imageFromBlob(blob, basename(path)));
    } catch (err) {
      errors.push(`Could not read ${basename(path)}: ${String(err)}`);
    }
  }

  return { attachments, errors };
}

/** Open the native picker and stage whatever comes back. Empty when cancelled. */
export async function pickImages(): Promise<StagedImages> {
  let selected: string | string[] | null;
  try {
    selected = await openDialog({
      multiple: true,
      filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }],
    });
  } catch (err) {
    return { attachments: [], errors: [`Could not open the file picker: ${String(err)}`] };
  }
  if (!selected) return { attachments: [], errors: [] };
  return imagesFromPaths(Array.isArray(selected) ? selected : [selected]);
}

/**
 * Images on a clipboard payload, if any.
 *
 * Returns the blobs rather than attachments so the caller decides the label —
 * a pasted image has no filename, and what to call it is a UI question.
 */
export function imageBlobsFromClipboard(data: DataTransfer | null): Blob[] {
  if (!data) return [];
  const out: Blob[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}
