let warnedNoSecret = false;

/** Server-side Turnstile verification (siteverify). When TURNSTILE_SECRET is
 *  not provisioned yet, verification is SKIPPED (returns true) and logged
 *  once per isolate — the owner creates the widget later. */
export async function verifyTurnstile(
    secret: string | undefined,
    token: string | undefined,
    ip: string | undefined,
): Promise<boolean> {
    if (!secret) {
        if (!warnedNoSecret) {
            warnedNoSecret = true;
            console.warn(JSON.stringify({ event: 'auth_turnstile_skipped', reason: 'no_secret' }));
        }
        return true;
    }
    if (!token) { return false; }
    const body = new URLSearchParams({ secret, response: token });
    if (ip) { body.set('remoteip', ip); }
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
    });
    if (!res.ok) { return false; }
    const data = await res.json() as { success?: boolean };
    return data.success === true;
}
