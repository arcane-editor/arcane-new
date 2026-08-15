/**
 * Project context pack (spec §3) — a deterministic, budgeted block of
 * project knowledge assembled from the indices the editor already maintains
 * (asmdef graph, graphify god nodes, per-project memory), so the model starts
 * every conversation knowing the project instead of rediscovering it with
 * read/list calls.
 *
 * Pure module: callers supply the data (see `captureDecoration` in
 * prompts/index.ts for the live wiring). Output rules:
 *   - deterministic — sorted, no counts, no timestamps — because the pack is
 *     frozen into the cached system-prompt prefix (frozen-context.ts);
 *   - hard char budget per effort tier, truncated at a line boundary.
 */

import type { Effort } from '../types';

export interface AssemblyInfo {
  name: string;
  references: string[];
  isEditorOnly: boolean;
}

export interface ContextPackInputs {
  assemblies: AssemblyInfo[];
  /** Structurally important file paths (graph god nodes etc.). */
  keyFiles: string[];
  /** Ranked per-project memory digest (spec §4); null until memory ships. */
  memoryDigest: string | null;
}

/** Char budgets per effort tier (exported for tests). */
export const CONTEXT_PACK_BUDGETS: Record<Effort, number> = {
  low: 1536,
  mid: 2560,
  high: 4096,
};

const MAX_ASSEMBLIES = 15;
const MAX_KEY_FILES = 12;

/**
 * Assemblies ranked by how many OTHER assemblies reference them (structural
 * importance), then by name for a deterministic total order.
 */
function rankAssemblies(assemblies: AssemblyInfo[]): AssemblyInfo[] {
  const inbound = new Map<string, number>();
  for (const a of assemblies) {
    for (const ref of a.references) {
      inbound.set(ref, (inbound.get(ref) ?? 0) + 1);
    }
  }
  return [...assemblies].sort((a, b) => {
    const d = (inbound.get(b.name) ?? 0) - (inbound.get(a.name) ?? 0);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
}

export function buildContextPackText(
  inputs: ContextPackInputs,
  budgetChars: number,
): string | null {
  const sections: string[] = [];

  if (inputs.assemblies.length > 0) {
    const lines = ['## Assemblies (asmdef graph)'];
    for (const a of rankAssemblies(inputs.assemblies).slice(0, MAX_ASSEMBLIES)) {
      const editor = a.isEditorOnly ? ' (editor-only)' : '';
      const refs = a.references.length > 0 ? ` → refs: ${[...a.references].sort().join(', ')}` : '';
      lines.push(`- ${a.name}${editor}${refs}`);
    }
    sections.push(lines.join('\n'));
  }

  if (inputs.keyFiles.length > 0) {
    const files = [...new Set(inputs.keyFiles)].sort().slice(0, MAX_KEY_FILES);
    sections.push(['## Key files (structurally central — read these first)', ...files.map((f) => `- ${f}`)].join('\n'));
  }

  if (inputs.memoryDigest) {
    sections.push(inputs.memoryDigest);
  }

  if (sections.length === 0) return null;

  const out = sections.join('\n\n');
  if (out.length <= budgetChars) return out;
  // Truncate at the last full line inside the budget.
  const cut = out.slice(0, budgetChars);
  const lastNewline = cut.lastIndexOf('\n');
  return (lastNewline > 0 ? cut.slice(0, lastNewline) : cut) + '\n…';
}
