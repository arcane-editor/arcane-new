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
 * @param {{pkg: string, tauriConf: string, cargoToml: string, tauriDevConf?: string, claudeBackend?: string}} sources
 * @returns {string[]} human-readable problems; empty means the tree is correct
 */
export function checkVersionSync({ pkg, tauriConf, cargoToml, tauriDevConf, claudeBackend }) {
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

  // BOTH channels, not just production. The dev config carries its own full
  // updater block (deliberately — see the plan's Task 3 Step 4: duplicating the
  // pubkey removes Tauri's config merge depth as a silent failure mode), so it
  // needs its own check. Checking only `tauri.conf.json` is how a real
  // placeholder survived here: production was filled in, the dev channel was
  // not, `verify` went green, and `dev-build.yml` would have shipped Arcane Dev
  // installers that can never auto-update.
  for (const [name, source] of [
    ['tauri.conf.json', tauriConf],
    ['tauri.dev.conf.json', tauriDevConf],
  ]) {
    if (!source) continue; // dev config is optional for callers/tests
    const pubkey = JSON.parse(source).plugins?.updater?.pubkey ?? '';
    if (PLACEHOLDER_PUBKEYS.has(pubkey.trim())) {
      problems.push(
        `${name}: updater pubkey is empty or a placeholder — a build shipped this way can never auto-update, on any install that receives it, and there is no remote fix`,
      );
    }
  }

  // The ACP handshake reports a version to the external agent, and it is a
  // literal because the handshake is synchronous — it cannot await Tauri's
  // getVersion(). Nothing tied it to package.json, so it silently sat at
  // 0.2.2 while the app shipped 0.3.2, and every Claude agent log recorded
  // the wrong client version. Assert it here rather than trusting a comment.
  if (claudeBackend) {
    const acpVersion = /^\s*const APP_VERSION = '([^']+)';/m.exec(claudeBackend)?.[1];
    if (acpVersion !== pkgVersion) {
      problems.push(
        `claude-backend.ts APP_VERSION ${acpVersion} does not match package.json ${pkgVersion}`,
      );
    }
  }

  return problems;
}
