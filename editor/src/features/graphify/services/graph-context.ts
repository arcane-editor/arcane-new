/**
 * Build a compact "graph snapshot" string for injection into the system prompt.
 *
 * Hard cap on size so we don't blow up prompt tokens. The snapshot contains:
 *   - A server-generated architecture summary + component labels, when the AI
 *     enrichment has run (see graphify-enrich.ts)
 *   - The graph's god nodes (most-connected symbols, project-wide signal),
 *     annotated with their role when enrichment is available
 *
 * Deeper traversal is left to the `graphify_query` tool on demand. The output
 * is deliberately deterministic (no counts, no active file) — it gets frozen
 * into the cached system-prompt prefix for a whole conversation.
 */

import { useGraphifyStore } from '../../../stores/graphify';
import { capSnapshot, MAX_CHARS } from './graph-snapshot-budget';

export { graphSnapshotBudget, capSnapshot } from './graph-snapshot-budget';

const MAX_GOD_NODES = 8;
const MAX_COMPONENTS = 8;

export function buildGraphSnapshot(opts?: { maxChars?: number }): string | null {
  const { status, summary, enrichment } = useGraphifyStore.getState();
  if (status !== 'present' && status !== 'stale') return null;
  if (!summary) return null;

  // Deliberately no node/edge counts and no active-file line: both jitter
  // between builds/sends with no decision-relevant signal, and this snapshot
  // is frozen into the cached system-prompt prefix (prompts/frozen-context.ts)
  // where every changed byte re-bills the whole conversation history.
  const lines: string[] = [];
  lines.push('## Codebase graph snapshot');

  // AI-generated architecture summary (highest-signal — keep it near the top).
  if (enrichment?.architectureSummary) {
    lines.push('', enrichment.architectureSummary);
  }

  // Named components (clustered communities), when enrichment ran.
  const components = (enrichment?.communityLabels ?? []).slice(0, MAX_COMPONENTS);
  if (components.length > 0) {
    lines.push('', 'Components:');
    for (const c of components) {
      lines.push(`  - ${c.label}: ${c.description}`);
    }
  }

  const roleByLabel = new Map(
    (enrichment?.godNodeNotes ?? []).map((n) => [n.label, n.role] as const),
  );
  const gods = (summary.god_nodes ?? []).slice(0, MAX_GOD_NODES);
  if (gods.length > 0) {
    lines.push('', 'God nodes (most-connected entities — likely architectural anchors):');
    for (const g of gods) {
      const label = g.label ?? '?';
      const src = g.source_file ? ` (${g.source_file})` : '';
      const role = g.label && roleByLabel.get(g.label) ? ` — ${roleByLabel.get(g.label)}` : '';
      lines.push(`  - ${label}${src}${role}`);
    }
  }

  lines.push(
    '',
    'To explore further: call graphify_query, graphify_explain, or graphify_path.',
  );

  const out = lines.join('\n');
  return capSnapshot(out, opts?.maxChars ?? MAX_CHARS);
}
