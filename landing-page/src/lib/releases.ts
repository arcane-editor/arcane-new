// Installer download links, per environment.
//
// The dev site MUST NOT link to production installers. It did, and the failure
// is silent: you download from dev.unityide.app, get the production app —
// same name, same bundle id, pointed at the production API — and nothing tells
// you until it behaves like prod. The dev channel ships "UnityIDE Dev", which
// installs alongside prod rather than over it.

const RELEASES_ORIGIN = 'https://releases.unityide.app';

export interface DownloadUrls {
    macArm: string;
    windows: string;
}

/** Derived from PUBLIC_API_URL rather than its own env var: that is the single
 *  switch the deploy workflow already flips per environment, so the download
 *  links cannot drift out of sync with the API the rest of the site talks to. */
export function downloadUrls(apiUrl: string): DownloadUrls {
    // Unrecognised hosts fall through to production — an unknown build should
    // never advertise dev installers to the public.
    return isDevChannel(apiUrl)
        ? {
            macArm: `${RELEASES_ORIGIN}/dev/latest/UnityIDE-Dev-arm64.dmg`,
            windows: `${RELEASES_ORIGIN}/dev/latest/UnityIDEDevSetup.exe`,
        }
        : {
            macArm: `${RELEASES_ORIGIN}/latest/UnityIDE-arm64.dmg`,
            windows: `${RELEASES_ORIGIN}/latest/UnityIDESetup.exe`,
        };
}

/** Platform keys as the Tauri updater spells them. Verified against the
 *  plugin source: macOS is `darwin`, never `macos`. */
export type UpdatePlatform = 'darwin-aarch64' | 'windows-x86_64';

export interface ManifestUrls {
    macArm: string;
    windows: string;
}

/** Whether this build targets the dev channel. Extracted so `downloadUrls`
 *  and `manifestUrls` can never disagree about which channel a site is on —
 *  a card showing a dev version beside a production download link would be
 *  worse than either being wrong on its own. */
function isDevChannel(apiUrl: string): boolean {
    return apiUrl.includes('api-dev.unityide.app')
        || apiUrl.includes('localhost')
        || apiUrl.includes('127.0.0.1');
}

/** Update manifests, one per platform — the same files the app polls. */
export function manifestUrls(apiUrl: string): ManifestUrls {
    const base = isDevChannel(apiUrl)
        ? `${RELEASES_ORIGIN}/dev/latest`
        : `${RELEASES_ORIGIN}/latest`;
    return {
        macArm: `${base}/darwin-aarch64.json`,
        windows: `${base}/windows-x86_64.json`,
    };
}

/**
 * The version a manifest offers for one platform, or null.
 *
 * Null rather than a throw for every failure mode: this is called during
 * `astro build`, so a malformed or truncated manifest must degrade to the
 * fallback version instead of failing the whole site build. Null also covers
 * "this manifest does not list your platform", which is a real state — a
 * release where one platform's build failed — and must not be shown as if
 * that platform had shipped.
 */
export function versionFromManifest(body: unknown, platform: UpdatePlatform): string | null {
    if (typeof body !== 'object' || body === null) return null;
    const m = body as { version?: unknown; platforms?: unknown };
    if (typeof m.version !== 'string' || m.version === '') return null;
    if (typeof m.platforms !== 'object' || m.platforms === null) return null;
    if (!(platform in (m.platforms as Record<string, unknown>))) return null;
    return m.version;
}

/**
 * The Unity UPM package for this channel.
 *
 * Two packages ship, and they are not interchangeable: `com.unityide.editor`
 * opens UnityIDE, `com.unityide.editor.dev` opens UnityIDE Dev. Routed through
 * `isDevChannel` for the same reason the installer links are — the dev site
 * handing out the release package is silently wrong in exactly the way that
 * only shows up once the plugin launches the wrong app.
 */
export function unityExtensionUrl(apiUrl: string): string {
    const base = `${RELEASES_ORIGIN}/unity-extension-releases`;
    return isDevChannel(apiUrl)
        ? `${base}/dev/latest/com.unityide.editor.dev.tgz`
        : `${base}/latest/com.unityide.editor.tgz`;
}

/**
 * A manifest URL that cannot be served from cache. Build-time reads only.
 *
 * The release workflow PUTs `latest/<platform>.json` with `max-age=300` and the
 * landing deploy now follows it within a couple of minutes — well inside that
 * window, so the edge can still be holding the PREVIOUS release's manifest and
 * the site would bake the very version it just replaced. A unique query string
 * is a distinct cache key, so this read reaches R2 itself.
 *
 * Deliberately NOT folded into `manifestUrls`: those are the same URLs the
 * app's updater polls, and that poll wants the cache.
 */
export function uncachedManifestUrl(url: string, token: string = String(Date.now())): string {
    const u = new URL(url);
    u.searchParams.set('t', token);
    return u.toString();
}
