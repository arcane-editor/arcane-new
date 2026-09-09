---
title: Opening Your First Project
description: Open a Unity project in UnityIDE and understand what happens next.
---

## Opening a Unity Project

1. Launch **UnityIDE**
2. Go to **File → Open...** (or press `Cmd+O`)
3. Select your Unity project's **root folder** — the one that contains the `Assets/` directory
4. Click **Open**

UnityIDE detects the Unity project automatically by looking for the `Assets/` folder. Non-project folders like `Library/`, `Temp/`, `obj/`, and `Logs/` are hidden from the file explorer automatically.

## What Happens Next

As soon as the project opens, UnityIDE starts **background indexing** in the node process:

- C# scripts are parsed for classes, methods, fields, and inheritance hierarchies
- Unity scene and prefab files are parsed for GameObjects and their components
- `.meta` files are read to build a GUID ↔ asset path lookup table
- Animator controllers and Input Action assets are also indexed

You'll see an **indexing status indicator** in the status bar. Once it reads "complete", the AI has full knowledge of your project structure. For large projects this can take a minute or two on first open — subsequent opens are incremental.

## File Explorer

The left sidebar shows your project's `Assets/` directory. You can:

- Click any `.cs` file to open it in the editor
- Right-click a `.unity` or `.prefab` file to **Reveal in Unity** or **Ping in Unity** (requires Unity connection)
- Right-click any asset to **Copy GUID** for use in scripts or YAML

## Using the AI

There is no API key to set up. Open **Settings** (`Cmd+,` / `Ctrl+,`), go to the
**Account** pane and sign in — your plan's AI usage is applied automatically. The
free plan includes a one-time trial to try it out.

Then click the chat icon in the left sidebar, or press `Cmd+L` / `Ctrl+L`.

## Next Steps

- [Unity Integration](/docs/unity-integration/scene-inspector/) — connect UnityIDE to the live Unity Editor
- [AI Chat Modes](/docs/ai-features/autocompletion/) — understand Agent, Ask, and Plan modes
