/**
 * Plan FILE NAMING — pure, so it is testable under Bun.
 *
 * Split out of `plan-files.ts` because that module imports the workspace store
 * (for `openPlanInEditor`), which transitively reaches the theme store and
 * `document` — fatal under plain `bun test`. Same split as `compile-wait-core.ts`.
 *
 * Not to be confused with `markdown-preview/services/plan-paths.ts`, which
 * decides whether a path IS a plan; this decides what a new plan is called.
 */

import { invoke } from '@tauri-apps/api/core';

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
  return `${workspacePath}/.arcane/plans/${timestamp()}-${slugify(prompt)}.aplan`;
}

/** How many `-2`, `-3`… variants to try before falling back to a stamped name. */
const MAX_PLAN_PATH_VARIANTS = 99;

/**
 * The nth candidate for a plan path: n=1 is the base name, n>1 inserts `-n`
 * before the extension.
 */
export function planPathVariant(basePath: string, n: number): string {
  if (n <= 1) return basePath;
  const dot = basePath.lastIndexOf('.');
  return dot < 0 ? `${basePath}-${n}` : `${basePath.slice(0, dot)}-${n}${basePath.slice(dot)}`;
}

/**
 * Pick a plan path that is not already taken.
 *
 * The timestamp is minute-precision, so regenerating a plan within the same
 * minute (which is exactly what "Regenerate" invites) produced the SAME path
 * for the same prompt and silently overwrote the previous plan — along with
 * whatever execution progress its checkboxes recorded.
 */
export async function reservePlanPath(
  workspacePath: string,
  prompt: string,
  exists: (absPath: string) => Promise<boolean> = defaultExists,
): Promise<string> {
  const base = buildPlanPath(workspacePath, prompt);
  for (let n = 1; n <= MAX_PLAN_PATH_VARIANTS; n++) {
    const candidate = planPathVariant(base, n);
    if (!(await exists(candidate))) return candidate;
  }
  // Absurd case (99 regenerations of the same prompt inside one minute): take a
  // guaranteed-distinct name rather than clobbering the 99th.
  const dot = base.lastIndexOf('.');
  const stamp = `${Date.now()}`;
  return dot < 0 ? `${base}-${stamp}` : `${base.slice(0, dot)}-${stamp}${base.slice(dot)}`;
}

async function defaultExists(absPath: string): Promise<boolean> {
  return await invoke<boolean>('path_exists', { path: absPath });
}
