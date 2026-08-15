/**
 * Per-project AI memory store (spec §4) — load/upsert/search/digest over
 * markdown files with frontmatter. All functions take an injected `MemoryFs`
 * so the logic stays pure and Bun-testable.
 *
 * Bloat control on the write path:
 *   - dedupe-before-write: a candidate matching an existing entry's title
 *     (normalized-exact or strong keyword overlap) UPDATES that entry and
 *     bumps its salience instead of creating a duplicate;
 *   - per-category cap: at the cap, a new entry may only replace an incumbent
 *     that was never recalled (timesUsed <= 1, oldest lastUsed first) —
 *     otherwise the candidate is rejected. The store never silently grows.
 */

import {
  MEMORY_CAPS,
  MEMORY_CATEGORIES,
  memoryDir,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryFs,
} from './memory-types';

export interface MemoryCandidate {
  category: MemoryCategory;
  title: string;
  body: string;
}

export type UpsertOutcome = 'created' | 'updated' | 'replaced' | 'rejected-cap';

/** Injectable clock (ISO date) so tests are deterministic. */
export type Today = () => string;
const defaultToday: Today = () => new Date().toISOString().slice(0, 10);

// ── frontmatter ──

function serializeEntry(e: MemoryEntry): string {
  return [
    '---',
    `category: ${e.category}`,
    `title: ${e.title.replace(/\n/g, ' ')}`,
    `created: ${e.created}`,
    `lastUsed: ${e.lastUsed}`,
    `timesUsed: ${e.timesUsed}`,
    '---',
    '',
    e.body.trim(),
    '',
  ].join('\n');
}

export function parseEntry(slug: string, raw: string): MemoryEntry | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const category = fields.get('category') as MemoryCategory | undefined;
  if (!category || !MEMORY_CATEGORIES.includes(category)) return null;
  const title = fields.get('title') ?? '';
  if (!title) return null;
  return {
    slug,
    category,
    title,
    body: m[2].trim(),
    created: fields.get('created') ?? '1970-01-01',
    lastUsed: fields.get('lastUsed') ?? fields.get('created') ?? '1970-01-01',
    timesUsed: Number.parseInt(fields.get('timesUsed') ?? '1', 10) || 1,
  };
}

// ── slugs + dedupe ──

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'memory';
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'when', 'this', 'that', 'are', 'not', 'was', 'has', 'have', 'use', 'using']);

function titleWords(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  ];
}

/** Crude stemming: equal, or one is a >=4-char prefix of the other (rename ~ renaming). */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/** True when two titles describe the same fact (dedupe rule). */
export function titlesMatch(a: string, b: string): boolean {
  if (slugify(a) === slugify(b)) return true;
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const common = wa.filter((w) => wb.some((v) => wordsMatch(w, v))).length;
  const union = wa.length + wb.length - common;
  return union > 0 && common / union >= 0.6;
}

// ── store operations ──

export async function loadEntries(fs: MemoryFs, workspacePath: string): Promise<MemoryEntry[]> {
  const dir = memoryDir(workspacePath);
  let files: string[];
  try {
    files = await fs.list(dir);
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.md') || f === 'task-context.md') continue;
    try {
      const parsed = parseEntry(f.slice(0, -3), await fs.read(`${dir}/${f}`));
      if (parsed) entries.push(parsed);
    } catch {
      // Unreadable entry — skip rather than fail the whole store.
    }
  }
  return entries;
}

async function writeEntry(fs: MemoryFs, workspacePath: string, entry: MemoryEntry): Promise<void> {
  const dir = memoryDir(workspacePath);
  await fs.mkdirp(dir);
  const body =
    entry.body.length > MEMORY_CAPS.entryBytes
      ? `${entry.body.slice(0, MEMORY_CAPS.entryBytes)}…`
      : entry.body;
  await fs.write(`${dir}/${entry.slug}.md`, serializeEntry({ ...entry, body }));
}

export async function upsertEntry(
  fs: MemoryFs,
  workspacePath: string,
  candidate: MemoryCandidate,
  today: Today = defaultToday,
): Promise<UpsertOutcome> {
  const entries = await loadEntries(fs, workspacePath);
  const now = today();

  // Dedupe: update the matching entry (any category — a fact re-learned
  // under a different label is still the same fact if the title matches).
  const existing = entries.find((e) => titlesMatch(e.title, candidate.title));
  if (existing) {
    await writeEntry(fs, workspacePath, {
      ...existing,
      body: candidate.body,
      lastUsed: now,
      timesUsed: existing.timesUsed + 1,
    });
    return 'updated';
  }

  const inCategory = entries.filter((e) => e.category === candidate.category);
  const fresh: MemoryEntry = {
    slug: uniqueSlug(candidate.title, entries),
    category: candidate.category,
    title: candidate.title.trim(),
    body: candidate.body.trim(),
    created: now,
    lastUsed: now,
    timesUsed: 1,
  };

  if (inCategory.length >= MEMORY_CAPS.perCategory) {
    // Only a never-recalled incumbent may be evicted; otherwise reject.
    const evictable = inCategory
      .filter((e) => e.timesUsed <= 1)
      .sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
    if (evictable.length === 0) return 'rejected-cap';
    await fs.remove(`${memoryDir(workspacePath)}/${evictable[0].slug}.md`);
    await writeEntry(fs, workspacePath, fresh);
    return 'replaced';
  }

  await writeEntry(fs, workspacePath, fresh);
  return 'created';
}

function uniqueSlug(title: string, entries: MemoryEntry[]): string {
  const base = slugify(title);
  const taken = new Set(entries.map((e) => e.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

/**
 * Salience bump for recalled entries (memory_search hits) — recall keeps
 * useful memories alive against cap eviction. Best-effort per slug.
 */
export async function bumpUsage(
  fs: MemoryFs,
  workspacePath: string,
  slugs: string[],
  today: Today = defaultToday,
): Promise<void> {
  const dir = memoryDir(workspacePath);
  const now = today();
  for (const slug of slugs) {
    try {
      const entry = parseEntry(slug, await fs.read(`${dir}/${slug}.md`));
      if (!entry) continue;
      await writeEntry(fs, workspacePath, {
        ...entry,
        lastUsed: now,
        timesUsed: entry.timesUsed + 1,
      });
    } catch {
      // best-effort
    }
  }
}

// ── read side ──

const CATEGORY_WEIGHT: Record<MemoryCategory, number> = { decision: 3, gotcha: 2, convention: 1 };

function salience(e: MemoryEntry, todayIso: string): number {
  const ageDays = Math.max(
    0,
    (Date.parse(todayIso) - Date.parse(e.lastUsed)) / 86_400_000 || 0,
  );
  return e.timesUsed * (1 / (1 + ageDays / 30)) * CATEGORY_WEIGHT[e.category];
}

/**
 * Ranked digest for the context pack — hard-capped, deterministic given the
 * same entries + date. Does NOT bump salience (reads are free).
 */
export function buildMemoryDigest(
  entries: MemoryEntry[],
  maxChars: number,
  today: Today = defaultToday,
): string | null {
  if (entries.length === 0) return null;
  const now = today();
  const ranked = [...entries].sort(
    (a, b) => salience(b, now) - salience(a, now) || a.slug.localeCompare(b.slug),
  );

  const lines = ['## Project memory (learned in past sessions — verify if stale)'];
  for (const e of ranked) {
    const line = `- [${e.category}] ${e.title}: ${e.body.replace(/\s+/g, ' ')}`;
    const candidate = [...lines, line].join('\n');
    if (candidate.length > maxChars) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

/** Keyword AND-search over title+body (memory_search tool). */
export function searchEntries(entries: MemoryEntry[], query: string): MemoryEntry[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];
  return entries.filter((e) => {
    const hay = `${e.title}\n${e.body}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// ── rolling task context ──

/**
 * "What we were working on" — a single file OVERWRITTEN each time, never
 * appended, so the bloat-prone category structurally cannot grow.
 */
export async function writeTaskContext(
  fs: MemoryFs,
  workspacePath: string,
  content: string,
): Promise<void> {
  const dir = memoryDir(workspacePath);
  await fs.mkdirp(dir);
  const capped =
    content.length > MEMORY_CAPS.taskContextBytes
      ? `${content.slice(0, MEMORY_CAPS.taskContextBytes)}…`
      : content;
  await fs.write(`${dir}/task-context.md`, capped.trim() + '\n');
}

export async function readTaskContext(fs: MemoryFs, workspacePath: string): Promise<string | null> {
  try {
    const text = await fs.read(`${memoryDir(workspacePath)}/task-context.md`);
    return text.trim() || null;
  } catch {
    return null;
  }
}
