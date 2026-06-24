/**
 * Server-side AI enrichment of the local AST graph.
 *
 * The graph itself is built locally and LLM-free. This adds a *semantic* layer
 * (architecture summary, human community labels, god-node roles) by sending a
 * trimmed projection of the graph (assembled in Rust) to arcane-server, which
 * runs the LLM via the Cloudflare AI Gateway.
 *
 * Best-effort: any failure (offline, not signed in, server error) returns null
 * so the local graph keeps working without the semantic layer.
 */

import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../../../stores/auth';

// Same host as the AI chat path (see ai-panel/services/arcane-stream.ts).
const ARCANE_SERVER_URL = 'https://api.arcaneai.org';

export interface GraphEnrichment {
  architectureSummary: string;
  communityLabels: { id: number; label: string; description: string }[];
  godNodeNotes: { label: string; role: string }[];
}

export async function enrichGraph(workspacePath: string): Promise<GraphEnrichment | null> {
  const token = useAuthStore.getState().token;
  if (!token) return null;

  let payload: unknown;
  try {
    payload = await invoke('graphify_enrich_payload', { workspacePath });
  } catch {
    return null;
  }

  try {
    const res = await fetch(`${ARCANE_SERVER_URL}/v1/graph/enrich`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.architectureSummary !== 'string') return null;
    return {
      architectureSummary: data.architectureSummary,
      communityLabels: Array.isArray(data.communityLabels) ? data.communityLabels : [],
      godNodeNotes: Array.isArray(data.godNodeNotes) ? data.godNodeNotes : [],
    };
  } catch {
    return null;
  }
}
