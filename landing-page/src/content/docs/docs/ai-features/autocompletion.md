---
title: AI Chat Modes
description: Choose Ask, Plan, or Agent for Unity development, set reasoning effort, and understand how built-in AI differs from Claude Code.
---

UnityIDE's built-in AI operates through the **chat panel**. It can investigate your project, write code, and use supported Unity tools. The mode you select determines which actions are available.

These modes apply to the **UnityIDE agent**. Claude Code through ACP uses its own modes and permissions; see [External Agents](#external-agents) below.

## Three Modes

You can switch modes from the mode selector in the chat panel.

### Agent Mode

Agent mode can read project files, implement changes, run shell commands, and call enabled Unity tools. For example, it can edit a C# script, inspect compilation errors, and request a Unity test run.

File edits follow your [apply-mode settings](/docs/ai-features/code-generation/). Actions that change the running Unity Editor, such as entering Play Mode or setting a component property, require approval. Live Unity tools also need a connected Editor.

Use Agent for a task with a clear scope and an observable result: "Add an EditMode test for this damage calculation, run it, and report the outcome."

### Ask Mode

Ask uses read-only tools. The agent can inspect files, query indexed relationships, and read supported Unity context, but cannot use file-writing tools, shell commands, or Unity mutation tools.

Use Ask to understand existing behavior: "Which component handles player input, and what calls it?"

### Plan Mode

Plan develops an approach before implementation. During planning, project investigation uses read-only tools and the agent can ask clarifying questions. Review the plan before starting execution; the execution phase can use editing and enabled Unity action tools.

Use Plan for a change across several scripts or assets, such as migrating a gameplay feature to the Input System. File and Unity action approval settings still apply during execution.

The [UI Toolkit canvas](/features/ui-toolkit/) also provides a document-focused **Design** mode through its design dock. It is separate from the three choices in the general chat mode menu.

## Reasoning Effort

The reasoning control cycles through the levels available to your account:

| Level | Purpose |
| --- | --- |
| **Standard** | Default reasoning for everyday tasks |
| **Deep Think** | More reasoning per turn for harder tasks, with higher latency and usage |
| **Max** | The highest reasoning level available through this control, subject to your plan |

Deep Think and Max require an eligible paid plan. The available options reflect your current account entitlements; see [pricing](/pricing/). More reasoning is not a guarantee of correctness, so review changes and check the result in Unity at every level.

## Unity Context

The built-in agent can use [AI tools](/docs/ai-features/inline-chat/) to gather:

- **Code and asset context** from project files, indexed relationships, and GUID references.
- **Scene context** from the connected Unity Editor, including GameObjects, components, and serialized values.
- **Console and compiler evidence** to investigate errors and check changes.
- **Unity API information** through API search and documentation tools.

Indexing and the [Unity Editor connection](/docs/unity-integration/scene-inspector/) affect what is available. A disconnected bridge cannot inspect the current scene, and an incomplete test run is not a pass.

## External Agents

Claude Code is available through ACP on eligible paid UnityIDE plans. It runs on your Anthropic account with its own tools and permission modes. Its mode, model, and effort controls come from the agent and appear in the chat toolbar.

UnityIDE's Ask/Plan/Agent settings do not control Claude Code. Configured MCP servers can extend the external agent's tools, but ACP alone does not provide all of UnityIDE's built-in Unity actions. For setup context and a practical first task, see [AI agent for Unity developers](/features/ai/).
