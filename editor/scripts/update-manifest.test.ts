import { describe, it, expect } from 'bun:test';
import { buildManifest } from './update-manifest.mjs';

const OK = {
  platform: 'darwin-aarch64',
  version: '0.3.2',
  url: 'https://releases.arcaneai.org/v0.3.2/UnityIDE.app.tar.gz',
  signature: 'dW50cnVzdGVkIGNvbW1lbnQ6...\n',
  pubDate: '2026-08-23T00:00:00Z',
};

describe('buildManifest', () => {
  it('produces the shape the Tauri updater expects', () => {
    expect(buildManifest(OK)).toEqual({
      version: '0.3.2',
      pub_date: '2026-08-23T00:00:00Z',
      platforms: {
        'darwin-aarch64': {
          signature: 'dW50cnVzdGVkIGNvbW1lbnQ6...',
          url: 'https://releases.arcaneai.org/v0.3.2/UnityIDE.app.tar.gz',
        },
      },
    });
  });

  it('refuses a url under /latest/', () => {
    // A manifest must name an immutable path. Pointing at /latest/ means a
    // download already in flight can be swapped out by the next release —
    // the client would verify a signature against different bytes.
    expect(() => buildManifest({ ...OK, url: 'https://releases.arcaneai.org/latest/UnityIDE.app.tar.gz' }))
      .toThrow(/versioned/);
  });

  it('refuses an empty signature', () => {
    // An unsigned manifest is rejected by every client, silently, forever.
    expect(() => buildManifest({ ...OK, signature: '   ' })).toThrow(/signature/);
  });

  it('refuses a version that is not semver', () => {
    expect(() => buildManifest({ ...OK, version: 'v0.3.2' })).toThrow(/version/);
  });

  it('accepts a prerelease version for the dev channel', () => {
    const m = buildManifest({ ...OK, version: '0.3.1-dev.42' });
    expect(m.version).toBe('0.3.1-dev.42');
  });

  it('refuses an unknown platform key', () => {
    // `macos-aarch64` looks right and is wrong — the updater spells it
    // `darwin`. A typo here 404s every client with no visible symptom.
    expect(() => buildManifest({ ...OK, platform: 'macos-aarch64' })).toThrow(/platform/);
  });
});
