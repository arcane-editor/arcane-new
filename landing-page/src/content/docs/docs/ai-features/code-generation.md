---
title: Settings & Configuration
description: Where UnityIDE's settings live, and what the AI and Unity options do.
---

## Opening Settings

Press `Cmd+,` (macOS) or `Ctrl+,` (Windows), or open the Command Palette
(`Cmd+Shift+P` / `Ctrl+Shift+P`) and search for **Open Settings**.

Settings are grouped into five categories — **Editor**, **Terminal**, **AI**,
**Unity** and **Updates** — plus an **Account** pane.

## AI Access

You do not need an OpenAI or Anthropic API key. AI runs through your UnityIDE
account: sign in from the **Account** pane and your plan's usage is applied
automatically. The free plan includes a one-time AI trial; paid plans add monthly
usage and the larger reasoning models. See [pricing](/pricing) for the tiers, or
manage your plan from your [account page](/account).

Model choice is not a setting. UnityIDE picks the model from your plan and the
reasoning effort you select in the chat — press `Cmd+D` / `Ctrl+D` to cycle
reasoning effort, and `Cmd+M` / `Ctrl+M` to cycle between Ask, Agent and Plan
mode. See [AI Chat Modes](/docs/ai-features/autocompletion/).

## AI Settings

| Setting | What it does |
|---------|--------------|
| **Inline suggestions (Tab)** | Ghost-text code suggestions as you type. Accept with `Tab`. |
| **Checkpoints** | Snapshots files before the AI writes to them, so you can restore a turn — and everything after it — from the chat timeline. |
| **Repair-Triggered Escalation** | When the agent needs two or more compile or analyzer repairs in one send, it escalates to a stronger model for the rest of that send. |
| **Apply Mode** | *Auto* (default): edits apply immediately and enter Accept/Reject review in the chat. *Approve*: review a diff and click Apply before any edit reaches disk. |
| **Always Approve Unity Serialized Assets** | Prompts before writing to `.unity`, `.prefab`, `.asset`, `.mat`, `.controller` or `.anim` even in Auto mode. Scene and prefab data is never touched silently. |

## Unity Settings

The **Unity** category is the largest, and it is where the verification behaviour
lives — the analyzers, the compile and language-server gates the agent must pass
before it reports success, the console check and auto-repair, and the diagnostics
for serialization, the Input System, UI Toolkit and assembly definitions. Each one
can be turned off individually.

See [Unity Editor Connection](/docs/unity-integration/scene-inspector/) for what
the bridge itself does.
