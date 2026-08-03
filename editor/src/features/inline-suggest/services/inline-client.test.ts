import { describe, it, expect } from 'bun:test';
import { createInlineClient, type InlineResult } from './inline-client';

const REQ = { prefix: 'a', suffix: 'b', language: 'csharp' };
const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function clientWith(fetchImpl: typeof fetch, timeoutMs = 4000) {
    return createInlineClient({ fetchImpl, getToken: () => 'tok', baseUrl: 'https://x.test', timeoutMs });
}

describe('inline client', () => {
    it('returns text on 200', async () => {
        const c = clientWith(async () => ok({ text: 'foo();', model: 'm' }));
        expect(await c.fetchCompletion(REQ)).toEqual({ ok: true, text: 'foo();' });
    });

    it('auth result without a token — and never calls fetch', async () => {
        let called = false;
        const c = createInlineClient({ fetchImpl: async () => { called = true; return ok({}); }, getToken: () => null });
        expect(await c.fetchCompletion(REQ)).toEqual({ ok: false, reason: 'auth' });
        expect(called).toBe(false);
    });

    it('maps statuses: 401→auth, 429→quota(+resetAt), 500→server', async () => {
        const mk = (status: number, body: unknown) => clientWith(async () => ok(body, status));
        expect(await mk(401, {}).fetchCompletion(REQ)).toEqual({ ok: false, reason: 'auth' });
        const quota = await mk(429, { code: 'inline_quota', resetAt: '2099-01-01T00:00:00.000Z' }).fetchCompletion(REQ);
        expect(quota).toEqual({ ok: false, reason: 'quota', resetAt: '2099-01-01T00:00:00.000Z' });
        expect(await mk(500, {}).fetchCompletion(REQ)).toEqual({ ok: false, reason: 'server' });
    });

    it('network throw → offline', async () => {
        const c = clientWith(async () => { throw new TypeError('fetch failed'); });
        expect(await c.fetchCompletion(REQ)).toEqual({ ok: false, reason: 'offline' });
    });

    it('timeout → timeout result', async () => {
        const c = clientWith(((_url: string, init: RequestInit) =>
            new Promise((_, reject) => {
                init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            })) as unknown as typeof fetch, 30);
        expect(await c.fetchCompletion(REQ)).toEqual({ ok: false, reason: 'timeout' });
    });

    it('single-flight: a new request aborts the in-flight one', async () => {
        let firstSignal: AbortSignal | undefined;
        let call = 0;
        const c = clientWith(((_url: string, init: RequestInit) => {
            call += 1;
            if (call === 1) {
                firstSignal = init.signal!;
                return new Promise((_, reject) => {
                    init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                });
            }
            return Promise.resolve(ok({ text: 'second' }));
        }) as unknown as typeof fetch);
        const p1 = c.fetchCompletion(REQ);
        const p2 = c.fetchCompletion(REQ);
        const [r1, r2] = await Promise.all([p1, p2]) as InlineResult[];
        expect(firstSignal?.aborted).toBe(true);
        expect(r1).toEqual({ ok: false, reason: 'aborted' });
        expect(r2).toEqual({ ok: true, text: 'second' });
    });
});
