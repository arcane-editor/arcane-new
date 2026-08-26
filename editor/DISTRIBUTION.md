# Distributing Arcane

Arcane ships for **macOS (Apple Silicon + Intel)** and **Windows x64**. Release builds are produced by the `Release` GitHub Actions workflow (`.github/workflows/release.yml`) and uploaded to the Cloudflare R2 bucket `arcane-releases` — see [Releasing (CI → Cloudflare R2)](#releasing-ci--cloudflare-r2) below. This doc covers what recipients see on each platform with the current **ad-hoc macOS / unsigned Windows** setup.

## macOS

Builds are **ad-hoc signed** (`signingIdentity: "-"`). That's enough to run them on the Mac that built them, but recipients on other Macs will see:

> **"Arcane" is damaged and can't be opened. You should move it to the Trash.**

This is expected and the app is not actually damaged. Read on for what to do.

## Why this happens

macOS attaches a `com.apple.quarantine` extended attribute to any file that crosses the "internet boundary" — download, AirDrop, Mail, Messages, Slack, etc. Gatekeeper on macOS Sequoia (15.x) sees the quarantined app, sees that its signature is ad-hoc (not from a paid Apple Developer ID), and refuses to open it.

The signature itself is fine. The rejection is about **trust**, not validity. There is no sender-side fix without a paid Apple Developer ID + notarization (see [Upgrade path](#upgrade-path) at the bottom). The recipient has to clear the quarantine attribute once.

## For recipients

1. Download the `.dmg` and double-click to mount it.
2. Drag `Arcane.app` into `/Applications` (or wherever you want to keep it).
3. Open **Terminal** (⌘+Space → "Terminal").
4. Paste this and hit Enter:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Arcane.app
   ```

   If you put the app somewhere other than `/Applications`, change the path accordingly.

5. Launch the app normally (double-click, or via Spotlight).

That's it — you only need to do this once per install.

### If Terminal isn't an option

Try to open the app once; macOS will block it. Then go to **System Settings → Privacy & Security**, scroll to the bottom, and look for an **Open Anyway** button next to the blocked app.

Caveat: on macOS 15+, "Open Anyway" reliably appears for the "unverified developer" prompt but often does **not** appear for the "damaged" prompt. If you see "damaged", use the `xattr` command above — it's the reliable fix.

## For the sender (you)

A few things worth knowing:

- The `.dmg` from `bun run tauri build` is fine as-is. You don't need to do anything special before sharing.
- Every transport adds quarantine — AirDrop, Mail, Slack, browser download. There's no quarantine-free channel.
- The `.dmg` wrapper itself doesn't need to be signed for the recipient flow above to work.
- The bundled `unityide-graph` sidecar is signed by Tauri automatically as part of the main bundle, so recipients don't need to do anything for it.
- **typescript-language-server is bundled** as a sidecar — TypeScript / JavaScript IntelliSense works out of the box without Node.js installed. The bundle ships with TypeScript 6 embedded.
- **csharp-ls is not bundled**. If the recipient wants C# language features they need the .NET SDK + `dotnet tool install -g csharp-ls`. For Unity projects the editor surfaces a modal when dotnet is missing; non-Unity workspaces get a quieter toast hint.
- **pyright is not bundled (yet)**. Python LSP still requires `npm install -g pyright` on the recipient's machine. Bundling is a known follow-up — see [LSP sidecar bundling](#lsp-sidecar-bundling) below.

## Windows

Windows builds are **unsigned** for now (no code-signing certificate). Recipients running `ArcaneSetup.exe` (the NSIS installer) will hit Microsoft **SmartScreen**:

> **Windows protected your PC** — Microsoft Defender SmartScreen prevented an unrecognized app from starting.

This is the "unknown publisher" warning, not a malware detection. To proceed:

1. Click **More info**.
2. Click **Run anyway**.
3. Continue through the installer normally.

It goes away once the installer is signed — see [Upgrade path](#upgrade-path). The bundled `unityide-graph` and `typescript-language-server` sidecars are installed alongside the app automatically; recipients don't need to do anything for them.

## LSP sidecar bundling

Bundled LSP binaries are produced by `bun run build:lsp-sidecars` (called automatically from `bun run tauri ...`). The script uses `@yao-pkg/pkg` to snapshot the npm package into a single native executable, written to `src-tauri/binaries/<name>-<target-triple>[.exe]`. Tauri's `bundle.externalBin` config picks them up and copies them next to the main executable in the final bundle.

**Per-platform builds**. By default the script compiles only for the host triple, so `bun run tauri build` on macOS arm64 produces a sidecar for that platform only. To build all targets at once (e.g. on a release CI runner): `bun run build:lsp-sidecars --all-targets` (or set `CI=true`).

Recommended CI matrix for release builds:

| Runner | Tauri triple |
|---|---|
| `macos-14` (arm64) | `aarch64-apple-darwin` |
| `macos-13` (intel) | `x86_64-apple-darwin` |
| `ubuntu-latest` | `x86_64-unknown-linux-gnu` |
| `windows-latest` | `x86_64-pc-windows-msvc` |

**Bundle size**. The TypeScript sidecar is ~83 MB per platform (TypeScript 6's source tree dominates). Roughly +85 MB per platform on the final installer compared to pre-bundling builds. Acceptable for a desktop IDE; if size becomes an issue, dropping bundled TypeScript and falling back to a workspace-local `typescript` install is a future option.

**Dev mode**. `bun run tauri dev` runs the binary from `src-tauri/binaries/<name>-<host-triple>` directly. If you haven't run the build script yet, `build.rs` drops a stub at that path so `cargo check` and dev builds keep working — `lsp.rs` then falls through to the PATH-installed binary. Setting `EDITOR_USE_SYSTEM_LSP=1` forces the PATH path even when the bundled sidecar exists.

**Pyright follow-up**. Pyright's distribution uses webpack-style chunked code with dynamic `require()` calls that pkg's static analysis can't fully follow; the bundled binary exits silently on `--stdio` inside pkg's snapshot filesystem. Options for a future PR: (a) ship the pyright source as Tauri resources + a bundled Node binary, (b) wait for pkg to resolve the chunked require issue, or (c) switch the Python LSP to one without this packaging pattern.

## Side-by-side dev app

`src-tauri/tauri.dev.conf.json` is an overlay that produces a **second app you
can install next to the production one**:

```
bun run tauri:build:dev-app    # package it, then install the .app
bun run tauri:dev-app          # iterate on code (see caveat below)
```

**Only the packaged build is a real second app.** `tauri dev` runs the bare
binary from `target/debug/` with no `.app` bundle, so there is no `Info.plist`
— the app is not separately named, and macOS LaunchServices never learns about
`arcane-dev://` (there is no runtime registration API for it, which is why
`setup()` only registers schemes at runtime on Windows and Linux). To get a
side-by-side app in the Dock with working deep-link sign-in, **build and
install it**; use `tauri:dev-app` only for fast iteration.

Everything that would otherwise collide is keyed off the overlay:

| | prod | dev app |
|---|---|---|
| App name | Arcane | Arcane Dev |
| Window title | Arcane | Arcane Dev |
| Bundle id | `com.inno.editor` | `com.inno.editor.dev` |
| Deep-link scheme | `arcane://` | `arcane-dev://` |
| Config dir | `~/.arcane` | `~/.arcane-dev` |
| API / web | `api.arcaneai.org` | `api-dev.arcaneai.org` |

Window titles come from `productName` via `window_title()` in
`src-tauri/src/lib.rs` — both for the programmatic welcome window and, in
`setup()`, for the one declared in `tauri.conf.json` (which is built before
Rust runs and would otherwise keep that file's literal "Arcane"). Retitling
there beats duplicating the whole window block in the overlay to change one
string. On macOS `hiddenTitle` keeps it out of the title bar, but it still
shows in the Window menu and Mission Control; on Windows and Linux it is the
title bar.

The bundle id is what lets macOS treat them as different apps, and
`arcane_dir_name()` (`src-tauri/src/auth.rs`) derives the config dir from it —
so the two never share tokens, sessions, or graphs. The deep-link scheme is
read from the runtime config rather than hardcoded
(`scheme_from_plugin_config`), so a dev build tells the website to call back to
`arcane-dev://` and sign-in lands in the right app. The website accepts both
via `SCHEME_ALLOWLIST` in `landing-page/src/lib/editor-login.ts`.

**The endpoints are the part that needs the extra script.** Vite only reads
`.env.development` in development mode, and `tauri build` runs `vite build`,
which is production mode — so a plain
`tauri build --config src-tauri/tauri.dev.conf.json` would be *named* "Arcane
Dev" while talking to the **production** API. The overlay therefore points
`beforeBuildCommand` at `build:dev-env` (`vite build --mode development`).
Use the scripts above rather than invoking `tauri build --config` directly.

## Releasing (CI → Cloudflare R2)

All three installers are built by **`.github/workflows/release.yml`** (repo root). Push a version tag to trigger it:

```bash
git tag v0.1.0
git push origin v0.1.0
```

(Or run it manually from the **Actions** tab via **Run workflow**.) The workflow runs one job per target — `macos-14` (Apple Silicon), `macos-13` (Intel), `windows-latest` — building the native `unityide-graph` + `typescript-language-server` sidecars on each runner, then `tauri build`, then uploading each installer to the `arcane-releases` R2 bucket under both the version path `` `<tag>/` `` (archived) and `` `latest/` `` (the stable links the landing page points at):

- `Arcane-arm64.dmg` — macOS Apple Silicon
- `Arcane-x64.dmg` — macOS Intel
- `ArcaneSetup.exe` — Windows x64

**Required GitHub secrets** (Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN` (a token with **R2 edit** permission) and `CLOUDFLARE_ACCOUNT_ID`. No signing secrets are needed while we're ad-hoc / unsigned.

**Manual upload.** To publish a locally-built installer (e.g. the Apple Silicon `.dmg` from `cd editor && bun run tauri build`), put the renamed files into `dist-release/` and run from the repo root:

```bash
scripts/upload-release.sh v0.1.0
```

It uploads to the same `<tag>/` + `latest/` paths. Auth via `wrangler login` or the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` env vars.

> **Note:** the previous `arcane-release-worker` (resumable multipart upload Worker) has been removed — current builds are small enough for `wrangler r2 object put`. The `releases.arcaneai.org` domain and the `arcane-releases` bucket stay as-is.

## Upgrade path

If you want recipients to open the app with a single double-click — no Terminal, no warnings — the path is:

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) (~$99/yr).
2. Generate a **Developer ID Application** certificate from the developer portal.
3. In `src-tauri/tauri.conf.json`, change:
   ```json
   "signingIdentity": "-"
   ```
   to your full identity string, e.g.:
   ```json
   "signingIdentity": "Developer ID Application: Your Name (TEAMID)"
   ```
4. After `bun run tauri build`, notarize and staple:
   ```bash
   xcrun notarytool submit \
     src-tauri/target/release/bundle/dmg/Arcane_0.1.0_aarch64.dmg \
     --apple-id "you@example.com" --team-id TEAMID --password APP_SPECIFIC_PASSWORD \
     --wait
   xcrun stapler staple \
     src-tauri/target/release/bundle/dmg/Arcane_0.1.0_aarch64.dmg
   ```

After that, recipients can mount and open the app with no warnings and no Terminal step. This is also a prerequisite if you ever add the in-app auto-updater (Gatekeeper blocks silent updates of ad-hoc-signed apps).

### Windows signing (later)

To remove the SmartScreen warning, sign `ArcaneSetup.exe` with a code-signing certificate or **Azure Trusted Signing**. Tauri wires this through `bundle.windows` config + a CI signing step — no restructuring of `release.yml` needed, just an added secret and config.
