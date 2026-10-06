import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminToken, authedGet, jsonPost, seedPasswordUser, tokenFor } from './helpers.ts';
import { recordAcquisition } from '../src/lib/acquisition.ts';
import { reportRange } from '../src/lib/acquisition-report.ts';

function registration(channel: 'release' | 'dev' = 'release') {
    return { installId: crypto.randomUUID(), installProof: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
        os: 'windows', appVersion: '0.3.3', channel };
}
async function row(installId: string) {
    return env.arcane_db.prepare('SELECT * FROM install_activations WHERE install_id = ?')
        .bind(installId).first<Record<string, unknown>>();
}

describe('first successful Unity activation', () => {
    it('enrolls without fabricating a legacy install or advertising conversion, pins proof and original details', async () => {
        const data = registration();
        expect((await jsonPost('/v1/install/register', data)).status).toBe(202);
        expect((await jsonPost('/v1/install/register', { ...data, appVersion: '9.9.9' })).status).toBe(202);
        const record = (await row(data.installId))!;
        expect(record.proof_hash).not.toBe(data.installProof);
        expect(record.app_version).toBe('0.3.3');
        expect(record.activated_at).toBeNull();
        expect(await env.arcane_db.prepare('SELECT * FROM app_installs WHERE install_id = ?').bind(data.installId).first()).toBeNull();
        expect(await env.arcane_db.prepare('SELECT * FROM reddit_conversions WHERE install_id = ?').bind(data.installId).first()).toBeNull();
        expect((await jsonPost('/v1/install/register', { ...data, installProof: 'a'.repeat(64) })).status).toBe(409);
    });

    it('requires enrollment and its proof; ignores caller user ids', async () => {
        const data = registration();
        expect((await jsonPost('/v1/install/activation', data)).status).toBe(409);
        await jsonPost('/v1/install/register', data);
        expect((await jsonPost('/v1/install/activation', { ...data, installProof: 'b'.repeat(64) })).status).toBe(403);
        expect((await jsonPost('/v1/install/activation', { ...data, userId: 1 })).status).toBe(202);
        expect((await row(data.installId))!.user_id).toBeNull();
    });

    it('preserves earliest activation under retries and never overwrites authenticated ownership', async () => {
        const data = registration();
        const first = await seedPasswordUser('activation-first@test.dev', 'password123');
        const other = await seedPasswordUser('activation-other@test.dev', 'password123');
        await jsonPost('/v1/install/register', data);
        await jsonPost('/v1/install/activation', data);
        await env.arcane_db.prepare("UPDATE install_activations SET activated_at = '2026-01-01 00:00:00' WHERE install_id = ?").bind(data.installId).run();
        await jsonPost('/v1/install/associate', data, await tokenFor(first));
        await jsonPost('/v1/install/associate', data, await tokenFor(other));
        await jsonPost('/v1/install/activation', data, await tokenFor(other));
        const record = (await row(data.installId))!;
        expect(record.activated_at).toBe('2026-01-01 00:00:00');
        expect(record.user_id).toBe(first.id);
        await env.arcane_db.prepare('DELETE FROM users WHERE id = ?').bind(first.id).run();
        await jsonPost('/v1/install/associate', data, await tokenFor(other));
        await jsonPost('/v1/install/activation', data, await tokenFor(other));
        expect((await row(data.installId))!.user_id).toBeNull();
    });

    it('accepts optional valid auth at activation and rejects revoked/invalid auth', async () => {
        const data = registration();
        const user = await seedPasswordUser('activation-login@test.dev', 'password123');
        const token = await tokenFor(user);
        await jsonPost('/v1/install/register', data);
        expect((await jsonPost('/v1/install/activation', data, 'invalid')).status).toBe(401);
        expect((await row(data.installId))!.activated_at).toBeNull();
        expect((await jsonPost('/v1/install/activation', data, token)).status).toBe(202);
        expect((await row(data.installId))!.user_id).toBe(user.id);
        await env.arcane_db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').bind(user.id).run();
        expect((await jsonPost('/v1/install/associate', data, token)).status).toBe(401);
        expect((await jsonPost('/v1/install/associate', data)).status).toBe(401);
    });

    it('rejects malformed and oversized payloads', async () => {
        for (const body of [null, [], {}, { ...registration(), installProof: 'short' }, { ...registration(), channel: 'unknown' }]) {
            expect((await jsonPost('/v1/install/register', body)).status).toBe(400);
        }
        expect((await jsonPost('/v1/install/register', { ...registration(), junk: 'x'.repeat(3000) })).status).toBe(413);
    });
});

describe('acquisition report', () => {
    it('requires admin and validates UTC date windows including impossible dates', async () => {
        expect((await SELF.fetch('https://example.com/v1/admin/acquisition-report')).status).toBe(401);
        const token = await adminToken();
        expect((await authedGet('/v1/admin/acquisition-report?to=invalid', token)).status).toBe(400);
        expect(reportRange('2026-02-30', '2026-03-15')).toBeNull();
        expect(reportRange('2026-01-01', '2028-01-01')).toBeNull();
    });

    it('deduplicates people across installs, excludes dev, keeps anonymous and unattributed separate', async () => {
        const user = await seedPasswordUser('organic-activation@test.dev', 'password123');
        await recordAcquisition(env.arcane_db, user.id, { source: 'google', medium: 'organic', landingPath: '/blog/unity-guide/' });
        const userToken = await tokenFor(user);
        for (const [channel, token] of [['release', userToken], ['release', userToken], ['release', undefined], ['dev', userToken]] as const) {
            const data = registration(channel);
            await jsonPost('/v1/install', data);
            await jsonPost('/v1/install/register', data);
            await jsonPost('/v1/install/activation', data, token);
            await env.arcane_db.prepare("UPDATE app_installs SET created_at = '2026-01-05 12:00:00' WHERE install_id = ?").bind(data.installId).run();
            await env.arcane_db.prepare("UPDATE install_activations SET registered_at = '2026-01-05 12:00:00', activated_at = '2026-01-06 12:00:00' WHERE install_id = ?").bind(data.installId).run();
        }
        const unactivated = registration();
        await jsonPost('/v1/install', unactivated);
        await env.arcane_db.prepare("UPDATE app_installs SET created_at = '2026-01-05 12:00:00' WHERE install_id = ?").bind(unactivated.installId).run();
        const res = await authedGet('/v1/admin/acquisition-report?from=2026-01-05&to=2026-02-01', await adminToken());
        const report = await res.json<{ weekly: Record<string, unknown>[]; acquisition: Record<string, unknown>[]; mature7DayCohort: Record<string, unknown> }>();
        expect(report.weekly).toEqual([{ weekStart: '2026-01-05', firstLaunches: 4, measurementEnrollments: 3, activatedInstalls: 3, identifiedActivatedUsers: 1, unlinkedActivatedInstalls: 1 }]);
        expect(report.acquisition).toEqual([{ source: 'google', medium: 'organic', landingPath: '/blog/unity-guide/', identifiedActivatedUsers: 1 }]);
        expect(report.mature7DayCohort).toEqual({ eligibleFirstLaunches: 4, activatedWithin7Days: 3, activationReceiptOrderGaps: 0 });
    });

    it('exposes out-of-order receipt timing and does not infer timely activation from a late offline report', async () => {
        for (const receipt of ['2026-01-31 12:00:00', '2026-02-12 12:00:00']) {
            const data = registration();
            await jsonPost('/v1/install', data);
            await jsonPost('/v1/install/register', data);
            await jsonPost('/v1/install/activation', data);
            await env.arcane_db.prepare("UPDATE app_installs SET created_at = '2026-02-01 12:00:00' WHERE install_id = ?").bind(data.installId).run();
            await env.arcane_db.prepare('UPDATE install_activations SET activated_at = ? WHERE install_id = ?').bind(receipt, data.installId).run();
        }
        const res = await authedGet('/v1/admin/acquisition-report?from=2026-02-01&to=2026-02-02', await adminToken());
        const report = await res.json<{ mature7DayCohort: Record<string, number>; notes: string[] }>();
        expect(report.mature7DayCohort).toEqual({ eligibleFirstLaunches: 2, activatedWithin7Days: 0, activationReceiptOrderGaps: 1 });
        expect(report.notes.some((note) => note.includes('server receipt times'))).toBe(true);
    });
});
