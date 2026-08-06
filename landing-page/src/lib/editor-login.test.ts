import { describe, it, expect } from 'vitest';
import {
    isValidLoopbackRedirect,
    canonicalLoopbackRedirect,
    parseEditorLoginParams,
    buildCallbackUrl,
} from './editor-login';

// Mirrors the private CALLBACK_RE in editor-login.ts: any string that leaves
// the loopback validator (and everything built from it) must satisfy this —
// the literal ASCII 127.0.0.1 IPv4 form, nothing else (the listener is
// IPv4-only, so [::1] is not accepted).
const CALLBACK_RE = /^((arcane|arcane-dev):\/\/auth\/callback\?|http:\/\/127\.0\.0\.1:\d{4,5}\/callback\?)/;

describe('isValidLoopbackRedirect', () => {
    it('accepts the exact loopback callback shape', () => {
        expect(isValidLoopbackRedirect('http://127.0.0.1:53411/callback')).toBe(true);
        expect(isValidLoopbackRedirect('http://127.0.0.1:1024/callback')).toBe(true);
        expect(isValidLoopbackRedirect('http://127.0.0.1:65535/callback')).toBe(true);
    });

    it('rejects non-loopback hosts', () => {
        for (const raw of [
            'http://evil.com/callback',
            'http://localhost:53411/callback',      // DNS-resolvable, therefore rebindable
            'http://0.0.0.0:53411/callback',
            'http://127.0.0.2:53411/callback',
            'http://127.0.0.1.evil.com:53411/callback',
            'http://[::2]:53411/callback',
            // IPv6 loopback is rejected: the editor's listener binds 127.0.0.1
            // (AF_INET) only and never emits these, so a browser sent to them
            // would get connection-refused. Validate only what the app produces.
            'http://[::1]:53411/callback',
            'http://[0:0:0:0:0:0:0:1]:53411/callback',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    it('rejects non-http protocols', () => {
        for (const raw of [
            'https://127.0.0.1:53411/callback',
            'file:///callback',
            'javascript:alert(1)//127.0.0.1/callback',
            'arcane://127.0.0.1:53411/callback',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    it('rejects wrong paths, queries and fragments', () => {
        for (const raw of [
            'http://127.0.0.1:53411/',
            'http://127.0.0.1:53411/callback-evil',
            'http://127.0.0.1:53411/callback/../evil',
            'http://127.0.0.1:53411/callback?next=x',
            'http://127.0.0.1:53411/callback#x',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    it('rejects embedded credentials', () => {
        expect(isValidLoopbackRedirect('http://user:pw@127.0.0.1:53411/callback')).toBe(false);
        expect(isValidLoopbackRedirect('http://evil.com@127.0.0.1:53411/callback')).toBe(false);
    });

    it('rejects missing, privileged and out-of-range ports', () => {
        for (const raw of [
            'http://127.0.0.1/callback',
            'http://127.0.0.1:80/callback',
            'http://127.0.0.1:1023/callback',
            'http://127.0.0.1:0/callback',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    it('rejects backslash normalization tricks and junk', () => {
        for (const raw of [
            'http:/\\127.0.0.1:53411/callback',
            'http://127.0.0.1:53411\\@evil.com/callback',
            '',
            'not a url',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    // These all genuinely resolve to the 127.0.0.1 IPv4 loopback — `new URL()`
    // itself collapses every one of them down to hostname `127.0.0.1` before
    // this validator ever inspects the host. Accepting them isn't wrong; the
    // bug (fixed earlier) was returning the RAW text instead of that canonical
    // form. IPv6 loopback spellings are deliberately NOT here — they're
    // rejected above, since the editor's listener is IPv4-only.
    it('accepts alternate IPv4 loopback encodings (WHATWG-normalized) as true', () => {
        for (const raw of [
            'http://2130706433:53411/callback',          // decimal IPv4
            'http://0177.0.0.1:53411/callback',          // octal
            'http://0x7f.0.0.1:53411/callback',          // hex, dotted
            'http://0x7f000001:53411/callback',          // hex, flat
            'http://127.1:53411/callback',               // short form
            'http://１２７.0.0.1:53411/callback', // fullwidth Unicode digits ("127")
            'http://127.0.0.1.:53411/callback',          // trailing dot
            'HTTP://127.0.0.1:53411/callback',           // uppercase scheme
            'http://127.0.0.1:5\t3411/callback',         // tab spliced into the port
            'http://127.0.0.1:534\n11/callback',         // newline spliced into the port
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(true);
        }
    });
});

describe('canonicalLoopbackRedirect', () => {
    it('returns the literal string unchanged when it is already canonical', () => {
        expect(canonicalLoopbackRedirect('http://127.0.0.1:53411/callback'))
            .toBe('http://127.0.0.1:53411/callback');
    });

    // The core of the fix: whatever alternate spelling comes in, what comes
    // out is always built from the parsed URL's own normalized fields
    // (`http://${u.hostname}:${port}/callback`), never the raw input.
    it('canonicalizes every alternate IPv4 loopback encoding to the literal ASCII form', () => {
        const IPV4_VECTORS = [
            'http://2130706433:53411/callback',
            'http://0177.0.0.1:53411/callback',
            'http://0x7f.0.0.1:53411/callback',
            'http://0x7f000001:53411/callback',
            'http://127.1:53411/callback',
            'http://１２７.0.0.1:53411/callback',
            'http://127.0.0.1.:53411/callback',
            'HTTP://127.0.0.1:53411/callback',
            'http://127.0.0.1:5\t3411/callback',
            'http://127.0.0.1:534\n11/callback',
        ];
        for (const raw of IPV4_VECTORS) {
            expect(canonicalLoopbackRedirect(raw), raw).toBe('http://127.0.0.1:53411/callback');
        }
    });

    it('returns null for everything isValidLoopbackRedirect rejects', () => {
        expect(canonicalLoopbackRedirect('http://evil.com/callback')).toBeNull();
        expect(canonicalLoopbackRedirect('http://3232235521:53411/callback')).toBeNull(); // decimal 192.168.0.1 — NOT loopback
        // IPv6 loopback spellings are rejected — the listener is IPv4-only and
        // never emits them, so they must not canonicalize to anything.
        expect(canonicalLoopbackRedirect('http://[::1]:53411/callback')).toBeNull();
        expect(canonicalLoopbackRedirect('http://[0:0:0:0:0:0:0:1]:53411/callback')).toBeNull();
        expect(canonicalLoopbackRedirect('')).toBeNull();
    });

    // Pin the invariant this whole fix exists for: the string that leaves the
    // validator is the string that gets used, and it always matches the
    // literal-text CALLBACK_RE gate downstream (loadEditorHandoff) — even
    // when the raw input took one of the alternate encodings above.
    it('invariant: every accepted value, and every deep link built from it, matches CALLBACK_RE', () => {
        const ACCEPTED_RAW = [
            'http://127.0.0.1:53411/callback',
            'http://2130706433:53411/callback',
            'http://0x7f000001:53411/callback',
            'http://127.1:53411/callback',
            'HTTP://127.0.0.1:53411/callback',
        ];
        for (const raw of ACCEPTED_RAW) {
            const canonical = canonicalLoopbackRedirect(raw);
            expect(canonical, raw).not.toBeNull();
            const deepLink = buildCallbackUrl({ kind: 'loopback', redirectUri: canonical! }, 'c', 's');
            expect(CALLBACK_RE.test(deepLink), deepLink).toBe(true);
        }
    });
});

describe('parseEditorLoginParams', () => {
    const CHALLENGE = 'a'.repeat(43);

    const params = (o: Record<string, string>) => new URLSearchParams(o);

    it('accepts a scheme request', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, scheme: 'arcane-dev' }),
        );
        expect(r.ok && r.request.target).toEqual({ kind: 'scheme', scheme: 'arcane-dev' });
    });

    const UUID = '11111111-2222-3333-4444-555555555555';

    it('carries a valid attempt id through', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, scheme: 'arcane', attempt: UUID }),
        );
        expect(r.ok && r.request.attemptId).toBe(UUID);
    });

    it('accepts a request with no attempt id (older app build)', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, scheme: 'arcane' }),
        );
        expect(r.ok).toBe(true);
        expect(r.ok && r.request.attemptId).toBeNull();
    });

    it('rejects a malformed attempt id rather than forwarding it', () => {
        for (const attempt of ['not-a-uuid', '', `${UUID}x`, '../../evil']) {
            const r = parseEditorLoginParams(
                params({ state: 's', challenge: CHALLENGE, scheme: 'arcane', attempt }),
            );
            expect(r.ok).toBe(false);
        }
    });

    it('accepts a loopback request', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, redirect_uri: 'http://127.0.0.1:53411/callback' }),
        );
        expect(r.ok && r.request.target).toEqual({
            kind: 'loopback',
            redirectUri: 'http://127.0.0.1:53411/callback',
        });
    });

    // The value stored in target.redirectUri must be the CANONICAL string,
    // not whatever alternate encoding arrived in the query param — this is
    // what buildCallbackUrl later interpolates verbatim.
    it('stores the canonicalized redirect_uri, not the raw query param', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, redirect_uri: 'http://0x7f000001:53411/callback' }),
        );
        expect(r.ok && r.request.target).toEqual({
            kind: 'loopback',
            redirectUri: 'http://127.0.0.1:53411/callback',
        });
    });

    it('rejects when neither scheme nor redirect_uri is present', () => {
        const r = parseEditorLoginParams(params({ state: 's', challenge: CHALLENGE }));
        expect(r.ok).toBe(false);
    });

    it('rejects when BOTH are present', () => {
        const r = parseEditorLoginParams(
            params({
                state: 's',
                challenge: CHALLENGE,
                scheme: 'arcane-dev',
                redirect_uri: 'http://127.0.0.1:53411/callback',
            }),
        );
        expect(r.ok).toBe(false);
    });

    it('rejects a bad challenge or state regardless of target', () => {
        expect(parseEditorLoginParams(params({ state: 's', challenge: 'short', scheme: 'arcane' })).ok)
            .toBe(false);
        expect(parseEditorLoginParams(params({ state: '', challenge: CHALLENGE, scheme: 'arcane' })).ok)
            .toBe(false);
    });

    it('truncates attacker-controlled text echoed into the error', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, scheme: 'x'.repeat(500) }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.length).toBeLessThan(400);
    });
});

describe('buildCallbackUrl', () => {
    it('builds a scheme URL', () => {
        expect(buildCallbackUrl({ kind: 'scheme', scheme: 'arcane-dev' }, 'c/1', 's 1'))
            .toBe('arcane-dev://auth/callback?code=c%2F1&state=s%201');
    });

    it('builds a loopback URL', () => {
        expect(
            buildCallbackUrl(
                { kind: 'loopback', redirectUri: 'http://127.0.0.1:53411/callback' },
                'c/1',
                's 1',
            ),
        ).toBe('http://127.0.0.1:53411/callback?code=c%2F1&state=s%201');
    });
});
