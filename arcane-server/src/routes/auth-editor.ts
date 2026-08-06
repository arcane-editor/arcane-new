import { Hono } from 'hono';
import { findUserById } from '../lib/db.ts';
import { authMiddleware, mintAuthResponse } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { generateToken, sha256Hex, s256Challenge } from '../lib/tokens.ts';
import {
    createAttempt, authorizeAttempt, consumeAttemptByCode, consumeAttemptById,
    findAttempt, cleanExpiredAttempts, ATTEMPT_TTL_SECONDS, CODE_TTL_SECONDS,
} from '../lib/attempts.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authEditorRouter = new Hono<AppEnv>();

// PKCE challenge: base64url, 43-128 chars (spec-fixed bounds).
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

// Step 0 (editor, public): register a PKCE-bound attempt BEFORE opening the
// browser. Storing the challenge server-side here is what lets the poll
// channel exist at all — it gives the app an id it can redeem against
// without the browser ever reaching it. Public by design: the app has no
// session yet, and the attempt is worthless without the matching verifier.
authEditorRouter.post('/v1/auth/editor/attempt', async (c) => {
    const body = await c.req.json<{ challenge?: string }>().catch(() => ({} as { challenge?: string }));
    if (typeof body.challenge !== 'string' || !CHALLENGE_RE.test(body.challenge)) {
        return c.json({ error: 'invalid_challenge' }, 400);
    }
    const db = c.env.arcane_db;
    await cleanExpiredAttempts(db);
    const attemptId = await createAttempt(db, body.challenge);
    return c.json({ attempt_id: attemptId, expires_in: ATTEMPT_TTL_SECONDS });
});

// Step 1 (website, logged in): attach this user and a fresh 60s one-time code
// to the attempt. Accepts `attempt_id` (current clients) or a bare `challenge`
// (older app builds, during dev rollout). The legacy form creates the attempt
// on the fly, so BOTH shapes share exactly one storage and one consume path —
// there is no second code store to keep in sync.
authEditorRouter.post('/v1/auth/editor/grant', authMiddleware(), async (c) => {
    const body = await c.req
        .json<{ attempt_id?: string; challenge?: string }>()
        .catch(() => ({} as { attempt_id?: string; challenge?: string }));
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;

    await cleanExpiredAttempts(db);

    let attemptId: string;
    if (typeof body.attempt_id === 'string' && body.attempt_id.length > 0) {
        attemptId = body.attempt_id;
    } else if (typeof body.challenge === 'string' && CHALLENGE_RE.test(body.challenge)) {
        attemptId = await createAttempt(db, body.challenge);
    } else {
        return c.json({ error: 'invalid_challenge' }, 400);
    }

    const rawCode = generateToken();
    const authorized = await authorizeAttempt(
        db, attemptId, parseInt(authUser.sub), await sha256Hex(rawCode),
    );
    if (!authorized) {
        // Unknown, expired, already authorized, or already consumed. One
        // error for all of them — no oracle telling which.
        return c.json({ error: 'invalid_attempt' }, 400);
    }

    logAuthEvent('editor_grant', { userId: authUser.sub });
    return c.json({ code: rawCode, expires_in: CODE_TTL_SECONDS });
});

// Step 2b (editor, public): the PULL channel. Covers environments where
// neither the custom scheme nor the loopback socket can deliver the callback —
// corporate/VPN setups that filter loopback sockets are the documented case
// (see the website's AuthSuccess page). Uses the SAME atomic consume as
// exchange, so exactly one channel can ever win a race between them.
//
// Every failure mode returns one opaque `invalid_attempt`, matching the
// exchange endpoint's no-oracle contract. The only distinguishable answer is
// 428, which merely says "not authorized yet" about an id the caller already
// holds — and reaching a session still requires the verifier.
authEditorRouter.post('/v1/auth/editor/poll', async (c) => {
    const body = await c.req
        .json<{ attempt_id?: string; verifier?: string }>()
        .catch(() => ({} as { attempt_id?: string; verifier?: string }));
    const { attempt_id: attemptId, verifier } = body;
    const invalid = () => c.json({ error: 'invalid_attempt' }, 400);
    if (typeof attemptId !== 'string' || !attemptId
        || typeof verifier !== 'string' || !verifier) {
        return invalid();
    }
    const db = c.env.arcane_db;

    // Peek before consuming: a still-pending attempt has to survive so the
    // app can keep polling it, so it must not go through the consuming
    // statement. `is_live` is computed SQL-side — see findAttempt.
    const peek = await findAttempt(db, attemptId);
    if (!peek || peek.consumed_at !== null || peek.is_live !== 1) { return invalid(); }
    if (peek.status === 'pending') {
        return c.json({ error: 'authorization_pending' }, 428);
    }

    const row = await consumeAttemptById(db, attemptId);
    if (!row || row.user_id === null) { return invalid(); }
    if (await s256Challenge(verifier) !== row.challenge) { return invalid(); }
    const user = await findUserById(db, row.user_id);
    if (!user) { return invalid(); }
    logAuthEvent('editor_poll_exchange', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

// Step 2 (editor, public): code + verifier → 30-day session JWT.
// ONE opaque error for every failure mode — no oracle distinguishing
// unknown/expired/replayed codes from wrong verifiers.
authEditorRouter.post('/v1/auth/editor/exchange', async (c) => {
    const body = await c.req
        .json<{ code?: string; verifier?: string }>()
        .catch(() => ({} as { code?: string; verifier?: string }));
    const { code, verifier } = body;
    const invalid = () => c.json({ error: 'invalid_code' }, 400);
    if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !verifier) {
        return invalid();
    }
    const db = c.env.arcane_db;
    // Consume FIRST: even a failed verifier attempt burns the code, so it
    // cannot be brute-forced against different verifiers.
    const row = await consumeAttemptByCode(db, await sha256Hex(code));
    if (!row || row.user_id === null) { return invalid(); }
    if (await s256Challenge(verifier) !== row.challenge) { return invalid(); }
    const user = await findUserById(db, row.user_id);
    if (!user) { return invalid(); }
    logAuthEvent('editor_exchange', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});
