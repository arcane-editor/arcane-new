---
title: Scripting Hooks
description: Hook into UnityIDE events with the scripting API.
---

Scripting hooks let you automate tasks and respond to editor events.

## Available Hooks

- `onFileOpen(callback)` — Fires when a file is opened
- `onFileSave(callback)` — Fires before a file is saved
- `onBuildStart(callback)` — Fires when a Unity build begins
- `onBuildComplete(callback)` — Fires when a build finishes
- `onError(callback)` — Fires when a compilation error occurs

## Example

```typescript
import { hooks } from '@unityide/api';

hooks.onFileSave(async (file) => {
  console.log(`Saving ${file.path}`);
  // Run custom formatting or validation
});
```

## Configuration

Hooks can be registered in your extension's `activate()` function or in a project-level `.unityide/hooks.ts` file.
