import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';

/**
 * `POST /v1/install` — the desktop app's first-run ping.
 *
 * Public by necessity (a first run predates any account) and idempotent by
 * obligation: this endpoint mints an ad conversion, so a second report of the
 * same install is not a harmless duplicate row — it is a fabricated customer
 * in the campaign the optimizer learns from.
 */

const VALID = {
    installId: '11111111-2222-3333-4444-555555555555',
    os: 'windows',
    appVersion: '0.3.3',
    channel: 'release',
};

function post(body: unknown, headers: Record<string, string> = {}) {
    return SELF.fetch('https://example.com/v1/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

function installRow(installId: string) {
    return env.arcane_db
        .prepare('SELECT * FROM app_installs WHERE install_id = ?')
        .bind(installId)
        .first<Record<string, unknown>>();
}

async function conversionCount(installId: string): Promise<number> {
    const row = await env.arcane_db
        .prepare('SELECT COUNT(*) AS n FROM reddit_conversions WHERE install_id = ?')
        .bind(installId)
        .first<{ n: number }>();
    return row!.n;
}

describe('POST /v1/install', () => {
    it('accepts a first-run ping from an unauthenticated app', async () => {
        const res = await post({ ...VALID, installId: crypto.randomUUID() });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('records the install with its platform details', async () => {
        const installId = crypto.randomUUID();
        await post({ ...VALID, installId });

        const row = await installRow(installId);
        expect(row).toBeTruthy();
        expect(row!.os).toBe('windows');
        expect(row!.app_version).toBe('0.3.3');
        expect(row!.channel).toBe('release');
    });

    it('reports exactly one Install conversion for a new install', async () => {
        const installId = crypto.randomUUID();
        await post({ ...VALID, installId });

        expect(await conversionCount(installId)).toBe(1);
        const row = await env.arcane_db
            .prepare('SELECT * FROM reddit_conversions WHERE install_id = ?')
            .bind(installId)
            .first<Record<string, unknown>>();
        expect(row!.event_name).toBe('Install');
    });

    /**
     * The behaviour this endpoint exists to get right. A reinstall, a restored
     * home directory, or a lost flag file all re-send the same install id.
     */
    it('is idempotent: a repeated ping reports no second conversion', async () => {
        const installId = crypto.randomUUID();
        await post({ ...VALID, installId });
        await post({ ...VALID, installId });
        await post({ ...VALID, installId });

        expect(await conversionCount(installId)).toBe(1);
    });

    it('still answers 202 on a repeat, so the client does not retry forever', async () => {
        const installId = crypto.randomUUID();
        await post({ ...VALID, installId });
        expect((await post({ ...VALID, installId })).status).toBe(202);
    });

    it('keeps the first report’s details rather than overwriting them', async () => {
        const installId = crypto.randomUUID();
        await post({ ...VALID, installId, appVersion: '0.3.3' });
        await post({ ...VALID, installId, appVersion: '9.9.9' });

        expect((await installRow(installId))!.app_version).toBe('0.3.3');
    });

    describe('validation', () => {
        it.each([
            ['missing', undefined],
            ['empty', ''],
            ['too short', 'abc'],
            ['containing a path traversal', '../../etc/passwd'],
            ['containing SQL punctuation', "abc'; DROP TABLE users;--"],
            ['containing spaces', 'abc def ghi jkl'],
        ])('rejects an install id that is %s', async (_label, installId) => {
            const res = await post({ ...VALID, installId });
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'invalid_install_id' });
        });

        it('rejects a non-JSON body without throwing', async () => {
            const res = await SELF.fetch('https://example.com/v1/install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: 'not json',
            });
            expect(res.status).toBe(400);
        });

        it('accepts a report that cannot name its own platform', async () => {
            // A client that fails to detect its OS should still be counted —
            // the install happened either way.
            const installId = crypto.randomUUID();
            const res = await post({ installId });
            expect(res.status).toBe(202);
            expect((await installRow(installId))!.os).toBe('');
        });

        it('truncates oversized descriptive fields instead of rejecting the install', async () => {
            const installId = crypto.randomUUID();
            await post({ installId, os: 'x'.repeat(500) });
            expect(String((await installRow(installId))!.os)).toHaveLength(32);
        });

        /** Truncating instead would map two distinct over-long ids onto the
         *  same 64-character prefix, letting one install absorb another's
         *  identity — and defeating the idempotency guard in the process. */
        it('rejects an over-long install id rather than truncating it into a collision', async () => {
            const res = await post({ ...VALID, installId: 'a'.repeat(500) });
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'invalid_install_id' });
        });

        it('does not record anything for a rejected install id', async () => {
            await post({ ...VALID, installId: 'a'.repeat(500) });
            expect(await installRow('a'.repeat(64))).toBeNull();
        });
    });
});
