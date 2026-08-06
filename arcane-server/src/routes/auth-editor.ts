import { Hono } from 'hono';
import {
    findUserById, createAuthToken, consumeAuthToken, cleanExpiredAuthTokens,
} from '../lib/db.ts';
import { authMiddleware, mintAuthResponse } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { generateToken, sha256Hex, s256Challenge, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import {
    createAttempt, authorizeAttempt, consumeAttemptByCode, consumeAttemptById,
    findAttempt, cleanExpiredAttempts, ATTEMPT_TTL_SECONDS,
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

// Step 1 (website, logged in): mint a 60s one-time code bound to the app's
// S256 challenge. The verifier never leaves the app.
authEditorRouter.post('/v1/auth/editor/grant', authMiddleware(), async (c) => {
    const { challenge } = await c.req.json<{ challenge?: string }>();
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) {
        return c.json({ error: 'invalid_challenge' }, 400);
    }
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;

    await cleanExpiredAuthTokens(db);
    const rawCode = generateToken();
    await createAuthToken(db, {
        userId: parseInt(authUser.sub),
        purpose: 'editor_login',
        tokenHash: await sha256Hex(rawCode),
        meta: JSON.stringify({ challenge }),
        ttlSeconds: TOKEN_TTL_SECONDS.editor_login,
    });
    logAuthEvent('editor_grant', { userId: authUser.sub });
    return c.json({ code: rawCode, expires_in: 60 });
});

// Step 2 (editor, public): code + verifier → 30-day session JWT.
// ONE opaque error for every failure mode — no oracle distinguishing
// unknown/expired/replayed codes from wrong verifiers.
authEditorRouter.post('/v1/auth/editor/exchange', async (c) => {
    const { code, verifier } = await c.req.json<{ code?: string; verifier?: string }>();
    const invalid = () => c.json({ error: 'invalid_code' }, 400);
    if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !verifier) {
        return invalid();
    }
    const db = c.env.arcane_db;
    // Consume FIRST: even a failed verifier attempt burns the code, so it
    // cannot be brute-forced against different verifiers.
    const row = await consumeAuthToken(db, 'editor_login', await sha256Hex(code));
    if (!row || !row.meta) { return invalid(); }
    let challenge: string | undefined;
    try {
        challenge = (JSON.parse(row.meta) as { challenge?: string }).challenge;
    } catch {
        return invalid();
    }
    if (!challenge || await s256Challenge(verifier) !== challenge) { return invalid(); }
    const user = await findUserById(db, row.user_id);
    if (!user) { return invalid(); }
    logAuthEvent('editor_exchange', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});
