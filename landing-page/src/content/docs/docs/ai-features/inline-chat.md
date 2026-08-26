---
title: AI Tools
description: The 15 tools available to the UnityIDE AI agent and what each one does.
---

When the AI responds to your messages, it can call **tools** to gather information or make changes. You'll see tool calls rendered in the chat as expandable blocks showing inputs and outputs.

## Code Navigation Tools

| Tool | What it does |
|------|-------------|
| `readFile` | Read the full contents of any file in `Assets/` |
| `listDirectory` | Browse the directory tree (always scoped to `Assets/`) |
| `searchCode` | Full-text search across all C# and other source files |
| `findSymbols` | Find classes, methods, or fields by name |
| `goToDefinition` | Jump to where a symbol is defined |
| `getReferences` | Find all usages of a symbol across the project |

## Code Modification Tools

| Tool | What it does |
|------|-------------|
| `writeFile` | Create a new file |
| `editFile` | Edit an existing file using find-and-replace patches |
| `runCommand` | Run a shell command (dotnet build, git, Unity CLI, etc.) |

:::caution
`writeFile`, `editFile`, and `runCommand` are only available in **Agent mode** and the execution phase of **Plan mode**. They are disabled in **Ask mode**.
:::

## Diagnostics

| Tool | What it does |
|------|-------------|
| `getDiagnostics` | Get compiler errors, warnings, and info messages from the language server |

## Unity Knowledge Graph Tools

These tools query the indexed knowledge graph built from your project's files.

| Tool | What it does |
|------|-------------|
| `projectOverview` | High-level summary: script count, scene list, component usage stats |
| `searchProject` | Search entities by **name**, **semantic meaning**, or **auto** (hybrid) |
| `queryRelationships` | Traverse edges in the graph — inheritance chains, scene references, component usage |
| `inspectEntity` | Deep dive into a single entity with all cross-references |
| `resolveGuid` | Convert a GUID to an asset path or vice versa |

### Semantic Search

The `searchProject` tool supports three modes:

- **name** — exact or partial name match
- **semantic** — uses vector embeddings to find conceptually similar code (e.g. "scripts that handle enemy damage" finds `EnemyHealth.cs` even if the words don't match)
- **auto** — the AI picks the best mode based on your query

## How to Get the Best Results

- **Be specific about scope** — "in PlayerController.cs" or "in the MainScene" helps the AI focus
- **Ask about errors with context** — after a Unity console error, just ask "why is this happening?" — the AI already has the stack trace
- **Let the AI explore** — for complex questions, let it call multiple tools rather than trying to paste in all context yourself
