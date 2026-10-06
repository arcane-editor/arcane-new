import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../types.ts';
import { sha256Hex } from '../lib/tokens.ts';
import { digestsMatch } from '../lib/crypto.ts';
import { authMiddleware } from '../middleware/auth.ts';

export const activationRouter = new Hono<AppEnv>();
activationRouter.use('/v1/install/*', bodyLimit({ maxSize: 2048,
    onError: (c) => c.json({ error: 'body_too_large' }, 413),
}));

type Identity = { installId: string; installProof: string };
type Registration = Identity & { os: string; appVersion: string; channel: 'release' | 'dev' };

async function identity(c: Context<AppEnv>): Promise<Identity | null> {
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;
    return typeof row.installId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(row.installId)
        && typeof row.installProof === 'string' && /^[a-f0-9]{64}$/.test(row.installProof)
        ? { installId: row.installId, installProof: row.installProof } : null;
}

async function registration(c: Context<AppEnv>): Promise<Registration | null> {
    const id = await identity(c);
    if (!id) return null;
    const row = await c.req.json<Record<string, unknown>>();
    if (typeof row.os !== 'string' || !/^[a-z-]{1,32}$/.test(row.os)
        || typeof row.appVersion !== 'string' || !/^[A-Za-z0-9.+-]{1,32}$/.test(row.appVersion)
        || (row.channel !== 'release' && row.channel !== 'dev')) return null;
    return { ...id, os: row.os, appVersion: row.appVersion, channel: row.channel };
}

async function storedProof(c: Context<AppEnv>, id: Identity): Promise<'missing' | 'valid' | 'invalid'> {
    const row = await c.env.arcane_db.prepare('SELECT proof_hash FROM install_activations WHERE install_id = ?')
        .bind(id.installId).first<{ proof_hash: string }>();
    if (!row) return 'missing';
    return await digestsMatch(row.proof_hash, await sha256Hex(id.installProof)) ? 'valid' : 'invalid';
}

// Enrollment is trust-on-first-use, including old installs that predate proofs.
// Knowing an install UUID alone cannot mutate an already enrolled install.
activationRouter.post('/v1/install/register', async (c) => {
    const data = await registration(c);
    if (!data) return c.json({ error: 'invalid_registration' }, 400);
    await c.env.arcane_db.prepare(`INSERT OR IGNORE INTO install_activations
        (install_id, proof_hash, os, app_version, channel) VALUES (?, ?, ?, ?, ?)`)
        .bind(data.installId, await sha256Hex(data.installProof), data.os, data.appVersion, data.channel).run();
    if (await storedProof(c, data) !== 'valid') return c.json({ error: 'install_already_registered' }, 409);
    return c.json({ ok: true }, 202);
});

activationRouter.post('/v1/install/activation', async (c, next) => {
    if (c.req.header('Authorization')) return authMiddleware()(c, next);
    return next();
}, async (c) => {
    const data = await registration(c);
    if (!data) return c.json({ error: 'invalid_activation' }, 400);
    const proof = await storedProof(c, data);
    if (proof === 'missing') return c.json({ error: 'install_not_registered' }, 409);
    if (proof === 'invalid') return c.json({ error: 'invalid_install_proof' }, 403);
    const auth = c.get('user');
    const userId = auth ? Number(auth.sub) : null;
    // First timestamp and first authenticated owner win, even under concurrent
    // windows/retries. Public payload userId fields are deliberately ignored.
    await c.env.arcane_db.prepare(`UPDATE install_activations SET
        activated_at = COALESCE(activated_at, datetime('now')),
        user_id = CASE WHEN associated_at IS NULL THEN ? ELSE user_id END,
        associated_at = CASE WHEN associated_at IS NULL AND ? IS NOT NULL THEN datetime('now') ELSE associated_at END
        WHERE install_id = ?`)
        .bind(userId, userId, data.installId).run();
    return c.json({ ok: true }, 202);
});

activationRouter.post('/v1/install/associate', authMiddleware(), async (c) => {
    const data = await identity(c);
    if (!data) return c.json({ error: 'invalid_install_identity' }, 400);
    const proof = await storedProof(c, data);
    if (proof === 'missing') return c.json({ error: 'install_not_registered' }, 409);
    if (proof === 'invalid') return c.json({ error: 'invalid_install_proof' }, 403);
    await c.env.arcane_db.prepare(`UPDATE install_activations SET user_id = ?, associated_at = datetime('now')
        WHERE install_id = ? AND activated_at IS NOT NULL AND associated_at IS NULL`)
        .bind(Number(c.get('user').sub), data.installId).run();
    // Never reveal another account's identity or replace its association.
    return c.json({ ok: true }, 202);
});
