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

- `csharp-ls` is the sole source of **semantic** C# intelligence: completions,
  hover, definitions, compiler diagnostics. The static Unity providers (API
  names, C# keywords) stand down once it has a project graph.
- Unity lifecycle snippets are a separate CompletionItemProvider, offered only
  at a bare member position — they expand to a whole declaration.
- Unity *inspections* come from two engines: the Roslyn analyzers running inside
  csharp-ls (`UNT` codes) and this app's own rules (`UNITY` codes). See below.
- The LSP client has crash detection (`lsp-exited` Tauri event) and auto-restart
  with document re-sync.
- Files opened before LSP starts get retroactive `didOpen` notifications when
  the LSP becomes ready.

## One URI, in both directions

**Never send `model.uri.toString()` to a language server.** Notifications
(`didOpen`/`didChange`) name a document with `fileUri(path)`; requests must name
it with `lspDocumentUri(model)` (`features/lsp/services/model-context.ts`),
which produces the identical string. `model.uri.toString()` stays the right key
for Monaco-internal maps — marker owners, pull timers, the ui-store — and never
crosses the wire.

This is not style. Monaco's renderer lower-cases a Windows drive letter and
percent-encodes its colon, so a model opened as `file:///C:/x/A.cs` renders as
`file:///c%3A/x/A.cs`. csharp-ls matched neither spelling to the other and
answered `null` to every completion, hover, definition, code action, inlay hint
and diagnostic pull — for months, on the platform most Unity developers use. It
looked like "IntelliSense mostly works" because Monaco's word-based suggestions
and the static Unity providers kept answering: members already spelled in the
open file appeared, and anything that had to come from Roslyn never did. macOS
paths have no drive letter, which is why it was invisible on the machine it was
written on.

A source scan in `file-uri-single-source.test.ts` forbids the shape returning.

## C# IntelliSense: verify it, every time

**Run `bun run verify` before reporting any change as done — including changes
that have nothing to do with C#, LSP, or Unity.** It runs tsc, the module-boundary
check, the JS and Rust suites, and `verify:intellisense`.

`bun run verify:intellisense` alone (~40s, including a cargo build) regenerates the project files through
the real Rust generator, starts the real `csharp-ls`, and asserts:

- the request URI equals the `didOpen` URI, before anything is sent;
- `Camera.` offers `main` and `allCameras` — static members come only from
  Roslyn, while instance members can appear as word-based suggestions even when
  the server is answering nothing at all;
- `transform.` offers the real Unity member list;
- three incremental `didChange` versions, then a completion reflecting the
  newest text;
- `completionItem/resolve` returns detail or documentation;
- a deliberate type error produces CS0029, and no CS0518/CS0433;
- the Unity analyzers report UNT0001, UNT0002 and UNT0004, and do NOT report
  CS0649 on a `[SerializeField]` field;
- the capabilities listed in `REQUIRED_CAPABILITIES` — the providers the
  editor registers, not every capability it consumes;
- latency budgets on the timed steps, printed every run.

It finds the Unity project itself (from the Unity Editor's own recent-projects
list) and provisions the pinned csharp-ls from the bundled package when it is
not installed yet — so a version bump cannot make the gate skip at the moment it
matters most.

**Why this is unconditional.** C# IntelliSense has been completely dead twice,
for long periods, while the entire suite stayed green. Both breaks shared two
properties, and both still hold:

1. **The break was environmental, not a code change.** Once when Unity stopped
   generating `.csproj` files; once when Monaco's URI formatting disagreed with
   the client's on one platform. No diff introduced either, so no amount of
   reviewing a diff could have caught them. Only probing the running server
   detects this class of failure.
2. **A skipped test looked identical to a passing one.** The Rust smoke tests
   were pinned to a path that had been deleted, so they returned early and
   reported success. The probe's own project list was macOS-only, so it printed
   SKIPPED on Windows — on the machine whose IntelliSense was dead.

So: when the check reports `SKIPPED`, that is **not** a pass — it means the
check did not run, and the claim "IntelliSense works" is unsupported. Say so
plainly rather than treating it as green. Set
`UNITYIDE_INTELLISENSE_E2E=required` to turn a skip into a failure,
`UNITYIDE_SMOKE_E2E=required` to do the same for the Rust smoke tests, and
`UNITYIDE_SMOKE_UNITY_PROJECT=<path>` to point either at a Unity project.

## Unity inspections: two engines, one division of labour

**Roslyn does semantics. The TypeScript rules do hot paths.**

`Microsoft.Unity.Analyzers` (43 diagnostics, 23 suppressors) runs inside
csharp-ls and reports what is semantically wrong *for Unity*: an empty
`Update()`, `tag == "Player"`, a message with the wrong signature. It has a real
parser and full type information, so where it and a local rule overlap, it wins
— a rule marks itself `supersededBy: ['UNT…']` and stands down.

It has **nothing** for "this is ruinous to call sixty times a second". That
family — `GetComponent` in `Update`, scene searches, per-frame allocation,
reflective messaging — is the entire reason `features/unity-analyzers` still
exists, and it is what a Unity developer actually notices in a profiler. Never
mark a hot-path rule superseded; a test in `rules/diagnostic-codes.test.ts`
fails if you do.

Four links in the analyzer chain fail silently, so each is asserted by the
probe:

| Link | Where | Failure mode |
|---|---|---|
| The package unpacks | `unity_analyzers.rs` | No inspections, no error |
| The csproj names it | `unity.rs` `<Analyzer Include>` | No inspections, no error |
| `WarningLevel` is not 0 | `unity.rs` | Roslyn **discards every analyzer diagnostic** above the project's warning level |
| `analyzersEnabled` is sent | `csharp-configuration.ts` | csharp-ls defaults it **off** |

Rules stand down only when the analyzers are *confirmed* live. That is three
conditions, not one — the csproj names the assembly (read back from the file
that was actually written), the user has not switched them off, and the server
is running — because each can stop holding without the others noticing. See
`roslynAnalyzersReporting`. A machine where the package failed to unpack, or a
user who unticks the setting, would otherwise lose those inspections from both
engines at once with nothing reported anywhere.

Two more rules of the same kind:

- **Diagnostic codes are user-facing.** People write
  `#pragma warning disable UNITY0201`, and quick fixes are looked up by code.
  Declare every code a rule emits in its `codes` field; never reuse a retired
  one (`RETIRED_CODES` in `rules/index.ts`). Five codes were once claimed by two
  rules each, so one suppression silenced two unrelated inspections.
- **A rule must not import a store, or another feature's barrel.** A Zustand
  store here reaches `@tauri-apps/api` and a feature barrel reaches Monaco and
  CSS, neither of which loads in a test — that is why thirteen rules had no
  coverage at all. Project knowledge arrives through `RuleContext`; shared
  tables live in `src/data/`.
- **A quick fix is derived from the diagnostic's range, so it is only correct
  while that range keeps its shape.** Check a new builder against the running
  analyzer, never against what looks natural: two shipped unreachable because
  their unit tests built the same wrong ranges by hand. The probe now feeds
  real diagnostics through the real builders.

csharp-ls does not surface the code fixes those analyzers ship (its code-action
handler reflects over three Roslyn assemblies and ignores the project's analyzer
references), so `unt-quick-fixes.ts` reimplements the safe ones client-side,
from the diagnostic's range alone.

The generator must never depend on Unity's `Assembly-CSharp*.csproj` again; it
derives its reference set from the Unity install (`unity.rs`,
`unity_install_references`). `csproj_is_complete_without_any_unity_generated_csproj`
is the hermetic regression test for that and needs no Unity installed.

## Two agent backends now, not one

The AI panel talks to either the hosted **UnityIDE** agent or an **external agent
over ACP** (Agent Client Protocol — JSON-RPC 2.0 as newline-delimited JSON over a
subprocess's stdio, the same idea as LSP but for agents). Claude Code is the only
external agent shipped, and it is gated on a paid plan.

Three rules keep this from turning into `selectedAgent === 'claude'` scattered
through the UI, which is what made the *previous* Claude integration expensive
enough to delete (`bce889d`):

1. **`getChatBackend()` (`ai-panel/services/chat-backend.ts`) is the only place
   that branches on the selected agent.** `ChatInput.handleSubmit` calls it;
   nothing else should need to know which agent is running. `getAgentService()`
   stays UnityIDE-only, for UnityIDE-only internals (plan controller, retry-turn,
   session restore).
2. **Meaning lives in `ai-panel`, transport lives in `features/acp`.** The `acp`
   feature owns the protocol, the process and the install, and imports nothing
   from `ai-panel` — the dependency runs one way (`ai-panel -> acp -> stores`).
   A mutual barrel import between two features is what broke app startup before.
3. **The agent describes itself; the UI renders what it is told.** Modes,
   models and effort arrive as ACP session config options and are rendered
   generically by `AgentConfigBar`. Do not hardcode Claude's mode or model ids —
   the last integration went stale exactly that way.

**Capabilities are feature switches, not descriptions.** `CLIENT_CAPABILITIES`
in `acp-translate.ts` is the single place they are declared, and dropping one
does not degrade a feature — it removes it, silently, with no error on either
side:

| Capability | What disappears without it |
|---|---|
| `elicitation.form` | Claude puts `AskUserQuestion` on its **disallowed-tools** list. The model stops asking and starts guessing. |
| `session.configOptions.boolean` | Boolean settings (Fast mode) degrade to a two-value select. |
| `fs` | The agent writes to disk directly, so edits land with no checkpoint and "restore this turn" stops working for its turns. |
| `auth.terminal` | No terminal sign-in method is offered, so a signed-out user has no way in. |

`acp-translate.test.ts` guards each one, and `verify:acp` proves the boolean
capability took effect by asserting `fast` comes back typed as a boolean rather
than as a select.

**The external agent is not driven like the UnityIDE one.** It runs its own loop,
its own tools and its own permission modes, so UnityIDE deliberately does NOT
wrap it in the UnityIDE agent's policy (see
`docs/superpowers/specs/2026-08-22-external-agent-autonomy-design.md`):

- **Reads are unconfined; writes stay inside the workspace** (`acp-fs.ts`,
  `computeExternalAgentWriteRoots`). The old read sandbox narrowed a Unity
  project to `Assets/` while `acp-terminals.ts` handed the same agent an
  unconfined shell — it caged the legible path and left the illegible one open.
  Do not "restore" that check without also sandboxing the terminal.
- **Writes get a checkpoint but no review row.** `recordPreWrite` stays (it
  records bytes, and per-turn restore is built on it); `useEditReviewStore` is
  gone (it is a workflow built for the UnityIDE agent's `auto` apply mode).
- **`session/request_permission` is the AGENT asking**, governed by its own
  `mode` config option. Render it; never add a second UnityIDE-side prompt on the
  same edit.
- **UnityIDE-only chrome is gated on the active agent.** `planPhase`,
  `activePlanPath` and `PlanActions` belong to UnityIDE's plan controller; an
  external agent never sets them, so switching agents mid-thread used to leave
  an Execute/Regenerate card under a Claude header.

One related trap in the same request family: `session/set_config_option` is a
discriminated union, and a boolean value **must** carry `type: 'boolean'`.
Without the tag the agent validates against the string variant and answers
`-32602`, so the toggle silently never applies. Build the payload with
`configOptionPayload()`.

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
pass** — set `UNITYIDE_ACP_E2E=required` to turn a skip into a failure, and
`UNITYIDE_ACP_ADAPTER=<path to dist/index.js>` to point it at an adapter outside
the managed install.

## Drag and drop: HTML5 DnD does not work here

`dragstart` never fires anywhere in this app. Tauri installs a native drag-drop
handler on the webview (`dragDropEnabled`, default **true**, never set in
`tauri.conf.json`), and `tauri-runtime-wry`'s handler returns `true`
unconditionally. On macOS wry only forwards a drag to WKWebView's own handling
when that listener returns `false`:

```rust
if !listener(DragDropEvent::Enter { .. }) {
  msg_send![super(this), draggingEntered: drag_info]   // OS default → HTML5 DnD
} else {
  NSDragOperation::Copy                                 // intercepted
}
```

So there are two separate mechanisms, and neither is HTML5 DnD:

| Drag | Mechanism |
|---|---|
| In-app (tab reorder, tab/tree → AI panel) | `utils/pointer-drag.ts` — pointer events, `data-drop-zone`, a `window` drop event |
| OS / Finder file drop | Tauri `onDragDropEvent` in `App.tsx`, hit-tested by coordinate (`utils/drop-point.ts`) |

**Do not add `draggable` / `onDragStart` / `onDrop` handlers.** They compile,
they look right in review, and they never run. Tab reorder and drag-to-context
both shipped this way and were dead from the first commit — for months, behind
comments that asserted in-webview drags were "unaffected by Tauri's native
interception". They are not.

Turning `dragDropEnabled` off would revive HTML5 DnD, but `onDragDropEvent`
would stop firing and macOS `File` objects carry no filesystem path — so it
trades the terminal drop, the explorer copy-drop and Finder → chat for the
in-app ones. Not a fix.

## Keybindings: always check both sides

A keyboard chord can be owned in **two independent places**, and changing one does not change the other:

1. The JS command registry (`App.tsx`), bound at the document level by `KeyboardShortcutManager` and bridged into Monaco by `bind-shortcuts.ts`.
2. The **native macOS menu** (`src-tauri/src/menu.rs`), whose accelerators are registered with the OS. `handle_menu_event` emits the menu item's **id** and the frontend runs `executeCommand(id)` on it directly — bypassing the keybinding lookup entirely.

On macOS the native menu wins. So moving a chord in `App.tsx` without updating `menu.rs` leaves the old command answering it, and can leave the new command with no chord at all.

**When you add, move, or remove a keybinding, grep `src-tauri/src/menu.rs` for the chord and the command id.** This is not hypothetical: `mod+j` was moved to `terminal.toggle` while `menu.rs` still bound `CmdOrCtrl+J` to `view.toggleBottomPanel`, which survived a full green suite and eleven review passes because every one of them was scoped to the JS diff.

Two related traps in the same area:

- `COMMANDS_TO_SKIP_SHELL` (`skip-shell.ts`) only decides whether an **app command fires** while a terminal has focus. It does **not** stop xterm sending the byte to the PTY — only a branch in `TerminalInstance`'s `attachCustomKeyEventHandler` does that. Both are needed to take a chord away from the shell.
- React attaches its listeners to `#root`, **below** the `document` listener react-hotkeys-hook uses. Any `e.stopPropagation()` in a React `onKeyDown` therefore kills every app hotkey for as long as that element has focus.
