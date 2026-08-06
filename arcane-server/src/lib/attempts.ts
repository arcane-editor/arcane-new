// editor_attempts queries (migration 0016). Kept out of db.ts, which is
// already 630 lines and covers a different concern.
//
// One attempt row backs an entire editor sign-in: it is created by the app
// (carrying the PKCE challenge), authorized by the website (attaching the
// user and a one-time grant code), and finally consumed by exactly ONE of the
// delivery channels — deep link / loopback via the code, or the poll endpoint
// via the attempt id. Both consume paths use the same `consumed_at IS NULL`
// predicate, so a race between them can only ever have one winner.

export interface EditorAttemptRow {
    attempt_id: string;
    challenge: string;
    status: string;
    user_id: number | null;
    code_hash: string | null;
    code_expires_at: string | null;
    consumed_at: string | null;
    expires_at: string;
    created_at: string;
}

export interface EditorAttemptPeek extends EditorAttemptRow {
    /** 1 when expires_at is still in the future. Computed SQL-side — see below. */
    is_live: number;
}

/** 10 minutes — matches the editor's LOGIN_TIMEOUT_MS so a client-side
 *  timeout and a server-side expiry can never disagree. Bounds the poll
 *  channel, i.e. how long the app may keep asking. */
export const ATTEMPT_TTL_SECONDS = 600;

/** 60 seconds — the grant code's own life, unchanged from the pre-0016
 *  auth_tokens flow. Much shorter than the attempt because the code travels
 *  in a browser-visible callback URL. */
export const CODE_TTL_SECONDS = 60;

/** expires_at is computed SQL-side (datetime('now', '+N seconds')) so its
 *  format always matches the datetime('now') comparisons below. */
export async function createAttempt(
    db: D1Database, challenge: string, ttlSeconds: number = ATTEMPT_TTL_SECONDS,
): Promise<string> {
    const attemptId = crypto.randomUUID();
    await db.prepare(
        `INSERT INTO editor_attempts (attempt_id, challenge, expires_at)
         VALUES (?, ?, datetime('now', ?))`
    ).bind(attemptId, challenge, `+${ttlSeconds} seconds`).run();
    return attemptId;
}

/**
 * Peek without consuming — the poll endpoint needs to distinguish "still
 * pending" (keep waiting) from "dead" without burning a live attempt.
 *
 * `is_live` is computed SQL-side deliberately: expires_at is SQLite's
 * `YYYY-MM-DD HH:MM:SS`, which does NOT compare correctly against a JS
 * `new Date().toISOString()` (that has a `T` separator and a trailing `Z`,
 * both of which sort above a space and a digit). Comparing them in JS looks
 * right and is wrong.
 */
export async function findAttempt(db: D1Database, attemptId: string): Promise<EditorAttemptPeek | null> {
    return db.prepare(
        `SELECT *, (expires_at > datetime('now')) AS is_live
         FROM editor_attempts WHERE attempt_id = ?`
    ).bind(attemptId).first<EditorAttemptPeek>();
}

/** Bind a user + grant code to a still-pending, still-live attempt. False when
 *  it is unknown, expired, already authorized, or already consumed. */
export async function authorizeAttempt(
    db: D1Database, attemptId: string, userId: number, codeHash: string,
    codeTtlSeconds: number = CODE_TTL_SECONDS,
): Promise<boolean> {
    const res = await db.prepare(
        `UPDATE editor_attempts
         SET status = 'authorized', user_id = ?, code_hash = ?,
             code_expires_at = datetime('now', ?)
         WHERE attempt_id = ? AND status = 'pending' AND consumed_at IS NULL
           AND expires_at > datetime('now')`
    ).bind(userId, codeHash, `+${codeTtlSeconds} seconds`, attemptId).run();
    return res.meta.changes > 0;
}

/** Atomic single-use consume by grant code (deep-link / loopback / paste).
 *  Enforces the CODE's 60s expiry, which is stricter than the attempt's. */
export async function consumeAttemptByCode(
    db: D1Database, codeHash: string,
): Promise<EditorAttemptRow | null> {
    return db.prepare(
        `UPDATE editor_attempts SET consumed_at = datetime('now')
         WHERE code_hash = ? AND status = 'authorized' AND consumed_at IS NULL
           AND code_expires_at > datetime('now')
         RETURNING *`
    ).bind(codeHash).first<EditorAttemptRow>();
}

/** Atomic single-use consume by attempt id (poll channel). Same guarantee. */
export async function consumeAttemptById(
    db: D1Database, attemptId: string,
): Promise<EditorAttemptRow | null> {
    return db.prepare(
        `UPDATE editor_attempts SET consumed_at = datetime('now')
         WHERE attempt_id = ? AND status = 'authorized' AND consumed_at IS NULL
           AND expires_at > datetime('now')
         RETURNING *`
    ).bind(attemptId).first<EditorAttemptRow>();
}

/** Opportunistic cleanup — mirrors cleanExpiredAuthTokens. */
export async function cleanExpiredAttempts(db: D1Database): Promise<void> {
    await db.prepare("DELETE FROM editor_attempts WHERE expires_at < datetime('now')").run();
}
