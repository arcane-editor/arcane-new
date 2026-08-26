import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

const ALLOWED = [
    'https://unityide.app',
    'https://www.unityide.app',
    'https://dev.unityide.app',
    'http://localhost:4321',
    'http://localhost:1420',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
];

describe('CORS allowlist', () => {
    it('echoes every allowlisted origin', async () => {
        for (const origin of ALLOWED) {
            const res = await SELF.fetch('https://example.com/health', { headers: { Origin: origin } });
            expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBe(origin);
        }
    });

    it('sends no CORS header for other origins', async () => {
        const res = await SELF.fetch('https://example.com/health',
            { headers: { Origin: 'https://evil.example' } });
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
        expect(res.status).toBe(200); // no-CORS ≠ blocked for non-browser callers
    });

    it('answers preflight with Authorization and Content-Type allowed', async () => {
        const res = await SELF.fetch('https://example.com/v1/auth/login', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://unityide.app',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'Authorization, Content-Type',
            },
        });
        expect(res.status).toBe(204);
        const allowed = res.headers.get('Access-Control-Allow-Headers')?.toLowerCase() ?? '';
        expect(allowed).toContain('authorization');
        expect(allowed).toContain('content-type');
    });
});
