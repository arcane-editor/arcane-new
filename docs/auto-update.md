# Auto-update

How UnityIDE updates itself, why it is built this way, and the things that break
it silently.

Implemented by Tasks 3–8 of `docs/superpowers/plans/2026-08-23-auto-update.md`.
Tasks 9–10 (site refresh on release, the plan's own verification pass) are
**not** done — see [What is not built](#what-is-not-built).

---

## The trust model

There is exactly **one keypair**, and it is the whole security story.

| Half | Lives in | Used for |
|---|---|---|
| Private | `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (GitHub secrets), backed up in `~/.unityide-release-keys/` | CI signs each update bundle |
| Public | `pubkey` in `tauri.conf.json` **and** `tauri.dev.conf.json` — compiled into the binary | The installed app verifies what it downloads |

Current key id: `2E7CE0241A47EB25`.

An app only trusts bytes signed by the key it was **built with**. Three
consequences, all permanent:

- **Never rotate the key casually.** Every existing install stops accepting
  updates the moment you do, and there is no remote fix — each one has to be
  replaced by hand.
- **Never lose the private key.** GitHub secrets are write-only; you cannot read
  it back out. Losing `~/.unityide-release-keys/` means you can never publish an
  update an installed build will accept.
- **The two halves must match.** `bun run check:version` fails on a placeholder
  pubkey in *either* config for this reason. It is the only thing standing
  between you and shipping installs that can never update.

---

## In the running app

Scheduling lives in **Rust** (`editor/src-tauri/src/updates.rs`), not the
webview. Each Tauri window runs its own JS context, so a frontend timer would
fire once *per open window* and could download the same update several times
over. There is one Rust process, so once-per-app falls out for free.

```
app starts
  └─ sleep 60s                    INITIAL_DELAY — startup is already contended
      │                           (Monaco, LSP sidecars, the file index)
      └─ check ──► nothing ──► sleep 6h ──► check ...   CHECK_INTERVAL
             └──► update found ──► platform path ──► STOP
```

The watcher **stops** once an update is staged. The running process still
reports the *old* version until it restarts, so continuing would re-find the
same update on every tick — and on macOS re-download and re-install it, forever.

Each check first reads `updates.autoInstall` from settings.
`auto_install_from_settings` returns **true for every shape it cannot read** —
absent, non-boolean, null. A corrupt settings file silently disabling updates is
the worse failure: nothing would ever surface it and the user sits on a stale
build believing otherwise.

### The platforms genuinely differ

| | macOS | Windows |
|---|---|---|
| Background check | downloads **and installs** | **announces only** |
| Why | replacing the `.app` under a running process is safe | `install()` launches the NSIS installer, which terminates this process |
| Restart does | relaunches (`app.restart()`) | downloads, then the installer replaces us |
| Toast says | "…is installed — restart whenever you're ready." | "…is available — restarting will download and install it." |

The copy difference is not decoration. Promising an instant restart on Windows
is a lie the user notices when it sits there downloading.

### The notice

Rust emits `unityide-update-ready` carrying `{ version, installed }`.
`editor/src/features/updates/` listens and raises a **persistent** notification
with a Restart action, which invokes `updates_apply_and_restart`.

Persistent on purpose: a notice that auto-dismisses after four seconds is one
the user misses, and this is something to act on at a natural stopping point.

The event is broadcast to every window, so each open window shows it — which is
what you want; the user sees it wherever they are.

---

## What CI publishes

Pushing a `v*` tag runs `.github/workflows/release.yml`:

```
git tag v0.3.3 && git push origin v0.3.3
  │
  ├─ assert tag == editor/package.json version
  │     A manifest claiming a version the binary does not report makes clients
  │     update, still see the old version, and update again every 6h forever.
  │
  ├─ build   macOS: `app,dmg`   Windows: `nsis`
  │     `app`/`nsis` are updater-enabled targets; `dmg` is NOT. Building dmg
  │     alone logs "no updater-enabled targets were built" and silently
  │     produces no .app.tar.gz at all.
  │
  ├─ sign    TAURI_SIGNING_PRIVATE_KEY → <artifact>.sig
  │
  └─ upload to the `arcane-releases` R2 bucket:
        v0.3.3/UnityIDE-arm64.dmg          what people download
        v0.3.3/UnityIDE.app.tar.gz         what the macOS updater fetches
        v0.3.3/UnityIDESetup.exe           both, on Windows
        latest/darwin-aarch64.json       the manifest  (max-age=300)
        latest/windows-x86_64.json
```

The app polls the `endpoints` in its config:

- production — `https://releases.unityide.app/latest/{{target}}-{{arch}}.json`
- dev — `https://releases.unityide.app/dev/latest/{{target}}-{{arch}}.json`

`{{target}}-{{arch}}` resolves to `darwin-aarch64` or `windows-x86_64`.

### The manifest

Written by `editor/scripts/write-update-manifest.mjs` around the tested pure
core in `update-manifest.mjs`:

```json
{
  "version": "0.3.3",
  "pub_date": "2026-08-25T08:01:04.947Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<minisign>", "url": "https://…/v0.3.3/UnityIDE.app.tar.gz" }
  }
}
```

The writer **refuses** four things, each guarding a failure with no visible
symptom:

| Refused | Because |
|---|---|
| a `/latest/` url | the path must be immutable — a download in flight would be swapped by the next release, and the client would verify a signature against different bytes |
| an empty signature | every client rejects an unsigned artifact, silently and permanently |
| a non-semver version (`v0.3.3`) | the leading `v` never matches what the binary reports |
| `macos-aarch64` | the updater spells it `darwin`; the typo 404s every client and looks right |

---

## The dev channel

`dev-build.yml` mirrors the release job for the **UnityIDE Dev** app
(`app.unityide.desktop.dev`), and publishes the same three things:

```
push to `dev`
  └─ upload to `arcane-releases`:
        dev/<sha7>/UnityIDE-Dev-arm64.dmg      what people download
        dev/latest/UnityIDE-Dev-arm64.dmg      (a stable copy of the same)
        dev/<sha7>/UnityIDE-Dev.app.tar.gz     what the updater fetches
        dev/latest/darwin-aarch64.json         the manifest  (max-age=300)
        dev/latest/windows-x86_64.json
```

Three differences from production, each deliberate:

| | Production | Dev |
|---|---|---|
| Version comes from | the pushed `v*` tag | `editor/package.json` — there is no tag |
| Immutable path | `v0.3.3/` | `dev/<sha7>/` |
| macOS updater name | `UnityIDE.app.tar.gz` | `UnityIDE-Dev.app.tar.gz` |

The macOS bundle is literally `UnityIDE Dev.app.tar.gz`, with a space. It is
renamed on the way out because the name lands in a manifest url; the signature
covers bytes, not filenames, so renaming is safe.

### Dev updates track version bumps, not merges

Every dev build between two version bumps reports the **same** version, because
`tauri.dev.conf.json` inherits `"version": "../package.json"` from the base
config. The updater compares versions, so it will not offer 0.3.3 to a machine
already running 0.3.3 — a second merge to `dev` at an unchanged version
publishes a new manifest that no client acts on.

This is the intended trade. Encoding a per-build version instead would leak a
build number into the UI, into the ACP `clientInfo` handshake and into every
crash report, in order to make `dev` update more often than it is versioned.
**Bump `editor/package.json` when you want dev installs to move.**

### What made this fail silently for a whole release

`tauri.dev.conf.json` named an updater endpoint from the day it was written, and
`dev-build.yml` never wrote anything to it. UnityIDE Dev polled
`dev/latest/darwin-aarch64.json`, got a 404, logged one line to stderr and went
quiet for six hours — so UnityIDE Dev 0.3.2 sat there while 0.3.3 shipped to the
same bucket. Two separate causes, both invisible:

- no manifest was ever written or uploaded, and
- the macOS job built `--bundles dmg` alone. `dmg` is not updater-enabled, so no
  `.app.tar.gz` existed to point a manifest at — and the job still passed.

`checkVersionSync` now fails `bun run verify` on both, for **either** workflow:
a channel that runs no `write-update-manifest.mjs`, one that uploads no `.json`,
and any matrix entry building `dmg` without `app`.

---

## Verifying a release actually worked

Signed manifests fail *quietly*, so check rather than assume:

```bash
# 1. Both manifests exist and are JSON
curl -sSI https://releases.unityide.app/latest/darwin-aarch64.json | head -1
curl -sSI https://releases.unityide.app/latest/windows-x86_64.json | head -1

# 2. The url inside each one resolves
curl -sS https://releases.unityide.app/latest/darwin-aarch64.json | grep url
curl -sSI "<that url>" | head -1

# 3. The same two on the dev channel
curl -sS https://releases.unityide.app/dev/latest/darwin-aarch64.json | grep -E 'version|url'

# 4. The app agrees: Settings → Updates shows the running version
```

The Rust side logs to stderr with an `[updates]` prefix. Every failure path is
swallowed after one log line — this runs unprompted in the background, and there
is nothing a user can do about a transient network error they never asked to
hear about.

---

## What is not built

- **Task 9 — refresh the production site on release.**
- **Task 10 — the plan's own end-to-end verification pass.**

### Known limitation of v0.3.2

v0.3.2 is the **bootstrap** release: the first build containing the watcher and
the first to publish manifests. It cannot update *itself* — the updater compares
versions, and 0.3.2 does not upgrade to 0.3.2. Anyone on 0.3.2 needs a manual
reinstall; v0.3.3 will be the first release the loop actually carries.

v0.3.2 was also force-retagged, so installers downloaded before 2026-08-25 differ
from the ones under that name now.

### v0.3.2 names two different products

The Arcane → UnityIDE rebrand ships under the **same** v0.3.2 tag, force-retagged
again. So "0.3.2" now refers to either the last Arcane build or the first UnityIDE
one, and the version string alone cannot tell them apart. Check the app name or
the bundle identifier (`com.inno.editor` vs `app.unityide.desktop`) instead.

`arcane-releases/v0.3.2/` and `latest/` consequently hold BOTH sets of artifacts
— `Arcane-arm64.dmg` beside `UnityIDE-arm64.dmg`, and so on. `wrangler r2 object
put` never deletes, so the Arcane ones stay until removed by hand. They are
unreachable once `releases.arcaneai.org` is detached, just confusing.

This is deliberate, and it has one upside worth recording: because the version
does not move, an install already on 0.3.2 is never *offered* 0.3.2-UnityIDE.
The rebrand therefore cannot half-migrate an existing Arcane install in place —
the failure mode you would otherwise get from an unchanged signing key plus a
version bump. Every UnityIDE install is a deliberate fresh download.

---

## Changing any of this

- **Adding a platform** — add its key to `PLATFORMS` in `update-manifest.mjs`
  (the guard is an allow-list on purpose) and a matrix entry with
  `platform_key` / `updater_asset` / `updater_glob`.
- **Changing bundles** — check the target is updater-enabled. `dmg` is not.
- **Changing the endpoint** — it is baked into shipped binaries. Old installs
  keep polling the old URL forever, so the old path must keep serving.
- **Touching the pubkey** — read [The trust model](#the-trust-model) first.
