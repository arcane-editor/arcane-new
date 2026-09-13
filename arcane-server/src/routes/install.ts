import { Hono } from 'hono';
import { recordInstall } from '../lib/db.ts';
import { reportConversion } from '../lib/reddit.ts';
import type { AppEnv } from '../types.ts';

/**
 * `POST /v1/install` — the desktop app's first-run ping.
 *
 * PUBLIC by necessity: a first run happens before anyone signs in, and that is
 * the whole event. Requiring a token would report only the installs that also
 * converted to accounts, which is the signup metric we already have.
 *
 * It exists because Reddit has no app-install conversion for a web pixel, and
 * a download click is not an install — it counts bots, re-downloads and people
 * who never open the thing. This is the only signal that says someone actually
 * ran the product.
 *
 * Attribution is honest about its limits: the app carries no browser cookie, so
 * there is no click id here. Reddit matches on hashed IP and the install id,
 * which is probabilistic. The deterministic join happens later, if that user
 * signs in — the website has the click id in a first-party cookie and the
 * SignUp conversion carries it.
 */

export const installRouter = new Hono<AppEnv>();

/** Field caps. An install report is a fixed, tiny shape; anything larger is
 *  either a bug or someone poking at the endpoint. */
const LIMITS = {
    installId: 64,
    os: 32,
    appVersion: 32,
    channel: 16,
} as const;

/**
 * The install id must be a plain opaque token.
 *
 * It becomes a PRIMARY KEY and part of an `external_id` match key sent to a
 * third party. The app generates a UUID; this allows that shape and little
 * else, so a public endpoint cannot be used to write arbitrary strings into
 * either place.
 */
const INSTALL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Cap and coerce an optional descriptive field. Never rejects — a client that
 *  cannot name its own OS should still have its install counted. */
function cap(value: unknown, max: number): string {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

installRouter.post('/v1/install', async (c) => {
    let body: Record<string, unknown>;
    try {
        body = await c.req.json<Record<string, unknown>>();
    } catch {
        return c.json({ error: 'invalid_body' }, 400);
    }

    // Validated at full length, NOT capped like the descriptive fields below.
    // Truncating this one would map two distinct over-long ids onto the same
    // 64-character prefix — one install silently absorbing another's identity,
    // and with it the idempotency guard that stops a duplicate conversion.
    const installId = typeof body.installId === 'string' ? body.installId.trim() : '';
    if (!INSTALL_ID_RE.test(installId)) {
        return c.json({ error: 'invalid_install_id' }, 400);
    }

    const os = cap(body.os, LIMITS.os);
    const appVersion = cap(body.appVersion, LIMITS.appVersion);
    const channel = cap(body.channel, LIMITS.channel);

    // The idempotency gate. A reinstall, a restored home directory or a lost
    // flag file all re-send this; a duplicate Install conversion would train
    // the ad optimizer on a user who does not exist.
    const isFirstReport = await recordInstall(c.env.arcane_db, { installId, os, appVersion, channel });

    if (isFirstReport) {
        c.executionCtx.waitUntil(reportConversion(c.env, {
            eventName: 'Install',
            // Derived from the install id, so even a replay of this exact
            // conversion collapses on Reddit's side rather than inventing a
            // second machine.
            conversionId: `install:${installId}`,
            installId,
            externalId: installId,
            ipAddress: c.req.header('CF-Connecting-IP') ?? null,
            userAgent: c.req.header('User-Agent') ?? null,
        }));
    }

    // 202 and never an error: the client cannot act on a failure here, and a
    // retry loop from every desktop app would be worse than a lost datapoint.
    return c.json({ ok: true }, 202);
});
