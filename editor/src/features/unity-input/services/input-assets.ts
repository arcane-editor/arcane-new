/**
 * Finding the `.inputactions` assets in a project.
 *
 * Separate from `inputactions-model.ts` because that module is pure and this
 * one talks to disk; keeping the split means the model stays testable without
 * a Tauri mock.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  parseInputActions,
  listActions,
  findBindingConflicts,
  type BindingConflict,
} from '../../../utils/inputactions-model';

/** Unity noise that can never hold a project-authored asset. */
const SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];

export interface InputAssetSummary {
  path: string;
  name: string;
  mapCount: number;
  actionCount: number;
  conflicts: BindingConflict[];
  /** Set when the file exists but could not be parsed. */
  error: string | null;
}

interface FileContent {
  path: string;
  content: string;
}

/**
 * Every `.inputactions` asset in the workspace, already parsed and checked.
 *
 * Best-effort throughout: a failed walk yields an empty list and an unparseable
 * asset comes back with `error` set rather than being dropped, because a file
 * the user can see in the explorer but not in this panel reads as a bug.
 */
export async function listInputActionAssets(
  workspacePath: string,
): Promise<InputAssetSummary[]> {
  let paths: string[];
  try {
    paths = await invoke<string[]>('scan_all_files_v2', {
      workspacePath,
      extraExcludes: SCAN_EXCLUDES,
    });
  } catch {
    return [];
  }

  const assetPaths = paths.filter((p) => p.toLowerCase().endsWith('.inputactions'));
  if (assetPaths.length === 0) return [];

  let files: FileContent[];
  try {
    files = await invoke<FileContent[]>('read_files_bulk', { paths: assetPaths });
  } catch {
    return [];
  }

  return files
    .map((file) => {
      const parsed = parseInputActions(file.content);
      return {
        path: file.path,
        name: file.path.split('/').pop() ?? file.path,
        mapCount: parsed.doc?.maps.length ?? 0,
        actionCount: parsed.doc ? listActions(parsed.doc).length : 0,
        conflicts: parsed.doc ? findBindingConflicts(parsed.doc) : [],
        error: parsed.error,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
