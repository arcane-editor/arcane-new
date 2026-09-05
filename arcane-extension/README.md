# UnityIDE — Unity Extension

Connects your Unity Editor to [UnityIDE](https://unityide.app) for AI-powered game development. Real-time bidirectional communication lets you control Unity directly from the IDE.

## Installation

### Option 1 — Download & Import (Recommended)

1. Download the package: [com.unityide.editor-0.0.1.tgz](https://releases.unityide.app/unity-extension-releases/com.unityide.editor-0.0.1.tgz)
2. In Unity, go to **Window > Package Manager**
3. Click **+** > **Add package from tarball...**
4. Browse to the downloaded `.tgz` file and click **Open**

### Option 2 — Edit manifest.json

Open your Unity project's `Packages/manifest.json` and add this line to the `"dependencies"` block:

```json
"com.unityide.editor": "https://releases.unityide.app/unity-extension-releases/com.unityide.editor-0.0.1.tgz"
```

Save the file. Unity will download and install the package automatically.

### Option 3 — Unity Package Manager UI

1. Open Unity Editor
2. Go to **Window > Package Manager**
3. Click the **+** button (top-left) > **Add package by name...**
4. Paste the URL:
   ```
   https://releases.unityide.app/unity-extension-releases/com.unityide.editor-0.0.1.tgz
   ```
5. Click **Add**

## Setup

After installing the package:

1. Go to **Edit > Preferences > External Tools** (macOS) or **Edit > Preferences > External Tools** (Windows)
2. Set **External Script Editor** to **UnityIDE**
3. If UnityIDE is not auto-detected, set the path manually via **UnityIDE > Settings** in the Unity menu bar

The extension auto-detects UnityIDE from these default locations:

| Platform | Default Paths |
|----------|--------------|
| macOS | `/Applications/UnityIDE.app`, `~/Applications/UnityIDE.app` |
| Windows | `C:\Program Files\UnityIDE\UnityIDE.exe`, `%LOCALAPPDATA%\Programs\UnityIDE\UnityIDE.exe` |
| Linux | `/usr/bin/unityide`, `/usr/local/bin/unityide`, `~/.local/bin/unityide` (the pre-rename `arcane` paths are still probed as a fallback) |

## Features

- **Script Editing** — Double-click `.cs` files in Unity to open them in UnityIDE
- **Console Streaming** — Unity logs appear in the IDE's console in real-time; the
  IDE can also pull a point-in-time snapshot (`getConsoleSnapshot`) and clear the
  console (`clearConsole`), which is what its post-turn console check is built on
- **Play Controls** — Play, pause, stop, and step from the IDE toolbar
- **Scene Hierarchy** — Live, read-only mirror of the open scenes in the IDE
- **Play-mode Telemetry** — FPS, memory, and GC stats streamed while playing
- **Test Runner** — Run EditMode and PlayMode tests from the IDE (requires
  `com.unity.test-framework`); individual results stream live as tests run,
  with a pass/fail summary on completion
- **UI Generation** — Attach a `UIDocument` to a GameObject and set serialized
  properties on a component, a GameObject, or an asset directly from the IDE
- **Project Generation** — Auto-generates `.sln`/`.csproj` for C# IntelliSense

## Requirements

- **Unity 2021.3 LTS** or later (2022.3 LTS and Unity 6 also supported)
- **UnityIDE** installed — [download here](https://unityide.app)
- Package **0.2.0** speaks bridge **protocol 4** — pair it with a UnityIDE build
  that speaks protocol 4 too (0.3.3+). An older pairing still connects (with a
  protocol-mismatch banner) but the protocol-4 features — console
  snapshot/clear and the UI-write RPCs — report they need an update instead
  of running; the test runner falls back to its older, blocking behavior
  rather than the queued one.

## Troubleshooting

**UnityIDE not in External Tools dropdown?**
Restart Unity after installing the package.

**Connection not established?**
Make sure UnityIDE is running and has the same project open. Check **UnityIDE > Settings** for connection status.

**Noisy logs?**
Add `UNITYIDE_VERBOSE` to **Player Settings > Scripting Define Symbols** to enable detailed logging. Logs are silent by default.

## Documentation

Full docs: [https://unityide.app/docs](https://unityide.app/docs)

## License

MIT — see [LICENSE.md](LICENSE.md)
