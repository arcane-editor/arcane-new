---
title: Plugin Development
description: Develop plugins that extend ArcaneIDE's core functionality.
---

Plugins provide deeper integration than extensions, with access to internal APIs.

## Plugin vs Extension

| Feature | Extension | Plugin |
|---------|-----------|--------|
| Sandboxed | Yes | No |
| Internal API access | Limited | Full |
| Language | TypeScript | TypeScript/C++ |
| Distribution | Marketplace | Manual |

## Getting Started

```bash
arcane plugin init my-plugin
cd my-plugin
arcane plugin dev
```

## Plugin Lifecycle

Plugins implement `activate()` and `deactivate()` hooks that run when the plugin loads and unloads.
