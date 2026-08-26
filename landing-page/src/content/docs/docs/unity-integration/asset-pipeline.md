---
title: GUID & Asset Resolution
description: How UnityIDE resolves Unity GUIDs and tracks asset references.
---

Unity identifies every asset by a **GUID** stored in its `.meta` file. UnityIDE reads all `.meta` files during indexing to build a bidirectional map: GUID → asset path and asset path → GUID.

## Why This Matters

When the AI reads a Unity scene or prefab (which are YAML files full of GUIDs), it can resolve every reference to a human-readable asset path. This means when you ask "What prefabs does my MainScene use?", the AI can give you actual filenames instead of opaque hex strings.

## Using the resolveGuid Tool

The AI has access to a `resolveGuid` tool that maps in both directions:

- **GUID → path**: "What asset is `a1b2c3d4...`?" → `Assets/Prefabs/Enemy.prefab`
- **Path → GUID**: "What's the GUID of `PlayerController.cs`?" → `f8e7d6c5...`

You can also access this directly from the Explorer: right-click any asset → **Copy GUID**.

## Asset Reimport

To trigger Unity to reimport an asset, use the **Reveal in Unity** context menu option and reimport from within the Unity Editor directly. UnityIDE does not manage asset imports itself — it defers to Unity's asset pipeline.
