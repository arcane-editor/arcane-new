/**
 * Memory consolidation (spec §4 bloat control #2). When a category nears its
 * cap, one cheap side-task call proposes merges/deletions; this module
 * applies them. Runs fire-and-forget after distillation — a failed or
 * garbage consolidation reply changes nothing.
 */

import { loadEntries, upsertEntry, type Today } from './memory-store';
import { MEMORY_CAPS, MEMORY_CATEGORIES, memoryDir, type MemoryCategory, type MemoryEntry, type MemoryFs } from './memory-types';

/** Consolidate when a category crosses 80% of its cap. */
export const CONSOLIDATION_THRESHOLD = Math.floor(MEMORY_CAPS.perCategory * 0.8);

/** Bound the blast radius of one consolidation pass. */
const MAX_OPS = 10;

export interface ConsolidationPlan {
  merge: Array<{
    into: { category: MemoryCategory; title: string; body: string };
    remove: string[];
  }>;
  delete: string[];
}

export function buildConsolidationPrompt(category: MemoryCategory, entries: MemoryEntry[]): string {
  const listing = entries
    .map((e) => `- slug: ${e.slug} | timesUsed: ${e.timesUsed} | title: ${e.title} | body: ${e.body.replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n');
  return `You maintain a small per-project memory store for an AI Unity coding assistant.
The "${category}" category is near its size cap. Propose consolidation.

Reply with ONLY a JSON object:
{"merge": [{"into": {"category": "${category}", "title": "...", "body": "..."}, "remove": ["slugA", "slugB"]}], "delete": ["slugC"]}

Rules:
- "merge": combine near-duplicate or related entries into ONE rewritten entry; list every replaced slug in "remove".
- "delete": entries about finished one-off tasks or clearly stale facts.
- Prefer keeping high-timesUsed entries. When in doubt, do nothing — empty arrays are a valid answer.
- Never invent slugs not listed below.

Entries:
${listing}`;
}

/** Defensive parse of the model's reply. Unknown slugs are dropped. */
export function parseConsolidationPlan(reply: string, validSlugs: Set<string>): ConsolidationPlan | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { merge?: unknown; delete?: unknown };

  const plan: ConsolidationPlan = { merge: [], delete: [] };
  if (Array.isArray(obj.delete)) {
    plan.delete = obj.delete
      .filter((s): s is string => typeof s === 'string' && validSlugs.has(s))
      .slice(0, MAX_OPS);
  }
  if (Array.isArray(obj.merge)) {
    for (const m of obj.merge) {
      if (plan.merge.length >= MAX_OPS) break;
      if (typeof m !== 'object' || m === null) continue;
      const { into, remove } = m as Record<string, unknown>;
      if (typeof into !== 'object' || into === null || !Array.isArray(remove)) continue;
      const { category, title, body } = into as Record<string, unknown>;
      const removeSlugs = remove.filter(
        (s): s is string => typeof s === 'string' && validSlugs.has(s),
      );
      if (
        typeof category === 'string' &&
        (MEMORY_CATEGORIES as readonly string[]).includes(category) &&
        typeof title === 'string' &&
        title.trim() &&
        typeof body === 'string' &&
        body.trim() &&
        removeSlugs.length > 0
      ) {
        plan.merge.push({
          into: { category: category as MemoryCategory, title: title.trim(), body: body.trim() },
          remove: removeSlugs,
        });
      }
    }
  }
  if (plan.merge.length === 0 && plan.delete.length === 0) return null;
  return plan;
}

export async function applyConsolidationPlan(
  fs: MemoryFs,
  workspacePath: string,
  plan: ConsolidationPlan,
  today?: Today,
): Promise<void> {
  const dir = memoryDir(workspacePath);
  for (const slug of plan.delete) {
    try {
      await fs.remove(`${dir}/${slug}.md`);
    } catch {
      /* best-effort */
    }
  }
  for (const m of plan.merge) {
    for (const slug of m.remove) {
      try {
        await fs.remove(`${dir}/${slug}.md`);
      } catch {
        /* best-effort */
      }
    }
    try {
      await upsertEntry(fs, workspacePath, m.into, today);
    } catch {
      /* best-effort */
    }
  }
}

export interface ConsolidateDeps {
  fs: MemoryFs;
  workspacePath: string;
  request: (prompt: string) => Promise<string>;
  today?: Today;
}

/** Run consolidation for any category over the threshold. */
export async function maybeConsolidate(deps: ConsolidateDeps): Promise<void> {
  let entries: MemoryEntry[];
  try {
    entries = await loadEntries(deps.fs, deps.workspacePath);
  } catch {
    return;
  }
  for (const category of MEMORY_CATEGORIES) {
    const inCategory = entries.filter((e) => e.category === category);
    if (inCategory.length <= CONSOLIDATION_THRESHOLD) continue;
    try {
      const reply = await deps.request(buildConsolidationPrompt(category, inCategory));
      const plan = parseConsolidationPlan(reply, new Set(inCategory.map((e) => e.slug)));
      if (plan) await applyConsolidationPlan(deps.fs, deps.workspacePath, plan, deps.today);
    } catch {
      // side task — never propagate
    }
  }
}
