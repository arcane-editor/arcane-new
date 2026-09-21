---
title: "Unity C# IntelliSense not working: diagnose the project first"
description: "Separate Unity compilation, project loading, and C# language-server problems with a small completion test before reinstalling your tools."
topic: "C# setup"
author: { name: "UnityIDE team", url: "/about/" }
draft: true
researchedAt: 2026-09-21
verification:
  status: pending
  summary: "The diagnostic workflow is grounded in Unity and Microsoft documentation. A live UnityIDE language-server check is required before this guide is published; VS Code setup has not been tested here."
testedVersions: []
sources:
  - title: "Microsoft: Unity Development with VS Code"
    url: "https://code.visualstudio.com/docs/other/unity"
    accessedAt: 2026-09-21
  - title: "Unity: Integrated development environment support"
    url: "https://docs.unity.com/en-us/engine/6000.7/manual/scripting/environment-and-tools/ide-support"
    accessedAt: 2026-09-21
  - title: "Microsoft: Getting Started with C# in VS Code"
    url: "https://code.visualstudio.com/docs/csharp/get-started"
    accessedAt: 2026-09-21
related:
  - { collection: comparisons, id: vscode }
  - { collection: blog, id: unity-ui-toolkit-query-null }
---

When `transform.` produces no useful suggestions, begin by finding which part of the chain is broken. A colored C# file shows syntax highlighting; it does not prove that the editor loaded your Unity project or resolved its assemblies.

The checks below are arranged to change one thing at a time. Keep a note of the first failing check and its exact error. That is more useful than a list of everything you reinstalled.

## Check whether Unity can compile the project

Open the project in the Unity Editor and wait for its initial import and compilation. Read the first C# error in the Console, including its file and line. Fix an actual compiler error before using the same script to evaluate completions.

If the project compiles but the IDE underlines `UnityEngine`, investigate project loading and assembly references. If both Unity and the IDE reject the same symbol, investigate code, packages, or assembly definitions instead. Neither situation establishes a bug in autocomplete by itself.

Record your Unity version, IDE version, operating system, and the affected script's assembly. A script under an Editor folder and a runtime script can have different reference contexts.

## Confirm the project is open, not just a loose file

Open the Unity project directory containing `Assets`, `Packages`, and `ProjectSettings`. Then open a script from Unity with the external editor you selected in Preferences or Settings → External Tools. Unity's [IDE support documentation](https://docs.unity.com/en-us/engine/6000.7/manual/scripting/environment-and-tools/ide-support) explains that opening a file and configuring full IDE support are separate steps.

Inspect the IDE's project or solution status. Can it identify the assembly containing the file? Does it report missing projects, unresolved references, or an SDK problem? Collect that output before restarting anything. Regenerating project files can be appropriate when they are stale; deleting your project's assets or metadata is not a project-loading fix.

## If you use VS Code, check the two different packages

There are two sides to Microsoft's integration: the **Unity extension in VS Code** and the **Visual Studio Editor package in Unity**. The names are easy to confuse.

[Microsoft's Unity guide](https://code.visualstudio.com/docs/other/unity) requires Unity 2021 or newer and the Visual Studio Editor package `2.0.20` or newer. Its Unity extension installs C# dependencies, including C# Dev Kit. The old Unity package named **Visual Studio Code Editor** is no longer maintained.

Check the installed names and versions rather than assuming any package with “VS Code” in its name is current. Follow the extension's setup messages if it reports a .NET dependency problem; Microsoft's [C# setup guide](https://code.visualstudio.com/docs/csharp/get-started) describes its environment walkthrough. These are documentation-based setup instructions, not a tested claim about every VS Code configuration.

## Use a small completion probe

Create `CompletionProbe.cs` in a disposable project's `Assets` directory:

```csharp
using UnityEngine;

public class CompletionProbe : MonoBehaviour
{
    private void Start()
    {
        Vector3 position = transform.position;
        Debug.Log(position);
    }
}
```

Wait for Unity to compile this valid version. In the IDE, place the caret after `transform.` on the assignment line and invoke suggestions. Check that `position` is offered. Restore the line, hover `Vector3`, and navigate to a project-defined symbol from another script.

These checks answer different questions: member completion tests Unity type information, hover tests symbol resolution, and cross-file navigation tests project scope. Restore valid code after the probe; an intentionally incomplete line is not a clean compilation test.

## Compare a clean project with the affected project

Run the same probe in a new project using the same Unity version and IDE configuration. If it works there, compare the affected project's package errors, assembly definitions, generated projects, and language-server output. If both fail, focus on the installed toolchain and integration.

Do not start by disabling every extension or deleting caches. First preserve the evidence, then try one reversible change and repeat the probe. A fix is useful when you can name the condition it corrected and show that the failing operation now succeeds.

## What counts as resolved

Use this acceptance checklist before closing the issue:

- Unity compiles the restored script without errors.
- The IDE resolves `UnityEngine` and offers the expected member completion.
- Hover and navigation return a real symbol, not a word match.
- Closing and reopening the project does not reproduce the failure.

If you need help, share versions, the minimal probe, the first relevant error, and whether a clean project reproduces it. Remove private paths and credentials from logs. For UnityIDE-specific setup, start with the [Unity connection guide](/docs/getting-started/unity-extension/).
