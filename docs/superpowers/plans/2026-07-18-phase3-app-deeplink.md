# Phase 3 — Desktop App Deep-Link Browser Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Part C of `docs/superpowers/specs/2026-07-18-dev-env-and-website-auth-design.md` — the editor signs users in by opening the browser to the (already-live) website auth flow and receiving a one-time PKCE-bound code back over an `arcane://` / `arcane-dev://` deep link, with the device-code flow kept as fallback.

**Architecture:** Rust gains the `deep-link` + `single-instance` Tauri plugins (single-instance registered FIRST; its callback preserves the "re-launch opens a window" UX) and one new command `auth_deep_link_scheme` that reads the merged config so the dev overlay is the single source of truth. The frontend gains a pure, bun-testable `browser-login.ts` service that owns state/verifier/challenge generation, deep-link listening, and the consume-before-exchange replay guard — while the Zustand auth store owns the actual `POST /v1/auth/editor/exchange` call and all UI state (`loginStatus`). `AuthTab` is reworked to "Continue in browser" primary + device-flow fallback, and an `auth-changed` Tauri event keeps every window's auth state in sync.

**Tech Stack:** Tauri 2 (`tauri-plugin-deep-link` 2, `tauri-plugin-single-instance` 2 w/ `deep-link` feature), Rust, React 19 + TypeScript, Zustand, WebCrypto (SubtleCrypto SHA-256), bun:test.

## Global Constraints

Every task implicitly includes these. Copy values EXACTLY — they are the live server/website contract (Phase 2a on api-dev.arcaneai.org, Phase 2b on dev.arcaneai.org).

- **Schemes:** prod `arcane`, dev build `arcane-dev`. Prod scheme lives in `tauri.conf.json` `plugins.deep-link.desktop.schemes: ["arcane"]`; the EXISTING dev overlay `src-tauri/tauri.dev.conf.json` already swaps to `["arcane-dev"]` (RFC 7396 merge replaces arrays wholesale — do not touch the overlay).
- **Browser-open URL:** `${ARCANE_WEB_URL}/auth?flow=editor&state=<state>&challenge=<challenge>&scheme=<scheme>` — param names exactly `flow`, `state`, `challenge`, `scheme`; `flow` is always the literal `editor`.
- **Deep-link callback:** `${scheme}://auth/callback?code=<one-time>&state=<echoed state>` — anything else is rejected.
- **Exchange:** `POST ${ARCANE_API_URL}/v1/auth/editor/exchange` with JSON body `{code, verifier}` → 200 `{token, user: {id, email, role, emailVerified}}` | 400 `{error: 'invalid_code'}` (single opaque error for ALL failure modes).
- **Verifier:** base64url(32 random bytes) = exactly 43 chars of `[A-Za-z0-9_-]`. **Challenge:** base64url(SHA-256(ascii(verifier))), must match the server regex `/^[A-Za-z0-9_-]{43,128}$/`.
- **Verifier is MEMORY-ONLY.** Never persisted, never leaves the app except inside the exchange POST body. Cold-start deep links therefore cannot complete a login (spec C5 — by design).
- **Replay guard:** the pending attempt is consumed (`pending = null`, listener + timer torn down) BEFORE the exchange runs. **State check:** callback `state` must equal the pending attempt's `state`; mismatch → `console.warn` + ignore (attempt stays pending).
- **Single-instance plugin is registered FIRST** in the Tauri builder chain, before every other plugin. Windows single-instance behavior change is **owner-approved** (spec C6).
- **Config module:** `editor/src/config/api.ts` exports `ARCANE_API_URL` and `ARCANE_WEB_URL` (Phase 1, already exists). Never hardcode URLs.
- **Manual-paste fallback uses the SAME grant code + exchange endpoint** (the `/auth/success` page shows the code), NOT the device flow. Device-flow endpoints (`POST /v1/auth/device/code`, `POST /v1/auth/device/token`) stay as the fallback for macOS `tauri dev`.
- **Deep Modules rule** (editor/CLAUDE.md): code outside `src/features/auth/` imports auth ONLY via `src/features/auth/index.ts`. Files inside the feature may import each other directly.
- **Commands** (run from `editor/` unless noted): `bun test src`, `bunx tsc --noEmit`, `bun run check:modules`, and `cargo test` from `editor/src-tauri/`.
- Work lands on the `dev` branch (already checked out). Commit per task; do NOT push or tag.

## Phase-1 groundwork — verified current state (2026-07-18)

Findings from reading the actual files (do not re-derive; splice against these):

- `src-tauri/src/auth.rs` — Phase 1 already added `arcane_dir_name`, `arcane_home_dir(app)`, identifier-keyed `auth_file_path`, `get_arcane_home_dir`, and a `#[cfg(test)] mod tests`. **`auth_deep_link_scheme` does NOT exist yet → Task 1 adds it.**
- `src/config/api.ts` — exists, exports `ARCANE_API_URL` + `ARCANE_WEB_URL` with prod fallbacks.
- `src/features/auth/services/auth-client.ts` — `DEFAULT_SERVER_URL` is **already gone**; `private serverUrl: string = ARCANE_API_URL` (config import) at line 26. Still has `login()`, `signup()`, dead `handleRefreshToken()` (X-Refreshed-Token — server never sends it).
- `authClient.login/signup` are consumed ONLY by `src/stores/auth.ts`; store `login`/`signup`/`loading` are consumed ONLY by `src/features/auth/components/AuthTab.tsx` (verified by grep). Deletion is safe once AuthTab is reworked.
- `src/features/ai-panel/components/AiSignInGate.tsx` has NO credential form — it opens the AuthTab (`openFile('auth://account', 'Account')`). No change needed there.
- `src-tauri/tauri.conf.json` — no `plugins` section yet; identifier `com.inno.editor`. `src-tauri/tauri.dev.conf.json` — already has `productName "Arcane Dev"`, `identifier com.inno.editor.dev`, `plugins.deep-link.desktop.schemes: ["arcane-dev"]`.
- `src-tauri/src/lib.rs` — `use tauri::Manager;` at module level (line 26); `open_or_focus_welcome` at lines 588-616 gated `#[cfg(target_os = "macos")]` with a redundant inner `use tauri::Manager;`; builder chain starts line 637 (`tauri::Builder::default()` → `.plugin(tauri_plugin_window_state...)` first); `generate_handler` auth block at lines 751-754; `.setup(|_app| {` at line 774 with a macOS-only body; the "no single-instance plugin" Windows comment at lines 788-793.
- `src/App.tsx` — mount effect calls `useAuthStore.getState().loadFromDisk()` (line 138); the `listenScoped`/`safeUnlisten` effect pattern is at lines 251-265 (`menu-action`). `useAuthStore`, `listenScoped` (line 52), `safeUnlisten` (line 79) already imported.
- `src/features/ai-panel/services/arcane-stream.ts` — 401/403 → `useAuthStore.getState().logout()` (line 293). Unchanged by this plan (spec C5); the store's reworked `logout` transparently adds the cross-window broadcast.
- bun test mocking precedent: `src/features/ai-panel/services/arcane-stream.test.ts` (`mock.module(...)` before dynamic `await import(...)`).
- Phase 1/2 artifacts live: `.github/workflows/dev-build.yml` exists; `editor/.env.development` / `.env.production` exist; website auth is deployed on dev.arcaneai.org, server on api-dev.arcaneai.org.

---

### Task 1: Rust plumbing — plugins, config, single-instance-first wiring, `auth_deep_link_scheme`

**Files:**
- Modify: `editor/src-tauri/Cargo.toml` (dependencies block, after line 27)
- Modify: `editor/src-tauri/tauri.conf.json` (add `plugins` section)
- Modify: `editor/src-tauri/capabilities/default.json` (permissions array)
- Modify: `editor/src-tauri/src/auth.rs` (new helper + command + tests)
- Modify: `editor/src-tauri/src/lib.rs` (builder chain ~637, `open_or_focus_welcome` ~588, `generate_handler` ~754, `setup` ~774, Windows comment ~788)

**Interfaces:**
- Consumes: existing `auth::arcane_home_dir` module layout; module-level `use tauri::Manager;` in lib.rs.
- Produces: Tauri command `auth_deep_link_scheme() -> String` (invoked from TS in Task 2 as `invoke<string>('auth_deep_link_scheme')`, returns `"arcane"` or `"arcane-dev"`); `pub fn deep_link_scheme(app: &tauri::AppHandle) -> String` (used by the single-instance callback); un-gated `pub(crate) fn open_or_focus_welcome(app: &tauri::AppHandle)`.

- [ ] **Step 1: Write the failing Rust tests** — in `editor/src-tauri/src/auth.rs`, replace the existing test module header and add two tests so the module reads:

```rust
#[cfg(test)]
mod tests {
    use super::{arcane_dir_name, scheme_from_plugin_config};
    use serde_json::json;

    #[test]
    fn prod_identifier_uses_arcane() {
        assert_eq!(arcane_dir_name("com.inno.editor"), ".arcane");
    }

    #[test]
    fn dev_identifier_uses_arcane_dev() {
        assert_eq!(arcane_dir_name("com.inno.editor.dev"), ".arcane-dev");
    }

    #[test]
    fn scheme_read_from_merged_plugin_config() {
        let v = json!({ "desktop": { "schemes": ["arcane-dev"] } });
        assert_eq!(scheme_from_plugin_config(Some(&v)), "arcane-dev");
    }

    #[test]
    fn scheme_falls_back_to_arcane() {
        assert_eq!(scheme_from_plugin_config(None), "arcane");
        let empty = json!({ "desktop": { "schemes": [] } });
        assert_eq!(scheme_from_plugin_config(Some(&empty)), "arcane");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd editor/src-tauri && cargo test scheme_`
Expected: COMPILE ERROR — `scheme_from_plugin_config` not found.

- [ ] **Step 3: Implement the scheme helper + command** — in `editor/src-tauri/src/auth.rs`, insert directly above the `#[cfg(test)]` line:

```rust
/// First deep-link scheme from the MERGED tauri config
/// (`plugins.deep-link.desktop.schemes[0]`). Reading the runtime config —
/// rather than hardcoding — makes the dev overlay (`tauri.dev.conf.json`,
/// schemes ["arcane-dev"]) the single source of truth: a dev build
/// automatically reports "arcane-dev" with zero extra plumbing.
fn scheme_from_plugin_config(deep_link: Option<&serde_json::Value>) -> String {
    deep_link
        .and_then(|v| v.get("desktop"))
        .and_then(|d| d.get("schemes"))
        .and_then(|s| s.get(0))
        .and_then(|s| s.as_str())
        .unwrap_or("arcane")
        .to_string()
}

/// Deep-link scheme of the running app: "arcane" (prod) or "arcane-dev"
/// (dev overlay build). Also used by the single-instance callback in lib.rs
/// to tell "re-launch with a deep link" from "plain re-launch".
pub fn deep_link_scheme(app: &tauri::AppHandle) -> String {
    scheme_from_plugin_config(app.config().plugins.0.get("deep-link"))
}

/// The scheme the frontend passes to the website's /auth page (`scheme=` param)
/// so the browser redirects back to THIS build of the app.
#[tauri::command]
pub fn auth_deep_link_scheme(app: tauri::AppHandle) -> String {
    deep_link_scheme(&app)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd editor/src-tauri && cargo test`
Expected: PASS — all existing tests plus `scheme_read_from_merged_plugin_config` and `scheme_falls_back_to_arcane`.

- [ ] **Step 5: Add the crates** — in `editor/src-tauri/Cargo.toml`, after the line `tauri-plugin-shell = "2"` (line 27), insert:

```toml
tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }
tauri-plugin-deep-link = "2"
```

(Plain `[dependencies]` per spec C1; desktop gating happens with `#[cfg(desktop)]` in code. The `deep-link` feature makes single-instance forward `arcane://…` argv URLs from a second launch to the deep-link plugin — the Windows/Linux delivery path.)

- [ ] **Step 6: Declare the prod scheme** — in `editor/src-tauri/tauri.conf.json`, insert a top-level `plugins` section between the `app` and `bundle` sections (i.e. replace the two lines `  },\n  "bundle": {` with):

```json
  },
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["arcane"]
      }
    }
  },
  "bundle": {
```

The bundler now writes `CFBundleURLTypes` (macOS Info.plist) / `HKCR\arcane` (Windows NSIS) at install. The dev overlay already overrides `identifier` AND `schemes: ["arcane-dev"]` — arrays are replaced wholesale by the JSON merge patch, so a dev build registers ONLY `arcane-dev`.

- [ ] **Step 7: Grant the capability** — in `editor/src-tauri/capabilities/default.json`, add one entry to `permissions` directly after `"core:default",`:

```json
    "deep-link:default",
```

(Spec C1 caveat: after the first `tauri dev`/`tauri build` regenerates `src-tauri/gen/schemas/`, verify `deep-link:default` includes `allow-get-current`; if the JS `onOpenUrl` call errors with a "not allowed" message during Task 5 manual verification, additionally add `"deep-link:allow-get-current"` here. Checked in Task 5, step 3.)

- [ ] **Step 8: Un-gate `open_or_focus_welcome`** — in `editor/src-tauri/src/lib.rs`, replace lines 588-597 (doc comment + cfg + fn signature + inner `use`):

```rust
/// Show/focus the existing "welcome" (project-manager) window, or create it if
/// none exists. Shared by the macOS dock-icon `RunEvent::Reopen` handler and by
/// the dock right-click menu's "New Window" action (`dock::install_dock_menu`),
///
/// macOS-only: `RunEvent::Reopen` and the dock menu are both macOS-only
/// surfaces, so gating this here keeps it out of other platforms' builds
/// (no dead-code warnings) while sharing one implementation.
#[cfg(target_os = "macos")]
pub(crate) fn open_or_focus_welcome(app: &tauri::AppHandle) {
    use tauri::Manager;
```

with:

```rust
/// Show/focus the existing "welcome" (project-manager) window, or create it if
/// none exists. Callers: the macOS dock-icon `RunEvent::Reopen` handler, the
/// dock right-click menu's "New Window" action (`dock::install_dock_menu`),
/// and — on every desktop platform — the single-instance callback in `run()`,
/// so a plain app re-launch opens a window in the running process instead of
/// spawning a second process. (`tauri::Manager` is imported at module level.)
pub(crate) fn open_or_focus_welcome(app: &tauri::AppHandle) {
```

(The function body stays byte-identical; the redundant inner `use tauri::Manager;` is dropped — line 26 already imports it.)

- [ ] **Step 9: Register single-instance FIRST, then deep-link** — in `editor/src-tauri/src/lib.rs`, replace the two lines at 637-638:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
```

with:

```rust
    let builder = tauri::Builder::default();

    // Single-instance MUST be the FIRST plugin registered (its docs require
    // it) so a second launch is intercepted before any other plugin runs.
    // Owner-approved Windows behavior change (spec C6): N launches used to
    // mean N processes; now one process — a plain re-launch (no deep-link
    // URL in argv) opens/focuses the welcome window instead, preserving the
    // visible "launch again = another window" UX (VS Code/Cursor pattern).
    // The `deep-link` cargo feature forwards any `arcane://`/`arcane-dev://`
    // URL in the second instance's argv to the deep-link plugin — this is
    // how Windows/Linux deliver deep links to a running app.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let scheme_prefix = format!("{}://", auth::deep_link_scheme(app));
        let has_deep_link = argv.iter().skip(1).any(|a| a.starts_with(&scheme_prefix));
        if !has_deep_link {
            open_or_focus_welcome(app);
        }
    }));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
```

- [ ] **Step 10: Register the command** — in the `generate_handler` list, after `auth::get_arcane_home_dir,` (line 754), add:

```rust
            auth::auth_deep_link_scheme,
```

- [ ] **Step 11: Runtime registration on Windows/Linux** — in the `.setup(|_app| {` closure (line 774), insert as the FIRST statement (before the `#[cfg(target_os = "macos")]` block):

```rust
            // Runtime deep-link registration for unbundled runs (`tauri dev`,
            // portable exe) — writes the registry/desktop-file entries the
            // installer would otherwise create. No macOS arm: LaunchServices
            // has no runtime-registration API, so `tauri dev` on macOS cannot
            // receive deep links — the frontend detects this
            // (isBrowserLoginSupported() === false) and defaults to the
            // device-code flow there.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = _app.deep_link().register_all() {
                    eprintln!("[deep-link] register_all failed: {e}");
                }
            }
```

- [ ] **Step 12: Reconcile the stale multi-instance comment** — replace the Windows note at lib.rs lines 788-793 (inside the macOS setup block):

```rust
                // Windows note: a Windows taskbar jumplist "New Window" entry is
                // NOT implemented — Tauri v2 exposes no jumplist API without a
                // custom plugin. Launching the .exe again already opens an
                // independent window (this app registers no single-instance
                // plugin), which is the intended multi-window behavior there.
```

with:

```rust
                // Windows note: a Windows taskbar jumplist "New Window" entry is
                // NOT implemented — Tauri v2 exposes no jumplist API without a
                // custom plugin. The single-instance plugin (registered first in
                // the builder; owner-approved, spec C6) now intercepts re-launches:
                // the callback opens/focuses the welcome window in the running
                // process, so "launch the .exe again = another window" still holds
                // — one process instead of N, which deep links require.
```

- [ ] **Step 13: Verify compile + tests**

Run: `cd editor/src-tauri && cargo test`
Expected: PASS (first run downloads/compiles the two new crates). Then `cargo check` — no warnings about `open_or_focus_welcome` (it is now referenced by the single-instance callback on all desktop platforms).

- [ ] **Step 14: Commit**

```bash
git add editor/src-tauri/Cargo.toml editor/src-tauri/Cargo.lock editor/src-tauri/tauri.conf.json editor/src-tauri/capabilities/default.json editor/src-tauri/src/auth.rs editor/src-tauri/src/lib.rs
git commit -m "feat(auth): deep-link + single-instance plumbing, auth_deep_link_scheme command"
```

---

### Task 2: `browser-login.ts` service + bun tests (TDD)

**Files:**
- Create: `editor/src/features/auth/services/browser-login.ts`
- Test: `editor/src/features/auth/services/browser-login.test.ts`
- Modify: `editor/src/features/auth/index.ts` (barrel)
- Modify: `editor/package.json` (via `bun add`)

**Interfaces:**
- Consumes: `invoke<string>('auth_deep_link_scheme')` (Task 1); `ARCANE_WEB_URL` from `src/config/api.ts`; `openUrl` from `@tauri-apps/plugin-opener` (installed); `onOpenUrl` from `@tauri-apps/plugin-deep-link` (added here).
- Produces (used by Task 3's store and Task 4's AuthTab):
  - `toBase64Url(bytes: Uint8Array): string`
  - `generateState(): string` (22-char base64url), `generateVerifier(): string` (43-char base64url)
  - `challengeS256(verifier: string): Promise<string>`
  - `parseCallback(rawUrl: string, scheme: string): { code: string; state: string } | null`
  - `interface BrowserLoginHandlers { onCode(code: string, verifier: string): void | Promise<void>; onError(message: string): void }`
  - `beginBrowserLogin(handlers: BrowserLoginHandlers, timeoutMs?: number): Promise<void>`
  - `cancelBrowserLogin(): void`
  - `reopenBrowser(): Promise<boolean>`
  - `submitManualCode(code: string): boolean`
  - `isBrowserLoginSupported(): boolean`

Design note (resolves a spec-C2-vs-task-cut tension): the service does NOT call the exchange endpoint itself — it hands `(code, verifier)` to the `onCode` handler after consuming the pending attempt, and the store (Task 3) owns `authClient.exchangeEditorCode`. This keeps browser-login.ts free of auth-client/store imports (fully bun-testable with only Tauri mocks) and lets Tasks 2 and 3 each compile and pass `tsc` independently. All spec C2 invariants (listener-before-open, state match, consume-before-exchange, memory-only verifier) live here.

- [ ] **Step 1: Install the JS plugin bindings**

Run: `cd editor && bun add @tauri-apps/plugin-deep-link`
Expected: `@tauri-apps/plugin-deep-link@^2` added to package.json dependencies.

- [ ] **Step 2: Write the failing test file** — create `editor/src/features/auth/services/browser-login.test.ts`:

```ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// browser-login.ts imports Tauri APIs that don't exist under plain `bun test`
// (no webview). Same pattern as arcane-stream.test.ts: register module mocks
// BEFORE dynamically importing the module under test, and capture calls.
let invokeCalls: string[] = [];
const scheme = 'arcane-dev';
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    invokeCalls.push(cmd);
    if (cmd === 'auth_deep_link_scheme') return scheme;
    throw new Error(`unexpected invoke: ${cmd}`);
  },
}));

let callOrder: string[] = [];
let openedUrls: string[] = [];
mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: async (url: string) => {
    callOrder.push('openUrl');
    openedUrls.push(url);
  },
}));

let deepLinkHandler: ((urls: string[]) => void) | null = null;
mock.module('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    callOrder.push('onOpenUrl');
    deepLinkHandler = handler;
    return () => {
      deepLinkHandler = null;
    };
  },
}));

const bl = await import('./browser-login');

function makeHandlers() {
  const calls: Array<{ code: string; verifier: string }> = [];
  const errors: string[] = [];
  const handlers: import('./browser-login').BrowserLoginHandlers = {
    onCode: (code, verifier) => {
      calls.push({ code, verifier });
    },
    onError: (message) => {
      errors.push(message);
    },
  };
  return { calls, errors, handlers };
}

/** state param of the most recently opened ${WEB}/auth URL. */
function sentState(): string {
  const url = new URL(openedUrls[openedUrls.length - 1]);
  return url.searchParams.get('state')!;
}

beforeEach(() => {
  bl.cancelBrowserLogin(); // reset module-level pending state between tests
  invokeCalls = [];
  callOrder = [];
  openedUrls = [];
  deepLinkHandler = null;
});

describe('generateVerifier', () => {
  it('is exactly 43 chars of base64url (32 random bytes, RFC 7636 minimum)', () => {
    expect(bl.generateVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('differs between calls', () => {
    expect(bl.generateVerifier()).not.toBe(bl.generateVerifier());
  });
});

describe('generateState', () => {
  it('is 22 chars of base64url (16 random bytes)', () => {
    expect(bl.generateState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('challengeS256', () => {
  it('matches the RFC 7636 appendix B known vector', async () => {
    const challenge = await bl.challengeS256(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('satisfies the server-side challenge regex', async () => {
    const challenge = await bl.challengeS256(bl.generateVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });
});

describe('parseCallback', () => {
  it('parses a valid callback', () => {
    expect(
      bl.parseCallback('arcane-dev://auth/callback?code=abc&state=xyz', 'arcane-dev'),
    ).toEqual({ code: 'abc', state: 'xyz' });
  });

  it.each([
    ['wrong scheme', 'arcane://auth/callback?code=a&state=s'],
    ['https scheme', 'https://auth/callback?code=a&state=s'],
    ['wrong host', 'arcane-dev://evil/callback?code=a&state=s'],
    ['wrong path', 'arcane-dev://auth/evil?code=a&state=s'],
    ['path suffix', 'arcane-dev://auth/callback-evil?code=a&state=s'],
    ['missing code', 'arcane-dev://auth/callback?state=s'],
    ['missing state', 'arcane-dev://auth/callback?code=a'],
    ['not a url at all', 'garbage'],
  ])('rejects %s', (_name, url) => {
    expect(bl.parseCallback(url, 'arcane-dev')).toBeNull();
  });
});

describe('beginBrowserLogin', () => {
  it('registers the deep-link listener BEFORE opening the browser', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    expect(callOrder).toEqual(['onOpenUrl', 'openUrl']);
    expect(invokeCalls).toContain('auth_deep_link_scheme');
  });

  it('opens ${WEB}/auth with flow=editor, state, S256 challenge, scheme', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const url = new URL(openedUrls[0]);
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('flow')).toBe('editor');
    expect(url.searchParams.get('scheme')).toBe('arcane-dev');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('completes on a state-matching callback and consumes the attempt (replay guard)', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    const url = `arcane-dev://auth/callback?code=C1&state=${sentState()}`;
    h([url]);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('C1');
    expect(calls[0].verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deepLinkHandler).toBeNull(); // listener torn down on consume
    h([url]); // replayed URL — pending already consumed
    expect(calls).toHaveLength(1);
    expect(bl.submitManualCode('C1')).toBe(false); // nothing pending anymore
  });

  it('ignores a state-mismatched callback and stays pending', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    h(['arcane-dev://auth/callback?code=EVIL&state=WRONG']);
    expect(calls).toHaveLength(0);
    h([`arcane-dev://auth/callback?code=C2&state=${sentState()}`]); // still pending
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('C2');
  });

  it('cancel-then-callback is ignored', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    const state = sentState();
    bl.cancelBrowserLogin();
    h([`arcane-dev://auth/callback?code=C3&state=${state}`]);
    expect(calls).toHaveLength(0);
  });

  it('restart tears down the previous attempt (old state no longer accepted)', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const firstState = sentState();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    h([`arcane-dev://auth/callback?code=OLD&state=${firstState}`]);
    expect(calls).toHaveLength(0);
    h([`arcane-dev://auth/callback?code=NEW&state=${sentState()}`]);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('NEW');
  });

  it('times out, reports an error, and clears the attempt', async () => {
    const { calls, errors, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers, 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(errors).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(bl.submitManualCode('LATE')).toBe(false);
  });
});

describe('submitManualCode', () => {
  it('delivers the trimmed pasted code with the held verifier (same consume path)', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const challenge = new URL(openedUrls[0]).searchParams.get('challenge')!;
    expect(bl.submitManualCode('  MANUAL1  ')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('MANUAL1');
    // PKCE binding preserved: the delivered verifier hashes to the sent challenge.
    expect(await bl.challengeS256(calls[0].verifier)).toBe(challenge);
    expect(bl.submitManualCode('MANUAL1')).toBe(false); // consumed
  });

  it('returns false when nothing is pending', () => {
    expect(bl.submitManualCode('NOPE')).toBe(false);
  });
});

describe('reopenBrowser', () => {
  it('re-opens the SAME url (state/challenge unchanged)', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    expect(await bl.reopenBrowser()).toBe(true);
    expect(openedUrls).toHaveLength(2);
    expect(openedUrls[1]).toBe(openedUrls[0]);
  });

  it('returns false when nothing is pending', async () => {
    expect(await bl.reopenBrowser()).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd editor && bun test src/features/auth/services/browser-login.test.ts`
Expected: FAIL — cannot resolve `./browser-login`.

- [ ] **Step 4: Implement the service** — create `editor/src/features/auth/services/browser-login.ts`:

```ts
// Browser-based login via deep link + PKCE (spec Part C2).
//
// Pure helpers (generateState/generateVerifier/challengeS256/parseCallback)
// are exported for unit tests. The stateful flow holds ONE pending attempt in
// module memory. Invariants (spec C2/C5):
//   - the PKCE verifier is MEMORY-ONLY — never persisted; a cold-start deep
//     link therefore cannot complete a login, by design
//   - the deep-link listener exists only while an attempt is pending; stale
//     URLs replayed by the plugin's getCurrent() on registration fail the
//     state check and are ignored
//   - the pending attempt is CONSUMED (pending = null, listener + timer torn
//     down) BEFORE code+verifier are handed to `onCode` — a replayed callback
//     URL finds no pending attempt (replay guard)
//   - multi-window: the deep-link event broadcasts to every webview, but only
//     the initiating window's module instance holds a matching `state`, so
//     completion lands in the initiator with no routing logic.
//
// The exchange itself (POST /v1/auth/editor/exchange) is NOT done here — the
// auth store's beginBrowserLogin action supplies `onCode` and owns exchange +
// UI state transitions. That keeps this module free of auth-client/store
// dependencies and fully testable under bun with only Tauri API mocks.
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { ARCANE_WEB_URL } from '../../../config/api';

// ── Pure helpers ────────────────────────────────────────────────────────────

/** bytes → base64url without padding (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** CSRF state echoed back in the deep link: base64url(16 random bytes) = 22 chars. */
export function generateState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** PKCE verifier: base64url(32 random bytes) = 43 chars (RFC 7636 minimum). */
export function generateVerifier(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * challenge = base64url(SHA-256(ascii(verifier))) — matches the server's
 * `/^[A-Za-z0-9_-]{43,128}$/` validation on /v1/auth/editor/grant.
 */
export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export interface ParsedCallback {
  code: string;
  state: string;
}

/**
 * Strict parse of `${scheme}://auth/callback?code=…&state=…`. Returns null
 * for anything else (wrong scheme, wrong host/path, missing params).
 * Deliberately string-prefix based instead of `new URL()`: WHATWG parsers
 * disagree across webviews about non-special (custom) schemes, and a prefix
 * check is exact and portable.
 */
export function parseCallback(rawUrl: string, scheme: string): ParsedCallback | null {
  const prefix = `${scheme}://auth/callback`;
  if (!rawUrl.startsWith(prefix)) return null;
  const rest = rawUrl.slice(prefix.length);
  // Allow exactly "" or "?…" — rejects e.g. `arcane://auth/callback-evil`.
  if (rest !== '' && !rest.startsWith('?')) return null;
  const params = new URLSearchParams(rest.startsWith('?') ? rest.slice(1) : '');
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return null;
  return { code, state };
}

// ── Stateful flow ───────────────────────────────────────────────────────────

export interface BrowserLoginHandlers {
  /**
   * Called at most once per attempt with the one-time grant code and the PKCE
   * verifier, AFTER the pending attempt has been consumed (replay guard).
   * The handler owns the exchange (`authClient.exchangeEditorCode`).
   */
  onCode: (code: string, verifier: string) => void | Promise<void>;
  /** Attempt-level failure (currently: the 10-minute timeout). */
  onError: (message: string) => void;
}

interface PendingAttempt {
  state: string;
  verifier: string;
  scheme: string;
  /** Full `${ARCANE_WEB_URL}/auth?…` URL, kept for "Open browser again". */
  url: string;
  handlers: BrowserLoginHandlers;
  unlisten: UnlistenFn | null;
  timer: ReturnType<typeof setTimeout>;
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

let pending: PendingAttempt | null = null;

function teardown(): void {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);
  if (p.unlisten) {
    try {
      p.unlisten();
    } catch {
      // Listener already gone (window teardown race) — nothing to do.
    }
  }
}

/** Consume the pending attempt FIRST (replay guard), then deliver. */
function consumeAndDeliver(code: string): void {
  const p = pending;
  if (!p) return;
  teardown(); // pending = null BEFORE onCode runs — replayed URLs find nothing
  void p.handlers.onCode(code, p.verifier);
}

function handleDeepLinkUrls(urls: string[]): void {
  for (const url of urls) {
    if (!pending) return; // consumed/cancelled — ignore the rest
    const parsed = parseCallback(url, pending.scheme);
    if (!parsed) {
      console.warn('[browser-login] ignoring non-callback deep link:', url);
      continue;
    }
    if (parsed.state !== pending.state) {
      console.warn('[browser-login] deep link state mismatch — ignoring');
      continue;
    }
    consumeAndDeliver(parsed.code);
    return;
  }
}

/**
 * Start (or restart — any pending attempt is torn down first, spec C5) a
 * browser login. Registers the deep-link listener BEFORE opening the browser
 * so a fast callback cannot be missed. `timeoutMs` is overridable for tests.
 */
export async function beginBrowserLogin(
  handlers: BrowserLoginHandlers,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
): Promise<void> {
  teardown();

  const state = generateState();
  const verifier = generateVerifier();
  const challenge = await challengeS256(verifier);
  const scheme = await invoke<string>('auth_deep_link_scheme');

  const params = new URLSearchParams({ flow: 'editor', state, challenge, scheme });
  const url = `${ARCANE_WEB_URL}/auth?${params.toString()}`;

  const timer = setTimeout(() => {
    teardown();
    handlers.onError('Sign-in timed out. Click "Continue in browser" to try again.');
  }, timeoutMs);

  pending = { state, verifier, scheme, url, handlers, unlisten: null, timer };

  // Register BEFORE openUrl. onOpenUrl also replays any startup/current URLs
  // on registration — those carry a stale (or no) state and are ignored above.
  const unlisten = await onOpenUrl(handleDeepLinkUrls);
  if (!pending || pending.state !== state) {
    // Cancelled or restarted while awaiting registration.
    unlisten();
    return;
  }
  pending.unlisten = unlisten;

  await openUrl(url);
}

/** Abort the pending attempt: verifier discarded, later callbacks ignored. */
export function cancelBrowserLogin(): void {
  teardown();
}

/** Re-open the SAME auth URL (state/challenge unchanged). False if nothing pending. */
export async function reopenBrowser(): Promise<boolean> {
  const p = pending;
  if (!p) return false;
  await openUrl(p.url);
  return true;
}

/**
 * Manual-paste fallback (spec C2): the code shown on the website's
 * /auth/success page is the SAME one-time grant code the deep link would
 * carry, so it goes through the SAME consume-then-exchange path — PKCE
 * binding to the held verifier preserved. NOT the device flow.
 * Returns false when no attempt is pending (or the code is blank).
 */
export function submitManualCode(code: string): boolean {
  if (!pending) return false;
  const trimmed = code.trim();
  if (!trimmed) return false;
  consumeAndDeliver(trimmed);
  return true;
}

/**
 * Deep links need OS-level scheme registration. Windows/Linux self-register at
 * runtime (`register_all()` in Rust setup), so even `tauri dev` works there.
 * macOS registers only via an installed .app bundle — under `tauri dev` on
 * macOS the device-code flow is the default sign-in path instead (spec C3).
 */
export function isBrowserLoginSupported(): boolean {
  const isMac = navigator.userAgent.includes('Macintosh');
  return !(isMac && import.meta.env.DEV);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd editor && bun test src/features/auth/services/browser-login.test.ts`
Expected: PASS — all describe blocks green.

- [ ] **Step 6: Export through the barrel** — replace the full contents of `editor/src/features/auth/index.ts`:

```ts
export { default as AuthTab } from './components/AuthTab';
export { authClient } from './services/auth-client';
export {
  beginBrowserLogin,
  cancelBrowserLogin,
  submitManualCode,
  reopenBrowser,
  isBrowserLoginSupported,
  type BrowserLoginHandlers,
} from './services/browser-login';
```

- [ ] **Step 7: Full verification**

Run (from `editor/`): `bun test src && bunx tsc --noEmit && bun run check:modules`
Expected: all green (nothing outside the feature imports the new internals yet).

- [ ] **Step 8: Commit**

```bash
git add editor/src/features/auth/services/browser-login.ts editor/src/features/auth/services/browser-login.test.ts editor/src/features/auth/index.ts editor/package.json editor/bun.lock
git commit -m "feat(auth): browser-login service — PKCE helpers, deep-link flow, replay guard (bun tests)"
```

---

### Task 3: `exchangeEditorCode` + store `loginStatus`/actions (additive; old surface deleted in Task 4)

**Files:**
- Modify: `editor/src/features/auth/services/auth-client.ts` (add interface + method; deletions happen in Task 4)
- Modify: `editor/src/stores/auth.ts` (full rewrite shown below)

**Interfaces:**
- Consumes: `beginBrowserLogin`/`cancelBrowserLogin`/`submitManualCode` + `BrowserLoginHandlers` from the auth barrel (Task 2); existing `authClient.loadFromDisk`/`logout`/`saveToken`.
- Produces:
  - `authClient.exchangeEditorCode(code: string, verifier: string): Promise<ExchangeResult>` where `interface ExchangeResult { success: boolean; error?: string; user?: { id: string; email: string; role: string; emailVerified: boolean } }`
  - Store: `export type LoginStatus = 'idle' | 'waiting-browser' | 'exchanging' | 'error'`; state field `loginStatus: LoginStatus`; actions `beginBrowserLogin(): Promise<void>`, `cancelBrowserLogin(): void`, `submitManualCode(code: string): void`; `logout()` and successful logins now `emit('auth-changed')`; `loadFromDisk()` resets auth state when the token file is missing.
  - Transitional: `loading`/`login`/`signup` remain (marked `@deprecated`) so AuthTab still compiles; Task 4 deletes them.

- [ ] **Step 1: Add `ExchangeResult` + `exchangeEditorCode` to the client** — in `editor/src/features/auth/services/auth-client.ts`, insert after the `DeviceTokenResult` interface (line 23):

```ts
export interface ExchangeResult {
  success: boolean;
  error?: string;
  user?: { id: string; email: string; role: string; emailVerified: boolean };
}
```

and insert this method inside `class AuthClient`, directly before `async requestDeviceCode(...)`:

```ts
  /**
   * Redeem the one-time grant code from the browser flow (deep link or
   * manual paste — same code either way) for a full session token.
   * The server returns a single opaque `invalid_code` for every failure
   * mode (expired, replayed, verifier mismatch) by design.
   */
  async exchangeEditorCode(code: string, verifier: string): Promise<ExchangeResult> {
    try {
      const res = await fetch(`${this.serverUrl}/v1/auth/editor/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        return {
          success: false,
          error:
            data.error === 'invalid_code'
              ? 'Invalid or expired code. Start the sign-in again.'
              : `Sign-in failed (${res.status})`,
        };
      }

      const data = (await res.json()) as {
        token: string;
        user: { id: string; email: string; role: string; emailVerified: boolean };
      };
      await this.saveToken(data.token, data.user.email);
      return { success: true, user: data.user };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }
```

- [ ] **Step 2: Rewrite the store** — replace the full contents of `editor/src/stores/auth.ts`:

```ts
import { create } from 'zustand';
import { emit } from '@tauri-apps/api/event';
import {
  authClient,
  beginBrowserLogin as serviceBeginBrowserLogin,
  cancelBrowserLogin as serviceCancelBrowserLogin,
  submitManualCode as serviceSubmitManualCode,
} from '../features/auth';

export type LoginStatus = 'idle' | 'waiting-browser' | 'exchanging' | 'error';

interface AuthState {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  token: string | null;
  /** @deprecated superseded by loginStatus — deleted with the AuthTab rework (Task 4). */
  loading: boolean;
  loginStatus: LoginStatus;
  error: string | null;

  /** @deprecated in-app credential login — deleted with the AuthTab rework (Task 4). */
  login: (email: string, password: string) => Promise<boolean>;
  /** @deprecated in-app signup — deleted with the AuthTab rework (Task 4). */
  signup: (email: string, password: string, promoCode?: string) => Promise<boolean>;
  /** Open the website auth page in the browser; completes via deep link,
   * manual code paste, or the 10-minute timeout. */
  beginBrowserLogin: () => Promise<void>;
  cancelBrowserLogin: () => void;
  /** Manual-paste fallback — same grant code + exchange endpoint, NOT device flow. */
  submitManualCode: (code: string) => void;
  logout: () => Promise<void>;
  loadFromDisk: () => Promise<void>;
}

function isJwtExpired(token: string): boolean {
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded);
    const data = JSON.parse(decoded) as { exp?: number };
    if (typeof data.exp !== 'number') return false;
    // 30s skew to avoid edge-expiry requests.
    return Date.now() >= data.exp * 1000 - 30_000;
  } catch {
    return false;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  loggedIn: false,
  email: null,
  plan: null,
  token: null,
  loading: false,
  loginStatus: 'idle',
  error: null,

  login: async (email: string, password: string) => {
    set({ loading: true, error: null });
    const result = await authClient.login(email, password);
    if (result.success && result.user) {
      const stored = await authClient.loadFromDisk().catch(() => null);
      set({
        loggedIn: true,
        email: result.user.email,
        plan: result.user.plan,
        token: stored?.token ?? null,
        loading: false,
        error: null,
      });
      return true;
    } else {
      set({ loading: false, error: result.error ?? 'Login failed' });
      return false;
    }
  },

  signup: async (email: string, password: string, promoCode?: string) => {
    set({ loading: true, error: null });
    const result = await authClient.signup(email, password, promoCode);
    if (result.success && result.user) {
      const stored = await authClient.loadFromDisk().catch(() => null);
      set({
        loggedIn: true,
        email: result.user.email,
        plan: result.user.plan,
        token: stored?.token ?? null,
        loading: false,
        error: null,
      });
      return true;
    } else {
      set({ loading: false, error: result.error ?? 'Signup failed' });
      return false;
    }
  },

  beginBrowserLogin: async () => {
    set({ loginStatus: 'waiting-browser', error: null });
    try {
      await serviceBeginBrowserLogin({
        // Runs AFTER the service consumed the pending attempt (replay guard);
        // this handler owns the exchange + resulting UI state.
        onCode: async (code, verifier) => {
          set({ loginStatus: 'exchanging' });
          const result = await authClient.exchangeEditorCode(code, verifier);
          if (result.success && result.user) {
            // exchangeEditorCode saved the token to disk; read it back for
            // in-memory API clients (arcane-stream etc. read store.token).
            const stored = await authClient.loadFromDisk().catch(() => null);
            set({
              loggedIn: true,
              email: result.user.email,
              // The exchange response carries no plan (contract:
              // {id, email, role, emailVerified}); /me can hydrate it later.
              plan: null,
              token: stored?.token ?? null,
              loginStatus: 'idle',
              error: null,
            });
            void emit('auth-changed');
          } else {
            set({ loginStatus: 'error', error: result.error ?? 'Sign-in failed' });
          }
        },
        onError: (message) => set({ loginStatus: 'error', error: message }),
      });
    } catch (err) {
      serviceCancelBrowserLogin();
      set({
        loginStatus: 'error',
        error: err instanceof Error ? err.message : 'Could not open the browser',
      });
    }
  },

  cancelBrowserLogin: () => {
    serviceCancelBrowserLogin();
    set({ loginStatus: 'idle', error: null });
  },

  submitManualCode: (code: string) => {
    // On success the onCode handler registered by beginBrowserLogin drives
    // 'exchanging' → success/error, exactly like the deep-link path.
    if (!serviceSubmitManualCode(code)) {
      set({
        loginStatus: 'error',
        error: 'No sign-in attempt in progress — click "Continue in browser" first.',
      });
    }
  },

  logout: async () => {
    serviceCancelBrowserLogin();
    await authClient.logout();
    set({ loggedIn: false, email: null, plan: null, token: null, loginStatus: 'idle', error: null });
    void emit('auth-changed');
  },

  loadFromDisk: async () => {
    const stored = await authClient.loadFromDisk();
    if (!stored) {
      // Token file missing — e.g. logout happened in ANOTHER window (spec C3)
      // or a fresh install. Reset instead of silently keeping stale state.
      set({ loggedIn: false, email: null, plan: null, token: null, error: null });
      return;
    }

    if (isJwtExpired(stored.token)) {
      await authClient.logout().catch(() => {});
      set({ loggedIn: false, email: null, plan: null, token: null, error: null });
      return;
    }

    set({
      loggedIn: true,
      email: stored.email,
      token: stored.token,
    });
  },
}));
```

- [ ] **Step 3: Verify**

Run (from `editor/`): `bun test src && bunx tsc --noEmit && bun run check:modules`
Expected: all green — AuthTab still compiles against the deprecated `loading`/`login`/`signup`, which still exist.

- [ ] **Step 4: Commit**

```bash
git add editor/src/features/auth/services/auth-client.ts editor/src/stores/auth.ts
git commit -m "feat(auth): exchangeEditorCode + store loginStatus/browser-login actions (auth-changed emits)"
```

---

### Task 4: AuthTab rework + delete legacy credential surface + cross-window `auth-changed` sync

**Files:**
- Modify: `editor/src/features/auth/components/AuthTab.tsx` (full rewrite shown)
- Modify: `editor/src/features/auth/services/auth-client.ts` (delete `login`/`signup`/`handleRefreshToken`/`AuthResult`; final file shown)
- Modify: `editor/src/stores/auth.ts` (delete deprecated members; exact edits shown)
- Modify: `editor/src/App.tsx` (one new effect after line ~265)

**Interfaces:**
- Consumes: store `loginStatus`/`beginBrowserLogin`/`cancelBrowserLogin`/`submitManualCode`/`logout`/`loadFromDisk` (Task 3); `isBrowserLoginSupported`/`reopenBrowser` from `../services/browser-login` (Task 2; direct import is fine — same feature); `authClient.requestDeviceCode`/`pollDeviceToken` (existing); `listenScoped`/`safeUnlisten` from `src/utils/tauri-listener` (existing); `emit` from `@tauri-apps/api/event`.
- Produces: the final UI; every login/logout path emits `auth-changed`; every window reloads auth state on that event. After this task `authClient.login`, `authClient.signup`, store `login`/`signup`/`loading`, and the dead X-Refreshed-Token handling no longer exist anywhere.

- [ ] **Step 1: Rewrite AuthTab** — replace the full contents of `editor/src/features/auth/components/AuthTab.tsx`:

```tsx
import { useState } from 'react';
import { Globe, KeyRound, Loader2, LogOut, RotateCw, Smartphone, X } from 'lucide-react';
import { emit } from '@tauri-apps/api/event';
import { useAuthStore } from '../../../stores/auth';
import { authClient } from '../services/auth-client';
import { isBrowserLoginSupported, reopenBrowser } from '../services/browser-login';

function AuthTab() {
  const {
    loggedIn,
    email,
    plan,
    loginStatus,
    error,
    beginBrowserLogin,
    cancelBrowserLogin,
    submitManualCode,
    logout,
  } = useAuthStore();
  // Device flow is the DEFAULT where deep links cannot work — macOS `tauri dev`
  // (spec C3). Everywhere else the browser flow is primary.
  const [mode, setMode] = useState<'browser' | 'device'>(
    isBrowserLoginSupported() ? 'browser' : 'device',
  );
  const [showPaste, setShowPaste] = useState(false);
  const [pasteCode, setPasteCode] = useState('');

  // Device flow state (kept as fallback; endpoints unchanged)
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const startBrowserLogin = () => {
    setShowPaste(false);
    setPasteCode('');
    void beginBrowserLogin();
  };

  const handleDeviceFlow = async () => {
    try {
      const response = await authClient.requestDeviceCode();
      setDeviceCode(response.device_code);
      setUserCode(response.user_code);
      setVerificationUri(response.verification_uri);
      setPolling(true);

      // Poll for authorization
      const interval = setInterval(async () => {
        try {
          const result = await authClient.pollDeviceToken(response.device_code);
          if (result.status === 'authorized') {
            clearInterval(interval);
            setPolling(false);
            setDeviceCode(null);
            // pollDeviceToken saved the token to disk — pull it into the
            // store (fixes the pre-existing "store token stays null until
            // restart" gap), then broadcast to the other windows.
            await useAuthStore.getState().loadFromDisk();
            if (result.user) {
              useAuthStore.setState({ plan: result.user.plan ?? null });
            }
            void emit('auth-changed');
          } else if (result.status === 'expired') {
            clearInterval(interval);
            setPolling(false);
            setDeviceCode(null);
            useAuthStore.setState({ error: 'Device code expired. Try again.' });
          }
        } catch {
          clearInterval(interval);
          setPolling(false);
        }
      }, 5000);
    } catch (err) {
      useAuthStore.setState({ error: err instanceof Error ? err.message : 'Device flow failed' });
    }
  };

  if (loggedIn) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 600 }}>Account</h2>
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>Email</div>
            <div style={{ fontSize: 14 }}>{email}</div>
          </div>
          {plan && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>Plan</div>
              <div style={{ fontSize: 14, textTransform: 'capitalize' }}>{plan}</div>
            </div>
          )}
          <button onClick={() => void logout()} style={dangerBtnStyle}>
            <LogOut size={14} />
            Sign Out
          </button>
          {isBrowserLoginSupported() && (
            <button
              onClick={() => {
                void (async () => {
                  await logout();
                  startBrowserLogin();
                })();
              }}
              style={{ ...linkBtnStyle, marginTop: 12, display: 'block' }}
            >
              Switch account…
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>
          {mode === 'browser' ? 'Sign In' : 'Device Sign In'}
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-secondary)' }}>
          Sign in to access AI features and sync settings
        </p>

        {error && (
          <div
            style={{
              padding: '8px 12px',
              marginBottom: 12,
              background: 'var(--error-bg)',
              border: '1px solid var(--error-border)',
              borderRadius: 4,
              fontSize: 12,
              color: 'var(--error-text)',
            }}
          >
            {error}
          </div>
        )}

        {mode === 'browser' ? (
          <div>
            {(loginStatus === 'idle' || loginStatus === 'error') && (
              <button onClick={startBrowserLogin} style={primaryBtnStyle}>
                <Globe size={14} />
                Continue in browser
              </button>
            )}

            {loginStatus === 'waiting-browser' && (
              <div>
                <div style={spinnerRowStyle}>
                  <Loader2 size={12} className="animate-spin" />
                  Complete sign-in in your browser…
                </div>
                <button onClick={() => void reopenBrowser()} style={secondaryBtnStyle}>
                  <RotateCw size={14} />
                  Open browser again
                </button>
                <button
                  onClick={cancelBrowserLogin}
                  style={{ ...secondaryBtnStyle, marginTop: 8 }}
                >
                  <X size={14} />
                  Cancel
                </button>
                <button
                  onClick={() => setShowPaste((v) => !v)}
                  style={{ ...linkBtnStyle, marginTop: 12, display: 'block' }}
                >
                  <KeyRound size={12} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
                  Browser didn't open? Paste the code
                </button>
                {showPaste && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      type="text"
                      value={pasteCode}
                      onChange={(e) => setPasteCode(e.target.value)}
                      placeholder="Code from the success page"
                      style={{ ...inputStyle, marginBottom: 8 }}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                    <button
                      disabled={!pasteCode.trim()}
                      onClick={() => {
                        submitManualCode(pasteCode);
                        setPasteCode('');
                      }}
                      style={primaryBtnStyle}
                    >
                      Submit code
                    </button>
                  </div>
                )}
              </div>
            )}

            {loginStatus === 'exchanging' && (
              <div style={spinnerRowStyle}>
                <Loader2 size={12} className="animate-spin" />
                Signing you in…
              </div>
            )}
          </div>
        ) : (
          <div>
            {!deviceCode ? (
              <button onClick={handleDeviceFlow} disabled={polling} style={primaryBtnStyle}>
                <Smartphone size={14} />
                Generate Device Code
              </button>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Enter this code at:
                </div>
                <div style={{ fontSize: 12, color: 'var(--info)', marginBottom: 12 }}>
                  {verificationUri}
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: 4,
                    padding: '12px 0',
                    background: 'var(--bg-input)',
                    borderRadius: 6,
                    marginBottom: 12,
                  }}
                >
                  {userCode}
                </div>
                {polling && (
                  <div style={spinnerRowStyle}>
                    <Loader2 size={12} className="animate-spin" />
                    Waiting for authorization...
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 12, fontSize: 12 }}>
          {mode === 'browser' && (
            <button
              onClick={() => {
                cancelBrowserLogin();
                setShowPaste(false);
                setMode('device');
              }}
              style={linkBtnStyle}
            >
              Use a device code instead
            </button>
          )}
          {mode === 'device' && isBrowserLoginSupported() && (
            <button
              onClick={() => {
                useAuthStore.setState({ error: null });
                setMode('browser');
              }}
              style={linkBtnStyle}
            >
              Sign in with browser
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  height: '100%',
  overflow: 'auto',
  padding: '48px 24px',
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 380,
  background: 'var(--bg-sidebar)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 24,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 16px',
  background: 'var(--button-primary-bg)',
  border: 'none',
  borderRadius: 4,
  color: 'var(--button-primary-text)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
};

const secondaryBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  fontWeight: 500,
};

const dangerBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: 'var(--button-danger-bg)',
  color: 'var(--button-danger-text)',
};

const linkBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
};

const spinnerRowStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  marginBottom: 12,
};

export default AuthTab;
```

(Deleted vs the old file: email/password/confirm/promo form, `handleSubmit`, `labelStyle`, the login/signup mode links, `LogIn`/`UserPlus` icons. Kept byte-similar: signed-in card, device-flow UI, container/card/input/button styles.)

- [ ] **Step 2: Delete the legacy client surface** — replace the full contents of `editor/src/features/auth/services/auth-client.ts`:

```ts
// Auth API client. In-app credential login/signup was removed in Phase 3
// (browser-based deep-link login, spec Part C); the device-code flow stays
// as the fallback for environments without deep links (macOS `tauri dev`).
// The old X-Refreshed-Token handling was dead code (the server never sends
// that header) and was removed with it (spec C6 optional cleanup).
import { invoke } from '@tauri-apps/api/core';
import { ARCANE_API_URL } from '../../../config/api';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResult {
  status: 'authorized' | 'pending' | 'expired';
  token?: string;
  user?: { email: string; plan: string };
}

export interface ExchangeResult {
  success: boolean;
  error?: string;
  user?: { id: string; email: string; role: string; emailVerified: boolean };
}

export class AuthClient {
  private serverUrl: string = ARCANE_API_URL;

  /**
   * Redeem the one-time grant code from the browser flow (deep link or
   * manual paste — same code either way) for a full session token.
   * The server returns a single opaque `invalid_code` for every failure
   * mode (expired, replayed, verifier mismatch) by design.
   */
  async exchangeEditorCode(code: string, verifier: string): Promise<ExchangeResult> {
    try {
      const res = await fetch(`${this.serverUrl}/v1/auth/editor/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        return {
          success: false,
          error:
            data.error === 'invalid_code'
              ? 'Invalid or expired code. Start the sign-in again.'
              : `Sign-in failed (${res.status})`,
        };
      }

      const data = (await res.json()) as {
        token: string;
        user: { id: string; email: string; role: string; emailVerified: boolean };
      };
      await this.saveToken(data.token, data.user.email);
      return { success: true, user: data.user };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }

  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const res = await fetch(`${this.serverUrl}/v1/auth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Failed to request device code (${res.status})`);
    }

    return res.json() as Promise<DeviceCodeResponse>;
  }

  async pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const res = await fetch(`${this.serverUrl}/v1/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });

    if (!res.ok) {
      throw new Error(`Device token poll failed (${res.status})`);
    }

    const data = (await res.json()) as DeviceTokenResult;

    if (data.status === 'authorized' && data.token && data.user) {
      await this.saveToken(data.token, data.user.email);
    }

    return data;
  }

  async loadFromDisk(): Promise<{ token: string; email: string } | null> {
    try {
      const result = await invoke<{ token: string; email: string } | null>('auth_read_token');
      return result;
    } catch {
      return null;
    }
  }

  async logout(): Promise<void> {
    await invoke('auth_delete_token');
  }

  private async saveToken(token: string, email: string): Promise<void> {
    await invoke('auth_write_token', { token, email });
  }
}

export const authClient = new AuthClient();
```

- [ ] **Step 3: Delete the deprecated store members** — in `editor/src/stores/auth.ts` (as written in Task 3):
  1. Remove these interface lines:
     - `/** @deprecated superseded by loginStatus — deleted with the AuthTab rework (Task 4). */` and `loading: boolean;`
     - `/** @deprecated in-app credential login — deleted with the AuthTab rework (Task 4). */` and `login: (email: string, password: string) => Promise<boolean>;`
     - `/** @deprecated in-app signup — deleted with the AuthTab rework (Task 4). */` and `signup: (email: string, password: string, promoCode?: string) => Promise<boolean>;`
  2. Remove the `loading: false,` initial-state line.
  3. Remove the entire `login: async (email: string, password: string) => { … },` implementation block (ends with `return false;\n    }\n  },`) and the entire `signup: async (…) => { … },` block.

- [ ] **Step 4: Cross-window auth sync in App.tsx** — in `editor/src/App.tsx`, directly AFTER the "Native menu (macOS)" effect (its closing `}, []);` is at line ~265), insert:

```tsx
  // Cross-window auth sync (spec C3): any window that completes a login or
  // logout emits 'auth-changed'; every window — emitter included, harmlessly —
  // re-reads token state from disk. Closes the pre-existing "window B stale
  // after login in window A" gap. listenScoped: receives global emit() plus
  // emit_to(ownLabel) only (no cross-window crosstalk).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listenScoped('auth-changed', () => {
        void useAuthStore.getState().loadFromDisk();
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);
```

(`listenScoped`, `safeUnlisten`, and `useAuthStore` are already imported in App.tsx — verified.)

- [ ] **Step 5: Verify nothing references the deleted surface**

Run (from `editor/`):
```bash
grep -rn "authClient\.login\|authClient\.signup\|handleRefreshToken\|X-Refreshed-Token" src ; grep -rn "\.loading\b" src/features/auth src/stores/auth.ts
```
Expected: no output from either grep.

- [ ] **Step 6: Full verification**

Run (from `editor/`): `bun test src && bunx tsc --noEmit && bun run check:modules`
Expected: all green.

- [ ] **Step 7: Dev-mode smoke (macOS)**

Run: `cd editor && bunx tauri dev`, open the Account tab (AI panel → Sign In).
Expected: the DEVICE-CODE UI is the default (isBrowserLoginSupported() === false under `tauri dev` on macOS) with a "Sign in with browser" link; no email/password form anywhere. Optionally run the device flow end-to-end against dev.arcaneai.org/auth/device (Phase 2b is live).

- [ ] **Step 8: Commit**

```bash
git add editor/src/features/auth/components/AuthTab.tsx editor/src/features/auth/services/auth-client.ts editor/src/stores/auth.ts editor/src/App.tsx
git commit -m "feat(auth): browser-first AuthTab, cross-window auth-changed sync, drop in-app credential forms"
```

---

### Task 5: Arcane Dev build + manual deep-link verification

**Files:**
- No source changes expected (except the possible `deep-link:allow-get-current` capability addition from Task 1 step 7's caveat).

**Interfaces:**
- Consumes: everything above; the LIVE dev stack (website dev.arcaneai.org, API api-dev.arcaneai.org); `.github/workflows/dev-build.yml` (exists — for the Windows installer artifact).
- Produces: a verified, installable Arcane Dev build and a completed manual checklist. This is the merge gate for the phase.

- [ ] **Step 1: Automated gates green** (from `editor/`):

```bash
bun test src && bunx tsc --noEmit && bun run check:modules && (cd src-tauri && cargo test)
```
Expected: all pass.

- [ ] **Step 2: Build a bundled Arcane Dev on macOS.** Shell env outranks every .env file (verified in the spec), so a local dev-flavored PROD build is:

```bash
cd editor
CI= bun run build:lsp-sidecars   # skip if binaries/ sidecars already built
VITE_ARCANE_API_URL=https://api-dev.arcaneai.org \
VITE_ARCANE_WEB_URL=https://dev.arcaneai.org \
bunx tauri build --config src-tauri/tauri.dev.conf.json
```
Expected: `src-tauri/target/release/bundle/macos/Arcane Dev.app` (and a .dmg). Note: `bunx tauri build`, NOT `bun run tauri build` (release.yml gotcha).

- [ ] **Step 3: Verify scheme registration + capability**

```bash
plutil -p "editor/src-tauri/target/release/bundle/macos/Arcane Dev.app/Contents/Info.plist" | grep -B2 -A4 URLSchemes
grep -rn "deep-link" editor/src-tauri/gen/schemas/desktop-schema.json | head -5
```
Expected: `CFBundleURLSchemes` contains exactly `arcane-dev`; the generated schema lists `deep-link:default` permissions including `allow-get-current`. If `allow-get-current` is NOT in the default set, add `"deep-link:allow-get-current"` to `editor/src-tauri/capabilities/default.json`, rebuild, and commit that change.

- [ ] **Step 4: Manual checklist — run each and mark it here:**

  - [ ] **Real end-to-end browser login (the phase's proof).** Launch `Arcane Dev.app` (first launch registers the scheme with LaunchServices) → Account tab → "Continue in browser" → browser opens `https://dev.arcaneai.org/auth?flow=editor&state=…&challenge=…&scheme=arcane-dev` → sign in with email/password → Authorize → `arcane-dev://auth/callback` deep link fires → app shows signed-in card. Verify token: `cat ~/.arcane-dev/auth.json` (0600). AI chat streams via api-dev (`cd arcane-server && wrangler tail --env dev`). NOTE: Google login + Turnstile are pending owner dashboard config — email/password is the e2e path today.
  - [ ] **Wrong state ignored.** Start a login attempt, then in Terminal: `open "arcane-dev://auth/callback?code=FAKE&state=BOGUS"` → app focuses, nothing happens (console shows the state-mismatch warn; UI still "waiting"). The real callback afterwards still completes.
  - [ ] **Cancel-then-callback ignored.** Start an attempt, copy the `state` param from the browser address bar, click Cancel in the app, then `open "arcane-dev://auth/callback?code=FAKE&state=<copied state>"` → ignored, app stays signed out at 'idle'.
  - [ ] **Cold-start deep link.** Quit Arcane Dev fully, then `open "arcane-dev://auth/callback?code=X&state=Y"` → the app LAUNCHES, no crash, no login (memory-only verifier — spec C5).
  - [ ] **Manual paste-code path.** Start an attempt → complete the browser login → on `/auth/success` copy the one-time code → in the app expand "Paste the code" → paste → Submit → signed in (same exchange endpoint; works even if the deep link itself was swallowed).
  - [ ] **Timeout + retry.** (Optional, 10 min) Start an attempt, wait out the timeout → error state with a working "Continue in browser" retry.
  - [ ] **macOS `tauri dev` fallback.** `bunx tauri dev` → Account tab defaults to the device-code UI; device flow completes against `dev.arcaneai.org/auth/device`.
  - [ ] **Two-window completion lands in the initiator.** Open two project windows (Dock → New Window), start login in window A only, complete in browser → A transitions waiting→signed-in; B (which never had a pending state) shows signed-in via the `auth-changed` reload — its AI panel gate clears. Sign out from B → A reflects signed-out.
  - [ ] **Windows: registry + single-instance + relaunch UX.** Trigger `dev-build.yml` (push to `dev` touching `editor/**`, or workflow dispatch), install `ArcaneDevSetup.exe`, then: `reg query HKCR\arcane-dev` shows the ProgID; launching the .exe a second time does NOT spawn a second process (Task Manager) — it opens/focuses the welcome window (owner-approved change, spec C6); `start "" "arcane-dev://auth/callback?code=FAKE&state=BOGUS"` focuses the app and is ignored; full browser login works via the argv-forwarding path.

- [ ] **Step 5: Record results + commit any capability fix**

```bash
git add -A && git commit -m "chore(auth): phase-3 deep-link verification pass"   # only if step 3 required the capability addition or checklist notes were added
```

---

## Self-review (performed while writing)

- **Spec C coverage:** C1 → Task 1 (crates, conf plugins, capability, single-instance-first + welcome un-gate, register_all, `auth_deep_link_scheme`, `bun add` in Task 2 step 1). C2 → Tasks 2+3 (service + store + exchange + barrel + manual-code-same-endpoint). C3 → Task 4 (AuthTab rework incl. device-default + Switch account; auth-changed emit/listen). C4 → Task 2 test file (verifier charset/length, S256 vector, parseCallback matrix, state-mismatch, replay guard). C5 edge cases → cold start (memory-only verifier, Task 5 check), replay/expired (opaque invalid_code mapping, Task 3), re-login teardown (service `teardown()` at begin + test), signed-in switch account (Task 4), 401 stream logout unchanged (store logout signature kept, now also emits). C6 → Windows comment update (Task 1 step 12), exchange contract baked into Global Constraints, X-Refreshed-Token cleanup (Task 4 step 2).
- **Splice accuracy:** all Modify targets were read at their current state on 2026-07-18; line anchors and verbatim old-code blocks come from that read (lib.rs 588-616/637-638/751-754/774/788-793; auth-client.ts line 26; App.tsx 251-265).
- **Deviation from the suggested task cut, with reason:** the exchange call lives in the store's `onCode` handler instead of inside browser-login.ts, and Task 3 keeps `loading`/`login`/`signup` as deprecated until Task 4 — both so that every task ends with `bun test` + `tsc` green (deleting the store surface before AuthTab's rework would leave tsc red between tasks).
- **Type consistency:** `BrowserLoginHandlers.onCode(code, verifier)` (T2) = what the store passes (T3); `ExchangeResult` defined in T3 step 1 verbatim-identical to the T4 step 2 final file; `LoginStatus` union matches AuthTab's checks; `auth_deep_link_scheme` returns bare `String` and TS invokes `invoke<string>`.
