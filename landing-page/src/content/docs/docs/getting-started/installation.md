---
title: Installation
description: Download and install UnityIDE on Windows or macOS.
---

UnityIDE runs on **Windows** and **macOS** (Apple Silicon). Windows is the primary,
better-tested target; the macOS build is ad-hoc signed and marked Beta. Linux is not
built yet.

## System Requirements

**Windows**

- Windows 10 or later, 64-bit

**macOS**

- macOS 12 Monterey or later
- Apple Silicon (M1 or newer). There is no Intel build.

**Both**

- Unity 2021.3 LTS or later, for the Unity integration features
- [.NET 10](https://dotnet.microsoft.com/download) — the runtime *and* an SDK — for
  C# IntelliSense. UnityIDE ships its own C# language server and unpacks it for you,
  but that server targets `net10.0` and loads projects through the SDK, so .NET 8
  alone is not enough.

AI features need a UnityIDE account, not an API key of your own. The free plan
includes AI usage; see [pricing](/pricing) for the paid tiers.

## Download

Head to the [download section](/#download) on the homepage and take the build for
your platform — `UnityIDESetup.exe` on Windows, or the Apple Silicon `.dmg` on macOS.

## Installing on Windows

1. Run the downloaded `UnityIDESetup.exe`
2. If SmartScreen warns that the publisher is unknown, choose **More info**, then
   **Run anyway** — the installer is not code-signed yet
3. Follow the installer and launch UnityIDE

## Installing on macOS

1. Open the downloaded `.dmg` file
2. Drag **UnityIDE** into your Applications folder
3. Eject the disk image

## macOS Gatekeeper — Unsigned App Warning

This section is macOS only. UnityIDE is not yet signed with an Apple Developer
certificate, so Gatekeeper blocks it on the first launch. There are two ways past it:

### Option A — Right-click to Open (easiest)

1. Go to **Applications** in Finder
2. **Right-click** (or Control-click) on **UnityIDE**
3. Choose **Open** from the context menu
4. In the dialog that appears, click **Open** again

macOS will remember this choice and you can open the app normally from then on.

### Option B — Remove quarantine via Terminal

If Option A doesn't work (or you prefer the terminal), run:

```bash
xattr -cr /Applications/UnityIDE.app
```

Then launch the app normally. This removes the quarantine flag that Gatekeeper added when you downloaded the file.

:::note
You only need to do this once. After bypassing Gatekeeper the first time, UnityIDE opens normally on every subsequent launch.
:::

## Unity Extension

UnityIDE connects to the Unity Editor through a lightweight Unity package. Install it so the IDE can communicate with your project in real-time.

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
3. Click the **+** button > **Add package by name...**
4. Paste: `https://releases.unityide.app/unity-extension-releases/latest/com.unityide.editor.tgz`
5. Click **Add**

### Setup

After installing the package:

1. Go to **Edit > Preferences > External Tools**
2. Set **External Script Editor** to **UnityIDE**
3. Double-click any `.cs` file — it will open in UnityIDE

For detailed setup, features, and troubleshooting, see the [Unity Extension guide](/docs/getting-started/unity-extension/).

## Next Steps

Once installed, head to [Opening Your First Project](/docs/getting-started/first-project/) to connect UnityIDE to your Unity project.
