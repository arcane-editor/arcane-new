# Arcane IDE — Unity Extension

Connects your Unity Editor to [Arcane IDE](https://arcaneai.org) for AI-powered game development. Real-time bidirectional communication lets you control Unity directly from the IDE.

## Installation

### Option 1 — Download & Import (Recommended)

1. Download the package: [com.arcane.editor-0.0.1.tgz](https://releases.arcaneai.org/unity-extension-releases/com.arcane.editor-0.0.1.tgz)
2. In Unity, go to **Window > Package Manager**
3. Click **+** > **Add package from tarball...**
4. Browse to the downloaded `.tgz` file and click **Open**

### Option 2 — Edit manifest.json

Open your Unity project's `Packages/manifest.json` and add this line to the `"dependencies"` block:

```json
"com.arcane.editor": "https://releases.arcaneai.org/unity-extension-releases/com.arcane.editor-0.0.1.tgz"
```

Save the file. Unity will download and install the package automatically.

### Option 3 — Unity Package Manager UI

1. Open Unity Editor
2. Go to **Window > Package Manager**
3. Click the **+** button (top-left) > **Add package by name...**
4. Paste the URL:
   ```
   https://releases.arcaneai.org/unity-extension-releases/com.arcane.editor-0.0.1.tgz
   ```
5. Click **Add**

## Setup

After installing the package:

1. Go to **Edit > Preferences > External Tools** (macOS) or **Edit > Preferences > External Tools** (Windows)
2. Set **External Script Editor** to **Arcane**
3. If Arcane IDE is not auto-detected, set the path manually via **Arcane > Settings** in the Unity menu bar

The extension auto-detects Arcane IDE from these default locations:

| Platform | Default Paths |
|----------|--------------|
| macOS | `/Applications/Arcane.app`, `~/Applications/Arcane.app` |
| Windows | `C:\Program Files\Arcane\Arcane.exe`, `%LOCALAPPDATA%\Programs\Arcane\Arcane.exe` |
| Linux | `/usr/bin/arcane`, `/usr/local/bin/arcane`, `~/.local/bin/arcane` |

## Features

- **Script Editing** — Double-click `.cs` files in Unity to open them in Arcane IDE
- **Console Streaming** — Unity logs appear in the IDE's console in real-time
- **Play Controls** — Play, pause, stop, and step from the IDE toolbar
- **Scene Hierarchy** — Live, read-only mirror of the open scenes in the IDE
- **Play-mode Telemetry** — FPS, memory, and GC stats streamed while playing
- **Test Runner** — Run EditMode and PlayMode tests from the IDE (requires `com.unity.test-framework`)
- **Project Generation** — Auto-generates `.sln`/`.csproj` for C# IntelliSense

## Requirements

- **Unity 2021.3 LTS** or later (2022.3 LTS and Unity 6 also supported)
- **Arcane IDE** installed — [download here](https://arcaneai.org)

## Troubleshooting

**Arcane not in External Tools dropdown?**
Restart Unity after installing the package.

**Connection not established?**
Make sure Arcane IDE is running and has the same project open. Check **Arcane > Settings** for connection status.

**Noisy logs?**
Add `ARCANE_VERBOSE` to **Player Settings > Scripting Define Symbols** to enable detailed logging. Logs are silent by default.

## Documentation

Full docs: [https://docs.arcaneai.org](https://docs.arcaneai.org)

## License

MIT — see [LICENSE.md](LICENSE.md)
