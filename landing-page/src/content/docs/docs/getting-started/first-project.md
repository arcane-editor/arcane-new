---
title: Opening Your First Project
description: Open a Unity project in ArcaneIDE and understand what happens next.
---

## Opening a Unity Project

1. Launch **ArcaneIDE**
2. Go to **File → Open...** (or press `Cmd+O`)
3. Select your Unity project's **root folder** — the one that contains the `Assets/` directory
4. Click **Open**

ArcaneIDE detects the Unity project automatically by looking for the `Assets/` folder. Non-project folders like `Library/`, `Temp/`, `obj/`, and `Logs/` are hidden from the file explorer automatically.

## What Happens Next

As soon as the project opens, Arcane starts **background indexing** in the node process:

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

## Configuring AI

Before using the chat, you need an API key. Open the **Settings panel** via the Command Palette (`Cmd+Shift+P` → "Arcane: Settings") and enter your **OpenAI** or **Anthropic** API key.

Once configured, click the chat icon in the left sidebar to start talking to the AI.

## Next Steps

- [Unity Integration](/docs/unity-integration/scene-inspector/) — connect Arcane to the live Unity Editor
- [AI Chat Modes](/docs/ai-features/autocompletion/) — understand Agent, Ask, and Plan modes
