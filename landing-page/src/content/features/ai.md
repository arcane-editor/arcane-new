---
title: "AI Agent for Unity Developers"
description: "Use UnityIDE's AI agent to work with C# code, scenes, prefabs and console errors. Explore built-in tools, Claude Code support, setup and review workflows."
topic: "AI agent for Unity development"
author: { name: "UnityIDE team", url: "/about/" }
draft: false
publishedAt: 2026-09-21
updatedAt: 2026-10-03
updateNote: "Expanded the Unity workflows and setup guidance, and clarified built-in agent capabilities versus Claude Code through ACP after reviewing documentation and implementation."
researchedAt: 2026-10-03
verification:
  status: documented
  summary: "Capabilities were reviewed against UnityIDE's documentation and implementation. These are supported workflows, not recorded benchmark results. Available actions and checks depend on the selected agent, settings, project, and Unity Editor connection."
testedVersions: []
sources:
  - title: "UnityIDE: AI chat modes"
    url: "https://unityide.app/docs/ai-features/autocompletion/"
    accessedAt: 2026-10-03
  - title: "UnityIDE: Unity Editor connection"
    url: "https://unityide.app/docs/unity-integration/scene-inspector/"
    accessedAt: 2026-10-03
  - title: "UnityIDE: Unity Extension setup and Test Runner"
    url: "https://unityide.app/docs/getting-started/unity-extension/"
    accessedAt: 2026-10-03
  - title: "UnityIDE: AI settings"
    url: "https://unityide.app/docs/ai-features/code-generation/"
    accessedAt: 2026-10-03
  - title: "UnityIDE: Features"
    url: "https://unityide.app/features/"
    accessedAt: 2026-10-03
  - title: "UnityIDE: Pricing"
    url: "https://unityide.app/pricing/"
    accessedAt: 2026-10-03
related:
  - { collection: comparisons, id: rider }
  - { collection: comparisons, id: vscode }
  - { collection: features, id: ui-toolkit }
---

UnityIDE is a Unity IDE with a built-in AI agent for C# code, scenes, prefabs, and the running Unity Editor. Use it to investigate a console error, trace an asset reference, implement a gameplay change, or prepare tests while working in the same editor.

The agent can connect a code question to Unity-specific evidence: which component is attached to a GameObject, what value a serialized field contains, and what the console reports after a change. You can also use Claude Code through ACP, with its own account, tools, and permissions.

## What can the built-in Unity AI agent do?

| Task | How UnityIDE helps | What it needs |
| --- | --- | --- |
| Understand C# code and asset references | Reads project files, queries indexed relationships, and resolves asset GUIDs to paths | An open project; indexing for relationship queries |
| Investigate a scene problem | Reads the live scene hierarchy, component types, and serialized field values | The Unity extension and a connected Editor |
| Implement a change | Writes C# and supported project assets, with file diffs and configurable approval controls | Agent mode or an approved plan |
| Check a fix | Reads compilation and console errors, and can run EditMode or PlayMode tests | A connected Editor; the Unity Test Framework for tests |

For example, a missing reference may come from an unassigned Inspector field rather than the C# expression that throws the exception. Reading the component and the console together gives the agent evidence to investigate that distinction. The [Unity integration guide](/docs/unity-integration/scene-inspector/) explains the live connection; [GUID and asset resolution](/docs/unity-integration/asset-pipeline/) explains file references.

## Choose Ask, Plan, or Agent for the task

The built-in agent offers three chat modes:

- **Ask** explores the project and answers questions with read-only tools. Start here to understand a script or locate the source of an error.
- **Plan** develops an approach before implementation. Review the plan before allowing execution when a change spans several files.
- **Agent** can edit files, run commands, and use enabled Unity actions. Use it for a task with a clear scope and finish line.

[AI settings](/docs/ai-features/code-generation/) control how built-in file edits reach disk: apply immediately with review, or approve a diff first. Checkpoints can restore file changes. Unity actions have their own approval controls, and available tools depend on your settings. See the [chat mode documentation](/docs/ai-features/autocompletion/) for the workflow.

## Set up an AI workflow in your Unity project

1. [Install UnityIDE](/docs/getting-started/installation/) for Windows or Apple Silicon macOS and check the Unity and .NET requirements.
2. Open your Unity project in the IDE and let project indexing finish.
3. Install the [UnityIDE Unity extension](/docs/getting-started/unity-extension/) in that project, open Unity, and confirm the IDE reports a connected Editor.
4. Sign in to your UnityIDE account and start with a small task in the chat panel.

Built-in AI uses your UnityIDE plan; you do not need to supply an OpenAI or Anthropic API key. The IDE is free, and AI allowances depend on your plan. [Compare current pricing](/pricing/) before choosing your usage level. The [privacy policy](/privacy/) describes how prompts and project context are handled.

## Use Claude Code with UnityIDE through ACP

Claude Code is the supported external agent integration. ACP, the Agent Client Protocol, connects its session to UnityIDE's chat interface. This option requires an eligible paid UnityIDE plan, agent setup, and authentication with your own Anthropic account. Provider usage is separate from built-in UnityIDE AI usage.

Claude Code runs its own agent loop and exposes its own mode, model, and effort controls. Its permissions and configured MCP servers determine which actions it can take. Connecting through ACP does not automatically give it every built-in UnityIDE tool or apply the built-in agent's review workflow. Check the selected agent's available tools before requesting live scene inspection or Unity test execution.

## Try one change with a visible result

A useful first request names the symptom, the affected screen or asset, and how to check the result. For example:

> Find why the Play button in MainMenu does not invoke its handler. Inspect the UXML name and C# query, propose the smallest change, and explain what to check in Play Mode.

This is an illustrative request, not a recorded product run. Review the resulting C# and UXML diffs, compile, open the screen, and click the button. Check that the intended action runs once. The [UI Toolkit editor](/features/ui-toolkit/) brings UXML and USS editing into this workflow. For gameplay logic, request relevant tests and inspect their results; for serialized data, compare saved values before and after.

A tool being available means the agent can request that action. It does not establish that the action ran successfully. A disconnected Editor, disabled check, or unfinished test leaves that part unverified. Compilation alone cannot confirm an interaction works in a scene.

Explore [UnityIDE's editor features](/features/) and our [Rider](/compare/rider/) and [VS Code](/compare/vscode/) comparisons to evaluate the workflow alongside your current tools. [Download UnityIDE](/#download) and begin with one Unity task you can inspect and verify.
