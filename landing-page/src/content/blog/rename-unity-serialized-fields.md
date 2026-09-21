---
title: "Rename Unity serialized fields without losing saved values"
description: "Use FormerlySerializedAs for a field-name change, verify a non-default asset value, and separate Editor asset migration from runtime save-data migration."
topic: "Serialized data"
author: { name: "UnityIDE team", url: "/about/" }
draft: true
researchedAt: 2026-09-21
verification:
  status: pending
  summary: "An executable asset-import fixture accompanies this guide. Publication is held until Unity verifies that an old field key preserves its value and reserializes under the new key."
testedVersions: []
sources:
  - title: "Unity: FormerlySerializedAsAttribute"
    url: "https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Serialization.FormerlySerializedAsAttribute.html"
    accessedAt: 2026-09-21
  - title: "Unity: Serialization rules"
    url: "https://docs.unity3d.com/6000.0/Documentation/Manual/script-serialization-rules.html"
    accessedAt: 2026-09-21
  - title: "Unity: How Unity uses serialization"
    url: "https://docs.unity3d.com/6000.0/Documentation/Manual/script-serialization-how-unity-uses.html"
    accessedAt: 2026-09-21
related:
  - { collection: blog, id: unity-prefab-merge-conflicts }
  - { collection: comparisons, id: rider }
---

A field rename has two audiences: C# code that refers to the field and existing assets that saved data under its old name. Updating every C# reference does not, on its own, demonstrate that an asset retained its value.

For a serialized field-name change, Unity provides [`FormerlySerializedAs`](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Serialization.FormerlySerializedAsAttribute.html). The attribute records the old name on the new field. This is a Unity serialization mechanism; it does not require a particular IDE.

## Start with a value that will reveal a failed migration

Use a disposable project or a clean version-control branch. Create `WeaponStats.cs`:

```csharp
using UnityEngine;

[CreateAssetMenu(menuName = "Examples/Weapon stats")]
public class WeaponStats : ScriptableObject
{
    public int oldDamage;
}
```

Create one asset from this menu, set `oldDamage` to **73**, and save it. Record the asset path and value. A nonzero value is deliberate: a field reset to its default should be obvious. Using a default value such as zero would make the same mistake harder to see.

Commit or otherwise preserve the original script and asset together. Do not carry out the experiment on the only copy of a production balance database.

## Apply the new name and keep the old serialized name

Change the field declaration while preserving its type:

```csharp
using UnityEngine;
using UnityEngine.Serialization;

[CreateAssetMenu(menuName = "Examples/Weapon stats")]
public class WeaponStats : ScriptableObject
{
    [FormerlySerializedAs("oldDamage")]
    public int damage;
}
```

Update code references to use `damage`. The string inside the attribute must remain the **old** name. Let Unity compile and reimport the asset, then inspect the value. For this example, the acceptance condition is still 73—not merely a successful compile.

For private fields, maintain the appropriate serialization attribute as well. A rename cannot make an unsupported type or a nonserialized field persist; consult Unity's [serialization rules](https://docs.unity3d.com/6000.0/Documentation/Manual/script-serialization-rules.html) before treating a missing value as a rename bug.

## Verify the asset, then verify the project

The narrow example has three checks:

1. The starting asset contains a non-default saved value.
2. Unity loads that value into the renamed field.
3. Saving or reserializing the asset retains the value under the current field name.

For a real project, build a migration inventory. Include standalone ScriptableObjects, scenes, prefabs, prefab variants, and assets that are not normally opened during a quick test. Inspect representative overrides and run the gameplay checks that use the field. A single successful asset demonstrates the mechanism, not complete project coverage.

Review the diff for unexpected unrelated changes. Avoid removing the compatibility attribute immediately just because one asset now uses the new name: another branch or unopened asset may still carry the old key. Decide when to remove it only after your project's migration coverage is understood.

## Keep the migration narrow

Do not combine this first check with changing the field's type, moving data between classes, or redesigning an inheritance hierarchy. Isolating a name change makes a failure diagnosable. Once the rename is verified, handle any data transformation as its own migration with its own expected output.

This guide also does not establish a migration for JSON saves already installed on players' devices. Unity documents differences between Editor and runtime serialization, including `FormerlySerializedAs` support, in [How Unity uses serialization](https://docs.unity3d.com/6000.0/Documentation/Manual/script-serialization-how-unity-uses.html). Test your save format's migration explicitly instead of assuming an Editor asset check covers it.

## If values have already reset

Stop saving affected assets while you investigate. Compare the script and serialized asset with a known-good revision. Determine whether the old key and original value are still available. The attribute can map an old name; it cannot reconstruct a value that has already been overwritten and is absent from every backup.

Restore the relevant known-good data in a controlled branch, apply the attribute, and repeat the non-default-value check. Have another developer review the resulting asset changes before merging a large migration.

UnityIDE's serialized-asset tools can make inspection more convenient, but they do not replace this evidence. The useful outcome is a verified preserved value in Unity, regardless of which editor performed the rename.
