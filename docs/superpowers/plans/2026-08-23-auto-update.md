# Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a signed, silent auto-updater for the Arcane editor on both the production and dev channels, and make the website's download cards read their version from the same feed the updater uses.

**Architecture:** CI publishes one small signed JSON manifest per platform per channel to the `arcane-releases` R2 bucket, next to the installers it already uploads. A Rust background task in the app polls its channel's manifest, downloads and (on macOS) installs silently, then emits an event the frontend turns into a "Restart" notice. The version collapses to a single source — `editor/package.json` — which `tauri.conf.json`, CI, and the landing page all read from.

**Tech Stack:** Tauri 2.10 (`tauri-plugin-updater`, `tauri-plugin-process`), Rust, React 19 + Zustand, Astro 5, GitHub Actions, Cloudflare R2 via wrangler.

**Spec:** `docs/superpowers/specs/2026-08-23-auto-update-design.md`

## Global Constraints

- **Branch:** all work lands on `heads/v0.3.2`. Never commit directly on `dev` — pushing `dev` auto-deploys and runs D1 migrations unattended.
- **Tauri version:** 2.10.x. `tauri` crate is 2.10.3, `@tauri-apps/cli` and `@tauri-apps/api` are 2.10.1. New plugins must resolve against these.
- **Endpoint placeholders are exact:** `{{target}}` expands to `darwin` / `windows` (NOT `macos`), `{{arch}}` to `aarch64` / `x86_64`. Verified in `plugins/updater/src/updater.rs`. A wrong value 404s on every check with no visible symptom.
- **Manifest platform keys** are `darwin-aarch64` and `windows-x86_64`.
- **Manifest `url` fields point at versioned paths** (`/v0.3.2/…`, `/dev/<sha7>/…`), never `/latest/…`.
- **Feature folders require an `index.ts`** and must be imported through it — enforced by `bun run check:modules`.
- **Tests:** editor uses `bun:test` (`bun test src`); landing-page uses `vitest` (`pnpm test`), node environment, pure functions only — no DOM, no Astro build.
- **The updater pubkey must never be empty or a placeholder in a build.** Task 1 adds a check that fails `verify` if it is; shipping a placeholder permanently bricks auto-update for every install that receives it.
- **`bun run verify` flakes** on the auth_loopback stop test roughly half the time, independent of any change. Re-run before investigating.

## File Structure

| File | Responsibility |
| --- | --- |
| `editor/scripts/check-version-sync.mjs` | Runner: fails the build on version drift or a placeholder pubkey |
| `editor/scripts/version-sync.mjs` | Pure validation logic, unit-tested |
| `editor/scripts/version-sync.test.ts` | Tests for the above |
| `editor/src-tauri/src/updates.rs` | Background update watcher + apply command + settings read |
| `editor/src/features/updates/index.ts` | Public API of the updates feature |
| `editor/src/features/updates/services/update-notice.ts` | Event listener + notification copy |
| `editor/src/features/updates/services/update-notice.test.ts` | Tests for the above |
| `landing-page/src/lib/releases.ts` | Adds manifest URLs + version resolution (extends existing file) |
| `landing-page/src/lib/releases.test.ts` | Extends existing tests |

Modified: `editor/package.json`, `editor/src-tauri/{Cargo.toml,tauri.conf.json,tauri.dev.conf.json,src/lib.rs}`, `editor/src-tauri/capabilities/default.json`, `editor/src/types/index.ts`, `editor/src/stores/settings.ts`, `editor/src/features/settings/data/definitions.ts`, `editor/src/App.tsx`, `landing-page/src/components/DownloadSection.astro`, `.github/workflows/{release,dev-build,deploy-landing}.yml`.

---

### Task 1: Single-source the version, and guard it

Today the version is written in `editor/package.json`, `editor/src-tauri/tauri.conf.json` and `editor/src-tauri/Cargo.toml`, and a fourth copy on the landing page has been stale since v0.2.0. Tauri's `version` field accepts a path to a `package.json` to read from, so `package.json` becomes the only place it is written. A check wired into `verify` fails if anything drifts back — and fails if the updater pubkey is still a placeholder.

**Files:**
- Create: `editor/scripts/version-sync.mjs`
- Create: `editor/scripts/version-sync.test.ts`
- Create: `editor/scripts/check-version-sync.mjs`
- Modify: `editor/src-tauri/tauri.conf.json` (the `version` field)
- Modify: `editor/package.json` (the `verify` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `checkVersionSync({ pkg, tauriConf, cargoToml })` returning `string[]` of problems (empty = fine). Task 7 and Task 8 rely on `editor/package.json` being the authoritative version.

- [ ] **Step 1: Write the failing test**

Create `editor/scripts/version-sync.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { checkVersionSync } from './version-sync.mjs';

const OK = {
  pkg: '{"version":"0.3.1"}',
  tauriConf: '{"version":"../package.json","plugins":{"updater":{"pubkey":"dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu"}}}',
  cargoToml: '[package]\nname = "editor"\nversion = "0.3.1"\n',
};

describe('checkVersionSync', () => {
  it('accepts a correctly wired tree', () => {
    expect(checkVersionSync(OK)).toEqual([]);
  });

  it('rejects a hardcoded version in tauri.conf.json', () => {
    // The whole point: if this is a literal, package.json stops being the
    // single source and the two can drift apart silently.
    const conf = OK.tauriConf.replace('"../package.json"', '"0.3.1"');
    expect(checkVersionSync({ ...OK, tauriConf: conf }).join(' '))
      .toContain('../package.json');
  });

  it('rejects a Cargo.toml version that disagrees with package.json', () => {
    const cargo = OK.cargoToml.replace('0.3.1', '0.3.0');
    expect(checkVersionSync({ ...OK, cargoToml: cargo }).join(' ')).toContain('0.3.0');
  });

  it('rejects an empty updater pubkey', () => {
    // A build shipped with no pubkey accepts no updates, ever, on every
    // install that receives it. There is no remote fix.
    const conf = OK.tauriConf.replace('dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu', '');
    expect(checkVersionSync({ ...OK, tauriConf: conf }).join(' ')).toContain('pubkey');
  });

  it('rejects a placeholder updater pubkey', () => {
    const conf = OK.tauriConf.replace('dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu', 'REPLACE_ME');
    expect(checkVersionSync({ ...OK, tauriConf: conf }).join(' ')).toContain('pubkey');
  });

  it('reports every problem at once rather than the first', () => {
    const problems = checkVersionSync({
      pkg: '{"version":"0.3.1"}',
      tauriConf: '{"version":"0.3.1","plugins":{"updater":{"pubkey":""}}}',
      cargoToml: '[package]\nversion = "9.9.9"\n',
    });
    expect(problems.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd editor && bun test scripts/version-sync.test.ts`
Expected: FAIL — cannot resolve `./version-sync.mjs`.

- [ ] **Step 3: Write the implementation**

Create `editor/scripts/version-sync.mjs`:

```js
/**
 * Validation for the one-version-one-place rule.
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
```

Create `editor/scripts/check-version-sync.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { checkVersionSync } from './version-sync.mjs';

const problems = checkVersionSync({
  pkg: readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  tauriConf: readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  cargoToml: readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8'),
});

if (problems.length > 0) {
  console.error('Version/updater configuration problems:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('version sync OK');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd editor && bun test scripts/version-sync.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Point tauri.conf.json at package.json**

In `editor/src-tauri/tauri.conf.json`, change `"version": "0.3.1"` to `"version": "../package.json"`.

- [ ] **Step 6: Wire the check into verify**

In `editor/package.json`, add the script and insert it into `verify`:

```json
"check:version": "node scripts/check-version-sync.mjs",
```

`verify` becomes — two changes: `bun run check:version` after `check:invoke`, and `bun test scripts` beside `bun test src`:

```json
"verify": "tsc --noEmit && bun run check:modules && bun run check:invoke && bun run check:version && bun test src && bun test scripts && bun run test:isolated && (cd src-tauri && cargo test --lib) && bun run verify:intellisense && bun run verify:acp",
```

`bun test scripts` matters more than it looks. `verify` only ran `bun test src`, so
nothing under `editor/scripts/` was ever executed — the existing
`check-invoke-args.test.ts` has been dormant the whole time (15 tests, all passing
as of this plan). Every test this plan adds under `scripts/` would have been
dormant too. Adding the path turns that coverage on; if `check-invoke-args.test.ts`
ever fails after this change, it is a pre-existing failure that was simply never
being run — report it rather than folding a fix into this work.

- [ ] **Step 7: Confirm the check fails loudly right now**

Run: `cd editor && node scripts/check-version-sync.mjs`
Expected: FAIL with the pubkey problem — Task 3 has not added `plugins.updater` yet. This is correct: it proves the guard works. It will pass once Task 3 lands a real pubkey.

- [ ] **Step 8: Commit**

```bash
git add editor/scripts/version-sync.mjs editor/scripts/version-sync.test.ts \
        editor/scripts/check-version-sync.mjs editor/package.json \
        editor/src-tauri/tauri.conf.json
git commit -m "build(version): make package.json the single source of the app version"
```

---
### Task 2: Landing page reads the version from the feed

`DownloadSection.astro:12` hardcodes `"v0.2.0"`. Replace it with a build-time read of each platform's update manifest — the same file the app polls — so the cards cannot advertise a version that was never shipped. Per-platform rather than one shared number, because if a Windows build fails during a release the Windows card should keep showing what Windows can actually download.

**Files:**
- Modify: `landing-page/src/lib/releases.ts`
- Modify: `landing-page/src/lib/releases.test.ts`
- Modify: `landing-page/src/components/DownloadSection.astro`

**Interfaces:**
- Consumes: `editor/package.json`'s version (Task 1) as the offline fallback.
- Produces: `manifestUrls(apiUrl)` → `{ macArm: string; windows: string }`; `versionFromManifest(body, platform)` → `string | null`. Task 7 and Task 8 must publish manifests at exactly the URLs `manifestUrls` returns.

- [ ] **Step 1: Write the failing tests**

Extend `landing-page/src/lib/releases.test.ts`. The file already imports `downloadUrls` from `./releases` — merge the new names into that existing import line rather than adding a second one, then append the `describe` blocks:

```ts
import { manifestUrls, versionFromManifest } from './releases';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd landing-page && pnpm test`
Expected: FAIL — `manifestUrls` and `versionFromManifest` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `landing-page/src/lib/releases.ts`:

```ts
/** Platform keys as the Tauri updater spells them. Verified against the
 *  plugin source: macOS is `darwin`, never `macos`. */
export type UpdatePlatform = 'darwin-aarch64' | 'windows-x86_64';

export interface ManifestUrls {
    macArm: string;
    windows: string;
}

/** Whether this build targets the dev channel. Extracted so `downloadUrls`
 *  and `manifestUrls` can never disagree about which channel a site is on. */
function isDevChannel(apiUrl: string): boolean {
    return apiUrl.includes('api-dev.arcaneai.org')
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
```

Then refactor `downloadUrls` to use the shared helper — replace its inline `const isDev = …` with `const isDev = isDevChannel(apiUrl);`, leaving the rest of the function unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd landing-page && pnpm test`
Expected: PASS — the five pre-existing `downloadUrls` tests plus the seven new ones.

- [ ] **Step 5: Use it in the component**

In `landing-page/src/components/DownloadSection.astro`, replace the frontmatter block (lines 1–13, from `import` through `const version = …`) with:

```astro
---
import { readFileSync } from "node:fs";
import { downloadUrls, manifestUrls, versionFromManifest, type UpdatePlatform } from "../lib/releases";

const apiUrl = import.meta.env.PUBLIC_API_URL ?? "";
const isDev = apiUrl.includes("api-dev");
const urls = downloadUrls(apiUrl);
const manifests = manifestUrls(apiUrl);

/** The version in the repo — used when the manifest cannot be reached, so a
 *  network blip during CI degrades to a slightly stale number instead of
 *  failing the site build. */
const fallbackVersion: string = JSON.parse(
  readFileSync(new URL("../../../editor/package.json", import.meta.url), "utf8"),
).version;

/**
 * The version this platform can actually download, read at build time.
 *
 * Reads the same manifest the app's updater polls, so the card cannot
 * advertise a release that was never published. Every failure falls back
 * rather than throwing: this runs inside `astro build`.
 */
async function shippedVersion(url: string, platform: UpdatePlatform): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return fallbackVersion;
    return versionFromManifest(await res.json(), platform) ?? fallbackVersion;
  } catch {
    return fallbackVersion;
  }
}

// The dev channel rebuilds several times a day; a version string there is
// noise, so it keeps the existing "dev build" label.
const macVersion = isDev ? "dev build" : `v${await shippedVersion(manifests.macArm, "darwin-aarch64")}`;
const winVersion = isDev ? "dev build" : `v${await shippedVersion(manifests.windows, "windows-x86_64")}`;
---
```

Then in `osCards`, change the macOS entry's `version,` to `version: macVersion,` and the Windows entry's `version,` to `version: winVersion,`. The Linux entry keeps `version: "Coming Soon"`.

- [ ] **Step 6: Verify the site builds and the cards are right**

Run: `cd landing-page && pnpm build && grep -o 'v0\.[0-9.]*' dist/index.html | sort -u`
Expected: the build succeeds and prints the version the production manifest currently offers. Before Task 7 has ever run there is no manifest, so the fetch 404s and the fallback applies — expect `v0.3.1` from `editor/package.json`, which is already the correct answer and the original bug fixed.

- [ ] **Step 7: Commit**

```bash
git add landing-page/src/lib/releases.ts landing-page/src/lib/releases.test.ts \
        landing-page/src/components/DownloadSection.astro
git commit -m "fix(landing): read the download version from the release feed, not a literal"
```

---

### Task 3: Wire the updater plugin into the app

Adds the plugin, turns on updater artifacts, and configures both channels. No behaviour yet — Task 4 adds the watcher. Note there is deliberately **no JS updater plugin**: the whole update flow lives in Rust (Task 4), so the webview never talks to the updater directly. `AppHandle::restart()` is core Tauri, so `tauri-plugin-process` is not needed either.

**Files:**
- Modify: `editor/src-tauri/Cargo.toml`
- Modify: `editor/src-tauri/src/lib.rs:709-715`
- Modify: `editor/src-tauri/tauri.conf.json`
- Modify: `editor/src-tauri/tauri.dev.conf.json`
- Modify: `editor/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: the guard from Task 1 (it will now pass once a real pubkey is in place).
- Produces: `app.updater()` available to Task 4 via `tauri_plugin_updater::UpdaterExt`.

- [ ] **Step 1: Add the crate**

In `editor/src-tauri/Cargo.toml`, after the `tauri-plugin-deep-link = "2"` line:

```toml
tauri-plugin-updater = "2"
```

- [ ] **Step 2: Register the plugin**

In `editor/src-tauri/src/lib.rs`, in the `builder` chain that starts at line 709, add after `.plugin(tauri_plugin_clipboard_manager::init())`:

```rust
        // Desktop-only: there is no updater on mobile targets, and the plugin
        // fails to build for them.
        .plugin(tauri_plugin_updater::Builder::new().build())
```

- [ ] **Step 3: Turn on updater artifacts and configure the production channel**

In `editor/src-tauri/tauri.conf.json`, add to the `bundle` object (alongside `"active": true`):

```json
    "createUpdaterArtifacts": true,
```

and add an `updater` entry to `plugins`, beside the existing `deep-link`:

```json
    "updater": {
      "pubkey": "REPLACE_ME",
      "endpoints": ["https://releases.arcaneai.org/latest/{{target}}-{{arch}}.json"],
      "windows": { "installMode": "passive" }
    }
```

- [ ] **Step 4: Configure the dev channel**

In `editor/src-tauri/tauri.dev.conf.json`, add to `plugins` beside `deep-link`:

```json
    "updater": {
      "pubkey": "REPLACE_ME",
      "endpoints": ["https://releases.arcaneai.org/dev/latest/{{target}}-{{arch}}.json"],
      "windows": { "installMode": "passive" }
    }
```

The block is written out in full — pubkey included — rather than relying on a deep merge over the base config. Tauri's merge *is* deep (the current `tauri.dev.conf.json` sets only `build.beforeBuildCommand` and dev builds still inherit `frontendDist`), but the pubkey is public and duplicating it removes merge depth as a failure mode from a code path whose breakage is silent.

- [ ] **Step 5: Allow the webview to read the app version**

In `editor/src-tauri/capabilities/default.json`, add to `permissions` after `"core:default"`:

```json
    "core:app:allow-version",
```

Task 6 uses `getVersion()` from `@tauri-apps/api/app` to show the running version in Settings; it is a core plugin command and is gated by this.

- [ ] **Step 6: Paste the real public key**

Replace **both** occurrences of `REPLACE_ME` with the contents of `~/.tauri/arcane.key.pub`.

> **BLOCKED until the key exists.** Generate with `cd editor && bunx tauri signer generate -w ~/.tauri/arcane.key`, then set repo secrets `TAURI_SIGNING_PRIVATE_KEY` (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/arcane.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The public key is safe to commit; the private key must never enter the repo or a transcript, and must be backed up somewhere durable — if it is lost, every install must be replaced by hand.

- [ ] **Step 7: Verify the config is valid and the guard now passes**

Run: `cd editor && node scripts/check-version-sync.mjs && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: `version sync OK`, then a clean `cargo check`. If the guard still reports the pubkey problem, Step 6 was skipped.

- [ ] **Step 8: Commit**

```bash
git add editor/src-tauri/Cargo.toml editor/src-tauri/Cargo.lock editor/src-tauri/src/lib.rs \
        editor/src-tauri/tauri.conf.json editor/src-tauri/tauri.dev.conf.json \
        editor/src-tauri/capabilities/default.json
git commit -m "feat(updates): wire the updater plugin into both channels"
```

---
### Task 4: The Rust update watcher

The whole update flow lives in Rust for a structural reason: each Tauri window runs its own JS context, so a check scheduled from the frontend would run once per open window and could download the same update several times over. There is exactly one Rust process, so scheduling here is once-per-app by construction.

**Files:**
- Create: `editor/src-tauri/src/updates.rs`
- Modify: `editor/src-tauri/src/lib.rs` (module declaration, `generate_handler!`, `.setup()` at line 871)

**Interfaces:**
- Consumes: `app.updater()` from Task 3; `crate::settings::read_settings()`.
- Produces: the `arcane-update-ready` event carrying `{ version: string, installed: bool }`, and the `updates_apply_and_restart` command. Task 5 consumes both. Task 6 writes the `updates.autoInstall` setting this reads.

- [ ] **Step 1: Write the failing tests**

Create `editor/src-tauri/src/updates.rs` containing only the tests and the function under test's signature — the test module goes at the bottom of the file that Step 3 completes:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_on_when_the_setting_is_absent() {
        assert!(auto_install_from_settings(&json!({})));
    }

    #[test]
    fn respects_an_explicit_opt_out() {
        assert!(!auto_install_from_settings(&json!({"updates.autoInstall": false})));
    }

    #[test]
    fn respects_an_explicit_opt_in() {
        assert!(auto_install_from_settings(&json!({"updates.autoInstall": true})));
    }

    #[test]
    fn defaults_on_for_a_non_boolean_value() {
        // A corrupt or half-written settings file must not silently switch
        // auto-update off: nothing would ever surface that it had happened,
        // and the user would sit on a stale build believing otherwise.
        assert!(auto_install_from_settings(&json!({"updates.autoInstall": "yes"})));
        assert!(auto_install_from_settings(&json!({"updates.autoInstall": null})));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd editor/src-tauri && cargo test --lib updates`
Expected: FAIL to compile — `updates` is not a declared module and `auto_install_from_settings` does not exist.

- [ ] **Step 3: Write the implementation**

Put this **above** the test module in `editor/src-tauri/src/updates.rs`:

```rust
//! Background update watcher.
//!
//! Scheduling lives here rather than in the webview because each Tauri window
//! runs its own JS context: a frontend timer would fire once per open window
//! and could download the same update several times over. There is one Rust
//! process, so once-per-app falls out for free.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Event the frontend listens on once an update is staged.
pub const UPDATE_READY_EVENT: &str = "arcane-update-ready";

/// Delay before the first check. Startup is already contended — Monaco, the
/// LSP sidecars and the file index all boot at once — so the check waits
/// rather than competing for bandwidth with what the user is waiting for.
const INITIAL_DELAY: Duration = Duration::from_secs(60);

/// Gap between checks in a long-lived session.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize)]
pub struct UpdateReady {
    pub version: String,
    /// True when the new version is already in place and only a relaunch is
    /// outstanding (macOS). False when the install still has to run and will
    /// terminate the app to do it (Windows).
    pub installed: bool,
}

/// Whether background installs are enabled, per the persisted settings.
///
/// Defaults to true for every shape it cannot read. A corrupt settings file
/// switching auto-update off silently is the worse failure: nothing would
/// ever tell the user, and they would sit on a stale build indefinitely.
pub fn auto_install_from_settings(settings: &Value) -> bool {
    settings
        .get("updates.autoInstall")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn auto_install_enabled() -> bool {
    crate::settings::read_settings()
        .map(|v| auto_install_from_settings(&v))
        .unwrap_or(true)
}

/// Start the watcher. Non-blocking; safe to call once from `setup`.
pub fn spawn_watcher(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            if check_once(&app).await {
                // An update is staged. Checking again would re-find it — the
                // running process still reports the OLD version until it
                // restarts — and on macOS would re-download and re-install the
                // same build on every tick, forever. Stop instead.
                break;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// One check. Returns true when an update is staged and the watcher should stop.
///
/// Every failure path is swallowed after a log line: this runs unprompted in
/// the background, and there is nothing a user can do about a transient
/// network error they never asked to hear about.
async fn check_once(app: &AppHandle) -> bool {
    if !auto_install_enabled() {
        return false;
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updates] updater unavailable: {e}");
            return false;
        }
    };

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return false,
        Err(e) => {
            eprintln!("[updates] check failed: {e}");
            return false;
        }
    };

    let version = update.version.clone();

    if cfg!(target_os = "windows") {
        // install() launches the NSIS installer, which terminates this
        // process — so downloading now would mean holding the installer
        // resident until the user happens to restart. Announce only; the
        // download runs from `updates_apply_and_restart`.
        let _ = app.emit(UPDATE_READY_EVENT, UpdateReady { version, installed: false });
        return true;
    }

    // macOS: replacing the .app under a running process is safe, and the new
    // version is simply what launches next time.
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            let _ = app.emit(UPDATE_READY_EVENT, UpdateReady { version, installed: true });
            true
        }
        Err(e) => {
            eprintln!("[updates] install failed: {e}");
            false
        }
    }
}

/// Finish the update the user was told about.
///
/// On macOS the new bundle is already in place, so this is just a relaunch.
/// On Windows the download happens here and the NSIS installer replaces us.
#[tauri::command]
pub async fn updates_apply_and_restart(app: AppHandle) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        let update = app
            .updater()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "that update is no longer available".to_string())?;
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        // Not reached in practice — the installer terminates this process.
        Ok(())
    } else {
        app.restart();
    }
}
```

- [ ] **Step 4: Declare the module and register the command**

In `editor/src-tauri/src/lib.rs`, add beside the other `mod` lines near line 4:

```rust
mod updates;
```

Add to the `tauri::generate_handler![` list, beside `settings::write_settings`:

```rust
            updates::updates_apply_and_restart,
```

- [ ] **Step 5: Start the watcher**

In `editor/src-tauri/src/lib.rs`, inside the `.setup(|_app| {` closure at line 871, add as the first statement in the closure body:

```rust
            // Background update watcher — once per process, never per window.
            updates::spawn_watcher(_app.handle());
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd editor/src-tauri && cargo test --lib updates`
Expected: PASS, 4 tests.

- [ ] **Step 7: Confirm the invoke-args check still passes**

Run: `cd editor && bun run check:invoke`
Expected: PASS. `AppHandle` is an injected parameter type, so the no-argument `invoke('updates_apply_and_restart')` added in Task 5 is correct.

- [ ] **Step 8: Commit**

```bash
git add editor/src-tauri/src/updates.rs editor/src-tauri/src/lib.rs
git commit -m "feat(updates): check, download and stage updates in the background"
```

---

### Task 5: Surface the staged update

Turns the `arcane-update-ready` event into a persistent toast with a Restart action, using the notification store that already exists. The event is broadcast to every window, so each open window shows the notice — which is what you want; the user sees it wherever they are.

**Files:**
- Create: `editor/src/features/updates/index.ts`
- Create: `editor/src/features/updates/services/update-notice.ts`
- Create: `editor/src/features/updates/services/update-notice.test.ts`
- Modify: `editor/src/App.tsx`

**Interfaces:**
- Consumes: the `arcane-update-ready` event and `updates_apply_and_restart` command from Task 4.
- Produces: `startUpdateNotices(): Promise<UnlistenFn>` and `updateReadyMessage(payload): string`, both re-exported from `features/updates/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `editor/src/features/updates/services/update-notice.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { updateReadyMessage } from './update-notice';

describe('updateReadyMessage', () => {
  it('says the update is already installed on macOS', () => {
    const msg = updateReadyMessage({ version: '0.3.2', installed: true });
    expect(msg).toContain('0.3.2');
    expect(msg).toContain('installed');
  });

  it('warns that restarting still has work to do on Windows', () => {
    // Windows downloads at restart time rather than in the background, so the
    // copy must not promise an instant restart the way the macOS copy can.
    const msg = updateReadyMessage({ version: '0.3.2', installed: false });
    expect(msg).toContain('0.3.2');
    expect(msg).not.toContain('installed');
    expect(msg.toLowerCase()).toContain('download');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd editor && bun test src/features/updates`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `editor/src/features/updates/services/update-notice.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useNotificationsStore } from '../../../stores/notifications';

export interface UpdateReadyPayload {
  version: string;
  /** True when the new version is in place and only a relaunch is outstanding. */
  installed: boolean;
}

/**
 * Copy for the update toast.
 *
 * Split from the listener so it is testable without a Tauri runtime, and so
 * the platform difference is stated in one place: on macOS the work is done
 * and restarting is instant; on Windows restarting still has to download and
 * run an installer, and promising otherwise would be a lie the user notices.
 */
export function updateReadyMessage({ version, installed }: UpdateReadyPayload): string {
  return installed
    ? `Arcane ${version} is installed — restart whenever you're ready.`
    : `Arcane ${version} is available — restarting will download and install it.`;
}

/**
 * Show a sticky toast whenever the backend stages an update.
 *
 * `persistent` because an update notice that auto-dismisses after four seconds
 * is one the user will miss; they should be able to act on it whenever they
 * reach a natural stopping point.
 */
export async function startUpdateNotices(): Promise<UnlistenFn> {
  return listen<UpdateReadyPayload>('arcane-update-ready', (event) => {
    useNotificationsStore.getState().addNotification({
      type: 'info',
      message: updateReadyMessage(event.payload),
      persistent: true,
      actions: [
        {
          label: 'Restart',
          run: () => {
            // Rejection is not worth a second toast: on Windows the process is
            // terminated by the installer mid-call, so the promise never
            // settles in the success case either.
            invoke('updates_apply_and_restart').catch(() => {});
          },
        },
      ],
    });
  });
}
```

Create `editor/src/features/updates/index.ts`:

```ts
// Public API of the updates feature. `check:modules` requires that every
// feature expose one, and that other features import only through it.
export { startUpdateNotices, updateReadyMessage } from './services/update-notice';
export type { UpdateReadyPayload } from './services/update-notice';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd editor && bun test src/features/updates`
Expected: PASS, 2 tests.

- [ ] **Step 5: Start the listener**

In `editor/src/App.tsx`, add the import beside the other feature imports:

```ts
import { startUpdateNotices } from './features/updates';
```

and add an effect alongside the other mount effects in the `App` component:

```tsx
  useEffect(() => {
    // Returns an unlisten fn; the promise resolves after mount, so cleanup
    // has to chain rather than return it directly.
    const pending = startUpdateNotices();
    return () => { void pending.then((un) => un()); };
  }, []);
```

- [ ] **Step 6: Verify the module boundary and types**

Run: `cd editor && bun run check:modules && tsc --noEmit`
Expected: PASS both. If `check:modules` complains, the import in `App.tsx` is reaching past `features/updates/index.ts`.

- [ ] **Step 7: Commit**

```bash
git add editor/src/features/updates editor/src/App.tsx
git commit -m "feat(updates): offer a restart once an update is staged"
```

---

### Task 6: Show the version, and let people opt out

The app displays its own version nowhere today — no About box, nothing in Settings — which makes "what version are you on?" unanswerable when someone files a bug. Adds an Updates settings category carrying the running version and a single opt-out toggle.

**Files:**
- Modify: `editor/src/types/index.ts` (`SettingsSchema`)
- Modify: `editor/src/stores/settings.ts` (`DEFAULT_SETTINGS`)
- Modify: `editor/src/features/settings/data/definitions.ts`
- Modify: `editor/src/features/settings/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: `auto_install_from_settings` in Task 4 reads the `updates.autoInstall` key this writes; the name must match exactly.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Extend `editor/src/features/settings/data/definitions.test.ts`. Merge these imports into the existing ones at the top of the file, then append the `describe` block:

```ts
import { SETTING_DEFINITIONS } from './definitions';
import { DEFAULT_SETTINGS } from '../../../stores/settings';

describe('updates settings', () => {
  it('offers an auto-install toggle', () => {
    const def = SETTING_DEFINITIONS.find((d) => d.key === 'updates.autoInstall');
    expect(def).toBeDefined();
    expect(def!.type).toBe('boolean');
    expect(def!.category).toBe('Updates');
  });

  it('defaults auto-install on', () => {
    // Must agree with `auto_install_from_settings` in src-tauri/src/updates.rs,
    // which also defaults true. If these two disagree, the checkbox shows one
    // thing and the backend does another.
    expect(DEFAULT_SETTINGS['updates.autoInstall']).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd editor && bun test src/features/settings/data/definitions.test.ts`
Expected: FAIL — the key is not in `SettingsSchema`, so this will not compile.

- [ ] **Step 3: Add the setting**

In `editor/src/types/index.ts`, add to `SettingsSchema` beside the other top-level keys (after `'window.zoomLevel'`'s neighbours):

```ts
  /** Download and install new versions in the background. */
  'updates.autoInstall': boolean;
```

In `editor/src/stores/settings.ts`, add to `DEFAULT_SETTINGS`:

```ts
  'updates.autoInstall': true,
```

In `editor/src/features/settings/data/definitions.ts`, append to `SETTING_DEFINITIONS`:

```ts
  { key: 'updates.autoInstall', type: 'boolean', category: 'Updates', label: 'Automatic Updates', description: 'Download and install new versions of Arcane in the background. Updates take effect when you restart.' },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd editor && bun test src/features/settings/data/definitions.test.ts`
Expected: PASS. The `Updates` category appears in the modal's left rail automatically — `categoriesOf` derives the nav from the catalogue.

- [ ] **Step 5: Show the running version**

In `editor/src/features/settings/components/SettingsModal.tsx`, add the import:

```ts
import { getVersion } from '@tauri-apps/api/app';
```

add state and a load effect in the component:

```tsx
  const [appVersion, setAppVersion] = useState<string>('');
  useEffect(() => {
    // Best-effort: the version line is a nicety, and a failure here must not
    // stop the settings modal from opening.
    getVersion().then(setAppVersion).catch(() => {});
  }, []);
```

and render it inside the Updates section pane, above the toggle:

```tsx
  {activeSection === 'Updates' && appVersion && (
    <p class="mb-4 font-mono text-xs opacity-70">Arcane {appVersion}</p>
  )}
```

Adapt the conditional and class syntax to whatever the surrounding component already uses — this file renders sections through `SettingsSection`, so follow that structure rather than pasting verbatim.

- [ ] **Step 6: Verify**

Run: `cd editor && tsc --noEmit && bun test src/features/settings`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add editor/src/types/index.ts editor/src/stores/settings.ts \
        editor/src/features/settings/data/definitions.ts \
        editor/src/features/settings/data/definitions.test.ts \
        editor/src/features/settings/components/SettingsModal.tsx
git commit -m "feat(settings): show the running version and allow opting out of auto-update"
```

---
### Task 7: Publish signed manifests from the release workflow

`release.yml` already builds and uploads the installers. This adds the signing secrets, stages the updater artifacts, and writes one manifest per platform. The manifest writer is a shared script with its own tests, because two workflows use it and the failure modes are silent.

**Files:**
- Create: `editor/scripts/update-manifest.mjs`
- Create: `editor/scripts/update-manifest.test.ts`
- Create: `editor/scripts/write-update-manifest.mjs`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `editor/package.json` version (Task 1), the manifest URLs from Task 2, `TAURI_SIGNING_PRIVATE_KEY` from Task 3's owner step.
- Produces: `https://releases.arcaneai.org/latest/{darwin-aarch64,windows-x86_64}.json`. Task 8 reuses the same script for the dev channel.

- [ ] **Step 1: Write the failing test**

Create `editor/scripts/update-manifest.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { buildManifest } from './update-manifest.mjs';

const OK = {
  platform: 'darwin-aarch64',
  version: '0.3.2',
  url: 'https://releases.arcaneai.org/v0.3.2/Arcane.app.tar.gz',
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
          url: 'https://releases.arcaneai.org/v0.3.2/Arcane.app.tar.gz',
        },
      },
    });
  });

  it('refuses a url under /latest/', () => {
    // A manifest must name an immutable path. Pointing at /latest/ means a
    // download already in flight can be swapped out by the next release —
    // the client would verify a signature against different bytes.
    expect(() => buildManifest({ ...OK, url: 'https://releases.arcaneai.org/latest/Arcane.app.tar.gz' }))
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd editor && bun test scripts/update-manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `editor/scripts/update-manifest.mjs`:

```js
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
```

Create `editor/scripts/write-update-manifest.mjs`:

```js
#!/usr/bin/env node
// Usage:
//   node editor/scripts/write-update-manifest.mjs \
//     --platform darwin-aarch64 --version 0.3.2 \
//     --url https://releases.arcaneai.org/v0.3.2/Arcane.app.tar.gz \
//     --sig dist-release/Arcane.app.tar.gz.sig \
//     --out dist-release/darwin-aarch64.json
import { readFileSync, writeFileSync } from 'node:fs';
import { buildManifest } from './update-manifest.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);

const manifest = buildManifest({
  platform: args.platform,
  version: args.version,
  url: args.url,
  signature: readFileSync(args.sig, 'utf8'),
  pubDate: new Date().toISOString(),
});

writeFileSync(args.out, JSON.stringify(manifest, null, 2));
console.log(`wrote ${args.out}: ${manifest.version} -> ${manifest.platforms[args.platform].url}`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd editor && bun test scripts/update-manifest.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add updater metadata to the release matrix**

In `.github/workflows/release.yml`, extend each matrix entry:

```yaml
          - os: macos-14          # Apple Silicon
            triple: aarch64-apple-darwin
            bundles: dmg
            asset: Arcane-arm64.dmg
            glob: editor/src-tauri/target/release/bundle/dmg/*.dmg
            platform_key: darwin-aarch64
            updater_asset: Arcane.app.tar.gz
            updater_glob: editor/src-tauri/target/release/bundle/macos/*.app.tar.gz
          - os: windows-latest    # Windows x64
            triple: x86_64-pc-windows-msvc
            bundles: nsis
            asset: ArcaneSetup.exe
            glob: editor/src-tauri/target/release/bundle/nsis/*-setup.exe
            platform_key: windows-x86_64
            updater_asset: ArcaneSetup.exe
            updater_glob: editor/src-tauri/target/release/bundle/nsis/*-setup.exe
```

On Windows the updater artifact *is* the installer — the same file, now with a `.sig` beside it. On macOS the DMG is not an updater artifact, so `.app.tar.gz` is produced alongside it.

- [ ] **Step 6: Assert the tag matches the app version**

Add a step immediately after `- uses: actions/checkout@v4`:

```yaml
      # A tag that disagrees with package.json publishes a manifest claiming a
      # version the binary does not report. Clients would update, still report
      # the old version, and update again — every six hours, forever. Fail here
      # instead.
      - name: Assert the tag matches editor/package.json
        if: startsWith(github.ref, 'refs/tags/v')
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          PKG=$(node -p "require('./editor/package.json').version")
          if [[ "$TAG" != "$PKG" ]]; then
            echo "tag $GITHUB_REF_NAME does not match editor/package.json version $PKG" >&2
            exit 1
          fi
```

- [ ] **Step 7: Sign the build**

Add to the `env:` block of the "Build Tauri app" step:

```yaml
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

- [ ] **Step 8: Stage the updater artifact and write the manifest**

Replace the "Stage installer under its public name" step with:

```yaml
      - name: Stage installer and updater artifact
        run: |
          mkdir -p dist-release
          cp "$(ls ${{ matrix.glob }} | head -n1)" "dist-release/${{ matrix.asset }}"
          UP="$(ls ${{ matrix.updater_glob }} | head -n1)"
          cp "$UP"      "dist-release/${{ matrix.updater_asset }}"
          cp "$UP.sig"  "dist-release/${{ matrix.updater_asset }}.sig"

      - name: Write the update manifest
        run: |
          V="${GITHUB_REF_NAME:-dev}"
          node editor/scripts/write-update-manifest.mjs \
            --platform "${{ matrix.platform_key }}" \
            --version  "${V#v}" \
            --url      "https://releases.arcaneai.org/$V/${{ matrix.updater_asset }}" \
            --sig      "dist-release/${{ matrix.updater_asset }}.sig" \
            --out      "dist-release/${{ matrix.platform_key }}.json"
```

- [ ] **Step 9: Upload the artifact and manifest**

Append to the `run:` block of the "Upload to R2" step:

```bash
          bunx wrangler r2 object put "arcane-releases/$V/${{ matrix.updater_asset }}" --file "dist-release/${{ matrix.updater_asset }}" --remote
          # The manifest is the one object that must never be served stale —
          # it is how a rollback reaches clients. Short TTL, JSON content type.
          bunx wrangler r2 object put "arcane-releases/latest/${{ matrix.platform_key }}.json" \
            --file "dist-release/${{ matrix.platform_key }}.json" --remote \
            --content-type application/json --cache-control "max-age=300"
```

- [ ] **Step 10: Verify the workflow parses**

Run: `cd editor && bun test scripts/update-manifest.test.ts && python3 -c "import yaml,sys; yaml.safe_load(open('../.github/workflows/release.yml')); print('release.yml parses')"`
Expected: tests PASS and the YAML parses.

- [ ] **Step 11: Commit**

```bash
git add editor/scripts/update-manifest.mjs editor/scripts/update-manifest.test.ts \
        editor/scripts/write-update-manifest.mjs .github/workflows/release.yml
git commit -m "ci(release): publish signed update manifests alongside the installers"
```

---

### Task 8: The same, for the dev channel

`dev-build.yml` mirrors `release.yml` step-for-step and must stay in sync. It needs one thing the release workflow does not: a unique version per build. Without it every dev build claims the same version, `remote > current` is false, and the dev channel silently never updates.

**Files:**
- Create: `editor/scripts/stamp-dev-version.mjs`
- Create: `editor/scripts/stamp-dev-version.test.ts`
- Modify: `.github/workflows/dev-build.yml`

**Interfaces:**
- Consumes: `buildManifest` from Task 7.
- Produces: `devVersion(base, runNumber)` → `string`; dev manifests at `dev/latest/*.json`.

- [ ] **Step 1: Write the failing test**

Create `editor/scripts/stamp-dev-version.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { devVersion } from './stamp-dev-version.mjs';

describe('devVersion', () => {
  it('appends a monotonic prerelease tag', () => {
    expect(devVersion('0.3.1', 42)).toBe('0.3.1-dev.42');
  });

  it('orders numerically, not lexically', () => {
    // The trap: semver compares numeric prerelease identifiers as numbers, so
    // dev.10 > dev.9. If this were ever emitted as a string tag ("dev.09") the
    // ordering would silently invert and clients would stop updating.
    const nine = devVersion('0.3.1', 9);
    const ten = devVersion('0.3.1', 10);
    expect(nine).toBe('0.3.1-dev.9');
    expect(ten).toBe('0.3.1-dev.10');
  });

  it('strips an existing prerelease so re-stamping is idempotent', () => {
    expect(devVersion('0.3.1-dev.7', 8)).toBe('0.3.1-dev.8');
  });

  it('rejects a run number that is not a positive integer', () => {
    expect(() => devVersion('0.3.1', 0)).toThrow(/run number/);
    expect(() => devVersion('0.3.1', -1)).toThrow(/run number/);
    expect(() => devVersion('0.3.1', 1.5)).toThrow(/run number/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd editor && bun test scripts/stamp-dev-version.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `editor/scripts/stamp-dev-version.mjs`:

```js
/**
 * Gives every dev build a unique, increasing version.
 *
 * Without this the dev channel is silently dead: `dev-build.yml` rebuilds on
 * every push but the repo version does not move, so the updater compares
 * 0.3.1 against 0.3.1, finds no update, and reports nothing wrong.
 *
 * A prerelease tag (not build metadata, `+dev.N`) because semver IGNORES build
 * metadata when comparing — `0.3.1+dev.9` and `0.3.1+dev.10` are equal, which
 * would reintroduce the exact bug. Numeric prerelease identifiers compare
 * numerically, so dev.10 correctly beats dev.9.
 */
export function devVersion(base, runNumber) {
  if (!Number.isInteger(runNumber) || runNumber < 1) {
    throw new Error(`run number must be a positive integer, got ${runNumber}`);
  }
  const core = String(base).split('-')[0];
  return `${core}-dev.${runNumber}`;
}
```

Append the runner to the same file:

```js
// Runner: `node editor/scripts/stamp-dev-version.mjs <runNumber>` rewrites
// editor/package.json in place. Cargo.toml is left alone deliberately —
// tauri.conf.json reads package.json, so that is the version the app reports.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const path = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = devVersion(pkg.version, Number(process.argv[2]));
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(pkg.version);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd editor && bun test scripts/stamp-dev-version.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mirror the release workflow changes**

In `.github/workflows/dev-build.yml`, extend the matrix entries:

```yaml
          - os: macos-14          # Apple Silicon
            triple: aarch64-apple-darwin
            bundles: dmg
            asset: Arcane-Dev-arm64.dmg
            glob: editor/src-tauri/target/release/bundle/dmg/*.dmg
            platform_key: darwin-aarch64
            updater_asset: Arcane-Dev.app.tar.gz
            updater_glob: editor/src-tauri/target/release/bundle/macos/*.app.tar.gz
          - os: windows-latest    # Windows x64
            triple: x86_64-pc-windows-msvc
            bundles: nsis
            asset: ArcaneDevSetup.exe
            glob: editor/src-tauri/target/release/bundle/nsis/*-setup.exe
            platform_key: windows-x86_64
            updater_asset: ArcaneDevSetup.exe
            updater_glob: editor/src-tauri/target/release/bundle/nsis/*-setup.exe
```

`updater_asset` is hyphenated on purpose: the dev app's `productName` is `Arcane Dev`, so the bundler emits `Arcane Dev.app.tar.gz` **with a space**, which needs URL-encoding in the manifest or it 404s. Staging it under a hyphenated name sidesteps that. Renaming is safe — the minisign signature covers the file's bytes, not its name.

- [ ] **Step 6: Stamp the version before building**

Add a step after "Install JS deps":

```yaml
      # Every dev build needs its own version or the updater never fires —
      # see editor/scripts/stamp-dev-version.mjs for why this is a prerelease
      # tag rather than build metadata.
      - name: Stamp a unique dev version
        run: node editor/scripts/stamp-dev-version.mjs "${{ github.run_number }}"
```

- [ ] **Step 7: Sign, stage and publish**

Add the same two `TAURI_SIGNING_*` env vars to the "Build Tauri app (dev config)" step as in Task 7 Step 7. Then replace the staging step and extend the upload:

```yaml
      - name: Stage installer and updater artifact
        run: |
          mkdir -p dist-release
          cp "$(ls ${{ matrix.glob }} | head -n1)" "dist-release/${{ matrix.asset }}"
          UP="$(ls ${{ matrix.updater_glob }} | head -n1)"
          cp "$UP"      "dist-release/${{ matrix.updater_asset }}"
          cp "$UP.sig"  "dist-release/${{ matrix.updater_asset }}.sig"

      - name: Write the update manifest
        run: |
          SHA7="${GITHUB_SHA:0:7}"
          V=$(node -p "require('./editor/package.json').version")
          node editor/scripts/write-update-manifest.mjs \
            --platform "${{ matrix.platform_key }}" \
            --version  "$V" \
            --url      "https://releases.arcaneai.org/dev/$SHA7/${{ matrix.updater_asset }}" \
            --sig      "dist-release/${{ matrix.updater_asset }}.sig" \
            --out      "dist-release/${{ matrix.platform_key }}.json"
```

and append to the "Upload to R2 (dev channel)" `run:` block:

```bash
          bunx wrangler r2 object put "arcane-releases/dev/$SHA7/${{ matrix.updater_asset }}" --file "dist-release/${{ matrix.updater_asset }}" --remote
          bunx wrangler r2 object put "arcane-releases/dev/latest/${{ matrix.platform_key }}.json" \
            --file "dist-release/${{ matrix.platform_key }}.json" --remote \
            --content-type application/json --cache-control "max-age=300"
```

- [ ] **Step 8: Verify**

Run: `cd editor && bun test scripts/ && python3 -c "import yaml; yaml.safe_load(open('../.github/workflows/dev-build.yml')); print('dev-build.yml parses')"`
Expected: all script tests PASS and the YAML parses.

- [ ] **Step 9: Commit**

```bash
git add editor/scripts/stamp-dev-version.mjs editor/scripts/stamp-dev-version.test.ts \
        .github/workflows/dev-build.yml
git commit -m "ci(dev): give every dev build its own version and publish its manifest"
```

---

### Task 9: Refresh the production site on release

The cards read the manifest at build time, so they only change when the site is rebuilt — and the production site deploys on manual dispatch only. A `v*` tag now also deploys it.

**Files:**
- Modify: `.github/workflows/deploy-landing.yml`

- [ ] **Step 1: Add the tag trigger**

In `.github/workflows/deploy-landing.yml`, add to the `on:` block beside the existing `push`:

```yaml
on:
  push:
    branches: ['dev']
    paths: ['landing-page/**', '.github/workflows/deploy-landing.yml']
    tags: ['v*']
```

- [ ] **Step 2: Route tags to the production job**

The dev job currently runs on any push. Narrow it, and widen the production job. Change the dev job's condition to:

```yaml
    if: (github.event_name == 'push' && !startsWith(github.ref, 'refs/tags/')) || inputs.environment == 'dev'
```

and the production job's to:

```yaml
    if: startsWith(github.ref, 'refs/tags/v') || inputs.environment == 'production'
```

Without the first change a tag push would deploy the dev site as well as production.

- [ ] **Step 3: Verify the conditions**

Run: `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy-landing.yml')); print(list(d['jobs'])); [print(k, '->', v.get('if')) for k,v in d['jobs'].items()]"`
Expected: prints both jobs with the new conditions. Confirm by reading that a tag push matches production only, and a `dev` branch push matches dev only.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-landing.yml
git commit -m "ci(landing): refresh the production site when a release is tagged"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run the whole suite**

Run: `cd editor && bun run verify`
Expected: PASS. If the auth_loopback stop test fails, re-run once — it flakes roughly half the time independently of any change.

- [ ] **Step 2: Run the landing tests and build**

Run: `cd landing-page && pnpm test && pnpm build`
Expected: PASS, and the built `dist/index.html` contains a real version.

- [ ] **Step 3: Write the manual checklist**

Create `docs/superpowers/plans/2026-08-23-auto-update-manual-verification.md` covering, in order:

1. **Dev channel, macOS.** Install the dev build from `dev/latest/`. Push a trivial commit to `dev`, wait for Dev Build to finish, reopen the app, wait out the 60s initial delay. Expect a toast: "Arcane 0.3.1-dev.N is installed — restart whenever you're ready." Restart; confirm Settings → Updates shows the new version.
2. **The ad-hoc signing question.** After that restart, confirm the app launches normally with no "damaged / cannot be opened" Gatekeeper dialog. This is the highest-risk unknown in the whole design — bundle replacement under ad-hoc signing is expected to work but has not been proven here.
3. **Dev channel, Windows.** Same, expecting "available — restarting will download and install it", then a UAC / SmartScreen prompt on restart. Record exactly what the prompt says; unsigned Windows builds may undercut "silent".
4. **The opt-out.** Turn off Settings → Updates → Automatic Updates, publish another dev build, confirm no toast appears.
5. **No re-install loop.** Leave the app running for one check interval after an update is staged and confirm it does not download again.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-23-auto-update-manual-verification.md
git commit -m "docs(update): manual verification checklist for auto-update"
```
