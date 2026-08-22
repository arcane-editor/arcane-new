import { Hono } from 'hono';
import { generateText } from 'ai';
import type { AppEnv } from '../types.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { checkAiBudget } from '../lib/credits.ts';
import { recordUsage } from '../lib/usage.ts';
import { getModelRouting, getEffectivePricing } from '../lib/app-config.ts';
import { resolveModel } from '../services/llm-router.ts';

export const graphRouter = new Hono<AppEnv>();

// ─── Request / response contract ─────────────────────────────────────────────
// The editor sends a TRIMMED projection of the locally-built graph (graph.json
// + graph.summary.json), assembled in Rust (graphify_enrich_payload) so large
// graphs don't blow the payload or the model's context window.

interface GraphEnrichRequest {
    stats: { nodes: number; edges: number; communities: number };
    godNodes: Array<{ label: string; source_file?: string; degree?: number }>;
    communities: Array<{
        id: number;
        size: number;
        sampleLabels: string[];
        sampleFiles: string[];
    }>;
    languages?: string[];
}

interface GraphEnrichResponse {
    architectureSummary: string;
    communityLabels: Array<{ id: number; label: string; description: string }>;
    godNodeNotes: Array<{ label: string; role: string }>;
    model: string;
}

function buildPrompt(body: GraphEnrichRequest): string {
    const lines: string[] = [];
    lines.push(`Code graph: ${body.stats.nodes} nodes, ${body.stats.edges} edges, ${body.stats.communities} communities (clusters).`);
    if (body.languages?.length) lines.push(`Languages: ${body.languages.join(', ')}.`);

    lines.push('\nGod nodes (most-connected symbols):');
    for (const g of body.godNodes.slice(0, 20)) {
        lines.push(`- ${g.label}${g.source_file ? ` (${g.source_file})` : ''}`);
    }

    lines.push('\nCommunities (id — sample member symbols / files):');
    for (const c of body.communities.slice(0, 30)) {
        const labels = c.sampleLabels.slice(0, 12).join(', ');
        const files = c.sampleFiles.slice(0, 8).join(', ');
        lines.push(`- #${c.id} (size ${c.size}): symbols=[${labels}]; files=[${files}]`);
    }
    return lines.join('\n');
}

// Tolerant JSON extraction — strips ``` fences / surrounding prose that smaller
// models sometimes add, then parses the first balanced object.
function parseEnrichment(text: string): Omit<GraphEnrichResponse, 'model'> {
    const empty = { architectureSummary: '', communityLabels: [], godNodeNotes: [] };
    if (!text) return empty;
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) s = fence[1].trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return empty;
    try {
        const obj = JSON.parse(s.slice(start, end + 1));
        return {
            architectureSummary: typeof obj.architectureSummary === 'string' ? obj.architectureSummary : '',
            communityLabels: Array.isArray(obj.communityLabels) ? obj.communityLabels : [],
            godNodeNotes: Array.isArray(obj.godNodeNotes) ? obj.godNodeNotes : [],
        };
    } catch {
        return empty;
    }
}

graphRouter.post('/v1/graph/enrich', async (c) => {
    const user = c.get('user') as AuthPayload;

    const budget = await checkAiBudget(c.env.arcane_db, parseInt(user.sub));
    if (!budget.ok) return c.json({ error: budget.error, code: budget.code }, budget.status);

    const body = await c.req.json<GraphEnrichRequest>();
    if (!body?.stats || !Array.isArray(body.communities)) {
        return c.json({ error: 'Invalid graph payload' }, 400);
    }

    // Enrichment stays on the mid tier's cheap executor — a per-request
    // lookup against the runtime routing doc (lib/app-config.ts) rather than
    // a hardcoded id, so an admin routing change takes effect here too.
    const routing = await getModelRouting(c.env.arcane_db);
    const enrichModel = routing.tiers.mid.executor;

    // Serve guard: mirrors chat.ts — a routing doc (or the code-default
    // fallback) can only be trusted once cross-checked against the EFFECTIVE
    // pricing catalog. Without this, a mid.executor pointed at a 'direct'
    // (e.g. spark/…) or otherwise-unconfigured model would either 500 deep
    // inside the provider call below or silently bill $0 (see usage.ts).
    const pricing = await getEffectivePricing(c.env.arcane_db);
    if (!pricing.catalog[enrichModel]) {
        console.error(JSON.stringify({ event: 'model_unconfigured', model: enrichModel }));
        return c.json({ error: 'This model is not configured. Contact support.', code: 'model_unconfigured' }, 503);
    }

    // Generative enrichment, like chat, is sampled (temperature 0.2) — skip the
    // gateway cache so a repeat call doesn't replay a stale sampled response.
    // resolveModel (not workersAiProvider directly) so a 'direct'-route model
    // (spark/…) — the shipped default mid.executor — is servable here too,
    // not just @cf/ Workers AI catalog ids.
    const model = resolveModel(enrichModel, c.env, { skipCache: true });

    const system = [
        'You are a code-architecture summarizer. You are given a structural code',
        'graph: its god nodes (most-connected symbols) and clustered communities',
        '(each with sample member symbol labels and file paths).',
        'Respond with ONLY a JSON object (no markdown, no prose) of the shape:',
        '{"architectureSummary": string (2-4 sentences),',
        ' "communityLabels": [{"id": number, "label": short human name, "description": one sentence}],',
        ' "godNodeNotes": [{"label": symbol, "role": one-line role}]}.',
        'Reference the actual symbol/file names. Be concrete and concise.',
    ].join(' ');

    const startTime = Date.now();
    try {
        const { text, usage } = await generateText({
            model,
            system,
            prompt: buildPrompt(body),
            maxOutputTokens: 1500,
            temperature: 0.2,
        });
        await recordUsage(c.env.arcane_db, parseInt(user.sub), enrichModel, usage.inputTokens ?? 0, usage.outputTokens ?? 0, Date.now() - startTime, { taskType: 'graph_enrich' });
        const parsed = parseEnrichment(text);
        return c.json<GraphEnrichResponse>({ ...parsed, model: enrichModel });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: { message, type: 'server_error' } }, 500);
    }
});
