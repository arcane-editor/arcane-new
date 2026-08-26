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

## Naming After The UnityIDE Rename

The product was called Arcane and shipped on arcaneai.org. Everything a user or
a crawler can see is now UnityIDE on unityide.app. Some names deliberately did
NOT change, and they are not oversights:

- **Cloudflare and repo resources** keep their original names because renaming
  them means recreating the resource or migrating data for zero user-visible
  gain: the workers `arcane-server` / `arcane-server-dev`, the D1 databases
  `arcane-db` / `arcane-db-dev` and their `arcane_db` binding, the R2 bucket
  `arcane-releases`, the AI gateways `arcane-ai-gateway*`, the Pages projects
  `arcane-landing*`, and the folders `arcane-server/` and `arcane-extension/`.
- **`JWT_ISSUER = 'arcane-server'`** and the OAuth cookie issuers stay because
  changing the issuer invalidates every live session token.
- **The Dodo metadata keys** `arcane_user_id` / `arcane_kind` / `arcane_ref`
  stay because they round-trip through a third party and appear in historical
  webhook payloads.
- **`LEGACY_*` constants and legacy aliases** are load-bearing compatibility, not
  leftovers: the pre-rename Unity package id, project files, config dir, theme
  ids, session plan key and deep-link schemes are all still read so an upgrade
  does not silently drop user state.

`node scripts/brand-audit.mjs` enforces this. It fails if any protected name's
occurrence count drifts, and lists whatever brand tokens remain. Run it after
any bulk edit that touches these strings; adjust a baseline only deliberately,
and say why in the commit.

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
