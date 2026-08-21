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

## C# IntelliSense: verify it, every time

**Run `bun run verify` before reporting any change as done — including changes
that have nothing to do with C#, LSP, or Unity.** It runs tsc, the module-boundary
check, the JS and Rust suites, and `verify:intellisense`.

`bun run verify:intellisense` alone (~8s) regenerates the project files through
the real Rust generator, starts the real `csharp-ls`, and asserts it answers
`transform.` with the real Unity member list and resolves hover on
`MonoBehaviour`. It exits non-zero if IntelliSense is dead.

**Why this is unconditional.** C# IntelliSense was completely broken for an
unknown period — every hover, completion and code action returning `null` —
while the entire test suite stayed green. Two properties made that possible and
both still hold:

1. **The break was environmental, not a code change.** Unity stops generating
   `.csproj` files once Arcane is registered as its external script editor, and
   the generator used to read its Unity DLL paths out of those files. No diff
   introduced the bug, so no amount of reviewing a diff could have caught it.
   Only probing the running server detects this class of failure.
2. **A skipped test looked identical to a passing one.** The Rust smoke tests
   were pinned to a project path that had been deleted, so they returned early
   and reported success.

So: when the check reports `SKIPPED`, that is **not** a pass — it means the
check did not run, and the claim "IntelliSense works" is unsupported. Say so
plainly rather than treating it as green. Set
`ARCANE_INTELLISENSE_E2E=required` to turn a skip into a failure, and
`ARCANE_SMOKE_UNITY_PROJECT=<path>` to point it at a Unity project.

The generator must never depend on Unity's `Assembly-CSharp*.csproj` again; it
derives its reference set from the Unity install (`unity.rs`,
`unity_install_references`). `csproj_is_complete_without_any_unity_generated_csproj`
is the hermetic regression test for that and needs no Unity installed.

## Two agent backends now, not one

The AI panel talks to either the hosted **Arcane** agent or an **external agent
over ACP** (Agent Client Protocol — JSON-RPC 2.0 as newline-delimited JSON over a
subprocess's stdio, the same idea as LSP but for agents). Claude Code is the only
external agent shipped, and it is gated on a paid plan.

Three rules keep this from turning into `selectedAgent === 'claude'` scattered
through the UI, which is what made the *previous* Claude integration expensive
enough to delete (`bce889d`):

1. **`getChatBackend()` (`ai-panel/services/chat-backend.ts`) is the only place
   that branches on the selected agent.** `ChatInput.handleSubmit` calls it;
   nothing else should need to know which agent is running. `getAgentService()`
   stays Arcane-only, for Arcane-only internals (plan controller, retry-turn,
   session restore).
2. **Meaning lives in `ai-panel`, transport lives in `features/acp`.** The `acp`
   feature owns the protocol, the process and the install, and imports nothing
   from `ai-panel` — the dependency runs one way (`ai-panel -> acp -> stores`).
   A mutual barrel import between two features is what broke app startup before.
3. **The agent describes itself; the UI renders what it is told.** Modes,
   models and effort arrive as ACP session config options and are rendered
   generically by `AgentConfigBar`. Do not hardcode Claude's mode or model ids —
   the last integration went stale exactly that way.

Debugging: every line in both directions is written to the trace file returned by
the `acp_trace_path` command (`->` sent, `<-` received, `!!` error), the same
convention as `lsp.rs`. A protocol this chatty is undebuggable without it.

**Run `bun run verify:acp` when you touch any of this.** It spawns the real
`@agentclientprotocol/claude-agent-acp`, runs `initialize` + `session/new` and
asserts the capabilities the editor depends on. It is the same class of check as
`verify:intellisense` and exists for the same reason: every failure this
integration has in the field is environmental (Node too old, half-finished
install, renamed package, expired login, protocol bump), and none of those appear
in a diff or break a mocked test. As with IntelliSense, **a `SKIPPED` is not a
pass** — set `ARCANE_ACP_E2E=required` to turn a skip into a failure, and
`ARCANE_ACP_ADAPTER=<path to dist/index.js>` to point it at an adapter outside
the managed install.

## Keybindings: always check both sides

A keyboard chord can be owned in **two independent places**, and changing one does not change the other:

1. The JS command registry (`App.tsx`), bound at the document level by `KeyboardShortcutManager` and bridged into Monaco by `bind-shortcuts.ts`.
2. The **native macOS menu** (`src-tauri/src/menu.rs`), whose accelerators are registered with the OS. `handle_menu_event` emits the menu item's **id** and the frontend runs `executeCommand(id)` on it directly — bypassing the keybinding lookup entirely.

On macOS the native menu wins. So moving a chord in `App.tsx` without updating `menu.rs` leaves the old command answering it, and can leave the new command with no chord at all.

**When you add, move, or remove a keybinding, grep `src-tauri/src/menu.rs` for the chord and the command id.** This is not hypothetical: `mod+j` was moved to `terminal.toggle` while `menu.rs` still bound `CmdOrCtrl+J` to `view.toggleBottomPanel`, which survived a full green suite and eleven review passes because every one of them was scoped to the JS diff.

Two related traps in the same area:

- `COMMANDS_TO_SKIP_SHELL` (`skip-shell.ts`) only decides whether an **app command fires** while a terminal has focus. It does **not** stop xterm sending the byte to the PTY — only a branch in `TerminalInstance`'s `attachCustomKeyEventHandler` does that. Both are needed to take a chord away from the shell.
- React attaches its listeners to `#root`, **below** the `document` listener react-hotkeys-hook uses. Any `e.stopPropagation()` in a React `onKeyDown` therefore kills every app hotkey for as long as that element has focus.
