/**
 * Per-project AI memory (spec §4) — shared types and caps.
 *
 * Storage is plain markdown files under `<workspace>/Library/ArcaneIDE/memory`
 * (machine-local; `Library/` is Unity-gitignored by convention, and the Rust
 * side already persists its index there). One entry per file, frontmatter +
 * body, so the user can open, edit, or delete any memory in the editor —
 * no black box.
 */

export type MemoryCategory = 'decision' | 'convention' | 'gotcha';

export interface MemoryEntry {
  /** File name (without .md) — derived from the title. */
  slug: string;
  category: MemoryCategory;
  title: string;
  body: string;
  /** ISO date (YYYY-MM-DD). */
  created: string;
  lastUsed: string;
  timesUsed: number;
}

/**
 * Bloat control (spec §4): hard caps enforced ON WRITE — the store can never
 * silently grow past them. Worst case: 3 categories × 30 entries × 1KB +
 * a 4KB task-context file ≈ 94KB, structurally under the 200KB spec bound.
 */
export const MEMORY_CAPS = {
  perCategory: 30,
  entryBytes: 1024,
  taskContextBytes: 4096,
} as const;

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = ['decision', 'convention', 'gotcha'];

/**
 * Minimal filesystem seam so the store logic is pure and Bun-testable; the
 * live implementation wraps the existing Tauri fs commands
 * (tauri-memory-fs.ts).
 */
export interface MemoryFs {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** File names (not paths) in a directory; [] when the directory is missing. */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
}

export function memoryDir(workspacePath: string): string {
  return `${workspacePath}/Library/ArcaneIDE/memory`;
}
