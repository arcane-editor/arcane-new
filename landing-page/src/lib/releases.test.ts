import { describe, it, expect } from 'vitest';
import { downloadUrls, manifestUrls, versionFromManifest } from './releases';

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

describe('manifestUrls', () => {
    it('points at the production channel manifests', () => {
        const urls = manifestUrls('https://api.arcaneai.org');
        expect(urls.macArm).toBe('https://releases.arcaneai.org/latest/darwin-aarch64.json');
        expect(urls.windows).toBe('https://releases.arcaneai.org/latest/windows-x86_64.json');
    });

    it('points at the dev channel manifests for the dev site', () => {
        const urls = manifestUrls('https://api-dev.arcaneai.org');
        expect(urls.macArm).toBe('https://releases.arcaneai.org/dev/latest/darwin-aarch64.json');
        expect(urls.windows).toBe('https://releases.arcaneai.org/dev/latest/windows-x86_64.json');
    });

    it('uses the same channel rule as the installer links', () => {
        // If these ever disagree, a card could show a dev version beside a
        // production download link.
        expect(manifestUrls('http://localhost:8787').macArm).toContain('/dev/latest/');
        expect(manifestUrls('https://example.test').macArm).not.toContain('/dev/');
    });
});

describe('versionFromManifest', () => {
    const manifest = {
        version: '0.3.2',
        pub_date: '2026-08-23T00:00:00Z',
        platforms: {
            'darwin-aarch64': { signature: 'sig', url: 'https://example.test/a.tar.gz' },
        },
    };

    it('reads the version when the platform is present', () => {
        expect(versionFromManifest(manifest, 'darwin-aarch64')).toBe('0.3.2');
    });

    it('returns null when this platform is absent from the manifest', () => {
        // A manifest that does not carry your platform is not a release you
        // can download, so its version must not be displayed as though it is.
        expect(versionFromManifest(manifest, 'windows-x86_64')).toBeNull();
    });

    it('returns null for a malformed body rather than throwing', () => {
        // This runs during `astro build`; a throw here fails the site build.
        expect(versionFromManifest(null, 'darwin-aarch64')).toBeNull();
        expect(versionFromManifest('nope', 'darwin-aarch64')).toBeNull();
        expect(versionFromManifest({ platforms: {} }, 'darwin-aarch64')).toBeNull();
        expect(versionFromManifest({ version: 5, platforms: { 'darwin-aarch64': {} } }, 'darwin-aarch64')).toBeNull();
    });
});
