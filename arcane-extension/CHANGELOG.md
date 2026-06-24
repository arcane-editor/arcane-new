# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Consolidated the live IDE bridge into this package. The Editor assembly now hosts
  the Unix-domain-socket bridge (`Arcane.Bridge`) that the current Arcane IDE speaks to,
  replacing the legacy length-prefixed IPC client.

### Added
- Live scene-hierarchy mirror, play-mode telemetry (FPS / memory / GC), debugger-endpoint
  discovery, and richer RPC handlers (editor state, selection, asset queries, test runner).

### Removed
- Inspector field sync, build-management UI, the standalone settings window, and Unity
  menu items. (External-editor registration and `.sln`/`.csproj` generation are retained.)

## [1.0.0] - 2026-03-05

### Added
- Official Asset Store release
- IPC communication with Arcane IDE via Unix domain sockets (macOS/Linux) and named pipes (Windows)
- Console log streaming with configurable batching and deduplication
- Play/Pause/Stop/Step controls from IDE
- Build management with configurable options (platform, development build, script debugging, auto-run)
- Asset refresh and .sln/.csproj generation
- Script compilation event reporting with errors and warnings
- Unity Test Framework integration (requires `com.unity.test-framework`)
- Inspector field change detection and remote field editing
- Asset ping and reveal from IDE
- Auto-detection of Arcane IDE installation (macOS, Windows, Linux)
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
