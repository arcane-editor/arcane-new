// --- Row types (match D1/SQLite column names) ---

export interface UserRow {
    id: number;
    email: string;
    password_hash: string;
    salt: string;
    role: string;
    created_at: string;
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
    email: string; passwordHash: string; salt: string;
}): Promise<UserRow> {
    const result = await db.prepare(
        'INSERT INTO users (email, password_hash, salt) VALUES (?, ?, ?) RETURNING *'
    ).bind(
        data.email.toLowerCase(), data.passwordHash, data.salt,
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
    data: { userId: number; model: string; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number },
): Promise<void> {
    await db.prepare(
        'INSERT INTO request_logs (user_id, model, input_tokens, output_tokens, cost_usd, duration_ms) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(data.userId, data.model, data.inputTokens, data.outputTokens, data.costUsd, data.durationMs).run();
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
