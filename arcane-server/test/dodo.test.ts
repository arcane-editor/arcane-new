import { describe, it, expect } from 'vitest';
import { verifyDodoWebhook, signDodoWebhook } from '../src/lib/dodo.ts';

const SECRET = 'c2VjcmV0LXRlc3Qtc2lnbmluZy1rZXk='; // base64 (matches wrangler.test.toml)

function nowTs(): string {
    return String(Math.floor(Date.now() / 1000));
}

describe('verifyDodoWebhook (Standard Webhooks HMAC)', () => {
    it('accepts a correctly-signed payload', async () => {
        const id = 'wh_1', ts = nowTs(), body = '{"type":"payment.succeeded"}';
        const sig = await signDodoWebhook(SECRET, id, ts, body);
        expect(await verifyDodoWebhook(SECRET, { id, timestamp: ts, signature: sig }, body)).toBe(true);
    });

    it('accepts a whsec_-prefixed secret (same underlying key)', async () => {
        const id = 'wh_2', ts = nowTs(), body = '{"a":1}';
        const sig = await signDodoWebhook(SECRET, id, ts, body);
        expect(await verifyDodoWebhook(`whsec_${SECRET}`, { id, timestamp: ts, signature: sig }, body)).toBe(true);
    });

    it('rejects a tampered body', async () => {
        const id = 'wh_3', ts = nowTs(), body = '{"amount":10}';
        const sig = await signDodoWebhook(SECRET, id, ts, body);
        expect(await verifyDodoWebhook(SECRET, { id, timestamp: ts, signature: sig }, '{"amount":9999}')).toBe(false);
    });

    it('rejects a signature made with a different secret', async () => {
        const id = 'wh_4', ts = nowTs(), body = '{"x":1}';
        const sig = await signDodoWebhook('ZGlmZmVyZW50LWtleQ==', id, ts, body);
        expect(await verifyDodoWebhook(SECRET, { id, timestamp: ts, signature: sig }, body)).toBe(false);
    });

    it('rejects a stale timestamp (>5 min) — replay protection', async () => {
        const id = 'wh_5', body = '{"x":1}';
        const oldTs = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
        const sig = await signDodoWebhook(SECRET, id, oldTs, body);
        expect(await verifyDodoWebhook(SECRET, { id, timestamp: oldTs, signature: sig }, body)).toBe(false);
    });

    it('rejects when any required header is missing', async () => {
        const id = 'wh_6', ts = nowTs(), body = '{"x":1}';
        const sig = await signDodoWebhook(SECRET, id, ts, body);
        expect(await verifyDodoWebhook(SECRET, { id: undefined, timestamp: ts, signature: sig }, body)).toBe(false);
        expect(await verifyDodoWebhook(SECRET, { id, timestamp: undefined, signature: sig }, body)).toBe(false);
        expect(await verifyDodoWebhook(SECRET, { id, timestamp: ts, signature: undefined }, body)).toBe(false);
    });

    it('accepts when the header carries multiple space-separated signatures', async () => {
        const id = 'wh_7', ts = nowTs(), body = '{"x":1}';
        const good = await signDodoWebhook(SECRET, id, ts, body);
        const header = `v1,AAAAdeadbeef ${good}`; // first is bogus, second valid
        expect(await verifyDodoWebhook(SECRET, { id, timestamp: ts, signature: header }, body)).toBe(true);
    });
});
