import type { TokenPurpose } from './tokens.ts';

// --- Row types (match D1/SQLite column names) ---

export interface UserRow {
    id: number;
    email: string;
    password_hash: string;   // '' = OAuth-only user, no password set
    salt: string;            // '' for OAuth-only users
    role: string;
    created_at: string;
    google_sub: string | null;
    email_verified: number;  // 0 | 1
    token_version: number;   // session revocation epoch (JWT claim must match)
}

export interface UsagePeriodRow {
    id: number;
    user_id: number;
    period_start: string;
    period_end: string;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
    total_requests: number;
}

export interface RequestLogRow {
    id: number;
    user_id: number;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    duration_ms: number;
    created_at: string;
    task_type: string | null;
    turn_index: number | null;
    tool_error_count: number | null;
    repair_count: number | null;
    cached_input_tokens: number | null;
    grounding_lint_hits: number | null;
    loop_guard_hits: number | null;
    escalated: number | null;
    grounding_tool_calls: number | null;
    grounding_unavailable: number | null;
    last_turn_latency_ms: number | null;
}

export interface UserWithUsageRow extends UserRow {
    total_cost_usd: number | null;
    total_requests: number | null;
}

export interface DeviceCodeRow {
    id: number;
    device_code: string;
    user_code: string;
    user_id: number | null;
    status: string;
    expires_at: string;
    created_at: string;
}

// --- Period helpers ---

export function getCurrentPeriodStart(): string {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export function getNextPeriodStart(): string {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

// --- User queries ---

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
    return db.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first<UserRow>();
}

export async function findUserById(db: D1Database, id: number): Promise<UserRow | null> {
    return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function createUser(db: D1Database, data: {
    email: string; passwordHash: string; salt: string; emailVerified?: boolean;
}): Promise<UserRow> {
    const result = await db.prepare(
        'INSERT INTO users (email, password_hash, salt, email_verified) VALUES (?, ?, ?, ?) RETURNING *'
    ).bind(
        data.email.toLowerCase(), data.passwordHash, data.salt, data.emailVerified ? 1 : 0,
    ).first<UserRow>();
    return result!;
}

export async function updateUser(db: D1Database, id: number, updates: { passwordHash?: string; salt?: string }): Promise<UserRow | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    if (updates.passwordHash !== undefined && updates.salt !== undefined) {
        setClauses.push('password_hash = ?'); values.push(updates.passwordHash);
        setClauses.push('salt = ?'); values.push(updates.salt);
    }
    if (setClauses.length === 0) return findUserById(db, id);
    values.push(id);
    return db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`).bind(...values).first<UserRow>();
}

export async function deleteUser(db: D1Database, id: number): Promise<boolean> {
    const result = await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
}

export async function findAllUsers(db: D1Database): Promise<UserRow[]> {
    const result = await db.prepare('SELECT * FROM users ORDER BY created_at DESC').all<UserRow>();
    return result.results;
}

export async function findAllUsersWithUsage(db: D1Database, periodStart: string): Promise<UserWithUsageRow[]> {
    const result = await db.prepare(`
        SELECT u.*, up.total_cost_usd, up.total_requests
        FROM users u
        LEFT JOIN usage_periods up ON up.user_id = u.id AND up.period_start >= ?
        ORDER BY u.created_at DESC
    `).bind(periodStart).all<UserWithUsageRow>();
    return result.results;
}

// --- UsagePeriod queries ---

export async function upsertUsagePeriod(
    db: D1Database,
    userId: number,
    periodStart: string,
    periodEnd: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
): Promise<void> {
    await db.prepare(`
        INSERT INTO usage_periods (user_id, period_start, period_end, total_input_tokens, total_output_tokens, total_cost_usd, total_requests)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(user_id, period_start) DO UPDATE SET
            total_input_tokens  = total_input_tokens  + excluded.total_input_tokens,
            total_output_tokens = total_output_tokens + excluded.total_output_tokens,
            total_cost_usd      = total_cost_usd      + excluded.total_cost_usd,
            total_requests      = total_requests      + 1
    `).bind(userId, periodStart, periodEnd, inputTokens, outputTokens, costUsd).run();
}

export async function findCurrentUsagePeriod(db: D1Database, userId: number, periodStart: string): Promise<UsagePeriodRow | null> {
    return db.prepare(
        'SELECT * FROM usage_periods WHERE user_id = ? AND period_start >= ?'
    ).bind(userId, periodStart).first<UsagePeriodRow>();
}

// --- Hourly cost query ---

export async function getHourlyCost(db: D1Database, userId: number): Promise<{ totalCost: number; oldestTimestamp: string | null }> {
    const result = await db.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) as total_cost, MIN(created_at) as oldest_ts
        FROM request_logs
        WHERE user_id = ? AND created_at > datetime('now', '-1 hour')
    `).bind(userId).first<{ total_cost: number; oldest_ts: string | null }>();
    return { totalCost: result?.total_cost ?? 0, oldestTimestamp: result?.oldest_ts ?? null };
}

// --- RequestLog queries ---

export async function createRequestLog(
    db: D1Database,
    data: {
        userId: number; model: string; inputTokens: number; outputTokens: number;
        costUsd: number; durationMs: number;
        taskType?: string; turnIndex?: number; toolErrorCount?: number;
        repairCount?: number; cachedInputTokens?: number;
        // Phase-2/3 harness counters (P4, additive — see migration 0011).
        groundingLintHits?: number; loopGuardHits?: number; escalated?: boolean;
        groundingToolCalls?: number; groundingUnavailable?: number;
        lastTurnLatencyMs?: number | null;
    },
): Promise<void> {
    await db.prepare(
        `INSERT INTO request_logs
         (user_id, model, input_tokens, output_tokens, cost_usd, duration_ms,
          task_type, turn_index, tool_error_count, repair_count, cached_input_tokens,
          grounding_lint_hits, loop_guard_hits, escalated, grounding_tool_calls,
          grounding_unavailable, last_turn_latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        data.userId, data.model, data.inputTokens, data.outputTokens, data.costUsd, data.durationMs,
        data.taskType ?? null, data.turnIndex ?? null, data.toolErrorCount ?? null,
        data.repairCount ?? null, data.cachedInputTokens ?? null,
        data.groundingLintHits ?? null, data.loopGuardHits ?? null,
        data.escalated === undefined ? null : data.escalated ? 1 : 0,
        data.groundingToolCalls ?? null, data.groundingUnavailable ?? null,
        data.lastTurnLatencyMs ?? null,
    ).run();
}

export async function findRecentRequestLogs(db: D1Database, userId: number, limit = 50): Promise<RequestLogRow[]> {
    const result = await db.prepare(
        'SELECT * FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(userId, limit).all<RequestLogRow>();
    return result.results;
}

// --- Feedback types & queries ---

export interface FeedbackRow {
    id: number;
    rating: number;
    message: string;
    email: string;
    category: string;
    created_at: string;
}

export async function createFeedback(
    db: D1Database,
    data: { rating: number; message: string; email?: string; category?: string },
): Promise<FeedbackRow> {
    const result = await db.prepare(
        'INSERT INTO feedback (rating, message, email, category) VALUES (?, ?, ?, ?) RETURNING *'
    ).bind(data.rating, data.message, data.email ?? '', data.category ?? 'general').first<FeedbackRow>();
    return result!;
}

export async function findAllFeedback(db: D1Database, limit = 100): Promise<FeedbackRow[]> {
    const result = await db.prepare(
        'SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all<FeedbackRow>();
    return result.results;
}

// --- Unity API signature queries ---

export interface UnityApiSignatureRow {
    id: number;
    unity_version: string;
    namespace: string;
    type: string;
    member: string;
    kind: string;
    signature: string;
    overloads_json: string | null;
    assembly: string | null;
    deprecated: number;
    obsolete_message: string | null;
    doc_url: string | null;
}

/** One signature record as supplied by the ingest job. */
export interface UnityApiRecord {
    unityVersion: string;
    namespace?: string;
    type: string;
    member: string;
    kind: string;
    signature: string;
    overloads?: string[];
    assembly?: string;
    deprecated?: boolean;
    obsoleteMessage?: string;
    docUrl?: string;
}

/** Exact signature lookup. With `member`, returns that member's row(s); without, all members of the type. */
export async function lookupUnitySignatures(
    db: D1Database,
    unityVersion: string,
    type: string,
    member?: string,
    limit = 200,
): Promise<UnityApiSignatureRow[]> {
    if (member) {
        const result = await db.prepare(
            `SELECT * FROM unity_api_signatures
             WHERE unity_version = ? AND type = ? AND member = ? COLLATE NOCASE
             ORDER BY kind LIMIT ?`,
        ).bind(unityVersion, type, member, limit).all<UnityApiSignatureRow>();
        return result.results;
    }
    const result = await db.prepare(
        `SELECT * FROM unity_api_signatures
         WHERE unity_version = ? AND type = ? COLLATE NOCASE
         ORDER BY member LIMIT ?`,
    ).bind(unityVersion, type, limit).all<UnityApiSignatureRow>();
    return result.results;
}

/** Deterministic name search (LIKE) — the fallback when Vectorize is cold/empty. */
export async function searchUnitySignaturesByName(
    db: D1Database,
    unityVersion: string,
    query: string,
    limit = 12,
): Promise<UnityApiSignatureRow[]> {
    const like = `%${query.replace(/[%_]/g, '')}%`;
    const result = await db.prepare(
        `SELECT * FROM unity_api_signatures
         WHERE unity_version = ? AND (type LIKE ? OR member LIKE ? OR signature LIKE ?)
         ORDER BY (type = ? COLLATE NOCASE) DESC, length(member) ASC LIMIT ?`,
    ).bind(unityVersion, like, like, like, query, limit).all<UnityApiSignatureRow>();
    return result.results;
}

/** List deprecated APIs for a version — powers migrations / version upgrades. */
export async function listDeprecatedUnityApis(
    db: D1Database,
    unityVersion: string,
    limit = 1000,
): Promise<UnityApiSignatureRow[]> {
    const result = await db.prepare(
        `SELECT * FROM unity_api_signatures
         WHERE unity_version = ? AND deprecated = 1 ORDER BY type, member LIMIT ?`,
    ).bind(unityVersion, limit).all<UnityApiSignatureRow>();
    return result.results;
}

/** Idempotent batch upsert (UNIQUE(unity_version,type,member,kind) → INSERT OR REPLACE). */
export async function upsertUnitySignatures(db: D1Database, records: UnityApiRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const stmt = db.prepare(
        `INSERT OR REPLACE INTO unity_api_signatures
         (unity_version, namespace, type, member, kind, signature, overloads_json, assembly, deprecated, obsolete_message, doc_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const batch = records.map((r) => stmt.bind(
        r.unityVersion,
        r.namespace ?? '',
        r.type,
        r.member,
        r.kind,
        r.signature,
        r.overloads && r.overloads.length ? JSON.stringify(r.overloads) : null,
        r.assembly ?? null,
        r.deprecated ? 1 : 0,
        r.obsoleteMessage ?? null,
        r.docUrl ?? null,
    ));
    await db.batch(batch);
    return records.length;
}

/** Clear all signatures for a version (used by ingest `reset`). */
export async function deleteUnitySignaturesForVersion(db: D1Database, unityVersion: string): Promise<number> {
    const result = await db.prepare('DELETE FROM unity_api_signatures WHERE unity_version = ?').bind(unityVersion).run();
    return result.meta.changes;
}

// --- Device code queries ---

export async function createDeviceCode(
    db: D1Database,
    data: { deviceCode: string; userCode: string; expiresAt: string },
): Promise<DeviceCodeRow> {
    const result = await db.prepare(
        'INSERT INTO device_codes (device_code, user_code, expires_at) VALUES (?, ?, ?) RETURNING *'
    ).bind(data.deviceCode, data.userCode, data.expiresAt).first<DeviceCodeRow>();
    return result!;
}

export async function findDeviceCodeByDeviceCode(db: D1Database, deviceCode: string): Promise<DeviceCodeRow | null> {
    return db.prepare('SELECT * FROM device_codes WHERE device_code = ?').bind(deviceCode).first<DeviceCodeRow>();
}

export async function findDeviceCodeByUserCode(db: D1Database, userCode: string): Promise<DeviceCodeRow | null> {
    return db.prepare('SELECT * FROM device_codes WHERE user_code = ?').bind(userCode).first<DeviceCodeRow>();
}

export async function authorizeDeviceCode(db: D1Database, userCode: string, userId: number): Promise<boolean> {
    const result = await db.prepare(
        "UPDATE device_codes SET status = 'authorized', user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > datetime('now')"
    ).bind(userId, userCode).run();
    return result.meta.changes > 0;
}

export async function deleteDeviceCode(db: D1Database, id: number): Promise<void> {
    await db.prepare('DELETE FROM device_codes WHERE id = ?').bind(id).run();
}

export async function cleanExpiredDeviceCodes(db: D1Database): Promise<void> {
    await db.prepare("DELETE FROM device_codes WHERE expires_at < datetime('now')").run();
}

// --- OAuth / verification user helpers ---

export async function findUserByGoogleSub(db: D1Database, googleSub: string): Promise<UserRow | null> {
    return db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(googleSub).first<UserRow>();
}

/** Links a Google subject to an existing account. Google verified the email
 *  ownership, so this also marks the account verified. */
export async function linkGoogleSub(db: D1Database, userId: number, googleSub: string): Promise<UserRow | null> {
    return db.prepare(
        'UPDATE users SET google_sub = ?, email_verified = 1 WHERE id = ? RETURNING *'
    ).bind(googleSub, userId).first<UserRow>();
}

/**
 * Link a Google identity onto a row that was NEVER email-verified. The
 * pre-existing password cannot be trusted (anyone could have set it before
 * the real mailbox owner arrived via Google), so it is cleared to the
 * OAuth-only sentinel and token_version is bumped to revoke any pre-link
 * sessions. Verified rows use linkGoogleSub instead — verification proved
 * mailbox ownership, so their password is legitimate.
 */
export async function linkGoogleSubClearingCredentials(db: D1Database, userId: number, googleSub: string): Promise<UserRow | null> {
    const row = await db.prepare(
        "UPDATE users SET google_sub = ?, email_verified = 1, password_hash = '', salt = '', token_version = token_version + 1 WHERE id = ? RETURNING *"
    ).bind(googleSub, userId).first<UserRow>();
    return row ?? null;
}

/** Google-only signup: '' password sentinel (column is NOT NULL), pre-verified. */
export async function createOAuthUser(db: D1Database, data: { email: string; googleSub: string }): Promise<UserRow> {
    const result = await db.prepare(
        "INSERT INTO users (email, password_hash, salt, email_verified, google_sub) VALUES (?, '', '', 1, ?) RETURNING *"
    ).bind(data.email.toLowerCase(), data.googleSub).first<UserRow>();
    return result!;
}

export async function setEmailVerified(db: D1Database, userId: number): Promise<UserRow | null> {
    return db.prepare('UPDATE users SET email_verified = 1 WHERE id = ? RETURNING *')
        .bind(userId).first<UserRow>();
}

/** Sets a new password AND bumps token_version — revokes every session. */
export async function updatePasswordBumpVersion(
    db: D1Database, userId: number, passwordHash: string, salt: string,
): Promise<UserRow | null> {
    return db.prepare(
        'UPDATE users SET password_hash = ?, salt = ?, token_version = token_version + 1 WHERE id = ? RETURNING *'
    ).bind(passwordHash, salt, userId).first<UserRow>();
}

export async function bumpTokenVersion(db: D1Database, userId: number): Promise<UserRow | null> {
    return db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ? RETURNING *')
        .bind(userId).first<UserRow>();
}

// --- One-time auth token queries (auth_tokens, migration 0012) ---

export interface AuthTokenRow {
    id: number;
    user_id: number;
    purpose: string;
    token_hash: string;
    meta: string | null;
    expires_at: string;
    consumed_at: string | null;
    created_at: string;
}

/** expires_at is computed SQL-side (datetime('now', '+N seconds')) so the
 *  format always matches the datetime('now') comparisons in consume/clean. */
export async function createAuthToken(db: D1Database, data: {
    userId: number; purpose: TokenPurpose; tokenHash: string; ttlSeconds: number; meta?: string;
}): Promise<AuthTokenRow> {
    const result = await db.prepare(
        `INSERT INTO auth_tokens (user_id, purpose, token_hash, meta, expires_at)
         VALUES (?, ?, ?, ?, datetime('now', ?)) RETURNING *`
    ).bind(
        data.userId, data.purpose, data.tokenHash, data.meta ?? null, `+${data.ttlSeconds} seconds`,
    ).first<AuthTokenRow>();
    return result!;
}

/** Atomic single-use consume: only one caller can ever win the UPDATE, even
 *  when two requests race — D1 serializes writes and the consumed_at IS NULL
 *  predicate makes the second UPDATE match zero rows. */
export async function consumeAuthToken(
    db: D1Database, purpose: TokenPurpose, tokenHash: string,
): Promise<AuthTokenRow | null> {
    return db.prepare(
        `UPDATE auth_tokens SET consumed_at = datetime('now')
         WHERE purpose = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')
         RETURNING *`
    ).bind(purpose, tokenHash).first<AuthTokenRow>();
}

/** Resend/abuse throttle: tokens minted in the last hour (consumed or not). */
export async function countRecentAuthTokens(
    db: D1Database, userId: number, purpose: TokenPurpose,
): Promise<number> {
    const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM auth_tokens
         WHERE user_id = ? AND purpose = ? AND created_at > datetime('now', '-1 hour')`
    ).bind(userId, purpose).first<{ n: number }>();
    return row?.n ?? 0;
}

/** Opportunistic cleanup — mirrors cleanExpiredDeviceCodes. */
export async function cleanExpiredAuthTokens(db: D1Database): Promise<void> {
    await db.prepare("DELETE FROM auth_tokens WHERE expires_at < datetime('now')").run();
}
