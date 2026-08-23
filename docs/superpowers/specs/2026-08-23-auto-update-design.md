# Auto-update for Arcane

Date: 2026-08-23
Status: approved, pending implementation plan

## Problem

Every Arcane upgrade is a manual download. There is no updater in the app at
all — `tauri-plugin-updater` is absent from `editor/src-tauri/Cargo.toml`, and
nothing in the app ever asks whether a newer version exists. Users install a
DMG or an EXE, and that is the version they keep until they happen to visit
the site again.

The same gap shows up on the site itself. `landing-page/src/components/DownloadSection.astro`
hardcodes `"v0.2.0"` while the app has shipped `v0.3.1`, because the version is
copy-pasted into four files with nothing tying them together:

| File | Value |
| --- | --- |
| `editor/package.json` | `0.3.1` |
| `editor/src-tauri/tauri.conf.json` | `0.3.1` |
| `editor/src-tauri/Cargo.toml` | `0.3.1` |
| `landing-page/src/components/DownloadSection.astro:12` | `v0.2.0` |

Both problems are the same problem: no single source of truth for "what version
is current", and no machine-readable feed anyone — the app or the website — can
read to find out.

## Scope

In scope: a signed update feed published by CI, an updater client in the app for
both the production and dev channels, a single source of truth for the version,
and download cards derived from the feed.

Out of scope: the Unity extension (`arcane-extension/`), which ships as a UPM
package and updates through Unity's own Package Manager — a different mechanism
with a different cadence, versioned independently (`0.0.1`) of the app. Also out
of scope: staged rollouts, update telemetry, and release notes in the update UI.

## Decisions

| Question | Decision |
| --- | --- |
| Update experience | Silent — download and apply without prompting, new version takes effect on restart |
| Channels | Both production and "Arcane Dev" auto-update, each strictly from its own channel |
| Feed hosting | Static per-platform manifests in R2, written by the release workflows |
| Version display on the site | Derived from the feed at build time, per platform |
| Prod site refresh | A `v*` tag triggers the production landing deploy |

### Why static manifests rather than a Worker route

`arcane-server` already serves app config (`src/routes/config.ts`), so a
`/updates/:target/:arch` route would have precedent, and it would buy staged
rollouts, minimum-version gating and adoption telemetry. None of those are
needed yet, and the realistic emergency — a bad release that must stop
propagating — is already covered by static files: overwriting one small JSON
points every client back at the previous good version. That is the kill switch,
and it costs no server code, no new binding, and no dependency on the API worker
being up.

A Worker route remains a clean later upgrade. Endpoints are baked into the
binary at build time, so switching would require shipping a release — acceptable,
and not worth pre-paying for now.

GitHub Releases with `tauri-action` was rejected outright: this project
deliberately publishes to R2, and a "View all releases on GitHub" link was
explicitly removed from the landing page rather than left in place. Routing the
update feed through GitHub Releases would undo that decision.

## A. Trust — the signing key

Tauri's updater rejects any artifact not signed by a key the project controls.
This is minisign and is entirely separate from macOS code signing; its purpose is
that a compromised R2 bucket cannot push arbitrary code to every install.

Generated once by the owner:

```bash
cd editor && bunx tauri signer generate -w ~/.tauri/arcane.key
```

- Public half → `plugins.updater.pubkey` in `tauri.conf.json`, committed.
- Private half + password → repo secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

One key covers both channels; only the endpoint differs between them.

**The key is permanent and load-bearing.** Once a release ships with the public
key baked in, installed apps accept updates signed by that key and nothing else.
If it is lost, every existing user must reinstall by hand — there is no recovery
path, because the broken clients are exactly the ones that can no longer be
reached by an update. It needs a durable backup outside `~/.tauri`.

## B. One version, one place

`tauri.conf.json`'s `version` field accepts either a semver string or a path to a
`package.json` to read it from. Setting:

```json
"version": "../package.json"
```

makes `editor/package.json` the sole place a version is bumped. A consistency
check wired into `bun run verify` fails if any file drifts back out of sync.

Whether `Cargo.toml`'s `version` still influences anything once the config points
at `package.json` must be confirmed empirically during implementation — build
once and assert the running app reports the expected version — rather than
assumed.

### The dev channel needs a unique version per build

`dev-build.yml` rebuilds on every push to `dev`, but the version in the repo
stays fixed. The updater only reports an update when remote > current, so every
dev build would claim `0.3.1`, `0.3.1 > 0.3.1` would be false, and the dev
channel would never update — silently, with no error anywhere.

Dev builds therefore stamp `0.3.1-dev.<run_number>` into `editor/package.json`
before building. Semver compares numeric prerelease identifiers numerically, so
`dev.9 < dev.10` orders correctly, and the sequence keeps climbing across version
bumps. A dev build sorts below the production release of the same number, which
is harmless: the dev channel only ever compares against itself.

## C. What CI publishes

`bundle.createUpdaterArtifacts: true` makes the bundler emit an updater artifact
and a detached `.sig` alongside the existing installers:

| Platform | Updater artifact | Installer (unchanged) |
| --- | --- | --- |
| macOS arm64 | `Arcane.app.tar.gz` + `.sig` | `Arcane-arm64.dmg` |
| Windows x64 | `ArcaneSetup.exe` + `.sig` | same file |

DMG and EXE continue to ship for fresh installs. The updater artifacts are
additional, not a replacement.

Each matrix leg writes its own manifest next to the binaries:

```
releases.arcaneai.org/latest/darwin-aarch64.json
releases.arcaneai.org/latest/windows-x86_64.json
releases.arcaneai.org/dev/latest/darwin-aarch64.json
releases.arcaneai.org/dev/latest/windows-x86_64.json
```

Manifest shape (the `signature` field holds the contents of the `.sig` file,
inlined):

```json
{
  "version": "0.3.2",
  "pub_date": "2026-08-23T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of Arcane.app.tar.gz.sig>",
      "url": "https://releases.arcaneai.org/v0.3.2/Arcane.app.tar.gz"
    }
  }
}
```

The app requests `.../{{target}}-{{arch}}.json`. Verified against the plugin
source (`plugins/updater/src/updater.rs`): `{{target}}` expands to `darwin` /
`windows` — *not* `macos`; the source carries a `// TODO shouldn't this be macos
instead?` comment on that branch — and `{{arch}}` to `aarch64` / `x86_64`. A
wrong path here produces a 404 on every check and no updates at all, with no
user-visible symptom, so the implementation must assert the exact filenames.

**Filename gotcha:** the dev app's `productName` is `Arcane Dev`, so its bundler
output is `Arcane Dev.app.tar.gz` — with a space, which needs URL-encoding in the
manifest or it 404s. Both workflows already stage installers under a hyphenated
public name; the updater artifact gets the same treatment (`Arcane-Dev.app.tar.gz`).
Renaming is safe because the minisign signature covers the file's contents, not
its name.

Two properties worth preserving:

- **Per-platform files, not one combined `latest.json`.** macOS and Windows build
  on different runners; separate files mean they cannot race each other, and no
  join job is needed after the matrix.
- **Manifest `url`s point at the versioned path**, never `latest/`, so a download
  already in flight cannot be swapped out mid-release.

Rolling back a bad release is overwriting one JSON object.

## D. How the app updates

The client checks on launch — deferred so it does not compete with startup — and
periodically thereafter. Check failures are swallowed: a background check never
surfaces an error, because there is nothing the user can do about a transient
network failure they did not ask to be told about.

`download()` and `install()` are separate calls in the plugin, which is what
makes the silent model workable across both platforms:

- **macOS**: `install()` runs immediately after download. Replacing the `.app`
  under a running process is safe; the new version is simply what launches next
  time. Zero clicks.
- **Windows**: the NSIS installer closes the app to apply, per the plugin's own
  documentation ("this function exits the app after launching the updater
  installer successfully"). Downloading cannot be followed by installing, so
  Windows only *detects* in the background and shows a dismissible "Update
  available — Restart" notice; the download runs when the restart is clicked.

  Pre-downloading on Windows was considered and rejected. `Update::download()`
  returns the artifact as an in-memory `Vec<u8>`, and an NSIS installer carrying
  the PyInstaller and LSP sidecars runs to hundreds of megabytes — holding that
  resident for hours to save a few seconds at restart is a bad trade. Staging it
  to a temp file instead would work, but brings partial-write handling, stale-file
  cleanup, and a superseded-version case for no user-visible gain. Windows users
  wait for the download when they click Restart; they were going to wait for a
  restart regardless.

The check runs once per app process, not once per window — the app opens a
`welcome` window plus `editor-*` windows, all sharing one process.

### New dependencies and permissions

- `tauri-plugin-updater` and `tauri-plugin-process` (the latter for `relaunch()`),
  registered in `lib.rs`.
- `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` on the JS side.
- `capabilities/default.json` gains `updater:default` and the process restart
  permission.

### Channel configuration

The two configs differ only in `endpoints` — production reads `latest/`, dev
reads `dev/latest/`.

Tauri's config merge is deep, which the current tree already demonstrates:
`tauri.dev.conf.json` sets only `build.beforeBuildCommand`, and dev builds still
find `frontendDist` and `devUrl` from the base config. `plugins.updater` is
nonetheless written out **in full** in both files — pubkey included, which is
public and safe to duplicate. The duplication costs nothing and removes config
merge depth as a failure mode from a code path whose breakage is silent.

### Surfacing the version

The app currently displays its own version nowhere — there is no About box and
nothing in Settings — which makes "what version are you on?" unanswerable when
someone reports a bug. A new Updates section in the existing settings catalogue
(`features/settings/data/definitions.ts`) shows the running version and offers a
single toggle to disable automatic installation, for anyone who needs version
stability.

## E. The landing page

`DownloadSection.astro` drops the hardcoded string. Each card reads its own
platform's manifest during `astro build` — a server-side fetch in Node, so no
CORS configuration on the R2 bucket and no client-side network dependency —
falling back to `editor/package.json` if the fetch fails.

Per-platform rather than one shared number because it is strictly more honest: if
a Windows build fails during a release and macOS succeeds, each card keeps
showing the version that platform can actually download. Obsidian's download page
shows exactly this asymmetry in the wild (desktop `1.13.7` alongside Android
`1.13.8`).

The dev site continues to show "dev build" rather than a number; dev versions
change several times a day and the string carries no useful information.

`deploy-landing.yml` gains a `v*` tag trigger so cutting a release refreshes the
production site. This loosens the current "production deploys are always a manual
dispatch" rule, accepted on the grounds that a version tag is a deliberate act
and not an accidental push.

### Prior art

Reviewed while choosing this approach:

| App | Download page shows | Source |
| --- | --- | --- |
| VS Code | nothing next to the buttons | n/a |
| Zed | one version + date above the section | live release API, the same service its updater uses |
| Cursor | one version above the buttons | live release feed |
| Obsidian | version inside each filename, per platform | the link itself |

None hardcode the version into the page template, and the ones that display a
version derive it from the feed their updater reads. That is the property being
copied here.

## F. Testing

- Unit tests for the update state machine (check → download → install → ready)
  and for dev-version stamping, following the existing `*.test.ts` convention
  under `editor/src/features/`.
- A version-consistency check in `bun run verify`.
- A manual verification checklist, per this repo's existing
  `docs/superpowers/plans/*-manual-verification.md` habit.

Note: `bun run verify` is known to flake on the auth_loopback stop test roughly
half the time, independently of any change under test.

## Risks

**macOS ad-hoc signing (highest risk).** The app is ad-hoc signed
(`signingIdentity: "-"`), not notarized. Bundle replacement under ad-hoc signing
*should* work — Tauri downloads the artifact itself, so no quarantine attribute
is set, and the replacement bundle carries its own valid signature from CI — but
this must be proven by a real upgrade between two real releases on a real Mac
before it reaches users. An auto-updater that bricks itself is the hardest class
of bug to recover from, because the broken clients are precisely the ones that
can no longer be updated.

**Windows SmartScreen.** Windows builds are unsigned. The NSIS installer launched
by the updater may trigger SmartScreen or a UAC prompt, which undercuts "silent".
Behaviour needs confirming on a real Windows machine; a code-signing certificate
is the only real fix and is out of scope here.

**No path for existing users.** Anyone on v0.3.1 or earlier has no update client
in their app and needs one final manual download. This is unavoidable and should
be communicated wherever release notes are published.

## Owner tasks

1. Generate the signing keypair and back up the private key durably.
2. Set `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as
   repo secrets — **before** the first release build, or the build produces
   unsigned artifacts that no client will accept.
3. Verify a real macOS upgrade between two releases before announcing.
