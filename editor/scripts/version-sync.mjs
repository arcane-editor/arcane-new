/**
 * Validation for the one-version-one-place rule.
 *
 * The version used to live in four files — package.json, tauri.conf.json,
 * Cargo.toml and a literal on the landing page — with nothing tying them
 * together. The landing page sat on v0.2.0 for two releases because of it.
 *
 * Pure (takes file *contents*, not paths) so it is unit-testable without a
 * fixture tree; `check-version-sync.mjs` is the thin runner that reads the
 * real files.
 */

/** A pubkey value that is present but obviously not a real key. */
const PLACEHOLDER_PUBKEYS = new Set(['', 'REPLACE_ME', 'TODO', 'CHANGEME']);

/**
 * @param {{pkg: string, tauriConf: string, cargoToml: string}} sources
 * @returns {string[]} human-readable problems; empty means the tree is correct
 */
export function checkVersionSync({ pkg, tauriConf, cargoToml }) {
  const problems = [];

  const pkgVersion = JSON.parse(pkg).version;
  const conf = JSON.parse(tauriConf);

  // tauri.conf.json must DEFER to package.json rather than restate the
  // version — a literal here is exactly how the two drifted apart before.
  if (conf.version !== '../package.json') {
    problems.push(
      `tauri.conf.json "version" must be "../package.json" so editor/package.json stays the single source; found ${JSON.stringify(conf.version)}`,
    );
  }

  // Cargo still needs a literal version, so it cannot defer. Assert equality
  // instead, so a bump that misses it is caught here rather than shipping a
  // crate version that disagrees with the app.
  const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
  if (cargoVersion !== pkgVersion) {
    problems.push(
      `Cargo.toml version ${cargoVersion} does not match package.json ${pkgVersion}`,
    );
  }

  const pubkey = conf.plugins?.updater?.pubkey ?? '';
  if (PLACEHOLDER_PUBKEYS.has(pubkey.trim())) {
    problems.push(
      'updater pubkey is empty or a placeholder — a build shipped this way can never auto-update, on any install that receives it, and there is no remote fix',
    );
  }

  return problems;
}
