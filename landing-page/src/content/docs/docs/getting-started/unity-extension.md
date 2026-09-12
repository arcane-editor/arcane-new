---
title: Unity Extension
description: Install and configure the UnityIDE Unity Extension to connect the Unity Editor with UnityIDE.
---

The UnityIDE Unity Extension connects your Unity Editor to UnityIDE over IPC, enabling real-time communication between the two. Once installed, you can edit scripts, control play mode, stream console logs, run tests, and more — all from the IDE.

## Installation

### Option 1 — Download & Import (Recommended)

1. Download the package: [com.unityide.editor.tgz](https://releases.unityide.app/unity-extension-releases/latest/com.unityide.editor.tgz)
2. In Unity, go to **Window > Package Manager**
3. Click **+** > **Add package from tarball...**
4. Browse to the downloaded `.tgz` file and click **Open**

### Option 2 — Edit manifest.json

Open your Unity project's `Packages/manifest.json` and add this line to the `"dependencies"` block:

```json
"com.unityide.editor": "https://releases.unityide.app/unity-extension-releases/latest/com.unityide.editor.tgz"
```

Save the file. Unity will download and install the package automatically.

### Option 3 — Unity Package Manager UI

1. Open Unity Editor
2. Go to **Window > Package Manager**
3. Click the **+** button (top-left) > **Add package by name...**
4. Paste the URL:
   ```
   https://releases.unityide.app/unity-extension-releases/latest/com.unityide.editor.tgz
   ```
5. Click **Add**

## Setup

The first time Unity loads the package on a machine with UnityIDE installed, it
offers to make UnityIDE the editor that opens your scripts. Choose **Use
UnityIDE** and you are done — the offer is made once, and declining it changes
nothing.

To set it yourself, or to change it later:

1. Go to **Edit > Preferences > External Tools**
2. Set **External Script Editor** to **UnityIDE**

That panel also reports where UnityIDE was found and whether it currently has
this project open, and lets you point it at a copy in a non-default location.

### Release and dev builds

The package ships twice, and the two are not interchangeable: `com.unityide.editor`
opens UnityIDE, and `com.unityide.editor.dev` opens UnityIDE Dev. Install the one
that matches the application you are running — installing either removes the
other, so a project always has exactly one.

Unless you are testing a dev build of UnityIDE itself, you want the release
package, which is what every link on this page points at. The dev package lives
at
`https://releases.unityide.app/unity-extension-releases/dev/latest/com.unityide.editor.dev.tgz`
and installs the same three ways.

### How UnityIDE is opened

Wherever possible the extension hands the request to your operating system as a
`unityide://open` link, rather than going looking for the application itself.
The OS already knows where UnityIDE is installed and how to bring it forward, so
this works for a copy in any location.

If no handler is registered — on Windows the link is registered the first time
you run UnityIDE, so a fresh install that has never been opened has none yet —
the extension falls back to launching the application directly. UnityIDE writes
its own location to `~/.unityide/install.json` every time it runs, so a copy
installed anywhere is found as soon as you have launched it once.

Failing that, these default install locations are checked:

| Platform | Default Paths |
|----------|--------------|
| macOS | `/Applications/UnityIDE.app`, `~/Applications/UnityIDE.app` |
| Windows | `%LOCALAPPDATA%\UnityIDE\UnityIDE.exe`, `C:\Program Files\UnityIDE\UnityIDE.exe` |
| Linux | `/usr/bin/unityide`, `/usr/local/bin/unityide`, `~/.local/bin/unityide` |

## Features

### Opening your project
**Window > UnityIDE > Open Project in UnityIDE** opens the current project in
UnityIDE, launching it if it is not already running and bringing it to the front
if it is. Unity's own **Assets > Open C# Project** does the same thing once
UnityIDE is your external script editor.

### Script Editing
Double-click any `.cs` file in Unity to open it in UnityIDE, at the right line
and in a focused tab. If the IDE already has the project open the file is sent
over the existing IPC connection — no second process, no window flash.
Otherwise UnityIDE is launched with the file and position.

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

**UnityIDE not appearing in External Tools dropdown?**
Restart Unity after installing the package. If it still doesn't appear, check that the package is listed in Window > Package Manager.

**Connection not established?**
- Make sure UnityIDE is running and has the same project open
- Check **UnityIDE > Settings** for connection status
- Both Unity and the IDE must be pointed at the same project path

**Console logs not appearing in IDE?**
Verify the connection is active in **UnityIDE > Settings**. Logs are only streamed while connected.

**Want detailed logs for debugging?**
Add `UNITYIDE_VERBOSE` to **Player Settings > Scripting Define Symbols** to enable verbose logging. By default, only errors are logged to keep the console clean.

**Test runner not available?**
Install `com.unity.test-framework` via Package Manager. The extension detects it automatically and enables test runner commands.
