import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { adminToken, authedGet } from './helpers.ts';

/**
 * `POST /v1/client-error` — desktop crash reports.
 *
 * The endpoint is deliberately PUBLIC: the AI panel can crash while the user
 * is signed out (that is the `!loggedIn` render path), so requiring a token
 * would drop exactly the reports we most need. Everything below is about the
 * consequences of that: it must never reject a real crash over a schema nit,
 * and it must not become an unbounded write amplifier.
 */

const VALID = {
    kind: 'react-error-boundary',
    message: "Cannot read properties of undefined (reading 'acp')",
    stack: 'TypeError: ...\n  at AgentPicker (index.js:1:2)',
    componentStack: '\n    at AgentPicker\n    at AiChatPanel',
    appVersion: '0.3.3',
    channel: 'dev',
    os: 'windows',
    sessionId: 'sess-abc',
};

function post(body: unknown, headers: Record<string, string> = {}) {
    return SELF.fetch('https://example.com/v1/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

describe('POST /v1/client-error', () => {
    it('accepts a report from an unauthenticated client', async () => {
        const res = await post(VALID);
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('persists the report so it can be read back later', async () => {
        await post({ ...VALID, message: 'persisted-marker' });

        const row = await env.arcane_db
            .prepare('SELECT * FROM client_errors WHERE message = ?')
            .bind('persisted-marker')
            .first<Record<string, unknown>>();

        expect(row).toBeTruthy();
        expect(row!.app_version).toBe('0.3.3');
        expect(row!.channel).toBe('dev');
        expect(row!.os).toBe('windows');
        expect(row!.kind).toBe('react-error-boundary');
        expect(row!.component_stack).toContain('AiChatPanel');
    });

    it('records no user_id when the request carries no token', async () => {
        await post({ ...VALID, message: 'anon-marker' });

        const row = await env.arcane_db
            .prepare('SELECT user_id FROM client_errors WHERE message = ?')
            .bind('anon-marker')
            .first<{ user_id: string | null }>();

        expect(row!.user_id).toBeNull();
    });

    it('rejects a report with no message', async () => {
        const res = await post({ ...VALID, message: '' });
        expect(res.status).toBe(400);
    });

    it('rejects a body that is not an object', async () => {
        const res = await post('nope');
        expect(res.status).toBe(400);
    });

    it('truncates an oversized stack rather than rejecting the report', async () => {
        const res = await post({
            ...VALID,
            message: 'oversized-marker',
            stack: 'x'.repeat(40_000),
        });
        expect(res.status).toBe(202);

        const row = await env.arcane_db
            .prepare('SELECT stack FROM client_errors WHERE message = ?')
            .bind('oversized-marker')
            .first<{ stack: string }>();

        // Capped, and says so — a silently clipped stack reads as a complete
        // one and sends the next reader hunting for a frame that was dropped.
        expect(row!.stack.length).toBeLessThanOrEqual(8_300);
        expect(row!.stack).toContain('truncated');
    });

    it('stores a report whose optional fields are all missing', async () => {
        // An early-boot crash may not know its own version yet. Losing that
        // report would be worse than storing it with blank metadata.
        const res = await post({ message: 'bare-marker' });
        expect(res.status).toBe(202);

        const row = await env.arcane_db
            .prepare('SELECT kind, app_version FROM client_errors WHERE message = ?')
            .bind('bare-marker')
            .first<{ kind: string; app_version: string }>();

        expect(row).toBeTruthy();
        expect(row!.kind).toBe('unknown');
    });
});

describe('GET /v1/admin/client-errors', () => {
    it('lists reports newest first', async () => {
        await post({ ...VALID, message: 'older-report' });
        await post({ ...VALID, message: 'newer-report' });

        const res = await authedGet('/v1/admin/client-errors', await adminToken());
        expect(res.status).toBe(200);

        const { clientErrors } = await res.json<{ clientErrors: Array<{ message: string }> }>();
        const messages = clientErrors.map((e) => e.message);
        expect(messages).toContain('newer-report');
        expect(messages.indexOf('newer-report')).toBeLessThan(messages.indexOf('older-report'));
    });

    it('refuses a request with no admin token', async () => {
        const res = await SELF.fetch('https://example.com/v1/admin/client-errors');
        expect(res.status).toBe(401);
    });
});
