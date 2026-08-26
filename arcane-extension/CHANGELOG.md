# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
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
