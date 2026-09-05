import { Hono } from 'hono';
import { embed } from 'ai';
import type { AppEnv } from '../types.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import {
    lookupUnitySignatures,
    searchUnitySignaturesByName,
    listDeprecatedUnityApis,
    type UnityApiSignatureRow,
} from '../lib/db.ts';
import { checkAiBudget, budgetErrorBody } from '../lib/credits.ts';
import { recordUsage } from '../lib/usage.ts';
import { workersAiProvider } from '../services/llm-router.ts';

export const unityApiRouter = new Hono<AppEnv>();

// 384-dim — MUST match the index dimensions and the embeddings route.
const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
// bge retrieval works best when the *query* carries this instruction prefix;
// stored passages are embedded as-is (with their breadcrumb prefix).
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const SEARCH_MAX_TOPK = 20;
const SEARCH_DEFAULT_TOPK = 8;

// Search-response cache (spec §6): the corpus is a static out-of-band ingest,
// so identical normalized queries return identical results — a hit skips the
// bge embed AND the Vectorize query. 7-day TTL; expired rows are cleaned up
// opportunistically (~1 in 50 requests) rather than by a scheduled job.
const SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_CACHE_CLEANUP_PROBABILITY = 0.02;

async function searchCacheKey(parts: Record<string, unknown>): Promise<string> {
    const canonical = JSON.stringify(parts, Object.keys(parts).sort());
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// docType values stored in Vectorize metadata (api signature | scriptref | manual prose).
type DocType = 'scriptref' | 'manual' | 'api';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize a full Unity version (e.g. '2022.3.10f1') to its major.minor key. */
function majorMinor(version: string): string {
    const m = version.match(/^(\d+)\.(\d+)/);
    return m ? `${m[1]}.${m[2]}` : version;
}

function rowToSignature(r: UnityApiSignatureRow) {
    return {
        namespace: r.namespace,
        type: r.type,
        member: r.member,
        kind: r.kind,
        signature: r.signature,
        overloads: r.overloads_json ? (JSON.parse(r.overloads_json) as string[]) : undefined,
        assembly: r.assembly ?? undefined,
        deprecated: r.deprecated === 1,
        obsoleteMessage: r.obsolete_message ?? undefined,
        docUrl: r.doc_url ?? undefined,
    };
}

function meta(value: unknown): string {
    return value == null ? '' : String(value);
}

// ─── Exact lookup (D1, deterministic, no model cost) ───────────────────────────

unityApiRouter.post('/v1/unity/api/lookup', async (c) => {
    const body = await c.req.json<{ unityVersion?: string; type?: string; member?: string }>();
    if (!body?.unityVersion || !body?.type) {
        return c.json({ error: 'unityVersion and type are required' }, 400);
    }
    const version = majorMinor(body.unityVersion);
    const rows = await lookupUnitySignatures(c.env.arcane_db, version, body.type, body.member);
    return c.json({
        version,
        type: body.type,
        member: body.member ?? null,
        signatures: rows.map(rowToSignature),
    });
});

// ─── Deprecated APIs for a version (D1, powers migrations / version upgrades) ──

unityApiRouter.post('/v1/unity/api/deprecated', async (c) => {
    const body = await c.req.json<{ unityVersion?: string; limit?: number }>();
    if (!body?.unityVersion) return c.json({ error: 'unityVersion is required' }, 400);
    const version = majorMinor(body.unityVersion);
    const rows = await listDeprecatedUnityApis(c.env.arcane_db, version, Math.min(body.limit ?? 500, 2000));
    return c.json({ version, deprecated: rows.map(rowToSignature) });
});

// ─── Semantic search (Vectorize, with D1 fallback) ─────────────────────────────

unityApiRouter.post('/v1/unity/api/search', async (c) => {
    const user = c.get('user') as AuthPayload;
    const budget = await checkAiBudget(c.env.arcane_db, parseInt(user.sub));
    if (!budget.ok) {
        if (budget.retryAfterSeconds !== undefined) c.header('Retry-After', String(budget.retryAfterSeconds));
        return c.json(budgetErrorBody(budget), budget.status);
    }

    const body = await c.req.json<{
        query?: string;
        unityVersion?: string;
        renderPipeline?: string;
        inputSystem?: string;
        docType?: DocType | 'all';
        topK?: number;
    }>();
    if (!body?.query || !body?.unityVersion) {
        return c.json({ error: 'query and unityVersion are required' }, 400);
    }

    const version = majorMinor(body.unityVersion);
    const topK = Math.min(Math.max(body.topK ?? SEARCH_DEFAULT_TOPK, 1), SEARCH_MAX_TOPK);

    // Cache lookup — best-effort: any cache failure falls through to the
    // normal search path.
    const cacheKey = await searchCacheKey({
        q: body.query.trim().toLowerCase(),
        v: version,
        rp: body.renderPipeline ?? '',
        is: body.inputSystem ?? '',
        dt: body.docType ?? 'all',
        topK,
    });
    try {
        const row = await c.env.arcane_db
            .prepare('SELECT response FROM unity_search_cache WHERE cache_key = ? AND expires_at > ?')
            .bind(cacheKey, Date.now())
            .first<{ response: string }>();
        if (row) {
            return c.json(JSON.parse(row.response) as Record<string, unknown>);
        }
    } catch {
        // table missing / transient D1 error — proceed uncached
    }

    const cachePut = async (payload: Record<string, unknown>): Promise<void> => {
        try {
            await c.env.arcane_db
                .prepare('INSERT OR REPLACE INTO unity_search_cache (cache_key, response, expires_at) VALUES (?, ?, ?)')
                .bind(cacheKey, JSON.stringify(payload), Date.now() + SEARCH_CACHE_TTL_MS)
                .run();
            if (Math.random() < SEARCH_CACHE_CLEANUP_PROBABILITY) {
                await c.env.arcane_db
                    .prepare('DELETE FROM unity_search_cache WHERE expires_at <= ?')
                    .bind(Date.now())
                    .run();
            }
        } catch {
            // best-effort
        }
    };

    const startTime = Date.now();
    try {
        const { embedding, usage } = await embed({
            model: workersAiProvider(c.env).textEmbedding(EMBED_MODEL),
            value: QUERY_PREFIX + body.query,
        });
        // Meter the embed as soon as it succeeds — the neuron cost is incurred
        // regardless of whether the Vectorize query below hits or falls back.
        await recordUsage(c.env.arcane_db, parseInt(user.sub), EMBED_MODEL, usage?.tokens ?? 0, 0, Date.now() - startTime, { taskType: 'unity_search' });

        const filter: Record<string, unknown> = { unityVersion: { $eq: version } };
        if (body.renderPipeline) filter.renderPipeline = { $in: [body.renderPipeline, 'any'] };
        if (body.inputSystem) filter.inputSystem = { $in: [body.inputSystem, 'any'] };
        if (body.docType && body.docType !== 'all') filter.docType = { $eq: body.docType };

        const res = await c.env.VECTORIZE.query(embedding, {
            topK,
            returnMetadata: 'all',
            filter: filter as never,
        });

        const results = res.matches.map((m) => {
            const md = (m.metadata ?? {}) as Record<string, unknown>;
            return {
                score: m.score,
                docType: meta(md.docType),
                type: meta(md.type) || undefined,
                member: meta(md.member) || undefined,
                namespace: meta(md.namespace) || undefined,
                breadcrumb: meta(md.breadcrumb) || undefined,
                title: meta(md.title) || undefined,
                url: meta(md.url) || undefined,
                deprecated: meta(md.deprecated) === 'true',
                text: meta(md.text),
            };
        });

        // Cold/empty index for this version → deterministic D1 fallback so a
        // not-yet-ingested version still grounds the model instead of failing.
        if (results.length === 0) {
            const rows = await searchUnitySignaturesByName(c.env.arcane_db, version, body.query, topK);
            const payload = { version, source: 'd1-fallback', results: rows.map(rowToSignature) };
            if (payload.results.length > 0) await cachePut(payload);
            return c.json(payload);
        }

        const payload = { version, source: 'vectorize', results };
        await cachePut(payload);
        return c.json(payload);
    } catch (err) {
        // Vectorize unavailable → fall back to D1 name search rather than erroring.
        const rows = await searchUnitySignaturesByName(c.env.arcane_db, version, body.query, topK);
        if (rows.length > 0) {
            return c.json({ version, source: 'd1-fallback', results: rows.map(rowToSignature) });
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: { message, type: 'server_error' } }, 500);
    }
});

// NOTE: Ingestion is a one-time, OUT-OF-BAND job — there is no ingest route on the
// Worker. The corpus is loaded straight into Vectorize + D1 via the Cloudflare
// REST API by scripts/ingest-direct.mjs (see scripts/README.md).
