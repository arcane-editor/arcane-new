---
title: "Unity prefab merge conflicts: use UnityYAMLMerge and verify the result"
description: "Set up Unity's semantic merge tool for Git, understand its inputs, and inspect the merged prefab in Unity before accepting a resolution."
topic: "Version control"
author: { name: "UnityIDE team", url: "/about/" }
draft: true
researchedAt: 2026-09-21
verification:
  status: pending
  summary: "The companion fixture creates base and branch prefabs, invokes UnityYAMLMerge, and reimports the output. Publication requires a successful run; ambiguous same-property conflicts and Git UI prompts are not covered."
testedVersions: []
sources:
  - title: "Unity: Smart Merge"
    url: "https://docs.unity3d.com/6000.0/Documentation/Manual/SmartMerge.html"
    accessedAt: 2026-09-21
  - title: "Git: git-mergetool"
    url: "https://git-scm.com/docs/git-mergetool"
    accessedAt: 2026-09-21
related:
  - { collection: blog, id: rename-unity-serialized-fields }
  - { collection: comparisons, id: rider }
---

A prefab conflict is a disagreement about serialized objects, even when Git presents it as a disagreement about lines. Unity ships **UnityYAMLMerge** to merge scene and prefab data with knowledge of that structure. It can help combine compatible edits; it cannot decide which gameplay change your team intended when both branches disagree.

Start in a disposable clone or a clean branch. Preserve both versions of a disputed asset until you have inspected the outcome in Unity.

## Identify the four merge files

For a three-way merge, the useful inputs are the common ancestor and each branch's version. The output is a fourth file:

| File | Meaning in this workflow |
| --- | --- |
| Base | The shared version before the changes |
| Remote | The incoming branch's version |
| Local | Your current branch's version |
| Merged | The result to inspect and accept |

Unity's documented command order is `base`, `remote`, `local`, `merged`. Keep that order intact when configuring a tool. Git exposes these file paths as `$BASE`, `$REMOTE`, `$LOCAL`, and `$MERGED`; its [mergetool documentation](https://git-scm.com/docs/git-mergetool) explains the mapping.

## Find the tool belonging to your Unity installation

Use the Unity installation that matches the project. On a Unity Hub installation, the path includes the installed version. Example locations are:

```text
macOS:
/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/Tools/UnityYAMLMerge

Windows:
C:/Program Files/Unity/Hub/Editor/<version>/Editor/Data/Tools/UnityYAMLMerge.exe
```

Replace `<version>` with the actual installed folder and verify the executable exists. A team's machines need not have identical installation paths. Avoid committing your machine-specific absolute path as if it were portable.

Use text-serialized assets for the exercise. In the Unity Editor, review the project's Asset Serialization setting before creating the fixture; if changing it for an established project creates a large unrelated diff, separate that change from the conflict you are investigating.

## Configure Git's explicit merge tool

Open the repository-local `.git/config` and add or update this section, replacing the placeholder with the executable path you verified:

```ini
[mergetool "unityyamlmerge"]
    trustExitCode = false
    cmd = '<absolute-path-to-UnityYAMLMerge>' merge -p "$BASE" "$REMOTE" "$LOCAL" "$MERGED"
```

This follows Unity's [Smart Merge setup](https://docs.unity3d.com/6000.0/Documentation/Manual/SmartMerge.html), with explicit selection when you invoke the tool:

```sh
git mergetool --tool=unityyamlmerge -- Assets/Prefabs/Example.prefab
```

The command is intended for a file Git currently considers conflicted. Installing this configuration does not automatically run the tool during every merge, and it does not configure a `.gitattributes` merge driver. Those are different integrations. Start with explicit invocation so the behavior is visible.

Keep the success prompt while you establish the workflow. Read the tool output and check the asset before confirming a resolution; a process exit code cannot prove that the intended gameplay behavior survived.

## Try two changes you can verify independently

Create a prefab with a root and two children named `Left` and `Right`. Preserve its base version. On one branch, move `Left` to local position `(1, 0, 0)`. On the other, move `Right` to `(0, 2, 0)`.

Combine the branch versions and inspect the result. The expected outcome is explicit: both children remain, and both positions survive. If ordinary Git merging handles this case without a conflict, that is fine; test the four-file UnityYAMLMerge invocation separately to verify the tool wiring. Do not manufacture a claim that every independent edit produces a Git conflict.

Then create a second exercise where both branches change the same property differently. Treat that as a decision for the developer. Record the intended result before choosing either value. The simple independent-change fixture does not establish how every ambiguous conflict will be presented.

## Inspect the merged asset in Unity

Reimport and open the prefab. Check its hierarchy, components, references, and overridden properties. For the sample, verify the two child positions numerically in the Inspector. In a real project, run a scene or test that exercises the changed object.

Review the final diff and look for unintended deletions or lost references before committing the resolution. Preserve `.meta` files alongside their assets. A textually clean file that opens successfully is useful evidence, but it does not substitute for checking the behavior your merge changed.

If the output is wrong, stop and compare the preserved inputs. Do not keep resaving an uncertain resolution. Work out whether the issue is a tool path, input order, unsupported data, or an actual incompatible change, then repeat the smallest reproduction.
