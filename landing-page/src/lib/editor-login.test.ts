import { describe, it, expect } from 'vitest';
import {
    isValidLoopbackRedirect,
    parseEditorLoginParams,
    buildCallbackUrl,
} from './editor-login';

describe('isValidLoopbackRedirect', () => {
    it('accepts the exact loopback callback shape', () => {
        expect(isValidLoopbackRedirect('http://127.0.0.1:53411/callback')).toBe(true);
        expect(isValidLoopbackRedirect('http://[::1]:53411/callback')).toBe(true);
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

    it('accepts a loopback request', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, redirect_uri: 'http://127.0.0.1:53411/callback' }),
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
