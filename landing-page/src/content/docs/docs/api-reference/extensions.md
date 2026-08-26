---
title: Troubleshooting
description: Common issues and how to fix them.
---

## macOS won't open UnityIDE

**Symptom:** "UnityIDE cannot be opened because it is from an unidentified developer."

**Fix:** UnityIDE is not yet code-signed. See the [Installation guide](/docs/getting-started/installation/#macos-gatekeeper--unsigned-app-warning) for how to bypass Gatekeeper using right-click → Open, or via `xattr -cr /Applications/UnityIDE.app` in the terminal.

---

## The AI doesn't know about my scripts

**Symptom:** The AI gives generic answers or says it can't find a class that clearly exists.

**Fixes:**
1. Check the status bar for indexing state — wait for it to show "Complete"
2. If it's stuck on "Indexing..." for more than a few minutes, open the Command Palette and run **"UnityIDE: Reindex Project"**
3. Make sure you opened the Unity project's root folder (the one containing `Assets/`), not a subfolder

---

## Unity Editor isn't connecting

**Symptom:** The Play/Pause toolbar buttons are greyed out or show "Not connected".

**Fixes:**
1. Make sure the **UnityIDE Unity Plugin** is installed in your Unity project
2. Check that both UnityIDE and the Unity Editor are running on the same machine
3. Restart both UnityIDE and the Unity Editor
4. Check the Output panel in UnityIDE for IPC connection errors

---

## AI chat returns no response

**Symptom:** Sending a message does nothing, or the chat spins indefinitely.

**Fixes:**
1. Open **UnityIDE: Settings** and confirm your API key is entered correctly
2. Check you have credits remaining with your provider (OpenAI / Anthropic)
3. If using a custom server URL, make sure the server at that address is running
4. Check the browser developer tools console (Help → Toggle Developer Tools) for network errors

---

## Indexing completed but search results seem wrong

**Symptom:** `searchProject` returns unrelated results, or misses classes that exist.

**Fix:** Run **"UnityIDE: Reindex Project"** from the Command Palette to do a full rebuild. This clears and regenerates the entire knowledge graph from scratch.

---

## Editor feels slow after opening a large project

**Symptom:** Typing feels laggy during the initial indexing phase.

**Fix:** This is expected behavior during the first index build. Indexing runs in the background Node.js process and shouldn't block the UI significantly, but very large projects (10,000+ scripts) may take a couple of minutes. Performance returns to normal once indexing completes.
