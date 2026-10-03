---
title: AI Tools
description: Explore UnityIDE's built-in AI tools for C# code, scene inspection, asset references, Unity console errors, and test execution.
---

The built-in UnityIDE agent calls **tools** to gather information or make changes. Expand a tool call in chat to inspect its inputs and output. You can request a task in plain language; you do not need to type tool names yourself.

This page groups representative tools by task. The available set depends on the selected mode, project, settings, and Unity connection. External agents such as Claude Code have their own toolsets.

## Read Code and Trace Relationships

| Tool | What it does |
| --- | --- |
| `read`, `list` | Read files and browse directories within the built-in agent's allowed project roots |
| `project_symbols` | List types and members in a file, or locate the file containing a type |
| `graphify_query` | Query indexed code relationships using a free-text question |
| `graphify_explain` | Inspect a graph node and its incoming and outgoing connections |
| `graphify_path` | Trace a path between named concepts in the code graph |
| `find_asset_references` | Find assets referencing a script or GUID; add live GameObject references when connected |

Graph queries require an available index. The static asset-reference index can work without a running Unity Editor; live references require the Unity extension connection.

## Inspect Unity Scenes and Errors

| Tool | What it does |
| --- | --- |
| `get_editor_state` | Read the Unity connection and Editor state |
| `get_scene_hierarchy` | Read GameObjects and component types in the open scenes |
| `get_game_object` | Inspect a live GameObject's components and serialized values |
| `get_compile_errors` | Read available Unity compiler diagnostics |
| `get_console_errors` | Inspect console entries and stack traces |
| `unity_api_search`, `get_unity_docs` | Look up Unity API information and documentation |

Scene inspection requires a [connected Unity Editor](/docs/unity-integration/scene-inspector/). Console access reads Unity's console when the connected bridge supports it. Otherwise, the tool reports its fallback to entries streamed during the IDE session. That fallback may not contain earlier errors.

## Edit Code and Project Assets

| Tool | What it does |
| --- | --- |
| `write`, `edit` | Create or edit project files |
| `bash` | Run shell commands using the project's installed tools |
| `unity_asset_edit` | Change fields in a supported serialized `.asset` file |
| `unity_input_edit` | Modify supported Input System action maps, actions, and bindings |
| `unity_ui_write` | Validate and write UI Toolkit `.uxml` and `.uss` files |

These editing tools are available in Agent mode and plan execution. Ask mode and plan investigation use read-only tools. The UI Toolkit Design workflow has its own document-scoped tool selection.

Review [apply mode and checkpoint settings](/docs/ai-features/code-generation/) before making changes. File writes through the built-in editing tools can be reviewed and checkpointed. Shell commands can modify files outside that checkpoint workflow; a restored turn does not undo every possible command effect.

## Control Unity and Run Tests

| Tool | What it does |
| --- | --- |
| `unity_play`, `unity_stop` | Enter or leave Play Mode |
| `unity_refresh` | Ask Unity to refresh assets |
| `unity_set_property` | Set supported serialized properties on a GameObject or asset |
| `unity_run_tests` | Run EditMode or PlayMode tests and await their result |

These actions require user approval and an available Unity connection. Settings can disable bridge actions or the Test Runner. Running tests also requires the Unity Test Framework package in your project; see the [extension guide](/docs/getting-started/unity-extension/).

An available tool is not evidence of a completed action. Check whether the call succeeded, whether tests actually finished, and whether the changed behavior was exercised. A clean compile alone cannot establish that an in-game interaction works.

## Get Useful Results

- Name the affected script, scene, or asset and describe the observed behavior.
- Ask the agent to inspect relevant evidence before making a change.
- Request a specific check, such as running an existing test or reproducing an interaction in Play Mode.
- Review the diff and any checks that remain unverified.

See [AI chat modes](/docs/ai-features/autocompletion/) to choose how much action to allow, or start with the [Unity AI agent workflow](/features/ai/).
