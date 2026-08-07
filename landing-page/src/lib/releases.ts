// Installer download links, per environment.
//
// The dev site MUST NOT link to production installers. It did, and the failure
// is silent: you download from dev.arcaneai.org, get the production app —
// same name, same bundle id, pointed at the production API — and nothing tells
// you until it behaves like prod. The dev channel ships "Arcane Dev", which
// installs alongside prod rather than over it.

const RELEASES_ORIGIN = 'https://releases.arcaneai.org';

export interface DownloadUrls {
    macArm: string;
    windows: string;
}

/** Derived from PUBLIC_API_URL rather than its own env var: that is the single
 *  switch the deploy workflow already flips per environment, so the download
 *  links cannot drift out of sync with the API the rest of the site talks to. */
export function downloadUrls(apiUrl: string): DownloadUrls {
    const isDev = apiUrl.includes('api-dev.arcaneai.org')
        || apiUrl.includes('localhost')
        || apiUrl.includes('127.0.0.1');
    // Unrecognised hosts fall through to production — an unknown build should
    // never advertise dev installers to the public.
    return isDev
        ? {
            macArm: `${RELEASES_ORIGIN}/dev/latest/Arcane-Dev-arm64.dmg`,
            windows: `${RELEASES_ORIGIN}/dev/latest/ArcaneDevSetup.exe`,
        }
        : {
            macArm: `${RELEASES_ORIGIN}/latest/Arcane-arm64.dmg`,
            windows: `${RELEASES_ORIGIN}/latest/ArcaneSetup.exe`,
        };
}
