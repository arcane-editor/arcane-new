/**
 * Plan file persistence — plans live under
 * `<workspace>/.unityide/plans/<YYYYMMDD-HHmm>-<slug>.aplan`.
 *
 * `.aplan` content is markdown; the extension exists so the editor can tell a
 * plan from a document by name and give it the step view (`plan-paths.ts`).
 *
 * The plan file is the source of truth: planning writes it, the user edits it
 * in place in the plan view, execution re-reads it from disk so any user edits
 * are honored.
 */

import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';

// Naming lives in a store-free module so it can be unit-tested under Bun;
// re-exported here so callers keep one import site.
export {
  slugify,
  buildPlanPath,
  planPathVariant,
  reservePlanPath,
} from './plan-file-paths';

export async function writePlan(absPath: string, markdown: string): Promise<void> {
  // Ensure .unityide/plans/ exists.
  const dir = absPath.slice(0, absPath.lastIndexOf('/'));
  await invoke('create_directory_recursive', { path: dir });
  await invoke('write_file', { path: absPath, contents: markdown });
}

export async function readPlan(absPath: string): Promise<string> {
  return await invoke<string>('read_file', { path: absPath });
}

/** Open the plan file in an editor tab (the plan view renders it). */
export function openPlanInEditor(absPath: string): void {
  const name = absPath.split('/').pop() ?? 'plan.aplan';
  useWorkspaceStore.getState().openFile(absPath, name);
}
