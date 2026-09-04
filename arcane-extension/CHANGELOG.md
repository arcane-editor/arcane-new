# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Bridge wire-protocol bumped to version 4** (`Discovery.ProtocolVersion`,
  pinned against `PROTOCOL_VERSION` in `unity_ipc.rs`). Scaffolding only in
  this release — the RPCs it makes room for (console snapshot/clear, a queued
  `runTests` with a `test_run_completed` push, `attachUiDocument` /
  `setSerializedProperty`) land in follow-up releases. Package version bumped
  to 0.2.0 to match the new protocol floor (`MIN_PACKAGE_VERSION`).
- **The package now ships once per release channel.** The release build targets
  the UnityIDE application, `unityide://` and `~/.unityide`; the dev build
  (`com.unityide.editor.dev`) targets UnityIDE Dev, `unityide-dev://` and
  `~/.unityide-dev`. Both are generated from this source by
  `scripts/unity-extension-channel.mjs`, which also gives the dev package its
  own assembly names and asset GUIDs so the two can never be confused for one
  another. Installing either one removes the other.

  This replaces working the channel out at runtime, which got it wrong in the
  one case that mattered: it always resolved to release, so anyone testing the
  dev build had their double-clicks answered by the release app, silently.
- **Window > UnityIDE > Open Project in UnityIDE** opens the current project in
  UnityIDE, launching it if it is not running and bringing it to the front if it
  is. Unity's own **Assets > Open C# Project** now works too — it hands us an
  empty file path, which produced a bare `UnityIDE "<project>"` that the app's
  argument parser ignored entirely.
- A one-time offer to make UnityIDE the external script editor, shown the first
  time the package loads on a machine where UnityIDE is installed and something
  else is configured. Opt-in, with "Not now" and "Never ask again"; the setting
  is never changed without an answer.
- **Window > UnityIDE > Use UnityIDE for C# Scripts**, for taking that offer
  later.
- Preferences > External Tools now reports where UnityIDE was found and whether
  it currently has this project open, with a button to open it.
- Opening now goes through the `unityide://open` deep link before it goes
  looking for an executable. The OS already knows where UnityIDE is installed
  and how to bring it forward, so a copy in a non-default location — or one the
  probe list has never heard of — is opened correctly, and on macOS nothing
  spawns a throwaway process to relay the request.

  Falling back to launching an executable is still needed and still happens: on
  macOS `tauri dev` can never register a scheme, and on Windows registration
  happens on the app's first run, so an install nobody has opened yet has no
  handler. The package only fires a deep link at Windows once
  `~/.unityide/install.json` proves the app has run.

### Fixed
- Double-clicking a script no longer relaunches the app when UnityIDE already
  has the project open. The file is sent over the bridge journal instead, with
  its line and column, and the IDE raises itself — no throwaway process, no dock
  bounce, and no dependence on knowing where the app is installed.
- UnityIDE is found on Windows again. The probe list carried Electron's
  `%LOCALAPPDATA%\Programs\<app>` convention while the installer puts a
  per-user install in `%LOCALAPPDATA%\<app>`, so a default install was never
  detected. The app now also records its own location in
  `~/.unityide/install.json` on every launch, which makes discovery work for a
  copy installed anywhere.
- A pre-rename install is found again. The bulk rename that turned Arcane into
  UnityIDE also rewrote the constant naming the *pre*-rename app, so every
  "legacy" probe path was a duplicate of the current one.
- Paths ending in a separator no longer mangle the launch. A trailing backslash
  escaped its own closing quote, so `"C:\Proj\"` swallowed every argument
  after it.
- The Unity test assembly compiles. It exercises internal types
  (`Discovery`, `Journal`, `BridgeClient`) and the package never granted it
  access, so none of its tests had ever run.
- Double-clicking a script when the package is installed but the application is
  not now opens the download page, once per Unity session. It used to write a
  console error and nothing else — from inside Unity, indistinguishable from
  the integration being broken.
- The dev application is discoverable at all. The probe list only ever named
  `UnityIDE`, so a machine with only UnityIDE Dev installed, and no install
  record yet, found nothing.
- A domain reload no longer looks like a disconnect. The bridge announces a new
  `reloading` message before tearing down its AppDomain, so the IDE widens its
  liveness deadline instead of dropping the session, and a script recompile no
  longer cancels in-flight requests.
- The farewell message (`disconnect` on quit, `reloading` on reload) is now
  actually written. It was emitted after joining the worker thread — which by
  definition returns only once that thread has closed the journals — so it had
  always been appended to a disposed writer and silently discarded.
- Teardown can no longer strand the worker thread. A worker blocked building the
  handshake payload is released as soon as shutdown begins, instead of waiting
  out its full timeout and leaving the journals open for the next AppDomain to
  double-write.

### Changed
- Consolidated the live IDE bridge into this package. The Editor assembly now hosts
  the Unix-domain-socket bridge (`UnityIDE.Bridge`) that the current UnityIDE speaks to,
  replacing the legacy length-prefixed IPC client.
- A warm resume after a domain reload no longer re-announces `connection_init`;
  the session resumes mid-stream as the journal transport intends.

### Added
- Live scene-hierarchy mirror, play-mode telemetry (FPS / memory / GC), debugger-endpoint
  discovery, and richer RPC handlers (editor state, selection, asset queries, test runner).

### Removed
- Inspector field sync, build-management UI, the standalone settings window, and Unity
  menu items. (External-editor registration and `.sln`/`.csproj` generation are retained.)

## [1.0.0] - 2026-03-05

### Added
- Official Asset Store release
- IPC communication with UnityIDE via Unix domain sockets (macOS/Linux) and named pipes (Windows)
- Console log streaming with configurable batching and deduplication
- Play/Pause/Stop/Step controls from IDE
- Build management with configurable options (platform, development build, script debugging, auto-run)
- Asset refresh and .sln/.csproj generation
- Script compilation event reporting with errors and warnings
- Unity Test Framework integration (requires `com.unity.test-framework`)
- Inspector field change detection and remote field editing
- Asset ping and reveal from IDE
- Auto-detection of UnityIDE installation (macOS, Windows, Linux)
- Settings window with custom install path and connection controls
- Assembly definition with Editor-only platform constraint
- AssemblyInfo.cs with version metadata

## [0.1.0] - 2026-02-22

### Added
- Initial release as standalone UPM package
- Core IPC communication
- Console log streaming
- Play mode controls
- Build management
- Compilation event reporting
- Test runner integration
- Project file generation
- Asset operations
- Cross-platform IDE detection
