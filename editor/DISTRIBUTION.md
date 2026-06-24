# Distributing the macOS Build

Builds produced by `bun run tauri build` are **ad-hoc signed**. That's enough to run them on the Mac that built them, but recipients on other Macs will see:

> **"editor" is damaged and can't be opened. You should move it to the Trash.**

This is expected and the app is not actually damaged. Read on for what to do.

## Why this happens

macOS attaches a `com.apple.quarantine` extended attribute to any file that crosses the "internet boundary" — download, AirDrop, Mail, Messages, Slack, etc. Gatekeeper on macOS Sequoia (15.x) sees the quarantined app, sees that its signature is ad-hoc (not from a paid Apple Developer ID), and refuses to open it.

The signature itself is fine. The rejection is about **trust**, not validity. There is no sender-side fix without a paid Apple Developer ID + notarization (see [Upgrade path](#upgrade-path) at the bottom). The recipient has to clear the quarantine attribute once.

## For recipients

1. Download the `.dmg` and double-click to mount it.
2. Drag `editor.app` into `/Applications` (or wherever you want to keep it).
3. Open **Terminal** (⌘+Space → "Terminal").
4. Paste this and hit Enter:

   ```bash
   xattr -dr com.apple.quarantine /Applications/editor.app
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
- The bundled `arcane-graph` sidecar is signed by Tauri automatically as part of the main bundle, so recipients don't need to do anything for it.
- **typescript-language-server is bundled** as a sidecar — TypeScript / JavaScript IntelliSense works out of the box without Node.js installed. The bundle ships with TypeScript 6 embedded.
- **csharp-ls is not bundled**. If the recipient wants C# language features they need the .NET SDK + `dotnet tool install -g csharp-ls`. For Unity projects the editor surfaces a modal when dotnet is missing; non-Unity workspaces get a quieter toast hint.
- **pyright is not bundled (yet)**. Python LSP still requires `npm install -g pyright` on the recipient's machine. Bundling is a known follow-up — see [LSP sidecar bundling](#lsp-sidecar-bundling) below.

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
     src-tauri/target/release/bundle/dmg/editor_0.1.0_aarch64.dmg \
     --apple-id "you@example.com" --team-id TEAMID --password APP_SPECIFIC_PASSWORD \
     --wait
   xcrun stapler staple \
     src-tauri/target/release/bundle/dmg/editor_0.1.0_aarch64.dmg
   ```

After that, recipients can mount and open the app with no warnings and no Terminal step.
