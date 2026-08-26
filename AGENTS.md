# UnityIDE Editor Monorepo

UnityIDE is a Unity-focused desktop IDE with supporting web, server, and Unity
integration packages. There is no root package script; run commands from the
package being changed.

## Repository Map

- `editor/` - Tauri v2 desktop app with React 19, TypeScript, Rust, Monaco,
  Zustand, and xterm.js.
- `arcane-server/` - Cloudflare Worker API built with Hono.
- `landing-page/` - Astro marketing and documentation site.
- `arcane-extension/` - Unity editor package and C# integration layer.
- `docs/` - Product designs, implementation plans, and operational notes.
- `scripts/` - Repository-level maintenance and release scripts.

## Mandatory Editor Instructions

Before inspecting or changing anything under `editor/`, read
`editor/CLAUDE.md` and treat it as mandatory. It documents deep-module import
boundaries, C# IntelliSense verification, ACP invariants, Tauri drag-and-drop
constraints, and native/JavaScript keybinding ownership.

For any completed editor change, run `bun run verify` from `editor/`. A
`SKIPPED` IntelliSense or ACP check is not a pass; report it as unverified.

## Package Commands

- Editor full verification: `bun run verify` from `editor/`.
- Editor focused tests: `bun test src` from `editor/`.
- Server verification: `bun run check:types` and `bun test` from
  `arcane-server/`.
- Landing page verification: `bun run build` and `bun test` from
  `landing-page/`.

Use Bun for JavaScript and TypeScript packages unless a package explicitly
documents another tool.

## Security And Operations

- Never read, print, commit, or overwrite `.env`, `.env.*`, `.dev.vars`, keys,
  tokens, or generated webhook-secret files unless the user explicitly asks.
- Treat production deploy commands and files containing `prod` or `production`
  as sensitive operations that require explicit confirmation.
- Keep generated dependencies, build output, `.wrangler/`, `.superpowers/`, and
  agent worktrees out of commits.
- Preserve unrelated worktree changes. Do not revert files you did not change.

## OpenCode

- Project MCP configuration lives in `opencode.json`; Dodo Payments remains
  project-scoped and authenticates through OpenCode OAuth.
- Global skills and MCP servers are configured under `~/.config/opencode/` and
  `~/.agents/skills/`; do not vendor them into this repository.
