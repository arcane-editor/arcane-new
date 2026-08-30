import { describe, it, expect, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { clearConfigCache, putConfigDoc } from '../src/lib/app-config.ts';
import type { ModelRoutingDoc } from '../src/lib/app-config.ts';
import { SSE_HEARTBEAT_FRAME } from '../src/lib/sse-heartbeat.ts';

// The route-level half of the "Stream stalled before the first token" fix
// (the timer's own behaviour is unit-tested in sse-heartbeat.test.ts).
//
// What broke: `streamSSE` gives the client its response headers immediately,
// but the first body byte only arrives with the model's first token. The
// editor's first-token watchdog starts on those headers, so it was timing
// model latency instead of connection health and killing slow turns.
//
// The test env has no AI binding, so the provider call fails at once — which
// is exactly what makes this a sharp test: the keepalive must already be on
// the wire BEFORE the upstream is even reached, so it shows up even here.

/** Every model is a '@cf/' id so the provider call fails synchronously with
 *  no network egress — same reasoning as chat-metering.test.ts's override. */
const CF_ONLY_ROUTING: ModelRoutingDoc = {
    tiers: {
        low: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        mid: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        high: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
    },
    inline: '@cf/qwen/qwen3-30b-a3b-fp8',
};

async function resetModelRouting(): Promise<void> {
    await env.arcane_db.prepare("DELETE FROM app_config WHERE key = 'model_routing'").run();
    clearConfigCache();
}

afterEach(resetModelRouting);

async function openStream(email: string): Promise<Response> {
    const user = await seedPasswordUser(email, 'password123');
    await env.arcane_db.prepare(
        "UPDATE users SET plan = 'pro', plan_credits_micro = 5000000, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
    ).bind(user.id).run();
    const token = await tokenFor(user);
    await putConfigDoc(env.arcane_db, 'model_routing', CF_ONLY_ROUTING);

    return SELF.fetch('https://example.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
}

describe('chat SSE keepalive', () => {
    it('puts a keepalive frame on the wire before anything the model produces', async () => {
        const res = await openStream('keepalive-first@test.dev');
        expect(res.status).toBe(200);

        const body = await res.text();

        // The heartbeat leads the stream — this is the assertion that the
        // client's first-token watchdog now has something to see while the
        // model is still thinking.
        expect(body.startsWith(SSE_HEARTBEAT_FRAME)).toBe(true);

        // ...and it lands strictly before any `data:` frame, not merely
        // somewhere in the body.
        const firstData = body.indexOf('data:');
        expect(firstData).toBeGreaterThan(-1);
        expect(body.indexOf(SSE_HEARTBEAT_FRAME)).toBeLessThan(firstData);
    });

    it('sends the keepalive as a comment the editor parser will not mistake for an event', async () => {
        const res = await openStream('keepalive-comment@test.dev');
        const body = await res.text();

        // `hosted-stream.ts` counts unparseable `data:` lines as corruption.
        // A keepalive that ever looked like one would turn every slow turn
        // into "Response corrupted" — strictly worse than the bug being fixed.
        const dataLines = body.split('\n').filter((l) => l.startsWith('data: '));
        for (const line of dataLines) {
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            expect(() => JSON.parse(payload)).not.toThrow();
        }
    });

    it('asks intermediaries not to buffer or compress the stream', async () => {
        const res = await openStream('keepalive-headers@test.dev');

        // A gzip encoder holds a 13-byte heartbeat back until it has a block
        // worth flushing, and a buffering proxy holds it indefinitely —
        // either one silently undoes the fix on exactly the dirty networks
        // (corporate egress, TLS-inspecting AV) where it matters most.
        expect(res.headers.get('Cache-Control')).toContain('no-transform');
        expect(res.headers.get('X-Accel-Buffering')).toBe('no');
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    });
});
