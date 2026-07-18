import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('GET /health', () => {
    it('returns {"status":"ok"} through the worker fetch handler', async () => {
        const res = await SELF.fetch('https://example.com/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
    });
});
