---
title: Installation
description: Download and install ArcaneIDE on macOS.
---

ArcaneIDE is currently available for **macOS** (Apple Silicon). Windows and Linux builds are planned.

## System Requirements

- **macOS 12 Monterey or later**
- Apple Silicon (M1/M2/M3/M4)
- Unity 2021.3 LTS or later (for Unity integration features)
- An OpenAI or Anthropic API key for AI features

## Download

Head to the [download section](/#download) of the homepage and grab the latest `.dmg` for your Mac.

## Installing the App

1. Open the downloaded `.dmg` file
2. Drag **ArcaneIDE** into your Applications folder
3. Eject the disk image

## macOS Gatekeeper — Unsigned App Warning

ArcaneIDE is not yet signed with an Apple Developer certificate, so macOS Gatekeeper will block it on the first launch. There are two ways to get past this:

### Option A — Right-click to Open (easiest)

1. Go to **Applications** in Finder
2. **Right-click** (or Control-click) on **ArcaneIDE**
3. Choose **Open** from the context menu
4. In the dialog that appears, click **Open** again

macOS will remember this choice and you can open the app normally from then on.

### Option B — Remove quarantine via Terminal

If Option A doesn't work (or you prefer the terminal), run:

```bash
xattr -cr /Applications/ArcaneIDE.app
```

Then launch the app normally. This removes the quarantine flag that Gatekeeper added when you downloaded the file.

:::note
You only need to do this once. After bypassing Gatekeeper the first time, ArcaneIDE opens normally on every subsequent launch.
:::

## Unity Extension

ArcaneIDE connects to the Unity Editor through a lightweight Unity package. Install it so the IDE can communicate with your project in real-time.

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
3. Click the **+** button > **Add package by name...**
4. Paste: `https://releases.arcaneai.org/unity-extension-releases/com.arcane.editor-0.0.1.tgz`
5. Click **Add**

### Setup

After installing the package:

1. Go to **Edit > Preferences > External Tools**
2. Set **External Script Editor** to **Arcane**
3. Double-click any `.cs` file — it will open in ArcaneIDE

For detailed setup, features, and troubleshooting, see the [Unity Extension guide](/docs/getting-started/unity-extension/).

## Next Steps

Once installed, head to [Opening Your First Project](/docs/getting-started/first-project/) to connect ArcaneIDE to your Unity project.
