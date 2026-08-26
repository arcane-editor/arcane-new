---
title: Unity Editor Connection
description: Connect UnityIDE to the live Unity Editor for play controls and console streaming.
---

UnityIDE connects to the Unity Editor via a local IPC socket, giving you real-time control and log streaming without switching windows.

## How the Connection Works

When UnityIDE starts, it opens a Unix domain socket and waits for the Unity Editor to connect. You need the **UnityIDE Unity Plugin** installed in your Unity project for the two to talk.

Once connected, a status indicator appears in the toolbar showing the connection state.

## Unity Toolbar

The toolbar at the top of the window contains Play, Pause, Stop, and Step buttons that send commands directly to the Unity Editor.

| Button | Action | Shortcut |
|--------|--------|----------|
| Play | Enter Play mode | `Ctrl+Shift+F5` |
| Pause | Pause execution | `Ctrl+Shift+F6` |
| Stop | Exit Play mode | `Ctrl+Shift+F10` |
| Step | Advance one frame | `Ctrl+Shift+F11` |

The toolbar also displays the current play state (Playing / Paused / Stopped).

## Unity Console

The **Unity Console** panel streams log output directly from the Unity Editor in real time. It captures:

- `Debug.Log`, `Debug.LogWarning`, and `Debug.LogError` messages
- Compilation errors and warnings
- Unhandled exceptions from scripts

The console deduplicates repeated messages and keeps up to 500 entries visible at once.

**Why this matters for the AI:** The console output is automatically included in the AI's context. When a script throws a `NullReferenceException`, you can immediately ask the chat "Why is this error happening?" and the AI already has the stack trace — no copy-pasting required.

## C# Intelligence Features

UnityIDE adds Unity-aware decorations to the Monaco editor for C# files:

- **Lifecycle method highlighting** — `Awake`, `Start`, `Update`, `OnEnable`, and other MonoBehaviour methods are visually distinguished
- **Serialization indicators** — Fields marked `[SerializeField]` or `public` are annotated in the gutter
- **Code lens** — Shows the number of references to each method inline

## Explorer Context Menu

Right-clicking `.unity`, `.prefab`, or other asset files in the Explorer gives you extra options when connected to Unity:

- **Reveal in Unity** — Selects the asset in the Unity Project window
- **Ping in Unity** — Highlights the asset in the Unity Editor
- **Copy GUID** — Copies the Unity GUID for use in scripts or YAML files
