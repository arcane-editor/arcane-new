// Runtime-editable AI config, stored in the `app_config` D1 table (key/value
// JSON documents; migration 0022). Two documents live here:
//   'model_routing' — which model each effort tier (low/mid/high) routes to,
//                      plus the inline (tab-completion) model.
//   'model_pricing' — per-model rate overrides merged OVER the code-default
//                      MODEL_CATALOG, plus the gatewayFee/margin multipliers.
// Both are optional: an empty table falls back to the code defaults
// (DEFAULT_MODEL_ROUTING / {MODEL_CATALOG, GATEWAY_FEE, MARGIN}) SILENTLY —
// that is the normal, defaults-active state of every fresh deploy, not an
// anomaly. A row that EXISTS but fails to parse or fails validation ALSO
// falls back to the same defaults, but that IS an anomaly (someone stored a
// bad doc) — that path logs one structured line so it's visible in the tail
// without throwing.
//
// Reads are cached per-isolate for TTL_MS (60s) to keep this off the hot
// path — one D1 read per doc per isolate per minute, not per request.
// putConfigDoc invalidates THIS isolate's cache immediately; other isolates
// pick up the change within TTL_MS. That staleness window is accepted: an
// admin price/routing change does not need to be instant.
//
// The two docs are NOT independent: getModelRouting validates the stored
// routing doc against the EFFECTIVE (pricing-merged) catalog, so a
// model_pricing write can change whether a cached model_routing doc is still
// considered valid. putConfigDoc therefore invalidates BOTH cache keys on
// every write, regardless of which doc was written.
import { MODEL_CATALOG, type ModelInfo, type LongContextRates } from './costs.ts';
import { GATEWAY_FEE, MARGIN } from '../config/tiers.ts';
import { DEFAULT_MODEL_ROUTING } from '../config/plans.ts';

export interface TierRouting {
    planner: string;
    executor: string;
    executorHard?: string;
}

export interface ModelRoutingDoc {
    tiers: Record<'low' | 'mid' | 'high', TierRouting>;
    /** Model for tab completions + harness side-tasks; MUST be a '@cf/' id
     *  (Workers AI only — inline traffic never pays gateway/third-party rates). */
    inline: string;
}

export interface ModelPricingDoc {
    /** Merged OVER MODEL_CATALOG by slug — a doc overrides only the slugs it
     *  names; every other catalog entry (and unmentioned fields) is untouched. */
    models: Record<string, ModelInfo>;
    /** Default GATEWAY_FEE (1.05) unless overridden. */
    gatewayFee: number;
    /** Default MARGIN (1.0) unless overridden. */
    margin: number;
}

export interface EffectivePricing {
    /** { ...MODEL_CATALOG, ...doc.models } — or plain MODEL_CATALOG on default. */
    catalog: Record<string, ModelInfo>;
    gatewayFee: number;
    margin: number;
}

type ConfigKey = 'model_routing' | 'model_pricing';

const TTL_MS = 60_000;

// Per-isolate cache shared by both getters (key = doc key: 'model_routing' |
// 'model_pricing'). A cold isolate starts empty; the first getter call in it
// pays one D1 read, then serves from here until expiresAt.
const cache = new Map<string, { value: unknown; expiresAt: number }>();

function readCache<T>(key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return undefined;
    return entry.value as T;
}

function writeCache(key: string, value: unknown): void {
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/** Test hook: drops the whole per-isolate cache so the next getter call
 *  re-reads D1. Production has no equivalent — the TTL staleness window is
 *  accepted there (see module doc comment above). */
export function clearConfigCache(): void {
    cache.clear();
}

/** One structured line per invalid/missing/malformed doc — grep-able by
 *  `event`, cheap enough to log on every cache miss (at most once per TTL_MS
 *  per isolate, not per request). */
function logInvalid(key: ConfigKey, reason: string): void {
    console.error(JSON.stringify({ event: 'app_config_invalid', key, reason }));
}

/** Uncached raw read (admin GET path — a later task serves this over HTTP). */
export async function readConfigDoc(
    db: D1Database, key: ConfigKey,
): Promise<{ raw: string; updatedAt: string } | null> {
    const row = await db.prepare('SELECT value, updated_at FROM app_config WHERE key = ?1')
        .bind(key).first<{ value: string; updated_at: string }>();
    if (!row) return null;
    return { raw: row.value, updatedAt: row.updated_at };
}

/** Upsert one config document (admin PUT path — the admin routes in
 *  routes/admin.ts expose this over HTTP). Invalidates this isolate's cache
 *  immediately; see module comment for the cross-isolate staleness window.
 *
 *  Invalidates BOTH keys, not just the one written: getModelRouting's cached
 *  value is validated against the EFFECTIVE (pricing-merged) catalog, so a
 *  model_pricing write can flip a cached model_routing doc's validity in
 *  either direction (a custom model newly available to route to, or one just
 *  removed that a cached "valid" routing doc depended on). Cross-invalidating
 *  is cheap — config writes are rare admin actions, not hot-path traffic —
 *  and keeps the two caches coherent with each other. */
export async function putConfigDoc(db: D1Database, key: ConfigKey, value: object): Promise<void> {
    await db.prepare(
        `INSERT INTO app_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, JSON.stringify(value)).run();
    cache.delete('model_routing');
    cache.delete('model_pricing');
}

/** Shared read → JSON.parse → validate pipeline for both getters below.
 *  Returns the parsed (validated) doc, or null. `error` is set ONLY for an
 *  ANOMALY — a row that exists but fails JSON.parse or fails `validate` —
 *  never for a plain missing row, which is the normal, defaults-active state
 *  of every fresh deploy and must not be treated as a failure to log. */
async function readAndValidate(
    db: D1Database, key: ConfigKey, validate: (parsed: unknown) => string | null,
): Promise<{ doc: unknown; error: string | null }> {
    const row = await db.prepare('SELECT value FROM app_config WHERE key = ?1').bind(key).first<{ value: string }>();
    if (!row) return { doc: null, error: null }; // no row yet — silent default, not an anomaly

    let parsed: unknown;
    try {
        parsed = JSON.parse(row.value);
    } catch (err) {
        return { doc: null, error: `invalid JSON: ${(err as Error).message}` };
    }

    const validationError = validate(parsed);
    if (validationError) return { doc: null, error: validationError };
    return { doc: parsed, error: null };
}

/** Which model each effort tier routes to, plus the inline model. Falls back
 *  to DEFAULT_MODEL_ROUTING (plans.ts) when the table has no row (silently —
 *  the normal state of a fresh deploy) or when the row fails to parse or
 *  fails validateModelRoutingDoc (an anomaly — logged).
 *
 *  Validates against the EFFECTIVE catalog (getEffectivePricing's merged
 *  MODEL_CATALOG + model_pricing overrides), NOT the static MODEL_CATALOG
 *  alone — an admin adding a custom model via PUT /admin/config/pricing and
 *  then routing a tier at it via PUT /admin/config/models must have that
 *  model actually SERVE, not silently revert to defaults here because this
 *  getter checked a narrower catalog than the one that accepted the write.
 *  No cycle: getEffectivePricing never calls back into this function. */
export async function getModelRouting(db: D1Database): Promise<ModelRoutingDoc> {
    const cached = readCache<ModelRoutingDoc>('model_routing');
    if (cached) return cached;

    const { catalog } = await getEffectivePricing(db);
    const { doc, error } = await readAndValidate(
        db, 'model_routing', (parsed) => validateModelRoutingDoc(parsed, catalog),
    );
    if (error) logInvalid('model_routing', error);

    const result = (doc as ModelRoutingDoc | null) ?? DEFAULT_MODEL_ROUTING;
    writeCache('model_routing', result);
    return result;
}

/** Effective pricing: MODEL_CATALOG with any admin `model_pricing` overrides
 *  merged in, plus the effective gatewayFee/margin. Falls back to
 *  {MODEL_CATALOG, GATEWAY_FEE, MARGIN} when the table has no row (silently —
 *  the normal state of a fresh deploy) or when the row fails to parse or
 *  fails validateModelPricingDoc (an anomaly — logged). */
export async function getEffectivePricing(db: D1Database): Promise<EffectivePricing> {
    const cached = readCache<EffectivePricing>('model_pricing');
    if (cached) return cached;

    const { doc, error } = await readAndValidate(db, 'model_pricing', validateModelPricingDoc);
    if (error) logInvalid('model_pricing', error);

    const pricingDoc = doc as ModelPricingDoc | null;
    const result: EffectivePricing = pricingDoc
        ? { catalog: { ...MODEL_CATALOG, ...pricingDoc.models }, gatewayFee: pricingDoc.gatewayFee, margin: pricingDoc.margin }
        : { catalog: MODEL_CATALOG, gatewayFee: GATEWAY_FEE, margin: MARGIN };
    writeCache('model_pricing', result);
    return result;
}

/**
 * Validates a parsed `model_routing` doc. `catalog` is the model id → info
 * map every referenced model (each tier's planner/executor/executorHard, and
 * `inline`) must exist in — getModelRouting's code path passes the EFFECTIVE
 * (pricing-merged) catalog from getEffectivePricing, not static MODEL_CATALOG
 * alone (a custom model that only exists via a model_pricing override must
 * still validate here); tests may pass any fixture catalog. Returns an error
 * message, or null when the doc is valid.
 */
export function validateModelRoutingDoc(x: unknown, catalog: Record<string, ModelInfo>): string | null {
    if (typeof x !== 'object' || x === null) return 'doc is not an object';
    const doc = x as Partial<ModelRoutingDoc>;

    if (typeof doc.inline !== 'string' || doc.inline.length === 0) return 'inline must be a non-empty string';
    if (!doc.inline.startsWith('@cf/')) return `inline must be a '@cf/' model id, got: ${doc.inline}`;
    if (!catalog[doc.inline]) return `inline model not in catalog: ${doc.inline}`;

    if (typeof doc.tiers !== 'object' || doc.tiers === null) return 'tiers must be an object';
    const tiers = doc.tiers as Record<string, Partial<TierRouting> | undefined>;

    for (const tierName of ['low', 'mid', 'high'] as const) {
        const tier = tiers[tierName];
        if (!tier || typeof tier !== 'object') return `missing tier: ${tierName}`;

        if (typeof tier.planner !== 'string' || tier.planner.length === 0) {
            return `${tierName}.planner must be a non-empty string`;
        }
        if (!catalog[tier.planner]) return `${tierName}.planner not in catalog: ${tier.planner}`;

        if (typeof tier.executor !== 'string' || tier.executor.length === 0) {
            return `${tierName}.executor must be a non-empty string`;
        }
        if (!catalog[tier.executor]) return `${tierName}.executor not in catalog: ${tier.executor}`;

        if (tier.executorHard !== undefined) {
            if (typeof tier.executorHard !== 'string' || tier.executorHard.length === 0) {
                return `${tierName}.executorHard must be a non-empty string`;
            }
            if (!catalog[tier.executorHard]) return `${tierName}.executorHard not in catalog: ${tier.executorHard}`;
        }
    }
    return null;
}

/**
 * Validates a parsed `model_pricing` doc against the ModelInfo shape (see
 * costs.ts) plus the top-level gatewayFee/margin multipliers. Returns an
 * error message, or null when the doc is valid. Does NOT cross-check that
 * models referenced by a routing doc exist here — this doc is additive
 * (merged over MODEL_CATALOG), not exhaustive.
 */
export function validateModelPricingDoc(x: unknown): string | null {
    if (typeof x !== 'object' || x === null) return 'doc is not an object';
    const doc = x as Partial<ModelPricingDoc>;

    if (typeof doc.models !== 'object' || doc.models === null) return 'models must be an object';

    for (const [slug, info] of Object.entries(doc.models)) {
        if (typeof info !== 'object' || info === null) return `${slug}: not an object`;
        const m = info as Partial<ModelInfo>;

        for (const field of ['inputCostPer1M', 'outputCostPer1M', 'cachedInputCostPer1M'] as const) {
            const v = m[field];
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
                return `${slug}.${field} must be a finite number >= 0`;
            }
        }
        if (typeof m.contextWindow !== 'number' || !(m.contextWindow > 0)) {
            return `${slug}.contextWindow must be > 0`;
        }
        if (typeof m.maxOutput !== 'number' || !(m.maxOutput >= 0)) {
            return `${slug}.maxOutput must be >= 0`;
        }
        if (m.route !== 'workers-ai' && m.route !== 'unified' && m.route !== 'direct') {
            return `${slug}.route must be one of 'workers-ai'|'unified'|'direct'`;
        }
        if (m.route === 'unified' && m.wireFormat !== 'chat' && m.wireFormat !== 'responses') {
            return `${slug}.wireFormat must be 'chat'|'responses' when route is 'unified'`;
        }
        if (m.longContext !== undefined) {
            if (typeof m.longContext !== 'object' || m.longContext === null) {
                return `${slug}.longContext must be an object`;
            }
            const lc = m.longContext as Partial<LongContextRates>;
            if (typeof lc.thresholdTokens !== 'number' || !(lc.thresholdTokens > 0)) {
                return `${slug}.longContext.thresholdTokens must be > 0`;
            }
            for (const field of ['inputCostPer1M', 'outputCostPer1M', 'cachedInputCostPer1M'] as const) {
                const v = lc[field];
                if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
                    return `${slug}.longContext.${field} must be a finite number >= 0`;
                }
            }
        }
    }

    if (typeof doc.gatewayFee !== 'number' || !(doc.gatewayFee >= 1)) return 'gatewayFee must be >= 1';
    if (typeof doc.margin !== 'number' || !(doc.margin >= 1)) return 'margin must be >= 1';
    return null;
}
