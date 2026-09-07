---
title: Keybindings
description: Default keyboard shortcuts for UnityIDE, including AI and Unity-specific controls.
---

UnityIDE is keyboard-first. The chords below follow VS Code wherever VS Code has
one, and everything the AI panel does is two keys.

Press `Ctrl+?` (`⌘?` on macOS) at any time for the full, searchable list — it is
generated from the running app, so it is never out of date with this page.

## AI

| Action | macOS | Windows/Linux |
|--------|-------|--------------|
| Open AI panel | `⌘L` | `Ctrl+L` |
| New chat | `⌘I` | `Ctrl+I` |
| Chat history | `⌘⇧H` | `Ctrl+Shift+H` |
| Maximize AI panel | `⌘⇧⏎` | `Ctrl+Shift+Enter` |
| Cycle mode (Ask / Agent / Plan) | `⌘M` | `Ctrl+M` |
| Cycle reasoning effort | `⌘D` | `Ctrl+D` |

Mode and effort are only live while the caret is in the chat box, so they never
take those keys away from the editor.

## General

| Action | macOS | Windows/Linux |
|--------|-------|--------------|
| Command Palette | `⌘⇧P` or `F1` | `Ctrl+Shift+P` or `F1` |
| Quick Open (files) | `⌘P` | `Ctrl+P` |
| Go to Symbol in Project | `⌘T` | `Ctrl+T` |
| Go to Symbol in File | `⌘⇧O` | `Ctrl+Shift+O` |
| Go to Line | `⌘G` | `Ctrl+G` |
| Keyboard Shortcuts | `⌘⇧/` | `Ctrl+Shift+/` |
| Settings | `⌘,` | `Ctrl+,` |
| Save | `⌘S` | `Ctrl+S` |
| New File | `⌘N` | `Ctrl+N` |
| Open Folder | `⌘O` | `Ctrl+O` |

Find (`⌘F` / `Ctrl+F`), Replace (`⌘⌥F` / `Ctrl+H`), Go to Definition (`F12`) and
Find References (`⇧F12`) are the editor's own and behave as they do in VS Code.

## Views and layout

| Action | macOS | Windows/Linux |
|--------|-------|--------------|
| Toggle left sidebar | `⌘B` | `Ctrl+B` |
| Toggle right sidebar | `⌘K` | `Ctrl+K` |
| Toggle terminal | `⌘J` or `` ⌘` `` | `Ctrl+J` or `` Ctrl+` `` |
| Maximize bottom panel | `⌘⇧J` | `Ctrl+Shift+J` |
| Explorer | `⌘⇧E` | `Ctrl+Shift+E` |
| Search in Files | `⌘⇧F` | `Ctrl+Shift+F` |
| Source Control | `⌘⇧G` | `Ctrl+Shift+G` |
| Run and Debug | `⌘⇧D` | `Ctrl+Shift+D` |
| Unity Hierarchy | `⌘⇧Y` | `Ctrl+Shift+Y` |
| Unity Tests | `⌘⇧U` | `Ctrl+Shift+U` |
| Zoom in / out / reset | `⌘=` / `⌘-` / `⌘0` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |

## Tabs

| Action | macOS | Windows/Linux |
|--------|-------|--------------|
| Next / previous tab | `⌘PgDn` / `⌘PgUp` | `Ctrl+PgDn` / `Ctrl+PgUp` |
| Go to tab 1–9 | `⌘1`–`⌘9` | `Ctrl+1`–`Ctrl+9` |
| Close tab | `⌘W` | `Ctrl+W` |
| Close all tabs | `⌘⇧W` | `Ctrl+Shift+W` |
| Reopen closed tab | `⌘⇧T` | `Ctrl+Shift+T` |

## Terminal

| Action | macOS | Windows/Linux |
|--------|-------|--------------|
| New terminal | `` ⌘⇧` `` | `` Ctrl+Shift+` `` |
| Split terminal | `⌘\` | `Ctrl+\` |
| Focus next / previous pane | `⌘⇧]` / `⌘⇧[` | `Ctrl+Shift+]` / `Ctrl+Shift+[` |
| Copy / paste | `⌘C` / `⌘V` | `Ctrl+Shift+C` / `Ctrl+Shift+V` |

While a terminal has focus the shell keeps its own control characters — `Ctrl+L`
clears the screen rather than opening the AI panel, `Ctrl+C` interrupts, and so
on. The terminal-management chords above are the exception and always reach the
app.

## Search

These apply to a Search tab.

| Action | Shortcut |
|--------|----------|
| Match case | `Alt+C` |
| Match whole word | `Alt+W` |
| Use regular expression | `Alt+R` |

## Unity Controls

These send commands straight to the connected Unity Editor over IPC, and are
active whenever a Unity project is open.

| Action | Shortcut |
|--------|----------|
| Play | `F5` |
| Pause | `F6` |
| Step frame | `F7` |
| Stop | `Shift+F5` |

The Unity toolbar buttons in the top bar do the same thing if you prefer
clicking.

## Editing

| Action | macOS | Windows/Linux |
|--------|-------|--------------|
| Format document | `⇧⌥F` | `Shift+Alt+F` |
| Refactor this | `⌘⇧R` | `Ctrl+Shift+R` |
| Reveal active file in Explorer | `⇧⌥R` | `Shift+Alt+R` |
| Switch branch | `⌘⇧B` | `Ctrl+Shift+B` |
