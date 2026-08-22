import { describe, it, expect } from 'bun:test';
import { shouldRequestInline } from './gating';

const OPEN = {
    enabled: true, loggedIn: true, online: true, breakerAllows: true,
    quotaActive: false, planAllows: true, scheme: 'file', contentLength: 100,
};

describe('shouldRequestInline', () => {
    it('passes the all-clear gate', () => {
        expect(shouldRequestInline(OPEN)).toBe(true);
    });
    it.each([
        ['disabled', { enabled: false }],
        ['signed out', { loggedIn: false }],
        ['offline', { online: false }],
        ['breaker open', { breakerAllows: false }],
        ['quota active', { quotaActive: true }],
        ['plan does not allow inline', { planAllows: false }],
        ['non-file scheme', { scheme: 'auth' }],
        ['large file', { contentLength: 1_000_001 }],
    ] as const)('blocks when %s', (_label, override) => {
        expect(shouldRequestInline({ ...OPEN, ...override })).toBe(false);
    });
});
