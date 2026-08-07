import { describe, it, expect } from 'vitest';
import { generateToken, sha256Hex, s256Challenge, TOKEN_TTL_SECONDS } from '../src/lib/tokens.ts';

describe('tokens lib', () => {
    it('generateToken returns 43-char base64url strings, unique across calls', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
            const t = generateToken();
            expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
            seen.add(t);
        }
        expect(seen.size).toBe(100);
    });

    it('sha256Hex matches the FIPS 180 "abc" vector', async () => {
        expect(await sha256Hex('abc'))
            .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('s256Challenge matches the RFC 7636 Appendix B vector', async () => {
        expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
            .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('TTL constants match the spec exactly', () => {
        // `editor_login` was retired in 0016 — the editor handoff code now
        // lives on the editor_attempts row (CODE_TTL_SECONDS, still 60s).
        expect(TOKEN_TTL_SECONDS).toEqual({
            verify_email: 86400,
            password_reset: 1800,
            web_login: 60,
            // Emailed sign-in link — must stay a separate purpose from
            // web_login, whose 60s is tuned for an instant redirect handoff.
            magic_login: 900,
        });
    });
});
