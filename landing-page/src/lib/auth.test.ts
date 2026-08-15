import { describe, it, expect } from 'vitest';
import { githubStartUrl, authErrorMessage, isKnownAuthErrorCode } from './auth';

describe('githubStartUrl', () => {
    it('targets the server start route with an encoded return_to', () => {
        expect(githubStartUrl('/auth'))
            .toMatch(/^https?:\/\/.+\/v1\/auth\/github\/start\?return_to=%2Fauth$/);
        expect(githubStartUrl('/account'))
            .toMatch(/^https?:\/\/.+\/v1\/auth\/github\/start\?return_to=%2Faccount$/);
    });
});

describe('GitHub auth error copy', () => {
    // The ?error= param is attacker-controllable, so AuthHub renders it only
    // when isKnownAuthErrorCode passes — every code the server can redirect
    // with must therefore be in the map, or the user gets a generic banner.
    const serverCodes = [
        'github_not_configured', 'github_oauth_failed',
        'github_email_unverified', 'github_account',
    ];

    it('recognises every code the GitHub callback can redirect with', () => {
        for (const code of serverCodes) {
            expect(isKnownAuthErrorCode(code)).toBe(true);
        }
    });

    it('maps each one to copy that does not leak the raw code', () => {
        for (const code of serverCodes) {
            const message = authErrorMessage(code);
            expect(message).not.toBe(code);
            expect(message.length).toBeGreaterThan(10);
        }
    });

    it('tells the user what to fix when GitHub has no verified primary email', () => {
        const message = authErrorMessage('github_email_unverified');
        // Prose, not the echoed code — which happens to contain "verif" itself.
        expect(message).toContain(' ');
        expect(message).toMatch(/verif/i);
        expect(message).toMatch(/primary|GitHub/i);
    });
});
