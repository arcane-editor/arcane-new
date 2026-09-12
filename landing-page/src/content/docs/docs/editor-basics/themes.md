---
title: Themes
description: Switch the UnityIDE colour theme, and what each one is for.
---

UnityIDE ships six built-in themes and applies the one you pick across the whole
window at once — the shell, the editor, and the terminal.

## Switching Themes

Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows) and
type **Color Theme**.

Arrow through the list and each theme is applied live so you can see it on your own
code. Press `Enter` to keep the highlighted theme, or `Esc` to revert to the one you
started on.

There is no separate shortcut for the picker: `Cmd+Shift+T` is the standard
reopen-closed-tab binding, so the theme picker is palette-only.

## Built-in Themes

| Theme | Notes |
|-------|-------|
| **UnityIDE Dark** | The default. Near-black violet surfaces with a candle-gold accent. |
| **UnityIDE Light** | The same palette inverted, for bright rooms. |
| **Dark+ (Default Dark)** | Matches the Visual Studio Code default dark theme. |
| **Light+ (Default Light)** | Matches the Visual Studio Code default light theme. |
| **Dracula** | The standard Dracula palette. |
| **Monokai** | The standard Monokai palette. |

## The Default Theme

**UnityIDE Dark** follows one rule: colour means the tool resolved something. Greys
are what any editor can tell you about a Unity file; the accents mark what UnityIDE
worked out — a resolved type, a verified change, a value Unity silently reset. There
is no decorative tint, which is why the interface is so nearly monochrome until
something is actually understood.

Your choice is remembered between sessions.

## Installing More Themes

Not yet. The six above are the whole set — UnityIDE does not currently load
third-party or VS Code theme packages. If you want a specific palette,
[tell us](/feedback).
