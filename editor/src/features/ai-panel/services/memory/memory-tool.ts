/**
 * `memory_search` — read-only agent tool over the per-project memory store.
 * Always registered (stable tool set for the prompt-prefix cache); answers
 * plainly when the store is empty. Returned entries get a salience bump so
 * recall keeps useful memories alive (spec §4).
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import { loadEntries, searchEntries, bumpUsage } from './memory-store';
import { tauriMemoryFs } from './tauri-memory-fs';
import type { MemoryFs } from './memory-types';

const searchArgs = Type.Object({
  query: Type.String({
    description: 'Keywords to look up in past decisions, conventions, and gotchas for THIS project.',
  }),
});
type SearchArgs = Static<typeof searchArgs>;

const MAX_RESULTS = 8;

export function createMemorySearchTool(
  workspacePath: string,
  fs: MemoryFs = tauriMemoryFs,
): AgentTool {
  return {
    name: 'memory_search',
    label: 'memory_search',
    description:
      'Search this project\'s persistent AI memory: decisions made in past sessions, confirmed conventions, and discovered gotchas. ' +
      'Call when the user references past work or when a choice may already have been settled.',
    parameters: searchArgs,
    async execute(_id: string, params: unknown): Promise<AgentToolResult> {
      const { query } = params as SearchArgs;
      try {
        const entries = await loadEntries(fs, workspacePath);
        if (entries.length === 0) {
          return text('No project memories recorded yet.');
        }
        const hits = searchEntries(entries, query).slice(0, MAX_RESULTS);
        if (hits.length === 0) {
          return text(`No memories matched "${query}".`);
        }
        // Recall keeps memories alive — best-effort, never blocks the answer.
        void bumpUsage(fs, workspacePath, hits.map((h) => h.slug)).catch(() => {});
        return text(
          hits
            .map((h) => `[${h.category}] ${h.title} (last used ${h.lastUsed})\n  ${h.body}`)
            .join('\n'),
        );
      } catch (e) {
        return text(`memory error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function text(t: string): AgentToolResult {
  return { content: [{ type: 'text', text: t }] };
}
