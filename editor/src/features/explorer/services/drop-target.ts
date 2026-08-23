/**
 * OS file drops onto the explorer tree — copies the dropped paths into the
 * directory they were dropped on.
 *
 * Hit-tests by hand rather than reading an event target, because Tauri handles
 * OS file drops natively (`dragDropEnabled` defaults to true) and the webview
 * never sees a DOM drop event — all we are given is a window coordinate. Same
 * constraint, and the same shape of solution, as `terminal/drop-target.ts`.
 */

import { invoke } from '@tauri-apps/api/core';
import { toCssPoint } from '../../../utils/drop-point';

const DROP_OVER_CLASS = 'tree-node--drop-over';
const ROOT_DROP_OVER_CLASS = 'sidebar-tree--drop-over';

export interface DropRow {
  path: string;
  isDir: boolean;
}

// Re-exported: this module's own callers and its test both import it from
// here, and the implementation now lives in `utils/` because the terminal and
// the AI panel need the same conversion. See `utils/drop-point.ts`.
export { toCssPoint };

/** The directory a drop on `row` should land in. */
export function targetDirFor(row: DropRow | null, treeRoot: string): string {
  if (!row) return treeRoot;
  if (row.isDir) return row.path;
  const idx = row.path.lastIndexOf('/');
  return idx > 0 ? row.path.slice(0, idx) : treeRoot;
}

/**
 * Candidate `<asset>.meta` paths for a set of dropped paths.
 *
 * A path that is itself a `.meta` is excluded: dragging one directly is
 * explicit, and `x.meta.meta` is not a thing.
 */
export function metaSiblingsOf(paths: string[]): string[] {
  return paths
    .filter((p) => !p.toLowerCase().endsWith('.meta'))
    .map((p) => `${p}.meta`);
}

/** Which tree row, if any, sits under a point in CSS pixels. */
function rowAtPoint(cssX: number, cssY: number): { row: DropRow; el: HTMLElement } | null {
  const rows = document.querySelectorAll<HTMLElement>('.tree-node[data-path]');
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    // Rows in a hidden sidebar measure empty and must never win a hit-test.
    if (r.width === 0 || r.height === 0) continue;
    if (cssX >= r.left && cssX <= r.right && cssY >= r.top && cssY <= r.bottom) {
      const path = el.dataset.path;
      if (!path) continue;
      return { row: { path, isDir: el.dataset.isDir === 'true' }, el };
    }
  }
  return null;
}

/** The tree container, when the sidebar is actually showing the explorer. */
function treeContainerAtPoint(cssX: number, cssY: number): HTMLElement | null {
  const el = document.querySelector<HTMLElement>('.sidebar-tree');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  if (cssX < r.left || cssX > r.right || cssY < r.top || cssY > r.bottom) return null;
  return el;
}

function clearHighlight(): void {
  document
    .querySelectorAll<HTMLElement>(`.${DROP_OVER_CLASS}, .${ROOT_DROP_OVER_CLASS}`)
    .forEach((el) => {
      el.classList.remove(DROP_OVER_CLASS);
      el.classList.remove(ROOT_DROP_OVER_CLASS);
    });
}

/** Highlights the row (or the whole tree) under the cursor during a drag. */
export function highlightExplorerDropTarget(position: { x: number; y: number }): void {
  const { x, y } = toCssPoint(position, window.devicePixelRatio);
  clearHighlight();

  const container = treeContainerAtPoint(x, y);
  if (!container) return;

  const hit = rowAtPoint(x, y);
  if (hit && hit.row.isDir) {
    hit.el.classList.add(DROP_OVER_CLASS);
  } else {
    // Over a file row or empty space: the copy lands in an enclosing folder,
    // so highlighting the whole tree tells the truth about where it goes.
    container.classList.add(ROOT_DROP_OVER_CLASS);
  }
}

export function clearExplorerDropTarget(): void {
  clearHighlight();
}

export interface ExplorerDropRequest {
  /** Directory the copies land in. */
  destDir: string;
  /** Paths to copy, `.meta` decision already applied. */
  paths: string[];
}

/**
 * Resolves a drop position to a copy request, or null when the point is not
 * over the explorer tree.
 *
 * Split from the copying itself so the caller can interpose the Unity `.meta`
 * prompt — which needs to know the paths — before anything touches disk.
 */
export function resolveExplorerDrop(
  position: { x: number; y: number },
  paths: string[],
  treeRoot: string,
): ExplorerDropRequest | null {
  if (paths.length === 0) return null;
  const { x, y } = toCssPoint(position, window.devicePixelRatio);
  if (!treeContainerAtPoint(x, y)) return null;
  const hit = rowAtPoint(x, y);
  return { destDir: targetDirFor(hit?.row ?? null, treeRoot), paths };
}

/**
 * The `<asset>.meta` paths that actually exist on disk for a set of drops.
 *
 * Returns the real list rather than a boolean so the caller can both size the
 * prompt ("3 files have .meta") and copy exactly those files — copying the
 * speculative candidates instead would produce a failure per asset that has no
 * `.meta`, which the caller would then have to filter back out.
 */
export async function existingMetaSiblings(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of metaSiblingsOf(paths)) {
    try {
      if (await invoke<boolean>('path_exists', { path: candidate })) found.push(candidate);
    } catch {
      // Probing failed — treat as absent rather than blocking the drop.
    }
  }
  return found;
}

/**
 * Copies `paths` into `destDir`, returning the paths actually written.
 *
 * Individual failures are collected rather than aborting the batch: a drop of
 * twenty files should not lose nineteen because one was unreadable.
 */
export async function copyIntoDir(
  destDir: string,
  paths: string[],
): Promise<{ copied: string[]; errors: string[] }> {
  const copied: string[] = [];
  const errors: string[] = [];

  // A `.meta` whose asset is also in this batch is skipped: `copy_path` carries
  // the sidecar with its asset, because only it knows the name the asset got
  // after collision handling. Copying them independently is what separated the
  // pair — the rename splits at the last dot, so `Player.cs` became
  // `Player 2.cs` while `Player.cs.meta` became `Player.cs 2.meta`, leaving the
  // copy with no meta and an orphan meta beside it.
  const assets = new Set(paths.map((p) => p.toLowerCase()));
  const toCopy = paths.filter((p) => {
    const lower = p.toLowerCase();
    if (!lower.endsWith('.meta')) return true;
    return !assets.has(lower.slice(0, -'.meta'.length));
  });

  for (const src of toCopy) {
    try {
      const written = await invoke<string>('copy_path', { src, destDir });
      copied.push(written);
    } catch (err) {
      const name = src.split('/').pop() ?? src;
      errors.push(`${name}: ${String(err)}`);
    }
  }

  return { copied, errors };
}
