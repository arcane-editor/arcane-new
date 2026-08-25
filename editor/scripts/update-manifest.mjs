/**
 * Builds the update manifest CI publishes to R2.
 *
 * Every check here guards a failure that is otherwise silent: the app just
 * stops finding updates and nobody notices for weeks.
 */

/** The only platform keys the app will ever ask for. */
const PLATFORMS = new Set(['darwin-aarch64', 'windows-x86_64']);

export function buildManifest({ platform, version, url, signature, pubDate }) {
  if (!PLATFORMS.has(platform)) {
    throw new Error(
      `unknown platform key ${JSON.stringify(platform)} — must be one of ${[...PLATFORMS].join(', ')}. ` +
        'The updater spells macOS "darwin", not "macos".',
    );
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`version ${JSON.stringify(version)} is not semver (no leading "v")`);
  }
  if (!/^https:\/\//.test(url)) {
    throw new Error(`url must be https: ${url}`);
  }
  if (url.includes('/latest/')) {
    throw new Error(
      `url must point at a versioned, immutable path, not /latest/: ${url}. ` +
        'A download in flight would otherwise be swapped by the next release.',
    );
  }
  const sig = signature.trim();
  if (sig === '') {
    throw new Error('signature is empty — every client rejects an unsigned artifact, permanently');
  }

  return { version, pub_date: pubDate, platforms: { [platform]: { signature: sig, url } } };
}
