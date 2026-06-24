/**
 * Plan file persistence — markdown plans live under
 * `<workspace>/.arcane/plans/<YYYYMMDD-HHmm>-<slug>.md`.
 *
 * The plan file is the source of truth: planning writes it, the user can
 * edit it in Monaco, execution re-reads it from disk so any user edits are
 * honored.
 */

import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';

/** Convert a free-form prompt into a kebab-case slug, max 40 chars. */
export function slugify(prompt: string): string {
  const cleaned = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return cleaned || 'plan';
}

/** Build a YYYYMMDD-HHmm timestamp in local time. */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function buildPlanPath(workspacePath: string, prompt: string): string {
  return `${workspacePath}/.arcane/plans/${timestamp()}-${slugify(prompt)}.md`;
}

export async function writePlan(absPath: string, markdown: string): Promise<void> {
  // Ensure .arcane/plans/ exists.
  const dir = absPath.slice(0, absPath.lastIndexOf('/'));
  await invoke('create_directory_recursive', { path: dir });
  await invoke('write_file', { path: absPath, contents: markdown });
}

export async function readPlan(absPath: string): Promise<string> {
  return await invoke<string>('read_file', { path: absPath });
}

/** Open the plan file in a Monaco tab. */
export function openPlanInEditor(absPath: string): void {
  const name = absPath.split('/').pop() ?? 'plan.md';
  useWorkspaceStore.getState().openFile(absPath, name);
}
