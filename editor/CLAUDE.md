# Editor - VS Code-like IDE

Tauri v2 desktop app with React 19 frontend, Rust backend, Monaco Editor, and integrated terminal.

## Architecture: Deep Modules

This project follows a **Deep Modules** architecture. Every feature is self-contained and exposes only a public API via its `index.ts` barrel file.

### Directory Structure

```
src/
  features/       # Self-contained feature modules
    editor/       # Monaco editor rendering + TS config
    lsp/          # Language Server Protocol client + providers
    terminal/     # Integrated terminal (xterm.js)
    git/          # Git/source control UI
    explorer/     # File tree browser
    theme/        # Theme system (definitions, registry, application)
  stores/         # All Zustand stores (workspace, ui, terminal, git, theme)
  components/     # Shared layout/UI components
  hooks/          # Shared React hooks
  utils/          # Shared utilities
  types/          # Shared TypeScript interfaces
```

### Rules

1. **Import features ONLY via `index.ts`:**
   ```typescript
   import { lspClient } from '../features/lsp';          // ALLOWED
   import { LspClient } from '../features/lsp/services/client'; // FORBIDDEN
   ```

2. **No feature imports another feature's internal files.** Only the barrel export.

3. **Stores are centralized** in `stores/` and can be imported by any feature or component.

4. **Shared folders** (`components/`, `hooks/`, `utils/`, `types/`) can be imported by anyone.

5. **Feature-internal code stays internal.** Components, hooks, and services inside a feature folder must not be imported from outside that feature.

### Adding a New Feature

1. Create `src/features/<name>/index.ts`
2. Put components in `src/features/<name>/components/`
3. Put services in `src/features/<name>/services/`
4. Export only the public API from `index.ts`
5. If the feature needs shared state, add a store in `src/stores/`

## Tech Stack

- **Runtime:** Tauri v2 (Rust backend)
- **Frontend:** React 19, TypeScript, Vite
- **Editor:** Monaco Editor via `@monaco-editor/react`
- **State:** Zustand
- **LSP:** `csharp-ls` (Roslyn-based C# language server) spawned by Rust backend
- **Terminal:** xterm.js with Tauri PTY backend
- **Package Manager:** Bun

## Key Patterns

- The LSP server (`csharp-ls`) is the sole source of diagnostics, completions, hover, and other IntelliSense features for C#.
- Unity lifecycle method snippets are provided as a separate CompletionItemProvider alongside LSP completions.
- The LSP client has crash detection (`lsp-exited` Tauri event) and auto-restart with document re-sync.
- Files opened before LSP starts get retroactive `didOpen` notifications when the LSP becomes ready.

## Keybindings: always check both sides

A keyboard chord can be owned in **two independent places**, and changing one does not change the other:

1. The JS command registry (`App.tsx`), bound at the document level by `KeyboardShortcutManager` and bridged into Monaco by `bind-shortcuts.ts`.
2. The **native macOS menu** (`src-tauri/src/menu.rs`), whose accelerators are registered with the OS. `handle_menu_event` emits the menu item's **id** and the frontend runs `executeCommand(id)` on it directly — bypassing the keybinding lookup entirely.

On macOS the native menu wins. So moving a chord in `App.tsx` without updating `menu.rs` leaves the old command answering it, and can leave the new command with no chord at all.

**When you add, move, or remove a keybinding, grep `src-tauri/src/menu.rs` for the chord and the command id.** This is not hypothetical: `mod+j` was moved to `terminal.toggle` while `menu.rs` still bound `CmdOrCtrl+J` to `view.toggleBottomPanel`, which survived a full green suite and eleven review passes because every one of them was scoped to the JS diff.

Two related traps in the same area:

- `COMMANDS_TO_SKIP_SHELL` (`skip-shell.ts`) only decides whether an **app command fires** while a terminal has focus. It does **not** stop xterm sending the byte to the PTY — only a branch in `TerminalInstance`'s `attachCustomKeyEventHandler` does that. Both are needed to take a chord away from the shell.
- React attaches its listeners to `#root`, **below** the `document` listener react-hotkeys-hook uses. Any `e.stopPropagation()` in a React `onKeyDown` therefore kills every app hotkey for as long as that element has focus.
