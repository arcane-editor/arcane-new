// Project-wide index of what the C# does to each UI Toolkit element.
//
// The scan is the same two invokes every other Unity snapshot in this codebase
// uses (`inputactions-cache.ts`, `input-assets.ts`): enumerate, bulk-read,
// parse. The parsing half is `utils/uxml-usage.ts` and is pure.
//
// No store imports: `stores/unity-index` reaches `stores/theme`, which touches
// `document` at module scope and takes the Bun suite down on import alone.

import { invoke } from '@tauri-apps/api/core';
import { findElementUsages, type ElementUsage } from '../../../utils/uxml-usage';

export interface UsageIndex {
  /** Element name -> everything the project does with it. */
  byElement: Map<string, ElementUsage[]>;
  scannedFiles: number;
  /** False until a scan has completed — the inspector shows "scanning", not "none". */
  loaded: boolean;
}

export const EMPTY_USAGE_INDEX: UsageIndex = {
  byElement: new Map(),
  scannedFiles: 0,
  loaded: false,
};

const SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];
const CHUNK = 300;

interface RawFile {
  path: string;
  content: string;
}

/** Pure: build the index from already-read files. */
export function buildUsageIndex(
  files: readonly RawFile[],
  names: readonly string[],
  blank: (text: string) => string,
): UsageIndex {
  const byElement = new Map<string, ElementUsage[]>();
  for (const file of files) {
    // Cheap gate: a file that never says `.Q` cannot reach an element by name,
    // and blanking every file in a large project is the expensive part.
    if (!file.content.includes('.Q')) continue;
    for (const usage of findElementUsages(file.path, blank(file.content), file.content, names)) {
      const list = byElement.get(usage.elementName);
      if (list) list.push(usage);
      else byElement.set(usage.elementName, [usage]);
    }
  }
  return { byElement, scannedFiles: files.length, loaded: true };
}

/**
 * Scan the project's C# for what it does with `names`.
 *
 * Returns the empty index on any failure rather than throwing: the inspector
 * showing "nothing found" is a survivable degradation, a crashed preview is not.
 */
export async function loadUsageIndex(
  workspacePath: string | null,
  names: readonly string[],
  blank: (text: string) => string,
): Promise<UsageIndex> {
  if (!workspacePath || names.length === 0) return EMPTY_USAGE_INDEX;

  let paths: string[];
  try {
    paths = await invoke<string[]>('scan_all_files_v2', {
      workspacePath,
      extraExcludes: SCAN_EXCLUDES,
    });
  } catch {
    return EMPTY_USAGE_INDEX;
  }

  const csharp = paths.filter((p) => p.endsWith('.cs'));
  const byElement = new Map<string, ElementUsage[]>();
  let scannedFiles = 0;

  for (let i = 0; i < csharp.length; i += CHUNK) {
    let files: RawFile[];
    try {
      files = await invoke<RawFile[]>('read_files_bulk', { paths: csharp.slice(i, i + CHUNK) });
    } catch {
      continue;
    }
    const partial = buildUsageIndex(files, names, blank);
    scannedFiles += partial.scannedFiles;
    for (const [name, list] of partial.byElement) {
      const existing = byElement.get(name);
      if (existing) existing.push(...list);
      else byElement.set(name, list);
    }
    // Yield between chunks so a large project does not freeze the panel.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { byElement, scannedFiles, loaded: true };
}
