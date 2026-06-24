---
title: AI Chat Modes
description: Understand Agent, Ask, and Plan modes — and how to choose between them.
---

The AI in ArcaneIDE operates through a **chat panel** on the right side of the editor. It can answer questions, navigate your codebase, write code, run commands, and control the Unity Editor.

## Three Modes

You can switch modes from the mode selector in the chat panel.

### Agent Mode

The AI has full autonomy. It can:
- Read and write any file in `Assets/`
- Run shell commands (dotnet build, git, etc.)
- Execute Unity play/stop commands

Use Agent mode when you want the AI to actually implement something end-to-end. It will ask for confirmation on destructive actions.

### Ask Mode

Read-only. The AI can explore your codebase and answer questions, but cannot modify files or run commands. Good for understanding code without risk of changes.

### Plan Mode

The AI first creates a step-by-step plan, then executes each step. During the planning phase it's read-only. Once the plan is approved, it switches to full tool access for execution.

Use Plan mode for large, multi-file changes where you want to review the approach before anything is touched.

## Reasoning Levels

Inside the chat panel you can also select a **reasoning level**, which controls how much thinking the model does before responding:

| Level | Speed | Best for |
|-------|-------|----------|
| **Low** | Fastest | Quick questions, simple edits |
| **Mid** | Balanced | Most everyday tasks |
| **High** | Slower | Complex logic, architecture questions |
| **Super** | Slowest | Available in Plan mode only — used for the planning phase of large refactors |

Higher reasoning levels use more tokens but produce more accurate, well-considered responses.

## Unity Context

The AI automatically has access to:
- **Recent Unity console output** — errors, warnings, and logs from the last session
- **Project overview** — script count, scene list, asset statistics
- **Unity API reference** — embedded documentation for common Unity classes

This context is injected automatically — you don't need to paste it in manually.
