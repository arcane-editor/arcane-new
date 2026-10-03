---
title: "Unity UXML & USS Editor with UI Toolkit Preview"
description: "Edit Unity UXML and USS with a live preview, style inspector, C# reference links, and AI design tools. See the workflow, prerequisites, and rendering limits."
topic: "UI Toolkit editing"
author: { name: "UnityIDE team", url: "/about/" }
draft: false
publishedAt: 2026-10-03
researchedAt: 2026-10-03
verification:
  status: documented
  summary: "Capabilities were checked against UnityIDE's implementation and Unity documentation. The preview approximates Unity rendering; this page does not report a hands-on runtime test or guarantee generated UI behavior."
testedVersions: []
sources:
  - title: "UnityIDE: Installation and Unity integration prerequisites"
    url: "https://unityide.app/docs/getting-started/installation/"
    accessedAt: 2026-10-03
  - title: "Unity: Structure UI with UXML"
    url: "https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-UXML.html"
    accessedAt: 2026-10-03
  - title: "Unity: Style UI with USS"
    url: "https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-USS.html"
    accessedAt: 2026-10-03
  - title: "Unity: Panel Settings properties reference"
    url: "https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-Runtime-Panel-Settings.html"
    accessedAt: 2026-10-03
related:
  - { collection: features, id: ai }
---

UnityIDE includes a Unity UXML editor and USS editing tools for developers building menus, HUDs, and other UI Toolkit screens. Work on the markup, inspect a visual preview, and follow an element back to the stylesheet or C# references that affect it.

Unity uses [UXML to define UI structure](https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-UXML.html) and [USS to style it](https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-USS.html). Keeping those files connected to the code that uses them helps answer practical questions: which rule sets this button's width, and where does the project look up its name?

## Edit UXML and USS with visual context

The UXML preview updates from the current editor buffer as you change the document. It loads referenced stylesheets and refreshes them after saved UXML or USS changes. Pan, zoom, fit the screen to the canvas, or enable box outlines to inspect the layout.

Source editing includes suggestions for known UXML elements and attributes, plus USS properties and state selectors. USS uses CSS-like syntax with Unity-specific behavior, so a familiar browser CSS property is not automatically a supported Unity style.

Select an element on the canvas to inspect its name, type, and classes. The **Styles** tab shows resolved declarations, their source rules, and competing declarations. Source links let you move from the visual result to the rule that needs attention.

## Keep UI elements connected to C#

The element inspector's **C# references** tab surfaces indexed queries and event-handler references for named elements. That gives a UI change useful context: renaming a button may also affect the code that queries it.

The AI's UI Toolkit inspection tool can list project documents, show a document's element tree, look up a name, and compare class usage across UXML, USS, and C#. Treat these as source-level findings. Code that creates elements dynamically or constructs names at runtime still needs investigation in the running application.

## Ask AI for a bounded design change

The design chat is available over the preview canvas. Give it the screen, the intended change, and the behavior to preserve. For example:

> In MainMenu.uxml, increase the Play button's padding using the existing USS variables. Keep its element name and C# handler unchanged. Report missing stylesheets and any preview limitations.

This is an example request, not a recorded test. For a new screen, the scaffold tool supplies starting templates for a HUD, main menu, settings, dialog, or inventory, using available project variables and reference resolution. It returns a recipe for the agent to apply; it does not itself write the files.

The dedicated UI write tool checks content before saving. Blocking findings include malformed UXML, missing stylesheet references, recognized CSS-only properties, likely property misspellings, and unsupported units. Other findings can remain warnings, and custom controls are outside some built-in checks. Validation therefore covers specific mistakes rather than every possible import or runtime problem.

Read the broader [AI editor workflow](/features/ai/) for choosing a task, reviewing changes, and checking results.

## Understand what the preview can establish

The canvas translates UXML and USS into a webview representation. Unity's built-in control theme is approximated, and unresolved stylesheets or unsupported styling can affect the result. Preview layout tools use that same representation, so their measurements do not establish exact Unity runtime rendering.

UnityIDE looks for the document's PanelSettings relationship and labels an assumed choice when several candidates exist. Without usable settings, the preview falls back to its default screen dimensions. Check the displayed dimensions and assumptions before judging scale. Unity's [Panel Settings reference](https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-Runtime-Panel-Settings.html) explains how scale mode and reference resolution affect the actual UI.

## Start with one screen and verify it in Unity

Follow the [installation guide](/docs/getting-started/installation/) for supported platforms and prerequisites, then open a Unity project containing the UXML and USS you want to edit. This workflow targets UI Toolkit assets; adopting UI Toolkit in a project using Canvas/uGUI is a separate decision.

For live Editor actions and console feedback, install the UnityIDE package and confirm the [Unity Editor connection](/docs/unity-integration/scene-inspector/). AI availability depends on your account and selected agent.

After reviewing a change, let Unity import the assets, open the intended screen, and exercise its controls. Check your target resolutions, navigation, and screen reopening behavior in Unity. The preview helps with iteration; the running project establishes the result.

[Explore all UnityIDE features](/features/) or [download UnityIDE](/#download) to evaluate this workflow on your own UI.
