---
title: "Unity UI Toolkit Q returns null: check name, type, and tree"
description: "Diagnose a missing UI Toolkit element with a minimal UXML example, then check document lifecycle and callback cleanup without hiding a broken query."
topic: "UI Toolkit"
author: { name: "UnityIDE team", url: "/about/" }
draft: true
researchedAt: 2026-09-21
verification:
  status: pending
  summary: "The accompanying fixture imports UXML and checks name, type, class, and tree selection. These checks must run before publication; Play Mode document lifecycle remains outside the fixture."
testedVersions: []
sources:
  - title: "Unity: UQueryExtensions.Q"
    url: "https://docs.unity3d.com/6000.0/Documentation/ScriptReference/UIElements.UQueryExtensions.Q.html"
    accessedAt: 2026-09-21
  - title: "Unity: Find visual elements with UQuery"
    url: "https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-UQuery.html"
    accessedAt: 2026-09-21
  - title: "Unity: UI Document component"
    url: "https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-create-ui-document-component.html"
    accessedAt: 2026-09-21
related:
  - { collection: blog, id: unity-intellisense-not-working }
  - { collection: features, id: ai }
---

`root.Q<Button>("play")` can compile successfully and still return `null`. C# checks that the method call is valid; it does not establish that a matching button exists in the visual tree at that moment.

Unity's [`Q` API](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/UIElements.UQueryExtensions.Q.html) returns the first element matching the supplied criteria, or null when none matches. Work through those criteria before changing event handling or adding a delay.

## Make the mismatch visible

Create a small UXML document:

```xml
<ui:UXML xmlns:ui="UnityEngine.UIElements">
    <ui:VisualElement name="menu">
        <ui:Button name="play" text="Play" class="primary" />
        <ui:Label name="status" text="Ready" />
    </ui:VisualElement>
</ui:UXML>
```

For a visual tree instantiated from this asset, compare these queries:

```csharp
root.Q<Button>("play");                 // matching name and type
root.Q<Button>("play-btn");             // wrong name
root.Q<Label>("play");                  // wrong type
root.Q<Button>(className: "primary");   // class selector
```

The button's displayed text is `Play`, its name is `play`, and its class is `primary`. They serve different purposes. Passing `"primary"` as the first positional argument searches by name, not by class. Unity's [UQuery guide](https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-UQuery.html) describes the available selectors.

## Confirm the tree you are querying

A correct name cannot find an element in another document. Identify the `UIDocument` instance and the source UXML assigned to it. In a project with several menus, a root reference from the previous screen is an easy mistake to miss.

In a scratch check, query a freshly cloned `VisualTreeAsset`. If the button appears there but not in the runtime document, you have narrowed the problem to document selection, instantiation, or lifecycle. If it fails in both places, start with the actual UXML name and element type.

Do not silently turn the result into an optional operation if the button is required. A diagnostic naming the missing element and document makes the next failure much easier to investigate.

## Bind controls when the document is ready

Unity recommends setting up runtime UI control interaction in `OnEnable` and cleaning it up in `OnDisable`. Its [UI Document lifecycle documentation](https://docs.unity3d.com/6000.0/Documentation/Manual/UIE-create-ui-document-component.html) explains that document contents can be cleared and recreated across lifecycle changes.

For a controller on the same GameObject as a configured, enabled `UIDocument`, the pattern is:

```csharp
using UnityEngine;
using UnityEngine.UIElements;

[RequireComponent(typeof(UIDocument))]
public class MenuController : MonoBehaviour
{
    private Button playButton;

    private void OnEnable()
    {
        var document = GetComponent<UIDocument>();
        playButton = document.rootVisualElement.Q<Button>("play");
        if (playButton == null)
        {
            Debug.LogError("Expected Button named play in this UIDocument.", this);
            return;
        }
        playButton.clicked += OnPlay;
    }

    private void OnDisable()
    {
        if (playButton != null) playButton.clicked -= OnPlay;
        playButton = null;
    }

    private void OnPlay() => Debug.Log("Play requested", this);
}
```

This lifecycle pattern is documentation-based. A query fixture alone does not test the timing of your screen transitions or dynamically replaced documents. If you enable the document independently of this controller, make the rebinding point explicit when its new tree exists.

## Verify recovery, not only the first click

Use a short acceptance sequence in your own project:

1. Open the screen and click Play once; observe one handler invocation.
2. Close and reopen the screen; click again and check for duplicate handlers.
3. Deliberately rename the UXML element; confirm the diagnostic identifies the missing match.
4. Restore the name; confirm the button works without stale references.
5. If the project has multiple UI documents, repeat with the intended document active.

Keep these failure cases in a small scene you can revisit after UI refactors. A null check prevents an exception, but a repeatable screen test establishes that the interaction actually works.

## Use editor diagnostics as a second line of defense

UnityIDE includes UI Toolkit tooling, described on the [features page](/features/). Static diagnostics can help catch a misspelled query before running the scene. They cannot establish which dynamic visual tree your application will create in every state. Keep the runtime checks for the states your players can reach.
