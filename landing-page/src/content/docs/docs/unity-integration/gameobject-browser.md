---
title: Project Knowledge Graph
description: How ArcaneIDE indexes your Unity project so the AI always has full context.
---

When you open a Unity project, ArcaneIDE automatically builds a **knowledge graph** — a structured database of every entity in your project and how they relate to each other. This is what gives the AI deep, accurate answers instead of guesses.

## What Gets Indexed

| File type | What's extracted |
|-----------|-----------------|
| `.cs` | Classes, methods, fields, inheritance, interfaces |
| `.unity` / `.prefab` | GameObjects, component types, serialized field values |
| `.controller` | Animation states, transitions, parameters |
| `.inputactions` | Action maps, bindings, control schemes |
| `.asmdef` | Assembly definitions and references |
| `.meta` | GUID ↔ asset path mappings |

## Indexing Status

A status indicator in the bottom bar shows the current state:

- **Indexing...** — First-time scan in progress
- **Complete** — Graph is up to date
- **Error** — Something failed (check the Output panel for details)

For large projects, the initial index can take a minute or two. Subsequent project opens are incremental — only changed files are re-processed.

## Reindexing

If you suspect the index is stale (e.g., after a large merge or an external tool modified many files), you can force a full rebuild:

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Search for **"Arcane: Reindex Project"**
3. The index is wiped and rebuilt from scratch

## How the AI Uses the Graph

The AI can query the knowledge graph through dedicated tools:

- **`projectOverview`** — High-level stats: script count, scene count, component usage
- **`searchProject`** — Find entities by name, or by semantic meaning (e.g. "scripts that handle enemy damage")
- **`queryRelationships`** — Trace inheritance chains, find which scenes use a prefab, see what components a GameObject has
- **`inspectEntity`** — Deep dive into a single class, scene, or asset with all its cross-references
- **`resolveGuid`** — Convert a GUID to an asset path or vice versa

You don't need to manually invoke these — the AI calls them automatically when answering questions about your project.
