---
title: Unity Extension
description: Install and configure the Arcane Unity Extension to connect the Unity Editor with ArcaneIDE.
---

The Arcane Unity Extension connects your Unity Editor to ArcaneIDE over IPC, enabling real-time communication between the two. Once installed, you can edit scripts, control play mode, stream console logs, run tests, and more — all from the IDE.

## Installation

### Option 1 — Download & Import (Recommended)

1. Download the package: [com.arcane.editor.tgz](https://releases.unityide.app/unity-extension-releases/latest/com.arcane.editor.tgz)
2. In Unity, go to **Window > Package Manager**
3. Click **+** > **Add package from tarball...**
4. Browse to the downloaded `.tgz` file and click **Open**

### Option 2 — Edit manifest.json

Open your Unity project's `Packages/manifest.json` and add this line to the `"dependencies"` block:

```json
"com.arcane.editor": "https://releases.unityide.app/unity-extension-releases/latest/com.arcane.editor.tgz"
```

Save the file. Unity will download and install the package automatically.

### Option 3 — Unity Package Manager UI

1. Open Unity Editor
2. Go to **Window > Package Manager**
3. Click the **+** button (top-left) > **Add package by name...**
4. Paste the URL:
   ```
   https://releases.unityide.app/unity-extension-releases/latest/com.arcane.editor.tgz
   ```
5. Click **Add**

## Setup

After installing the package:

1. Go to **Edit > Preferences > External Tools**
2. Set **External Script Editor** to **Arcane**
3. If Arcane IDE is not auto-detected, open **Arcane > Settings** in the Unity menu bar and set the path manually

The extension auto-detects Arcane IDE from these default install locations:

| Platform | Default Paths |
|----------|--------------|
| macOS | `/Applications/Arcane.app`, `~/Applications/Arcane.app` |
| Windows | `C:\Program Files\Arcane\Arcane.exe`, `%LOCALAPPDATA%\Programs\Arcane\Arcane.exe` |
| Linux | `/usr/bin/arcane`, `/usr/local/bin/arcane`, `~/.local/bin/arcane` |

## Features

### Script Editing
Double-click any `.cs` file in Unity to open it in Arcane IDE. If the IDE is already running and connected, the file opens instantly via IPC. Otherwise, Arcane launches with the file and line number.

### Console Streaming
Unity console logs (messages, warnings, errors) are streamed to the IDE's console panel in real-time. Logs are batched and deduplicated. Stack traces are parsed with clickable file references.

### Play Controls
Control Unity's play mode directly from the IDE:
- **Play** — Enter play mode
- **Pause** — Pause play mode
- **Stop** — Exit play mode
- **Step** — Advance a single frame (while paused)

Play state changes in Unity are reflected in the IDE toolbar instantly.

### Build Management
Trigger Unity builds from the IDE with configurable options:
- Target platform
- Development build toggle
- Script debugging toggle
- Auto-run after build

Build progress and results (including errors) are streamed back to the IDE.

### Inspector Field Sync
Changes to component fields in Unity's Inspector are detected and reported to the IDE. The IDE can also edit field values remotely — supporting scenes and prefabs, with type-safe handling of int, float, bool, string, enum, Vector2/3/4, Color, and Quaternion.

### Test Runner
Run Unity tests from the IDE (requires `com.unity.test-framework` package):
- EditMode and PlayMode tests
- Optional name filter
- Individual test results streamed as they complete
- Aggregate summary on completion

### Project Generation
Generates `.sln` and `.csproj` files for C# IntelliSense support. The extension auto-detects available IDE packages (`com.unity.ide.vscode`, `com.unity.ide.visualstudio`) and uses them via reflection.

## Compatibility

| Unity Version | Status |
|--------------|--------|
| 2021.3 LTS | Supported |
| 2022.3 LTS | Supported |
| Unity 6 (6000.x) | Supported |

### Platforms
- macOS (Apple Silicon)
- Windows 10/11
- Linux (Ubuntu 20.04+)

## Troubleshooting

**Arcane not appearing in External Tools dropdown?**
Restart Unity after installing the package. If it still doesn't appear, check that the package is listed in Window > Package Manager.

**Connection not established?**
- Make sure Arcane IDE is running and has the same project open
- Check **Arcane > Settings** for connection status
- Both Unity and the IDE must be pointed at the same project path

**Console logs not appearing in IDE?**
Verify the connection is active in **Arcane > Settings**. Logs are only streamed while connected.

**Want detailed logs for debugging?**
Add `ARCANE_VERBOSE` to **Player Settings > Scripting Define Symbols** to enable verbose logging. By default, only errors are logged to keep the console clean.

**Test runner not available?**
Install `com.unity.test-framework` via Package Manager. The extension detects it automatically and enables test runner commands.
