---
title: "AI Code Editor for Unity"
description: "Use UnityIDE to work with C# and Unity context, review changes, and check results against a connected Unity Editor. Learn the workflow and its limits before you start."
topic: "AI for Unity development"
author: { name: "UnityIDE team", url: "/about/" }
draft: false
publishedAt: 2026-09-21
researchedAt: 2026-09-21
verification:
  status: documented
  summary: "This page describes UnityIDE's documented workflow. It is not a benchmark or a guarantee that every generated change is correct. Available actions and verification depend on the selected mode, agent, project, and Editor connection."
testedVersions: []
sources:
  - title: "UnityIDE: AI chat modes"
    url: "https://unityide.app/docs/ai-features/autocompletion/"
    accessedAt: 2026-09-21
  - title: "UnityIDE: Unity Editor connection"
    url: "https://unityide.app/docs/unity-integration/scene-inspector/"
    accessedAt: 2026-09-21
  - title: "UnityIDE: Features"
    url: "https://unityide.app/features/"
    accessedAt: 2026-09-21
  - title: "UnityIDE: Pricing"
    url: "https://unityide.app/pricing/"
    accessedAt: 2026-09-21
related:
  - { collection: comparisons, id: rider }
  - { collection: comparisons, id: vscode }
  - { collection: blog, id: unity-ui-toolkit-query-null }
---

Unity development crosses code, assets, and the running Editor. A change to a C# field can affect serialized data; a UI query can compile but find no element. UnityIDE brings those parts of the project into an IDE built around that workflow.

Use AI to investigate a problem, prepare a bounded change, and review what happened. The important result is the behavior you can verify in Unity, not how confidently an agent describes its work.

## Connect the running Editor

Install UnityIDE and add its package to a Unity project. The connection lets the IDE work with Editor information and supported actions, rather than relying only on source files. The [connection guide](/docs/unity-integration/scene-inspector/) explains the toolbar, console, and setup requirements.

Start with a small project and confirm the connected state before asking for a task that depends on the scene or Editor. An unavailable connection changes what can be observed and verified. Do not treat an absent console error as proof that a scene was exercised.

## Choose the amount of action you want

Use **Ask** when you want an explanation or investigation. Use **Plan** when you want to work through a multi-step change before implementation. Use **Agent** when you are ready for the agent to take supported actions. Read the [mode documentation](/docs/ai-features/autocompletion/) for the current behavior and controls.

Give the task a visible finish line. For example:

> Find why the Play button in MainMenu does not invoke its handler. Explain the relevant UXML name and C# query, propose the smallest change, and list what still needs to be checked in Play Mode.

This is an example request, not a recorded product run. It identifies the asset, the symptom, and the evidence needed to judge the result.

## Review the change and the evidence

UnityIDE's [documented features](/features/) include project-specific tooling and checks connected to Unity. Review the changed files and the reported checks separately. A check that could not run remains unverified. Passing a compiler check does not establish that an interaction works in the scene.

For a UI fix, inspect the UXML and C# diff, compile, open the relevant screen, click the button, and check that it invokes the intended action once. For a serialized-data change, compare saved values before and after. For gameplay logic, run the relevant tests or a repeatable scene interaction.

Keep the task small enough that you can explain what changed. If a result introduces a new error, capture that error and re-check the affected behavior after correcting it. Do not expand the task simply because an agent can modify more files.

## Use the model or supported agent that fits your setup

Built-in AI usage is available through UnityIDE's plans. Supported external agents can provide another way to work with the project's tools; check current compatibility rather than assuming every agent exposes identical behavior. The [features page](/features/) and [AI settings documentation](/docs/ai-features/code-generation/) describe the available options.

The IDE itself is free. AI usage limits, model availability, and external subscription requirements are separate considerations. Check [pricing](/pricing/) before choosing a workflow, and read the [privacy policy](/privacy/) for how prompts and project context are handled.

## Decide whether this workflow suits you

UnityIDE is most useful to evaluate on a real recurring task. Keep a short record: what the agent could observe, what it changed, which checks ran, and what you verified yourself. Compare that with your current setup on the same task.

AI can help investigate and implement; it does not remove the need to review your project. If you are choosing between environments, our [Rider comparison](/compare/rider/) and [VS Code comparison](/compare/vscode/) explain the documented differences without assuming that competing tools lack Unity integrations.

[Download UnityIDE](/#download), follow the [installation guide](/docs/getting-started/installation/), and begin with one change you can verify.
