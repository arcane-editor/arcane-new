# Phase 1: Dev Environment + CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A complete Cloudflare dev environment (dev API at `api-dev.arcaneai.org`, dev site at `dev.arcaneai.org`, side-by-side "Arcane Dev" app builds) with CI workflows, so website→API→app can be tested end-to-end without touching prod.

**Architecture:** Additive only — prod behavior unchanged. A `[env.dev]` wrangler environment (own D1, own AI Gateway, shared Vectorize), a single editor config module fed by Vite mode env files, a Tauri `--config` JSON-merge overlay for the dev app identity, and three new GitHub workflows triggered by the long-lived `dev` branch. Spec: `docs/superpowers/specs/2026-07-18-dev-env-and-website-auth-design.md` (Part A).

**Tech Stack:** Cloudflare Workers/D1/Pages/R2 (wrangler v4), Tauri v2 (Rust), Vite 7 env files, GitHub Actions, bun (editor) / npm (arcane-server) / pnpm 9 (landing-page).

## Global Constraints

- Prod URLs are the **code fallbacks** everywhere (`https://api.arcaneai.org`, `https://arcaneai.org`) — a build with missing env vars fails safe to prod.
- Dev URLs: API `https://api-dev.arcaneai.org`, website `https://dev.arcaneai.org`.
- Committed `.env.development` / `.env.production` files may contain **public URLs only** — never secrets. `editor/.env` (contains a secret) stays gitignored and untouched.
- CI gotchas (from release.yml, apply to dev-build.yml too): `actions/setup-node@v4` node 22 pin; `CI= bun run build:lsp-sidecars`; `bunx tauri build` never `bun run tauri`; `NODE_OPTIONS: --max-old-space-size=4096`; `defaults.run.shell: bash`.
- Wrangler named envs do NOT inherit bindings/vars; `routes` IS inherited → `[env.dev]` must declare its own `routes`.
- Dev worker gets a DIFFERENT `JWT_SECRET` than prod (tokens must not cross environments).
- Editor deep-modules rules: features import shared code from `src/config/` (new shared folder, like `src/utils/`); run `bun run check:modules` after import changes.
- All work lands on the `dev` branch (already created from `master`).
- Cloudflare account id: `1420a69fe10a9c3d49ccb95c432b9412`. `gh` CLI is NOT installed (use GitHub REST via curl); local wrangler runs via `npx --yes wrangler@latest` (already OAuth-authenticated).

---

### Task 1: Editor API config module + env files

**Files:**
- Create: `editor/src/config/api.ts`
- Create: `editor/src/config/api.test.ts`
- Create: `editor/.env.development`
- Create: `editor/.env.production`
- Modify: `editor/src/vite-env.d.ts`
- Modify: `.gitignore` (root, after line 26 `!.env.vars.example`)
- Modify: `editor/src/features/auth/services/auth-client.ts:4,27`
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts:32`
- Modify: `editor/src/features/ai-panel/services/unity-tools/api-client.ts:19`
- Modify: `editor/src/features/graphify/services/graphify-enrich.ts:17`

**Interfaces:**
- Produces: `ARCANE_API_URL: string` and `ARCANE_WEB_URL: string` exported from `editor/src/config/api.ts` — consumed by every later editor task (Phase 3 uses `ARCANE_WEB_URL` for the browser sign-in URL).

- [ ] **Step 1: Write the failing test**

`editor/src/config/api.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ARCANE_API_URL, ARCANE_WEB_URL } from './api';

// bun test does not load .env.development (NODE_ENV=test), and editor/.env
// contains no VITE_ARCANE_* vars — so these assert the fail-safe fallbacks.
describe('api config', () => {
  test('falls back to the production API URL', () => {
    expect(ARCANE_API_URL).toBe('https://api.arcaneai.org');
  });
  test('falls back to the production web URL', () => {
    expect(ARCANE_WEB_URL).toBe('https://arcaneai.org');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/config/api.test.ts`
Expected: FAIL — `Cannot find module './api'`

- [ ] **Step 3: Create the config module**

`editor/src/config/api.ts`:

```ts
// Single source of truth for every backend endpoint the editor talks to.
// Values come from Vite env files (.env.development / .env.production,
// overridable via .env.development.local or shell env at build time).
// Fallbacks are the PRODUCTION endpoints so a build with missing env vars
// fails safe.
export const ARCANE_API_URL: string =
  import.meta.env.VITE_ARCANE_API_URL ?? 'https://api.arcaneai.org';

export const ARCANE_WEB_URL: string =
  import.meta.env.VITE_ARCANE_WEB_URL ?? 'https://arcaneai.org';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd editor && bun test src/config/api.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Create the env files**

`editor/.env.development` (used by `tauri dev` / `vite dev` automatically):

```bash
# Dev-environment endpoints (public URLs only — never put secrets here).
# Local override: create .env.development.local (gitignored) — e.g. point
# VITE_ARCANE_API_URL=http://localhost:8787 at a local `wrangler dev`.
VITE_ARCANE_API_URL=https://api-dev.arcaneai.org
VITE_ARCANE_WEB_URL=https://dev.arcaneai.org
```

`editor/.env.production` (used by `vite build` / `tauri build` automatically):

```bash
# Production endpoints (public URLs only — never put secrets here).
VITE_ARCANE_API_URL=https://api.arcaneai.org
VITE_ARCANE_WEB_URL=https://arcaneai.org
```

- [ ] **Step 6: Un-ignore the two committed env files**

In root `.gitignore`, directly after the line `!.env.vars.example` (line 26), add:

```gitignore
# …and DO keep the editor's committed env files (public URLs only, no secrets)
!.env.development
!.env.production
```

Run: `git check-ignore editor/.env.development editor/.env.production; echo "exit=$?"`
Expected: no paths printed, `exit=1` (not ignored). Also confirm the secret file stays ignored: `git check-ignore editor/.env` prints `editor/.env`.

- [ ] **Step 7: Type the new env vars**

Replace `editor/src/vite-env.d.ts` with:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARCANE_API_URL?: string;
  readonly VITE_ARCANE_WEB_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 8: Replace the four hardcoded constants**

`editor/src/features/auth/services/auth-client.ts` — line 4 becomes an import, line 27 uses it:

```ts
import { ARCANE_API_URL } from '../../../config/api';
```

```ts
  private serverUrl: string = ARCANE_API_URL;
```

(delete the `const DEFAULT_SERVER_URL = 'https://api.arcaneai.org';` line)

`editor/src/features/ai-panel/services/arcane-stream.ts` — replace line 32 `const ARCANE_SERVER_URL = 'https://api.arcaneai.org';` with:

```ts
import { ARCANE_API_URL } from '../../../config/api';

const ARCANE_SERVER_URL = ARCANE_API_URL;
```

(put the import at the top with the other imports; keep the local `ARCANE_SERVER_URL` alias so the rest of the file is untouched)

`editor/src/features/ai-panel/services/unity-tools/api-client.ts` — replace line 19 the same way (import path is one level deeper):

```ts
import { ARCANE_API_URL } from '../../../../config/api';

const ARCANE_SERVER_URL = ARCANE_API_URL;
```

`editor/src/features/graphify/services/graphify-enrich.ts` — replace line 17:

```ts
import { ARCANE_API_URL } from '../../../config/api';

const ARCANE_SERVER_URL = ARCANE_API_URL;
```

- [ ] **Step 9: Verify the whole editor still checks out**

Run: `cd editor && bun test src && bun run check:modules && bunx tsc --noEmit`
Expected: all tests PASS, module check clean, no type errors.

- [ ] **Step 10: Commit**

```bash
git add editor/src/config/ editor/.env.development editor/.env.production editor/src/vite-env.d.ts .gitignore editor/src/features/auth/services/auth-client.ts editor/src/features/ai-panel/services/arcane-stream.ts editor/src/features/ai-panel/services/unity-tools/api-client.ts editor/src/features/graphify/services/graphify-enrich.ts
git commit -m "feat(editor): env-driven API/web URLs via src/config/api.ts

tauri dev + dev builds -> api-dev.arcaneai.org; prod builds -> prod.
Fallbacks are prod so missing env fails safe.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Note (expected behavior change):** plain `bunx tauri dev` now talks to the DEV API. A previously stored prod token in `~/.arcane/auth.json` will 401 against dev and the app signs you out — sign in once against dev. This is by design (owner decision: local+dev use the dev API).

---

### Task 2: Rust per-app config dir (`~/.arcane` vs `~/.arcane-dev`)

**Files:**
- Modify: `editor/src-tauri/src/auth.rs`
- Modify: `editor/src-tauri/src/graphify.rs:35-49` (`graph_dir_for` + its two callers)
- Modify: `editor/src-tauri/src/lib.rs` (generate_handler list, ~line 751)
- Modify: `editor/src/features/ai-panel/services/session-persistence.ts:69-72`

**Interfaces:**
- Consumes: nothing from other tasks (independent of Task 1).
- Produces: `pub fn arcane_home_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>` and `pub fn arcane_dir_name(identifier: &str) -> &'static str` in `auth.rs`; new Tauri command `get_arcane_home_dir() -> Result<String, String>`. Phase 3 reuses `arcane_home_dir` for anything else app-scoped.

- [ ] **Step 1: Write the failing Rust test**

Append to `editor/src-tauri/src/auth.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::arcane_dir_name;

    #[test]
    fn prod_identifier_uses_arcane() {
        assert_eq!(arcane_dir_name("com.inno.editor"), ".arcane");
    }

    #[test]
    fn dev_identifier_uses_arcane_dev() {
        assert_eq!(arcane_dir_name("com.inno.editor.dev"), ".arcane-dev");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor/src-tauri && cargo test arcane_dir_name 2>&1 | tail -5`
Expected: compile error — `arcane_dir_name` not found.

- [ ] **Step 3: Implement the dir helpers in auth.rs**

Replace `auth_file_path()` (auth.rs:13-17) with:

```rust
/// Directory NAME for per-app config under $HOME, keyed off the bundle
/// identifier so the side-by-side dev build (com.inno.editor.dev) never
/// shares tokens/sessions/graphs with the prod app.
pub fn arcane_dir_name(identifier: &str) -> &'static str {
    if identifier.ends_with(".dev") {
        ".arcane-dev"
    } else {
        ".arcane"
    }
}

/// Absolute per-app config dir: ~/.arcane (prod) or ~/.arcane-dev (dev build).
pub fn arcane_home_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(arcane_dir_name(&app.config().identifier)))
}

fn auth_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(arcane_home_dir(app)?.join("auth.json"))
}
```

Give the three existing commands an `app: tauri::AppHandle` first parameter and pass it through — e.g.:

```rust
#[tauri::command]
pub fn auth_read_token(app: tauri::AppHandle) -> Result<Option<AuthToken>, String> {
    let path = auth_file_path(&app)?;
    ...
```

(same one-line change in `auth_write_token(app: tauri::AppHandle, token: String, email: String)` and `auth_delete_token(app: tauri::AppHandle)`; the frontend `invoke()` calls need NO changes — AppHandle is injected by Tauri). Update the two doc comments that mention `~/.arcane/auth.json` to say "the per-app config dir (see `arcane_home_dir`)".

Add the new command:

```rust
/// Absolute path of the per-app config dir (~/.arcane or ~/.arcane-dev),
/// for frontend code that persists files (e.g. AI session history).
#[tauri::command]
pub fn get_arcane_home_dir(app: tauri::AppHandle) -> Result<String, String> {
    arcane_home_dir(&app).map(|p| p.to_string_lossy().to_string())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd editor/src-tauri && cargo test arcane_dir_name 2>&1 | tail -5`
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Register the command + fix graphify.rs**

In `editor/src-tauri/src/lib.rs`, add `get_arcane_home_dir` to the `tauri::generate_handler![...]` list next to `auth_read_token` / `auth_write_token` / `auth_delete_token` (~line 751). Check how auth commands are referenced there (module path like `auth::auth_read_token`) and match it.

In `editor/src-tauri/src/graphify.rs`, change `graph_dir_for` to take the app (all its callers are commands that already have `AppHandle`):

```rust
fn graph_dir_for(app: &AppHandle, workspace_path: &str) -> Result<PathBuf, String> {
    let mut hasher = Sha1::new();
    hasher.update(workspace_path.as_bytes());
    let hash = hex::encode_short(&hasher.finalize());
    Ok(crate::auth::arcane_home_dir(app)?.join("graphs").join(hash))
}

fn graph_json_path(app: &AppHandle, workspace_path: &str) -> Result<PathBuf, String> {
    Ok(graph_dir_for(app, workspace_path)?.join("graph.json"))
}

fn summary_json_path(app: &AppHandle, workspace_path: &str) -> Result<PathBuf, String> {
    Ok(graph_dir_for(app, workspace_path)?.join("graph.summary.json"))
}
```

Then update every caller of `graph_json_path`/`summary_json_path`/`graph_dir_for` inside the `graphify_*` commands to pass `&app` (the commands whose param is `_app: AppHandle` must rename it to `app`).

Run: `cd editor/src-tauri && cargo check 2>&1 | tail -3`
Expected: no errors.

- [ ] **Step 6: Point session persistence at the command**

In `editor/src/features/ai-panel/services/session-persistence.ts`, replace the `getSessionsDir` body (lines 69-72):

```ts
async function getSessionsDir(): Promise<string> {
  if (!sessionsDir) {
    // Per-app dir (~/.arcane or ~/.arcane-dev) so the side-by-side dev
    // build never shares/corrupts the prod app's session files.
    const arcaneHome = await invoke<string>('get_arcane_home_dir');
    sessionsDir = await join(arcaneHome, 'sessions');
    try {
      await ensureSessionsDirExists(sessionsDir);
    } catch (error) {
      console.warn('Failed to create sessions directory:', error);
    }
  }
  return sessionsDir;
}
```

Remove the now-unused `homeDir` import (keep `join`). Confirm `invoke` is already imported in this file; add it if not.

- [ ] **Step 7: Full verification**

Run: `cd editor/src-tauri && cargo test 2>&1 | tail -3 && cd .. && bun test src && bunx tsc --noEmit`
Expected: cargo tests pass, bun tests pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add editor/src-tauri/src/auth.rs editor/src-tauri/src/graphify.rs editor/src-tauri/src/lib.rs editor/src/features/ai-panel/services/session-persistence.ts
git commit -m "feat(editor): per-app config dir keyed off bundle identifier

~/.arcane for prod, ~/.arcane-dev for the side-by-side Arcane Dev build.
Covers auth token, graph cache, and AI session persistence.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Tauri dev overlay (`Arcane Dev` side-by-side identity)

**Files:**
- Create: `editor/src-tauri/tauri.dev.conf.json`

**Interfaces:**
- Consumes: Task 2's identifier-keyed config dir (`.dev` suffix → `~/.arcane-dev`).
- Produces: the overlay path `src-tauri/tauri.dev.conf.json` used by dev-build.yml (Task 6) and by Phase 3 (its `plugins.deep-link` block activates once the plugin lands).

- [ ] **Step 1: Create the overlay**

`editor/src-tauri/tauri.dev.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Arcane Dev",
  "identifier": "com.inno.editor.dev",
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["arcane-dev"]
      }
    }
  }
}
```

(RFC 7396 JSON Merge Patch: objects deep-merge into `tauri.conf.json`, arrays replace. The `plugins.deep-link` block is inert until Phase 3 installs the plugin — it cleanly swaps `["arcane"]` → `["arcane-dev"]` then. Do NOT put a `version` key here — it inherits.)

- [ ] **Step 2: Verify JSON validity and config merge**

Run: `cd editor && python3 -m json.tool src-tauri/tauri.dev.conf.json > /dev/null && echo VALID`
Expected: `VALID`

Run: `cd editor && bunx tauri dev --config src-tauri/tauri.dev.conf.json` (let it launch, then quit)
Expected: window titled per welcome window; app writes config under `~/.arcane-dev` after a sign-in attempt — full side-by-side proof is deferred to Task 10 (needs a bundled build). If the dev server can't run in this session, at minimum confirm `bunx tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json` starts compiling with `productName: Arcane Dev` in its log, then Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add editor/src-tauri/tauri.dev.conf.json
git commit -m "feat(editor): tauri.dev.conf.json overlay for side-by-side Arcane Dev builds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `[env.dev]` in wrangler.toml (+ dev D1 creation)

**Files:**
- Modify: `arcane-server/wrangler.toml`
- Modify: `arcane-server/src/types.ts:5-12` (Bindings)
- Modify: `arcane-server/package.json` (scripts)

**Interfaces:**
- Consumes: nothing.
- Produces: wrangler envs `--env dev` (worker `arcane-server-dev`) and default (prod); `WEB_BASE_URL` binding available to Phase 2 server code; npm scripts `deploy:dev`, `db:migrate:dev:remote`.

- [ ] **Step 1: Create the dev D1 database**

Run: `cd arcane-server && npx --yes wrangler@latest d1 create arcane-db-dev`
Expected: output containing `database_name = "arcane-db-dev"` and a fresh `database_id = "<uuid>"`. Record the uuid for Step 2.

- [ ] **Step 2: Rewrite wrangler.toml**

Replace `arcane-server/wrangler.toml` content with (keep the existing Vectorize/AI-gateway comment blocks verbatim where shown abbreviated; `<DEV_D1_ID>` = uuid from Step 1):

```toml
name = "arcane-server"
main = "index.ts"
compatibility_date = "2025-12-01"
compatibility_flags = ["nodejs_compat"]

# Prod custom domain, adopted from the dashboard mapping. The first deploy
# with this block must be run MANUALLY (not from CI) — see the Phase 1 plan
# Task 5 — in case wrangler asks to confirm adopting the existing domain.
routes = [
  { pattern = "api.arcaneai.org", custom_domain = true }
]

[[d1_databases]]
binding = "arcane_db"
database_name = "arcane-db"
database_id = "fdc0556c-e622-44db-a189-1be9a55acb80"

# Cloudflare Workers AI — all LLM calls route through this binding.
[ai]
binding = "AI"

# Vectorize — version-accurate Unity documentation index (ScriptReference +
# Manual + API signatures), embedded with @cf/baai/bge-small-en-v1.5 (384-dim).
# (creation commands: see git history of this file)
[[vectorize]]
binding = "VECTORIZE"
index_name = "unity-docs-v1"

[vars]
ENVIRONMENT = "production"
# AI Gateway id — see ai-gateway/configuration/authentication ("Expected behavior").
CF_AI_GATEWAY_ID = "arcane-ai-gateway"
# Base URL of the user-facing website (auth pages live there). Phase 2 uses
# this for the device-flow verification_uri and email links.
WEB_BASE_URL = "https://arcaneai.org"

[observability]
enabled = true
head_sampling_rate = 1

# ── dev environment ─────────────────────────────────────────────────────────
# Deploy: wrangler deploy --env dev   (worker: arcane-server-dev)
# NOTE: bindings/vars are NOT inherited into named envs — the full set is
# repeated below. `routes` IS inherited, so it MUST be overridden here or a
# dev deploy would claim api.arcaneai.org.
[env.dev]
name = "arcane-server-dev"
routes = [
  { pattern = "api-dev.arcaneai.org", custom_domain = true }
]

[[env.dev.d1_databases]]
binding = "arcane_db"
database_name = "arcane-db-dev"
database_id = "<DEV_D1_ID>"

[env.dev.ai]
binding = "AI"

# SHARED with prod — the Unity docs corpus is read-only at runtime; a second
# index would need a full re-ingest for no isolation benefit.
[[env.dev.vectorize]]
binding = "VECTORIZE"
index_name = "unity-docs-v1"

[env.dev.vars]
ENVIRONMENT = "development"
CF_AI_GATEWAY_ID = "arcane-ai-gateway-dev"
WEB_BASE_URL = "https://dev.arcaneai.org"

[env.dev.observability]
enabled = true
head_sampling_rate = 1
```

- [ ] **Step 3: Add WEB_BASE_URL to the Bindings type**

In `arcane-server/src/types.ts`, add to `AppEnv.Bindings` (after `ENVIRONMENT: string;`):

```ts
        WEB_BASE_URL: string;        // user-facing website base (auth pages, email links)
```

- [ ] **Step 4: Add convenience scripts**

In `arcane-server/package.json` scripts, add:

```json
    "deploy:dev": "wrangler deploy --env dev",
    "db:migrate:dev:remote": "wrangler d1 migrations apply arcane-db-dev --env dev --remote"
```

- [ ] **Step 5: Verify both envs dry-run cleanly**

Run: `cd arcane-server && npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry 2>&1 | tail -15 && npx wrangler deploy --dry-run --env dev --outdir /tmp/wrangler-dry-dev 2>&1 | tail -15`
Expected: prod shows `arcane-server` + route `api.arcaneai.org` + bindings (arcane_db, AI, VECTORIZE, 3 vars); dev shows `arcane-server-dev` + route `api-dev.arcaneai.org` + same binding shape with dev values. No warnings about missing bindings.

- [ ] **Step 6: Apply migrations to the dev D1**

Run: `cd arcane-server && npm run db:migrate:dev:remote`
Expected: all migrations 0001→0011 applied (0002_seed included).
Then: `npx wrangler d1 execute arcane-db-dev --env dev --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`
Expected: `users`, `device_codes`, `feedback`, `request_logs`, `usage_periods`, `unity_api_signatures` (+ `d1_migrations`, sqlite internals).

- [ ] **Step 7: Commit**

```bash
git add arcane-server/wrangler.toml arcane-server/src/types.ts arcane-server/package.json
git commit -m "feat(server): [env.dev] environment — arcane-server-dev at api-dev.arcaneai.org

Own D1 (arcane-db-dev) + dev AI gateway; shared Vectorize corpus.
Prod custom domain adopted into wrangler.toml routes. WEB_BASE_URL var
added for Phase 2 auth work.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Cloudflare infra bring-up (dev worker, gateway, Pages project, prod route adoption)

**Files:** none (cloud state only). Owner-facing steps are marked **[OWNER]**; the rest run from this machine's authenticated wrangler / Cloudflare API.

**Interfaces:**
- Consumes: Task 4's wrangler.toml.
- Produces: live `https://api-dev.arcaneai.org`, AI Gateway `arcane-ai-gateway-dev`, Pages project `arcane-landing-dev` serving `https://dev.arcaneai.org`, dev `JWT_SECRET`.

- [ ] **Step 1: Create the dev AI Gateway**

Via Cloudflare API (account id `1420a69fe10a9c3d49ccb95c432b9412`):

```
POST /accounts/1420a69fe10a9c3d49ccb95c432b9412/ai-gateway/gateways
{"id": "arcane-ai-gateway-dev", "collect_logs": true, "cache_ttl": 0, "rate_limiting_interval": 0, "rate_limiting_limit": 0, "rate_limiting_technique": "fixed"}
```

(use the cloudflare-api MCP tool or curl with the owner's token; **[OWNER]** fallback: dashboard → AI → AI Gateway → Create gateway → id `arcane-ai-gateway-dev`, logs on). Mirror prod gateway's rate-limit settings if it has any.
Expected: 200/201 with the gateway object.

- [ ] **Step 2: First dev worker deploy**

Run: `cd arcane-server && npx wrangler deploy --env dev`
Expected: `Deployed arcane-server-dev` + `api-dev.arcaneai.org (custom domain)` in the routes output (DNS record auto-created — same-account zone).

- [ ] **Step 3: Set the dev JWT secret**

Run: `cd arcane-server && openssl rand -base64 48 | npx wrangler secret put JWT_SECRET --env dev`
Expected: `✨ Success! Uploaded secret JWT_SECRET`. (Different value from prod by construction; never echo it.)

- [ ] **Step 4: Verify the dev API is live**

Run: `curl -s https://api-dev.arcaneai.org/health`
Expected: `{"status":"ok"}` (allow a minute for cert issuance on the very first hit).
Also: `curl -s -X POST https://api-dev.arcaneai.org/v1/auth/signup -H 'Content-Type: application/json' -d '{"email":"smoke@test.dev","password":"smoketest123"}'` → 200 with a token (proves D1 + JWT_SECRET wired). Then clean up: `npx wrangler d1 execute arcane-db-dev --env dev --remote --command "DELETE FROM users WHERE email='smoke@test.dev'"`.

- [ ] **Step 5: Prod route adoption deploy (manual, careful)**

Precondition: `curl -s https://api.arcaneai.org/health` → `{"status":"ok"}` (baseline).
Run: `cd arcane-server && npx wrangler deploy`
Expected: `Deployed arcane-server` with route `api.arcaneai.org (custom domain)`; if wrangler asks to confirm adopting the existing dashboard-mapped domain, answer yes.
Verify immediately: `curl -s https://api.arcaneai.org/health` → `{"status":"ok"}` and a live editor AI request still works. If anything breaks: the domain can be re-attached in dashboard → Workers & Pages → arcane-server → Settings → Domains & Routes.

- [ ] **Step 6: Create the dev Pages project + domain**

Run: `cd landing-page && npx wrangler pages project create arcane-landing-dev --production-branch main`
Expected: project created.
First deploy (dev API baked in):

```bash
cd landing-page && CI=true pnpm install && PUBLIC_API_URL=https://api-dev.arcaneai.org pnpm build && npx wrangler pages deploy dist --project-name arcane-landing-dev --branch main --commit-dirty=true
```

Expected: deployment URL `https://<hash>.arcane-landing-dev.pages.dev`.
Attach the custom domain via API: `POST /accounts/1420a69fe10a9c3d49ccb95c432b9412/pages/projects/arcane-landing-dev/domains` with `{"name": "dev.arcaneai.org"}`, then confirm a proxied CNAME `dev` → `arcane-landing-dev.pages.dev` exists in the zone (create it via the DNS API if Pages didn't auto-create it). **[OWNER]** fallback: dashboard → Workers & Pages → arcane-landing-dev → Custom domains → add `dev.arcaneai.org`.
Verify: `curl -sI https://dev.arcaneai.org | head -3` → `HTTP/2 200`.

- [ ] **Step 7: Record infra state in the SDD ledger**

Append to `.superpowers/sdd/progress.md` (create heading if missing): D1 id, gateway id, Pages project name, deploy timestamps — so Phase 2 doesn't re-derive them.

---

### Task 6: `dev-build.yml` — dev app builds to R2

**Files:**
- Create: `.github/workflows/dev-build.yml`

**Interfaces:**
- Consumes: Task 1 env vars, Task 3 overlay.
- Produces: `releases.arcaneai.org/dev/latest/Arcane-Dev-arm64.dmg` and `.../dev/latest/ArcaneDevSetup.exe` (+ per-SHA copies under `dev/<sha7>/`).

- [ ] **Step 1: Create the workflow**

`.github/workflows/dev-build.yml`:

```yaml
name: Dev Build

# Builds the side-by-side "Arcane Dev" app (identifier com.inno.editor.dev,
# scheme arcane-dev://, config dir ~/.arcane-dev) with the DEV API/web URLs
# baked in, and uploads installers to arcane-releases under dev/.
#
# Mirrors release.yml step-for-step — keep the two in sync. Same two repo
# secrets (CLOUDFLARE_API_TOKEN with R2 edit, CLOUDFLARE_ACCOUNT_ID).
on:
  push:
    branches: ['dev']
    paths: ['editor/**', '.github/workflows/dev-build.yml']
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14          # Apple Silicon
            triple: aarch64-apple-darwin
            bundles: dmg
            asset: Arcane-Dev-arm64.dmg
            glob: editor/src-tauri/target/release/bundle/dmg/*.dmg
          - os: windows-latest    # Windows x64
            triple: x86_64-pc-windows-msvc
            bundles: nsis
            asset: ArcaneDevSetup.exe
            glob: editor/src-tauri/target/release/bundle/nsis/*-setup.exe
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        shell: bash   # bash on Windows too, so the `CI=` env-prefix works everywhere
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      # Pin OFFICIAL Node (static libuv) — homebrew node crashes native addons.
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.triple }}

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Build arcane-graph sidecar
        run: |
          cd editor/tooling/arcane-graph-sidecar
          python -m venv .venv
          if [[ "$RUNNER_OS" == "Windows" ]]; then
            PY=".venv/Scripts/python.exe"
          else
            PY=".venv/bin/python"
          fi
          "$PY" -m pip install --upgrade pip
          "$PY" -m pip install graphifyy pyinstaller
          "$PY" -m PyInstaller pyinstaller.spec
          mkdir -p ../../src-tauri/binaries
          if [[ "$RUNNER_OS" == "Windows" ]]; then
            cp dist/arcane-graph.exe "../../src-tauri/binaries/arcane-graph-${{ matrix.triple }}.exe"
          else
            cp dist/arcane-graph "../../src-tauri/binaries/arcane-graph-${{ matrix.triple }}"
          fi

      - name: Install JS deps
        run: cd editor && bun install

      # GOTCHA: CI=true would cross-build all 4 LSP targets. Host-only here.
      - name: Build typescript-language-server sidecar (host only)
        run: cd editor && CI= bun run build:lsp-sidecars

      # `bunx tauri` (binary), NOT `bun run tauri`. Shell env beats
      # .env.production in Vite, so the dev URLs win at build time.
      - name: Build Tauri app (dev config)
        env:
          NODE_OPTIONS: --max-old-space-size=4096
          VITE_ARCANE_API_URL: https://api-dev.arcaneai.org
          VITE_ARCANE_WEB_URL: https://dev.arcaneai.org
        run: cd editor && bunx tauri build --bundles ${{ matrix.bundles }} --config src-tauri/tauri.dev.conf.json

      - name: Stage installer under its public name
        run: |
          mkdir -p dist-release
          cp "$(ls ${{ matrix.glob }} | head -n1)" "dist-release/${{ matrix.asset }}"

      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.asset }}
          path: dist-release/${{ matrix.asset }}

      - name: Upload to R2 (dev channel)
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          SHA7="${GITHUB_SHA:0:7}"
          bunx wrangler r2 object put "arcane-releases/dev/$SHA7/${{ matrix.asset }}"  --file "dist-release/${{ matrix.asset }}" --remote
          bunx wrangler r2 object put "arcane-releases/dev/latest/${{ matrix.asset }}" --file "dist-release/${{ matrix.asset }}" --remote
```

- [ ] **Step 2: Static validation**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/dev-build.yml')); print('VALID')"`
Expected: `VALID` (if PyYAML missing: `npx --yes js-yaml .github/workflows/dev-build.yml > /dev/null && echo VALID`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/dev-build.yml
git commit -m "ci: dev-build workflow — Arcane Dev installers to R2 dev/ channel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Live-run verification happens in Task 9 after the token swap + push.)

---

### Task 7: `deploy-server.yml`

**Files:**
- Create: `.github/workflows/deploy-server.yml`

**Interfaces:**
- Consumes: Task 4's envs/scripts.
- Produces: auto dev deploys on `dev`-branch server changes; gated prod deploys via dispatch.

- [ ] **Step 1: Create the workflow**

`.github/workflows/deploy-server.yml`:

```yaml
name: Deploy Server

# arcane-server (Cloudflare Worker) deploys.
#  - push to dev touching arcane-server/  -> deploy to env.dev (with migrations)
#  - manual dispatch with environment=production -> prod deploy (with migrations)
# Requires CLOUDFLARE_API_TOKEN with Workers Scripts:Edit + D1:Edit +
# Workers Routes:Edit (zone) — see Task 9 of the Phase 1 plan.
on:
  push:
    branches: ['dev']
    paths: ['arcane-server/**', '.github/workflows/deploy-server.yml']
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        type: choice
        options: [dev, production]
        default: dev

jobs:
  deploy-dev:
    if: github.event_name == 'push' || inputs.environment == 'dev'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: arcane-server
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      # Migrations BEFORE deploy so new code never sees an old schema.
      - name: Apply D1 migrations (dev)
        run: npx wrangler d1 migrations apply arcane-db-dev --env dev --remote
      - name: Deploy worker (dev)
        run: npx wrangler deploy --env dev

  deploy-prod:
    if: github.event_name == 'workflow_dispatch' && inputs.environment == 'production'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: arcane-server
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Apply D1 migrations (prod)
        run: npx wrangler d1 migrations apply arcane-db --remote
      - name: Deploy worker (prod)
        run: npx wrangler deploy
```

- [ ] **Step 2: Static validation + commit**

Run the same YAML validation as Task 6 Step 2, then:

```bash
git add .github/workflows/deploy-server.yml
git commit -m "ci: deploy-server workflow — auto dev deploys, gated prod deploys

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `deploy-landing.yml`

**Files:**
- Create: `.github/workflows/deploy-landing.yml`

**Interfaces:**
- Consumes: Task 5's `arcane-landing-dev` project.
- Produces: auto dev site deploys; gated prod site deploys. Phase 2 will add `PUBLIC_TURNSTILE_SITE_KEY` to both build steps.

- [ ] **Step 1: Create the workflow**

`.github/workflows/deploy-landing.yml`:

```yaml
name: Deploy Landing

# landing-page (Astro, Cloudflare Pages) deploys.
#  - push to dev touching landing-page/ -> arcane-landing-dev (dev.arcaneai.org)
#  - manual dispatch with environment=production -> arcane-landing (arcaneai.org)
# Both Pages projects use production branch "main" — always pass --branch main.
# The load-bearing landing-page/.npmrc (entities hoist exclusion) is picked up
# automatically because pnpm runs inside landing-page/.
# Phase 2 adds PUBLIC_TURNSTILE_SITE_KEY next to PUBLIC_API_URL below.
on:
  push:
    branches: ['dev']
    paths: ['landing-page/**', '.github/workflows/deploy-landing.yml']
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        type: choice
        options: [dev, production]
        default: dev

jobs:
  deploy-dev:
    if: github.event_name == 'push' || inputs.environment == 'dev'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: landing-page
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: pnpm install --frozen-lockfile
      - name: Build (dev API baked in)
        env:
          PUBLIC_API_URL: https://api-dev.arcaneai.org
        run: pnpm build
      - name: Deploy to arcane-landing-dev
        run: npx wrangler pages deploy dist --project-name arcane-landing-dev --branch main

  deploy-prod:
    if: github.event_name == 'workflow_dispatch' && inputs.environment == 'production'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: landing-page
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: pnpm install --frozen-lockfile
      - name: Build (prod API baked in)
        env:
          PUBLIC_API_URL: https://api.arcaneai.org
        run: pnpm build
      - name: Deploy to arcane-landing (production)
        run: npx wrangler pages deploy dist --project-name arcane-landing --branch main
```

- [ ] **Step 2: Static validation + commit**

Run the same YAML validation as Task 6 Step 2, then:

```bash
git add .github/workflows/deploy-landing.yml
git commit -m "ci: deploy-landing workflow — dev site auto-deploys, gated prod deploys

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Token swap, push, and live CI verification

**Files:** none (GitHub/Cloudflare state).

- [ ] **Step 1: [OWNER] Create the expanded Cloudflare API token**

Dashboard → My Profile → API Tokens → Create Token (custom):
- Account `1420a69fe10a9c3d49ccb95c432b9412`: **Workers R2 Storage:Edit** (keeps release.yml working), **Workers Scripts:Edit**, **Cloudflare Pages:Edit**, **D1:Edit**
- Zone `arcaneai.org`: **Workers Routes:Edit**, **DNS:Edit**
Then GitHub repo → Settings → Secrets and variables → Actions → update `CLOUDFLARE_API_TOKEN`.

- [ ] **Step 2: Push the dev branch**

Run: `git push -u origin dev`
Expected: all three new workflows trigger (editor/**, arcane-server/**, landing-page/** were all touched on this branch).

- [ ] **Step 3: Watch the runs**

`gh` is not installed — poll via REST:

```bash
curl -s "https://api.github.com/repos/Sourav12061999/arcane-editor/actions/runs?branch=dev&per_page=6" | python3 -c "import json,sys; [print(r['name'], r['status'], r['conclusion']) for r in json.load(sys.stdin)['workflow_runs']]"
```

Expected: `Dev Build`, `Deploy Server`, `Deploy Landing` all `completed success` (Dev Build takes ~15 min). Debug failures from the run's `jobs_url` logs.

- [ ] **Step 4: Verify the artifacts**

```bash
curl -sI https://releases.arcaneai.org/dev/latest/Arcane-Dev-arm64.dmg | head -3
curl -sI https://releases.arcaneai.org/dev/latest/ArcaneDevSetup.exe | head -3
curl -s https://api-dev.arcaneai.org/health
curl -sI https://dev.arcaneai.org | head -3
```

Expected: two `200`s for installers, `{"status":"ok"}`, `200` for the site.

---

### Task 10: Phase 1 end-to-end verification (spec A7)

**Files:** none. Run through the checklist; record results in `.superpowers/sdd/progress.md`.

- [ ] `curl -s https://api.arcaneai.org/health` AND a real AI request from the prod app still work (prod regression).
- [ ] Dev unity-api search returns results via `curl -s -X POST https://api-dev.arcaneai.org/v1/unity/api/search -H "Authorization: Bearer <dev-signup-token>" -H 'Content-Type: application/json' -d '{"query":"Rigidbody.AddForce","unityVersion":"6000.3"}'` (proves shared Vectorize; get a token from a dev-API signup).
- [ ] One chat request against the dev API appears in the `arcane-ai-gateway-dev` dashboard logs; the prod gateway shows nothing at that timestamp.
- [ ] `https://dev.arcaneai.org` in a browser: devtools network shows calls to `api-dev.arcaneai.org` (feedback form is the easiest trigger).
- [ ] Local: `cd editor && bunx tauri dev` → sign in (dev API) → AI request streams; network hits `api-dev.arcaneai.org` (verify via `npx wrangler tail --env dev` in arcane-server).
- [ ] Local override: create `editor/.env.development.local` with `VITE_ARCANE_API_URL=http://localhost:8787`, run `npm run dev` in arcane-server, restart `tauri dev` → requests hit the local worker. Delete the override; behavior reverts.
- [ ] **[OWNER, has both OSes?]** Install `Arcane-Dev-arm64.dmg` ALONGSIDE prod Arcane: both launch simultaneously; sign in inside Arcane Dev → token written to `~/.arcane-dev/auth.json`; `~/.arcane/auth.json` untouched; AI chat streams via api-dev (`wrangler tail --env dev`).
- [ ] Prod bundle check on next prod release: `grep -c "api.arcaneai.org" editor/dist/assets/*.js` after a plain `bunx tauri build` shows the prod URL (spot-check that `.env.production` won).

---

## Self-review notes

- Spec coverage: A1→Task 4, A2→Task 1, A3→Tasks 2+3, A4→Tasks 6-8 (+token in Task 9), A5→already done (dev branch exists), A6→Tasks 4-5, A7→Tasks 9-10. Complete.
- Type consistency: `ARCANE_API_URL`/`ARCANE_WEB_URL` (Tasks 1,6), `arcane_home_dir`/`arcane_dir_name`/`get_arcane_home_dir` (Task 2), asset names `Arcane-Dev-arm64.dmg`/`ArcaneDevSetup.exe` (Tasks 6,9) used consistently.
- Known accepted behavior: plain `tauri dev` now targets the dev API (owner decision); prod token in `~/.arcane` will 401 once against dev then sign out.
