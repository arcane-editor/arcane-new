import { describe, it, expect } from 'vitest';
import { downloadUrls } from './releases';

describe('downloadUrls', () => {
    it('serves the dev channel when the site is built against the dev API', () => {
        const urls = downloadUrls('https://api-dev.arcaneai.org');
        expect(urls.macArm).toBe('https://releases.arcaneai.org/dev/latest/Arcane-Dev-arm64.dmg');
        expect(urls.windows).toBe('https://releases.arcaneai.org/dev/latest/ArcaneDevSetup.exe');
    });

    it('serves the production channel for the production API', () => {
        const urls = downloadUrls('https://api.arcaneai.org');
        expect(urls.macArm).toBe('https://releases.arcaneai.org/latest/Arcane-arm64.dmg');
        expect(urls.windows).toBe('https://releases.arcaneai.org/latest/ArcaneSetup.exe');
    });

    it('never hands the dev site a production installer', () => {
        // The bug this guards: dev.arcaneai.org linked to /latest/, so anyone
        // downloading from the dev site got the production app — same name,
        // same bundle id, no way to tell until it misbehaves.
        const dev = downloadUrls('https://api-dev.arcaneai.org');
        expect(dev.macArm).toContain('/dev/latest/');
        expect(dev.windows).toContain('/dev/latest/');
    });

    it('falls back to production for an unrecognised API host', () => {
        // Fail safe: an unknown host must not advertise dev builds publicly.
        expect(downloadUrls('https://example.test').macArm)
            .toBe('https://releases.arcaneai.org/latest/Arcane-arm64.dmg');
    });

    it('treats a localhost API as dev', () => {
        expect(downloadUrls('http://localhost:8787').macArm).toContain('/dev/latest/');
    });
});
