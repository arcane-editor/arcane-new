# UnityIDE Integration

Unity Editor extension that connects your Unity project to UnityIDE. Provides real-time bidirectional communication, allowing you to control Unity directly from the IDE and see Unity state reflected instantly.

## Requirements

- Unity 2021.3 or later (LTS recommended)
- UnityIDE installed ([download](https://unityide.app))

## Installation

### Via Download & Import (Recommended)
1. Download the package: [com.unityide.editor-0.0.1.tgz](https://releases.unityide.app/unity-extension-releases/com.unityide.editor-0.0.1.tgz)
2. In Unity, go to **Window > Package Manager**
3. Click **+** > **Add package from tarball...**
4. Browse to the downloaded `.tgz` file and click **Open**

### Via manifest.json
Open your Unity project's `Packages/manifest.json` and add this to the `"dependencies"` block:

```json
"com.unityide.editor": "https://releases.unityide.app/unity-extension-releases/com.unityide.editor-0.0.1.tgz"
```

Save the file — Unity will download and install the package automatically.

### Via Unity Package Manager UI
1. Open Unity Editor
2. Go to **Window > Package Manager**
3. Click **+** > **Add package by name...**
4. Paste: `https://releases.unityide.app/unity-extension-releases/com.unityide.editor-0.0.1.tgz`
5. Click **Add**

## Setup

1. After installation, go to **Edit > Preferences > External Tools**
2. Select **UnityIDE** from the External Script Editor dropdown
3. If UnityIDE is not auto-detected, set the path manually via **UnityIDE > Settings** in the menu bar

The extension auto-detects UnityIDE from these default install locations:

| Platform | Default Paths |
|----------|--------------|
| macOS | `/Applications/UnityIDE.app`, `~/Applications/UnityIDE.app` |
| Windows | `C:\Program Files\UnityIDE\UnityIDE.exe`, `%LOCALAPPDATA%\Programs\UnityIDE\UnityIDE.exe` |
| Linux | `/usr/bin/unityide`, `/usr/local/bin/unityide`, `~/.local/bin/unityide` (the pre-rename `arcane` paths are still probed as a fallback) |

## Features

### Script Editing
Double-click any `.cs` file in Unity to open it in UnityIDE. If the IDE is already running and connected, the file opens instantly via IPC. Otherwise, UnityIDE launches with the file and line number.

### IPC Communication
Real-time bidirectional messaging between Unity and the IDE over Unix domain sockets (macOS/Linux) or named pipes (Windows). Connection is automatic — the extension connects on startup and reconnects with exponential backoff if the connection drops.

### Console Streaming
Unity console logs (messages, warnings, errors) are streamed to the IDE's console panel in real-time. Logs are batched (100ms debounce) and deduplicated. Stack traces are parsed with clickable file references.

Two additional RPCs (protocol 4+) back the IDE's own post-turn console check rather than the live panel: `getConsoleSnapshot`, a point-in-time read of the console the IDE merges against what it already streamed, and `clearConsole`. Both are served from a bounded, persisted "hook ring" of recent entries, so a script recompile does not reset what the IDE has already seen.

### Play Controls
Control Unity's play mode directly from the IDE:
- **Play** — Enter play mode
- **Pause** — Pause play mode
- **Stop** — Exit play mode
- **Step** — Advance a single frame (while paused)

Play state changes in Unity are reflected in the IDE toolbar instantly.

### Compilation Events
Script compilation status is reported to the IDE in real-time, including errors and warnings with file paths and line numbers.

### Build Management
Trigger Unity builds from the IDE with configurable options:
- Target platform
- Development build toggle
- Script debugging toggle
- Auto-run after build

Build progress and results (including errors) are streamed back to the IDE.

### Asset Operations
- **Ping Asset** — Highlight an asset in the Unity Project window
- **Reveal Asset** — Select and focus an asset in the Project window
- **Refresh Assets** — Trigger an AssetDatabase refresh

### Inspector Field Sync
Changes to component fields in Unity's Inspector are detected and reported to the IDE. The IDE can also edit field values remotely — supporting scenes and prefabs, with type-safe handling of int, float, bool, string, enum, Vector2/3/4, Color, and Quaternion.

### UI Generation
Two write RPCs (protocol 4+) let the IDE build UI Toolkit screens directly in the open scene: `attachUiDocument` wires a `UIDocument` to a GameObject — a `.uxml`, a `PanelSettings`, and a theme, creating whichever of those is missing — and `setSerializedProperty` sets one serialized value on a component, a GameObject, or an asset. Both refuse to run while Play Mode, a domain reload, or Prefab Mode would make the write unsafe.

### Test Runner
Run Unity tests from the IDE (requires `com.unity.test-framework` package):
- EditMode and PlayMode tests
- Optional name filter
- `runTests` is queued rather than blocking — a second call while a run is in progress joins it instead of starting a duplicate
- Individual test results streamed as they complete
- Aggregate summary on completion

### Project Generation
Generate `.sln` and `.csproj` files for C# IntelliSense support. The extension auto-detects available IDE packages (`com.unity.ide.vscode`, `com.unity.ide.visualstudio`) and uses them via reflection.

## Settings

Access settings via **UnityIDE > Settings** in the menu bar.

| Setting | Default | Description |
|---------|---------|-------------|
| Install Path | (auto-detected) | Custom path to the UnityIDE executable |
| Auto Connect | `true` | Automatically connect to the IDE on Unity startup |
| Log Batch Interval | `100ms` | How often console logs are flushed to the IDE |
| Max Log Batch Size | `100` | Maximum log entries per batch |

## Compatibility

| Unity Version | Status |
|--------------|--------|
| 2021.3 LTS | Supported |
| 2022.3 LTS | Supported |
| Unity 6 (6000.x) | Supported |

### Platforms
- macOS (Intel & Apple Silicon)
- Windows 10/11
- Linux (Ubuntu 20.04+)

### Optional Dependencies
- `com.unity.test-framework` — Required for test runner integration. The extension detects this automatically via version defines.

## Troubleshooting

**UnityIDE not appearing in External Tools dropdown:**
Ensure the package is installed (check Window > Package Manager). If installed, try restarting Unity.

**Connection not established:**
- Make sure UnityIDE is running and has the same project open
- Check **UnityIDE > Settings** for connection status
- Both Unity and the IDE must have the same project path to connect

**Console logs not appearing in IDE:**
Verify the connection is active in **UnityIDE > Settings**. Logs are only streamed while connected.

**Test runner not available:**
Install `com.unity.test-framework` via Package Manager. The extension will automatically detect it and enable test runner commands.

## Support

- Documentation: [https://unityide.app/docs/getting-started/unity-extension/](https://unityide.app/docs/getting-started/unity-extension/)
- Issues: [unityide.app/#feedback](https://unityide.app/#feedback)
- Email: support@unityide.app
