/**
 * Build a compact "graph snapshot" string for injection into the system prompt.
 *
 * Hard cap on size so we don't blow up prompt tokens. The snapshot contains:
 *   - A server-generated architecture summary + component labels, when the AI
 *     enrichment has run (see graphify-enrich.ts)
 *   - The graph's god nodes (most-connected symbols, project-wide signal),
 *     annotated with their role when enrichment is available
 *   - The active file's path (if any) so the model knows where the user is
 *
 * Deeper traversal is left to the `graphify_query` tool on demand.
 */

import { useGraphifyStore } from '../../../stores/graphify';

// Local alias for the ai-panel `Effort` type. Deep-modules boundary check
// forbids importing ai-panel internals from graphify (only the ai-panel
// barrel is a valid import target, and importing the barrel here would be a
// cross-feature cycle), so the tier union is duplicated here instead.
type Tier = 'low' | 'mid' | 'high' | 'super';

const MAX_GOD_NODES = 8;
const MAX_COMPONENTS = 8;
const MAX_CHARS = 1024;

/** Higher-effort tiers get a bigger graph-snapshot slice of the prompt budget. */
export function graphSnapshotBudget(effort: Tier): number {
  return effort === 'high' || effort === 'super' ? 4096 : MAX_CHARS;
}

/** Truncate `text` to `maxChars`, appending an ellipsis when it overflows. */
export function capSnapshot(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

export function buildGraphSnapshot(
  activeFilePath: string | null,
  opts?: { maxChars?: number },
): string | null {
  const { status, summary, enrichment } = useGraphifyStore.getState();
  if (status !== 'present' && status !== 'stale') return null;
  if (!summary) return null;

  const lines: string[] = [];
  lines.push(
    '## Codebase graph snapshot',
    `Graph: ${summary.nodes} nodes, ${summary.edges} edges across ${summary.communities} communities.`,
  );

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

  if (activeFilePath) {
    lines.push('', `Active file: ${activeFilePath}`);
  }
  lines.push(
    '',
    'To explore further: call graphify_query, graphify_explain, or graphify_path.',
  );

  const out = lines.join('\n');
  return capSnapshot(out, opts?.maxChars ?? MAX_CHARS);
}
