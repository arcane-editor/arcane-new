# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Language servers

The editor delegates IntelliSense (completion, hover, diagnostics, go-to-definition,
references, signature help) to standalone LSP servers. Each one is spawned by the
Rust backend on demand — C# eagerly when a workspace opens, Python and TypeScript/
JavaScript lazily when the first file of that language is opened.

The servers are **not** bundled. Install whichever languages you use:

| Language | Server | Install |
|---|---|---|
| C# (Unity) | [`csharp-ls`](https://github.com/razzmatazz/csharp-language-server) | `dotnet tool install -g csharp-ls` |
| Python | [`pyright`](https://github.com/microsoft/pyright) | `npm install -g pyright` |
| TypeScript / JavaScript | [`typescript-language-server`](https://github.com/typescript-language-server/typescript-language-server) | `npm install -g typescript-language-server typescript` |

If a server isn't installed when you open a file in that language, the editor
will still load with Monaco's syntax highlighting and surface a one-time
"Pyright not found — install with: …" notification. Once installed, run
**Restart LSP** from the status bar (or reload the workspace) to retry.

The `typescript-language-server` instance handles `.ts`, `.tsx`, `.js`, `.jsx`,
`.mts`, and `.cts` from a single process.

LSP traffic is logged to `~/Library/Caches/editor-unityide/lsp-trace.log`
(macOS) / `~/.cache/editor-unityide/lsp-trace.log` (Linux); each line is
prefixed with the language so multi-language sessions stay readable.
Click the LSP status indicator to open the trace in your default viewer.

## Distribution (macOS)

Builds are **ad-hoc signed** — no paid Apple Developer account required.
Sharing the `.dmg` with another Mac works, but the recipient needs a
one-line `xattr` command to clear macOS's quarantine attribute before the
app will open. See [DISTRIBUTION.md](./DISTRIBUTION.md) for the full
recipient and sender instructions, plus the upgrade path to Developer ID
+ notarization if you want frictionless distribution.
