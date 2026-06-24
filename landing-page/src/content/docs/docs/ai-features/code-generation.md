---
title: Settings & Configuration
description: Configure API keys, model selection, and other ArcaneIDE settings.
---

## Opening Settings

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and search for **"Arcane: Settings"**. The settings panel opens in a tab.

## API Keys

ArcaneIDE supports two AI providers. You need at least one API key.

| Provider | Where to get a key |
|----------|--------------------|
| **OpenAI** | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com/) |

Enter your key in the Settings panel. Keys are stored locally on your machine and never sent anywhere except the provider's API.

## Model Selection

You can select which model powers the AI chat. Available options depend on which API keys you've configured.

The default model is chosen automatically based on the current reasoning level. You can pin a specific model with the **Explicit Model Override** toggle.

## Server URL

By default, ArcaneIDE connects to a local LLM gateway server at `http://localhost:3001`. If you're running the Arcane server yourself (e.g. for shared team use), update this URL to point to your instance.

Leave this at the default if you're using API keys directly.

## Project Indexing

| Action | What it does |
|--------|-------------|
| **Reindex Project** | Clears the knowledge graph and rebuilds it from scratch |
| **Clear Index** | Wipes the index without rebuilding (useful for troubleshooting) |

Use **Reindex Project** after large merges or if the AI seems unaware of recent changes.
