# Phase 2b — Website Auth Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every website auth page from design spec Part B2 (`docs/superpowers/specs/2026-07-18-dev-env-and-website-auth-design.md`) against the LIVE Phase 2a server already deployed at `https://api-dev.arcaneai.org`: `/auth` hub (email/password + Google + editor deep-link grant), `/auth/success`, `/auth/device`, `/verify`, `/forgot`, `/reset`, `/account`, plus a Navbar sign-in link.

**Architecture:** Astro 5 **static SSG — NO adapter**. Every auth page is a thin `.astro` wrapper rendering one `client:load` React island inside `LandingLayout` (exact pattern of `src/pages/admin.astro` + `components/admin/AdminPanel.tsx`). All server interaction is client-side `fetch` from `src/lib/auth.ts`; the session JWT lives in localStorage. The editor deep-link context (`state`/`challenge`/`scheme`) and the post-grant handoff live in sessionStorage via a new pure-helper module `src/lib/editor-login.ts`.

**Tech Stack:** Astro 5 (`@astrojs/react`), React 19, TypeScript (strict, `@/*` → `src/*` alias, `react-jsx`), Tailwind CSS **3** (site utility classes: `glass`, `text-gradient-orange`, `glow-orange-sm`, shadcn-style tokens `bg-primary`/`text-muted-foreground`/`border-border`/`bg-destructive`), lucide-react, `pnpm` (v9), Cloudflare Pages via `.github/workflows/deploy-landing.yml`.

## Global Constraints

**Live server contract (authoritative — match EXACTLY; base URL = `PUBLIC_API_URL`, dev = `https://api-dev.arcaneai.org`). "Bearer" = `Authorization: Bearer <jwt>` header.**

| Route | Request | Success | Errors |
|---|---|---|---|
| `POST /v1/auth/signup` | `{email,password[,cf-turnstile-response]}` | 200 `{token, user:{id,email,role,emailVerified}}` | 400 `{error:'invalid_email'\|'weak_password'}`; 409 `{error:'google_account'}`; 400 `{error:'turnstile_failed'}` (only when server `TURNSTILE_SECRET` set) |
| `POST /v1/auth/login` | `{email,password[,cf-turnstile-response]}` | 200 `{token,user}` | 401 `{error:'Invalid credentials'}` (**prose string, NOT a code** — Phase 2b owns mapping it); 401 `{error:'use_google'}` |
| `GET /v1/auth/me` | Bearer | 200 `{user:{id,email,role,emailVerified}, hasPassword, googleLinked, usage:{totalRequests,totalInputTokens,totalOutputTokens}}` | 401 |
| `POST /v1/auth/verify` | `{token}` | 200 `{token,user}` (fresh JWT) | 400 `{error:'invalid_token'}` |
| `POST /v1/auth/resend-verification` | Bearer, no body | 200 `{ok:true}` | 429 `{error:'resend_throttled'}` |
| `POST /v1/auth/forgot` | `{email}` | **always** 200 `{ok:true}` | — (anti-enumeration) |
| `POST /v1/auth/reset` | `{token,newPassword}` | 200 `{token,user}` (fresh JWT; server bumps token_version → all other sessions die) | 400 `{error:'invalid_token'\|'weak_password'}` |
| `POST /v1/auth/change-password` | Bearer, `{currentPassword,newPassword}` | 200 `{token,user}` (fresh JWT — store it, old one is dead) | 401 `{error:'invalid_credentials'}`; 400 `{error:'no_password_set'}` |
| `GET /v1/auth/google/start?return_to=<path>` | full-page navigation, NOT fetch | 302 to Google | 302 to `${WEB}/auth?error=google_not_configured` when unconfigured |
| Google callback (server-side) | — | 302 to `${WEB}${return_to}?code=<web_login code>` | 302 to `${WEB}/auth?error=google_oauth_failed` |
| `POST /v1/auth/web/exchange` | `{code}` | 200 `{token,user}` | 400 `{error:'invalid_code'}` |
| `POST /v1/auth/editor/grant` | Bearer, `{challenge}` (base64url, 43–128 chars) | 200 `{code, expires_in:60}` | 400 `{error:'invalid_challenge'}` |
| `POST /v1/auth/device/code` | (editor calls this, not us) | 200 `{...,verification_uri,user_code}` | — |
| `POST /v1/auth/device/authorize` | Bearer, `{user_code}` | 200 | error `{error:...}` |

**Hard rules (every task inherits these):**

- localStorage token key: `arcane_auth_token` (existing — reuse `getStoredToken`/`setStoredToken`/`clearStoredToken`; never invent a second key).
- sessionStorage keys (new, defined once in `editor-login.ts`): `arcane_editor_login_request`, `arcane_editor_login_handoff`, `arcane_post_auth_return`.
- Deep-link scheme allowlist: `['arcane', 'arcane-dev']` — reject anything else with a hard error screen; **never build a deep link for a non-allowlisted scheme**.
- Deep link format: `${scheme}://auth/callback?code=<grantCode>&state=<state>` (both values URL-encoded).
- `challenge` validation: base64url charset `[A-Za-z0-9_-]`, length 43–128. `state` validation: length 1–256.
- Server `return_to` allowlist (for `googleStartUrl`): exactly `/auth`, `/auth/device`, `/account` — pass nothing else.
- Internal `?return=` param: honored only if it starts with `/` and does NOT start with `//` (blocks external + protocol-relative redirects).
- One error-code→friendly-message map (`authErrorMessage` in `auth.ts`) handles ALL codes above **plus** the prose string `Invalid credentials` and the redirect-error params `google_not_configured` / `google_oauth_failed`. UI never shows raw codes.
- Secrets hygiene: strip `?code=`, `?token=`, `?error=`, and editor params from the URL via `history.replaceState` immediately after capture.
- Graceful degradation (owner hasn't configured Turnstile/Google yet): render NO Turnstile widget when `PUBLIC_TURNSTILE_SITE_KEY` is unset/empty; Google button always renders — the server 302s back with `?error=google_not_configured`, shown as a friendly banner. Email/password, editor-grant, and device flows are FULLY testable on dev today. (Verification emails only arrive once Phase 2a email onboarding is done — the pages must not assume the email arrived.)
- Editor grant works while unverified — only AI endpoints are gated server-side. Do not block the grant on `emailVerified`.
- Astro/SSR safety: islands are pre-rendered at build time. NO `window`/`localStorage`/`sessionStorage` access at module top level or in the initial render path — only inside `useEffect`/event handlers (existing `getStoredToken` already guards `typeof window`).
- Style: copy the existing idiom — `glass rounded-2xl p-8` cards, `AdminPanel` input/button classes, `font-display` headings, `text-muted-foreground` copy, `bg-destructive/10 border border-destructive/20` error banners. 4-space indent in new tsx/ts (matches `AdminPanel.tsx`/`auth.ts`); 2-space in `Navbar.tsx` edits (matches that file).
- **TESTING GATE (every task):** `cd /Users/inno/Documents/experiments/arcane-editor/landing-page && pnpm build` exits 0, plus the task's manual browser checks. There is NO test harness in landing-page and this plan does NOT stand one up. Pure helpers (`editor-login.ts`, `authErrorMessage`) are written framework-free so a lightweight vitest could cover them later — documented option only, not required.
- Local manual checks run against the dev API: `cd landing-page && PUBLIC_API_URL=https://api-dev.arcaneai.org pnpm dev` → http://localhost:4321 (Phase 2a CORS allowlist includes `localhost:4321`).
- Do not touch `arcane-server/` or `editor/` — Phase 2a is live, Phase 3 (app) is separate.

## File Map

**Create:**
- `landing-page/src/lib/editor-login.ts` — pure helpers + sessionStorage plumbing (T1)
- `landing-page/src/components/auth/AuthShell.tsx` — shared centered card wrapper (T2)
- `landing-page/src/components/auth/TurnstileWidget.tsx` — optional Turnstile island child (T2)
- `landing-page/src/components/auth/AuthHub.tsx` + `landing-page/src/pages/auth/index.astro` (T2)
- `landing-page/src/components/auth/AuthSuccess.tsx` + `landing-page/src/pages/auth/success.astro` (T3)
- `landing-page/src/components/auth/VerifyEmail.tsx` + `landing-page/src/pages/verify.astro` (T4)
- `landing-page/src/components/auth/ForgotPassword.tsx` + `landing-page/src/pages/forgot.astro` (T4)
- `landing-page/src/components/auth/ResetPassword.tsx` + `landing-page/src/pages/reset.astro` (T4)
- `landing-page/src/components/auth/DeviceAuthorize.tsx` + `landing-page/src/pages/auth/device.astro` (T5)
- `landing-page/src/components/auth/AccountPanel.tsx` + `landing-page/src/pages/account.astro` (T6)

**Modify:**
- `landing-page/src/lib/auth.ts` — types, error map, new API calls (T1)
- `landing-page/src/components/Navbar.tsx` — Sign in / Account link (T6)
- `.github/workflows/deploy-landing.yml` — `PUBLIC_TURNSTILE_SITE_KEY` (T7)

Resolved ambiguities (defaults chosen where the spec was silent):
1. Flow pages (`/auth`, `/auth/success`, `/auth/device`, `/verify`, `/forgot`, `/reset`) follow the `admin.astro` pattern — island only, no Navbar/Footer (no distractions mid-flow; "Back to home" links instead). `/account` is a destination page → gets Navbar + Footer like `features.astro`.
2. The internal `?return=` must survive the Google redirect; the server's `return_to` allowlist is exact-path so it can't carry it. Solution: stash it in sessionStorage (`arcane_post_auth_return`) and always send `return_to=/auth` from the hub.
3. On a failed editor grant the user IS authenticated, so we show a dedicated error screen ("return to the editor and retry"), not the sign-in forms.
4. `pnpm build` (`astro build`) is the compile gate; it catches import/JSX/astro errors. `pnpm astro check` would add full type-checking but needs a new dev dependency (`@astrojs/check`) — documented option, not required.

---

### Task 1: Auth lib extensions + editor-login helpers

**Files:**
- Modify: `landing-page/src/lib/auth.ts`
- Create: `landing-page/src/lib/editor-login.ts`

**Interfaces:**
- Consumes: existing `API_URL`/`TOKEN_KEY` constants and storage helpers in `auth.ts` (unchanged).
- Produces (later tasks import these EXACT names):
  - `auth.ts`: `AuthUser` (now with `emailVerified: boolean`), `AuthResponse`, `MeResponse` (now with `hasPassword: boolean; googleLinked: boolean`), `authErrorMessage(codeOrMessage: string): string`, `apiLogin(email, password, turnstileToken?)`, `apiSignup(email, password, turnstileToken?)`, `googleStartUrl(returnTo: '/auth' | '/auth/device' | '/account'): string`, `apiWebExchange(code: string): Promise<AuthResponse>`, `apiEditorGrant(token: string, challenge: string): Promise<{code: string; expires_in: number}>`, `apiVerifyEmail(verifyToken: string): Promise<AuthResponse>`, `apiResendVerification(token: string): Promise<void>`, `apiForgot(email: string): Promise<void>`, `apiReset(resetToken: string, newPassword: string): Promise<AuthResponse>`, `apiChangePassword(token: string, currentPassword: string, newPassword: string): Promise<AuthResponse>`.
  - `editor-login.ts`: `SCHEME_ALLOWLIST`, `EditorScheme`, `EditorLoginRequest`, `EditorHandoff`, `isAllowedScheme`, `isValidChallenge`, `isValidState`, `parseEditorLoginParams(params: URLSearchParams): EditorLoginParseResult`, `saveEditorLoginRequest`, `loadEditorLoginRequest`, `clearEditorLoginRequest`, `saveEditorHandoff`, `loadEditorHandoff`, `clearEditorHandoff`, `buildDeepLink(scheme, code, state): string`, `sanitizeInternalReturn(raw: string | null): string | null`, `savePostAuthReturn(path: string): void`, `takePostAuthReturn(): string | null`.

- [ ] **Step 1: Rewrite the types + add the error map in `landing-page/src/lib/auth.ts`**

Replace the current `AuthUser`/`MeResponse` interfaces (lines 4–22) with:

```ts
export interface AuthUser {
    id: number;
    email: string;
    role: string;
    emailVerified: boolean;
}

export interface AuthResponse {
    token: string;
    user: AuthUser;
}

export interface MeResponse {
    user: AuthUser;
    hasPassword: boolean;
    googleLinked: boolean;
    usage: {
        totalRequests: number;
        totalInputTokens: number;
        totalOutputTokens: number;
    };
}
```

(`AdminPanel.tsx` defines its own `AdminUser` type and never uses `AuthUser`/`MeResponse`, so this is safe — verify with a grep in Step 4.)

Then add, directly below the `MeResponse` interface:

```ts
// ─── Error messages ─────────────────────────────────────────
// Single source of truth mapping server error codes (and the one prose-string
// quirk: login returns `Invalid credentials`, not a code) to friendly copy.
// Also covers the ?error= values the Google redirect can land with.

const ERROR_MESSAGES: Record<string, string> = {
    'Invalid credentials': 'Incorrect email or password.',
    invalid_credentials: 'Incorrect email or password.',
    use_google: 'This account signs in with Google. Use "Continue with Google" instead.',
    google_account: 'An account with this email already uses Google sign-in. Use "Continue with Google".',
    invalid_email: "That doesn't look like a valid email address.",
    weak_password: 'Password must be at least 8 characters.',
    invalid_token: 'This link is invalid or has expired. Request a new one and try again.',
    resend_throttled: "You've requested too many verification emails. Try again in an hour.",
    invalid_code: 'This code is invalid or has expired. Start the sign-in again.',
    invalid_challenge: "The editor's sign-in request was invalid. Return to Arcane and click Sign in again.",
    no_password_set: 'This account has no password yet. Use "Set a password" on your account page.',
    turnstile_failed: 'Human verification failed. Refresh the page and try again.',
    google_not_configured: "Google sign-in isn't set up yet. Use email and password instead.",
    google_oauth_failed: 'Google sign-in failed. Please try again.',
};

export function authErrorMessage(codeOrMessage: string | undefined | null): string {
    if (!codeOrMessage) return 'Something went wrong. Please try again.';
    return ERROR_MESSAGES[codeOrMessage] ?? codeOrMessage;
}
```

- [ ] **Step 2: Extend `apiLogin`/`apiSignup` with optional Turnstile token**

Replace the existing `apiLogin` and `apiSignup` functions with:

```ts
export async function apiLogin(email: string, password: string, turnstileToken?: string): Promise<AuthResponse> {
    const body: Record<string, string> = { email, password };
    if (turnstileToken) body['cf-turnstile-response'] = turnstileToken;
    const res = await fetch(`${API_URL}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Login failed');
    }
    return res.json();
}

export async function apiSignup(email: string, password: string, turnstileToken?: string): Promise<AuthResponse> {
    const body: Record<string, string> = { email, password };
    if (turnstileToken) body['cf-turnstile-response'] = turnstileToken;
    const res = await fetch(`${API_URL}/v1/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Signup failed');
    }
    return res.json();
}
```

(Existing callers — `AdminPanel.handleAdminLogin` calls `apiLogin(email, password)` — still compile: the new param is optional. API functions keep throwing `Error` whose `.message` is the RAW server code; UI layers pass it through `authErrorMessage`. AdminPanel keeps showing the raw message — "Invalid credentials" reads fine there — no change needed.)

- [ ] **Step 3: Add the new API calls to `auth.ts`**

Insert after `apiAuthorizeDevice` (before the `// ─── Admin API Calls` section):

```ts
// ─── Phase 2b auth API calls ────────────────────────────────

export function googleStartUrl(returnTo: '/auth' | '/auth/device' | '/account'): string {
    // Full-page navigation target (302 to Google), NOT a fetch endpoint.
    // returnTo must be on the server's allowlist: /auth, /auth/device, /account.
    return `${API_URL}/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}

export async function apiWebExchange(code: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/web/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_code');
    }
    return res.json();
}

export async function apiEditorGrant(token: string, challenge: string): Promise<{ code: string; expires_in: number }> {
    const res = await fetch(`${API_URL}/v1/auth/editor/grant`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ challenge }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_challenge');
    }
    return res.json();
}

export async function apiVerifyEmail(verifyToken: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: verifyToken }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_token');
    }
    return res.json();
}

export async function apiResendVerification(token: string): Promise<void> {
    const res = await fetch(`${API_URL}/v1/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Resend failed');
    }
}

export async function apiForgot(email: string): Promise<void> {
    // Server ALWAYS returns 200 {ok:true} (anti-enumeration); this throws only
    // on network/5xx failures.
    const res = await fetch(`${API_URL}/v1/auth/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error('Request failed');
}

export async function apiReset(resetToken: string, newPassword: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_token');
    }
    return res.json();
}

export async function apiChangePassword(token: string, currentPassword: string, newPassword: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/change-password`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_credentials');
    }
    return res.json();
}
```

- [ ] **Step 4: Confirm no existing consumer broke**

Run: `grep -rn "AuthUser\|MeResponse\|apiGetMe\|apiLogin\|apiSignup" /Users/inno/Documents/experiments/arcane-editor/landing-page/src --include="*.tsx" --include="*.ts" --include="*.astro"`
Expected: only `lib/auth.ts` itself and `components/admin/AdminPanel.tsx` (which uses `apiLogin(email, password)` — fine) match. No other consumer of the changed types exists today.

- [ ] **Step 5: Create `landing-page/src/lib/editor-login.ts`** (complete file)

```ts
// Editor deep-link login flow: pure validators + sessionStorage plumbing.
// Framework-free on purpose — a lightweight vitest could cover the pure
// functions later (documented option; no test harness exists in landing-page
// today and this module must not require one).

export const SCHEME_ALLOWLIST = ['arcane', 'arcane-dev'] as const;
export type EditorScheme = (typeof SCHEME_ALLOWLIST)[number];

export interface EditorLoginRequest {
    state: string;      // app-generated CSRF token, echoed verbatim in the deep link (1-256 chars)
    challenge: string;  // PKCE S256 challenge, base64url 43-128 chars
    scheme: EditorScheme;
}

export interface EditorHandoff {
    deepLink: string;   // `${scheme}://auth/callback?code=...&state=...`
    code: string;       // one-time grant code (~60s TTL) for the manual-paste fallback
}

const REQUEST_KEY = 'arcane_editor_login_request';
const HANDOFF_KEY = 'arcane_editor_login_handoff';
const RETURN_KEY = 'arcane_post_auth_return';

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const DEEP_LINK_RE = /^(arcane|arcane-dev):\/\/auth\/callback\?/;

// ─── Pure validators ────────────────────────────────────────

export function isAllowedScheme(scheme: string): scheme is EditorScheme {
    return (SCHEME_ALLOWLIST as readonly string[]).includes(scheme);
}

export function isValidChallenge(challenge: string): boolean {
    return CHALLENGE_RE.test(challenge);
}

export function isValidState(state: string): boolean {
    return state.length >= 1 && state.length <= 256;
}

export type EditorLoginParseResult =
    | { ok: true; request: EditorLoginRequest }
    | { ok: false; error: string };

/** Parse `?flow=editor&state=&challenge=&scheme=` params. Caller has already
 *  checked `flow === 'editor'`. Never builds a deep link on failure. */
export function parseEditorLoginParams(params: URLSearchParams): EditorLoginParseResult {
    const state = params.get('state') ?? '';
    const challenge = params.get('challenge') ?? '';
    const scheme = params.get('scheme') ?? '';
    if (!isAllowedScheme(scheme)) {
        return {
            ok: false,
            error: `This sign-in link asked to open an app link ("${scheme || 'none'}://") this site doesn't recognize, so we stopped for your safety. Update Arcane, then click Sign in again from the editor.`,
        };
    }
    if (!isValidChallenge(challenge)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad challenge). Return to Arcane and click Sign in again.' };
    }
    if (!isValidState(state)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad state). Return to Arcane and click Sign in again.' };
    }
    return { ok: true, request: { state, challenge, scheme } };
}

export function buildDeepLink(scheme: EditorScheme, code: string, state: string): string {
    return `${scheme}://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

/** Internal post-login redirect target: must start with '/' but not '//'
 *  (blocks external and protocol-relative redirects). Null when rejected. */
export function sanitizeInternalReturn(raw: string | null): string | null {
    if (!raw) return null;
    if (!raw.startsWith('/') || raw.startsWith('//')) return null;
    return raw;
}

// ─── sessionStorage plumbing (SSR-safe) ─────────────────────

function storageAvailable(): boolean {
    return typeof window !== 'undefined' && !!window.sessionStorage;
}

export function saveEditorLoginRequest(req: EditorLoginRequest): void {
    if (!storageAvailable()) return;
    sessionStorage.setItem(REQUEST_KEY, JSON.stringify(req));
}

export function loadEditorLoginRequest(): EditorLoginRequest | null {
    if (!storageAvailable()) return null;
    const raw = sessionStorage.getItem(REQUEST_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as EditorLoginRequest;
        // Re-validate on load — sessionStorage is same-origin writable; never trust it blindly.
        if (!isAllowedScheme(parsed.scheme) || !isValidChallenge(parsed.challenge) || !isValidState(parsed.state)) {
            sessionStorage.removeItem(REQUEST_KEY);
            return null;
        }
        return parsed;
    } catch {
        sessionStorage.removeItem(REQUEST_KEY);
        return null;
    }
}

export function clearEditorLoginRequest(): void {
    if (storageAvailable()) sessionStorage.removeItem(REQUEST_KEY);
}

export function saveEditorHandoff(handoff: EditorHandoff): void {
    if (!storageAvailable()) return;
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
}

export function loadEditorHandoff(): EditorHandoff | null {
    if (!storageAvailable()) return null;
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as EditorHandoff;
        if (typeof parsed.deepLink !== 'string' || typeof parsed.code !== 'string'
            || parsed.code.length === 0 || !DEEP_LINK_RE.test(parsed.deepLink)) {
            sessionStorage.removeItem(HANDOFF_KEY);
            return null;
        }
        return parsed;
    } catch {
        sessionStorage.removeItem(HANDOFF_KEY);
        return null;
    }
}

export function clearEditorHandoff(): void {
    if (storageAvailable()) sessionStorage.removeItem(HANDOFF_KEY);
}

export function savePostAuthReturn(path: string): void {
    if (!storageAvailable()) return;
    if (sanitizeInternalReturn(path)) sessionStorage.setItem(RETURN_KEY, path);
}

/** Read-and-clear the stashed internal return path (sanitized again on read). */
export function takePostAuthReturn(): string | null {
    if (!storageAvailable()) return null;
    const raw = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return sanitizeInternalReturn(raw);
}
```

- [ ] **Step 6: Build gate**

Run: `cd /Users/inno/Documents/experiments/arcane-editor/landing-page && pnpm build`
Expected: exit 0, `dist/` produced, no new warnings about `lib/`.

- [ ] **Step 7: Commit**

```bash
git add landing-page/src/lib/auth.ts landing-page/src/lib/editor-login.ts
git commit -m "feat(landing): auth lib — error map, new API calls, editor-login helpers"
```

**Verification:** `pnpm build` green. No manual browser check yet (nothing renders these); T2 exercises everything here.

---

### Task 2: `/auth` hub (state machine)

**Files:**
- Create: `landing-page/src/components/auth/AuthShell.tsx`
- Create: `landing-page/src/components/auth/TurnstileWidget.tsx`
- Create: `landing-page/src/components/auth/AuthHub.tsx`
- Create: `landing-page/src/pages/auth/index.astro`

**Interfaces:**
- Consumes (from T1): everything listed in T1's Produces block — `apiLogin`, `apiSignup`, `apiGetMe`, `apiWebExchange`, `apiEditorGrant`, `googleStartUrl`, `authErrorMessage`, storage helpers from `auth.ts`; `parseEditorLoginParams`, `saveEditorLoginRequest`, `loadEditorLoginRequest`, `clearEditorLoginRequest`, `saveEditorHandoff`, `buildDeepLink`, `sanitizeInternalReturn`, `savePostAuthReturn`, `takePostAuthReturn` from `editor-login.ts`.
- Produces (later tasks import): `AuthShell` (named export) `({ children, wide? }) => JSX` used by T3/T4/T5; `TurnstileWidget` (default export, props `{ onToken: (token: string) => void }`) and `turnstileEnabled(): boolean` (named export). `AuthHub` is the page island (default export, no props).

**AuthHub mount state machine (spec B2 step 3 — implement in THIS order):**
1. `?flow=editor` → validate `state`/`challenge`/`scheme` (`parseEditorLoginParams`); invalid scheme/params → strip URL, hard error screen, STOP (never build the deep link). Valid → `saveEditorLoginRequest`.
2. Capture `?return=` (sanitized) → sessionStorage stash; capture `?code=`/`?error=`; then strip ALL query params via `history.replaceState`.
3. `?code=` (Google return) → `apiWebExchange(code)` → `setStoredToken` → continue as authenticated.
4. `?error=` → friendly banner above the forms.
5. Authenticated (stored token validated via `apiGetMe`; 401 → clear token) + pending editor request → `apiEditorGrant(token, challenge)` → `buildDeepLink` → `saveEditorHandoff` → `clearEditorLoginRequest` → `window.location.href = '/auth/success'`.
6. Authenticated, no editor request → `takePostAuthReturn() ?? '/account'`.
7. Otherwise → Sign in / Create account tabs (Turnstile slot only when `PUBLIC_TURNSTILE_SITE_KEY` set) + "Continue with Google" (`window.location.href = googleStartUrl('/auth')`).

- [ ] **Step 1: Create `landing-page/src/components/auth/AuthShell.tsx`** (complete file)

```tsx
import type { ReactNode } from "react";

/** Centered glass card used by all auth-flow pages (matches admin login card). */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
    return (
        <div className="min-h-screen flex items-center justify-center px-4 py-16">
            <div className={`glass rounded-2xl p-8 w-full ${wide ? "max-w-md" : "max-w-sm"}`}>
                {children}
            </div>
        </div>
    );
}

/** Shared field styling (copied from AdminPanel's login form). */
export const authInputClass =
    "h-10 rounded-md border border-border bg-secondary/50 px-3 text-sm text-foreground outline-none focus:border-primary transition-colors w-full";

export const authPrimaryBtnClass =
    "h-10 w-full rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all disabled:opacity-50";

export const authErrorBannerClass =
    "mb-4 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive";
```

- [ ] **Step 2: Create `landing-page/src/components/auth/TurnstileWidget.tsx`** (complete file)

```tsx
import { useEffect, useRef } from "react";

// Graceful degradation: when PUBLIC_TURNSTILE_SITE_KEY is unset (owner hasn't
// created the widget yet) this component renders NOTHING and forms submit
// without a cf-turnstile-response. The server only enforces Turnstile when
// its own TURNSTILE_SECRET is set.
const SITE_KEY: string | undefined = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

declare global {
    interface Window {
        turnstile?: {
            render: (el: HTMLElement, opts: Record<string, unknown>) => string;
            remove: (id: string) => void;
            reset: (id: string) => void;
        };
    }
}

export function turnstileEnabled(): boolean {
    return typeof SITE_KEY === "string" && SITE_KEY.length > 0;
}

function loadScript(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (window.turnstile) { resolve(); return; }
        const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
        if (existing) {
            existing.addEventListener("load", () => resolve());
            return;
        }
        const s = document.createElement("script");
        s.src = SCRIPT_SRC;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("turnstile script failed to load"));
        document.head.appendChild(s);
    });
}

export default function TurnstileWidget({ onToken }: { onToken: (token: string) => void }) {
    const container = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!turnstileEnabled()) return;
        let widgetId: string | null = null;
        let cancelled = false;
        void loadScript()
            .then(() => {
                if (cancelled || !container.current || !window.turnstile) return;
                widgetId = window.turnstile.render(container.current, {
                    sitekey: SITE_KEY,
                    theme: "dark",
                    callback: (token: string) => onToken(token),
                    "expired-callback": () => onToken(""),
                    "error-callback": () => onToken(""),
                });
            })
            .catch(() => { /* script blocked/offline: degrade, server decides */ });
        return () => {
            cancelled = true;
            if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!turnstileEnabled()) return null;
    return <div ref={container} className="min-h-[65px]" />;
}
```

- [ ] **Step 3: Create `landing-page/src/components/auth/AuthHub.tsx`** (complete file)

```tsx
import { useState, useEffect, useRef } from "react";
import {
    getStoredToken, setStoredToken, clearStoredToken,
    apiLogin, apiSignup, apiGetMe, apiWebExchange, apiEditorGrant,
    googleStartUrl, authErrorMessage,
} from "@/lib/auth";
import {
    parseEditorLoginParams, saveEditorLoginRequest, loadEditorLoginRequest,
    clearEditorLoginRequest, saveEditorHandoff, buildDeepLink,
    sanitizeInternalReturn, savePostAuthReturn, takePostAuthReturn,
} from "@/lib/editor-login";
import TurnstileWidget, { turnstileEnabled } from "./TurnstileWidget";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

type HubState = "boot" | "hard-error" | "forms";
type Tab = "signin" | "signup";

export default function AuthHub() {
    const [state, setState] = useState<HubState>("boot");
    const [bootMessage, setBootMessage] = useState("Loading…");
    const [hardError, setHardError] = useState("");
    const [banner, setBanner] = useState("");
    const [editorPending, setEditorPending] = useState(false);
    const [tab, setTab] = useState<Tab>("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [formError, setFormError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    // Ref, not state: the Turnstile callback fires outside React's render cycle
    // and the token is only read on submit.
    const turnstileToken = useRef("");

    /** Post-login continuation: editor grant → /auth/success; else internal return → /account. */
    const afterAuthenticated = async (token: string): Promise<void> => {
        const pending = loadEditorLoginRequest();
        if (pending) {
            setState("boot");
            setBootMessage("Connecting to Arcane…");
            try {
                const grant = await apiEditorGrant(token, pending.challenge);
                saveEditorHandoff({
                    deepLink: buildDeepLink(pending.scheme, grant.code, pending.state),
                    code: grant.code,
                });
                clearEditorLoginRequest();
                window.location.href = "/auth/success";
            } catch (err) {
                clearEditorLoginRequest();
                setHardError(
                    `Couldn't finish signing in to the editor: ${authErrorMessage((err as Error).message)} ` +
                    "You are signed in on this site — return to Arcane and click Sign in again."
                );
                setState("hard-error");
            }
            return;
        }
        window.location.href = takePostAuthReturn() ?? "/account";
    };

    useEffect(() => {
        void (async () => {
            const params = new URLSearchParams(window.location.search);

            // (1) Editor deep-link request — validate BEFORE anything else.
            if (params.get("flow") === "editor") {
                const parsed = parseEditorLoginParams(params);
                if (!parsed.ok) {
                    window.history.replaceState(null, "", window.location.pathname);
                    setHardError(parsed.error);
                    setState("hard-error");
                    return;
                }
                saveEditorLoginRequest(parsed.request);
            }

            // (2) Capture, then strip, remaining params (codes/errors must not linger in history).
            const ret = sanitizeInternalReturn(params.get("return"));
            if (ret) savePostAuthReturn(ret);
            const code = params.get("code");
            const errorParam = params.get("error");
            if (window.location.search) {
                window.history.replaceState(null, "", window.location.pathname);
            }

            setEditorPending(loadEditorLoginRequest() !== null);

            // (3) Google return: swap the one-time ?code= for a session token.
            if (code) {
                setBootMessage("Signing you in…");
                try {
                    const data = await apiWebExchange(code);
                    setStoredToken(data.token);
                    await afterAuthenticated(data.token);
                } catch (err) {
                    setBanner(authErrorMessage((err as Error).message));
                    setState("forms");
                }
                return;
            }

            // (4) Redirect errors (e.g. google_not_configured, google_oauth_failed).
            if (errorParam) {
                setBanner(authErrorMessage(errorParam));
                setState("forms");
                return;
            }

            // (5)/(6) Existing session?
            const token = getStoredToken();
            if (token) {
                try {
                    await apiGetMe(token); // server-side validation (catches expiry/version bump)
                    await afterAuthenticated(token);
                    return;
                } catch {
                    clearStoredToken();
                }
            }

            // (7) No session — show the forms.
            setState("forms");
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSubmit = async () => {
        if (!email || !password) { setFormError("Email and password are required."); return; }
        if (tab === "signup" && password.length < 8) { setFormError(authErrorMessage("weak_password")); return; }
        setSubmitting(true);
        setFormError("");
        try {
            const data = tab === "signin"
                ? await apiLogin(email, password, turnstileToken.current || undefined)
                : await apiSignup(email, password, turnstileToken.current || undefined);
            setStoredToken(data.token);
            await afterAuthenticated(data.token);
        } catch (err) {
            setFormError(authErrorMessage((err as Error).message));
            setSubmitting(false);
        }
    };

    if (state === "boot") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">{bootMessage}</p>
            </AuthShell>
        );
    }

    if (state === "hard-error") {
        return (
            <AuthShell wide>
                <h1 className="font-display text-2xl font-bold mb-3 text-center">Can't continue</h1>
                <div className={authErrorBannerClass}>{hardError}</div>
                <a href="/" className="block mt-4 text-center text-primary text-sm hover:underline">Back to home</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">
                {tab === "signin" ? "Sign in" : "Create account"}
            </h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                {editorPending
                    ? "The Arcane editor is asking to sign in. Finish here and you'll be sent back to the app."
                    : "Sign in to Arcane to use AI features"}
            </p>

            {banner && <div className={authErrorBannerClass}>{banner}</div>}

            {/* Tabs */}
            <div className="flex gap-1 border-b border-border/50 mb-5">
                {([["signin", "Sign in"], ["signup", "Create account"]] as [Tab, string][]).map(([id, label]) => (
                    <button
                        key={id}
                        onClick={() => { setTab(id); setFormError(""); }}
                        className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                            tab === id
                                ? "border-primary text-primary"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {formError && <div className={authErrorBannerClass}>{formError}</div>}

            <div className="flex flex-col gap-3">
                <input
                    className={authInputClass}
                    placeholder="Email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />
                <input
                    className={authInputClass}
                    placeholder={tab === "signup" ? "Password (min 8 characters)" : "Password"}
                    type="password"
                    autoComplete={tab === "signup" ? "new-password" : "current-password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />

                {turnstileEnabled() && (
                    <TurnstileWidget onToken={t => { turnstileToken.current = t; }} />
                )}

                <button className={authPrimaryBtnClass} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Working…" : tab === "signin" ? "Sign In" : "Create Account"}
                </button>
            </div>

            {tab === "signin" && (
                <a href="/forgot" className="block mt-3 text-center text-primary text-sm hover:underline">
                    Forgot password?
                </a>
            )}

            {/* Divider */}
            <div className="flex items-center gap-3 my-5">
                <div className="h-px flex-1 bg-border/50" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="h-px flex-1 bg-border/50" />
            </div>

            <button
                className="h-10 w-full rounded-md border border-border bg-secondary/50 text-sm font-semibold text-foreground hover:border-primary transition-colors flex items-center justify-center gap-2"
                onClick={() => { window.location.href = googleStartUrl("/auth"); }}
            >
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                Continue with Google
            </button>

            <a href="/" className="block mt-5 text-center text-muted-foreground text-xs hover:text-foreground">
                Back to home
            </a>
        </AuthShell>
    );
}
```

- [ ] **Step 4: Create `landing-page/src/pages/auth/index.astro`** (complete file; exact `admin.astro` pattern — note the `../../` depth)

```astro
---
import LandingLayout from '../../layouts/LandingLayout.astro';
import AuthHub from '../../components/auth/AuthHub.tsx';
---

<LandingLayout>
  <AuthHub client:load />
</LandingLayout>
```

- [ ] **Step 5: Build gate**

Run: `cd /Users/inno/Documents/experiments/arcane-editor/landing-page && pnpm build`
Expected: exit 0; build output lists `/auth/index.html`.

- [ ] **Step 6: Manual browser checks (dev server against live dev API)**

Run: `cd /Users/inno/Documents/experiments/arcane-editor/landing-page && PUBLIC_API_URL=https://api-dev.arcaneai.org pnpm dev`, open `http://localhost:4321/auth` and verify:

1. Forms render (Sign in default tab); NO Turnstile widget (no `PUBLIC_TURNSTILE_SITE_KEY` locally).
2. Wrong password on a known account → banner reads exactly "Incorrect email or password." (proves the `Invalid credentials` prose-string mapping).
3. Create account with a 5-char password → client-side "Password must be at least 8 characters." (and the same via server if you bypass by signing in tab first).
4. Create a fresh account (e.g. `p2b-test+1@example.com` / 8+ chars) → redirected to `/account` (404 until T6 — the redirect itself is the check; URL bar shows `/account`).
5. `http://localhost:4321/auth?flow=editor&state=teststate-123&challenge=aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_aBcDe&scheme=arcane` while signed in → brief "Connecting to Arcane…" → lands on `/auth/success` (404 until T3 — URL is the check) and sessionStorage has `arcane_editor_login_handoff` with a `deepLink` starting `arcane://auth/callback?code=` and `state=teststate-123`.
6. Same URL with `scheme=evil` → hard error screen naming the scheme; sessionStorage has NO `arcane_editor_login_request`; URL params stripped.
7. Same URL with `challenge=short` → hard error (malformed challenge).
8. `http://localhost:4321/auth?error=google_not_configured` → banner "Google sign-in isn't set up yet. Use email and password instead."
9. "Continue with Google" click → navigates to `https://api-dev.arcaneai.org/v1/auth/google/start?return_to=%2Fauth` → 302s back to `/auth?error=google_not_configured` (until owner configures Google) → same friendly banner.
10. `http://localhost:4321/auth?code=garbage` → banner "This code is invalid or has expired. Start the sign-in again."
11. `http://localhost:4321/auth?return=//evil.com` then sign in → lands on `/account`, NOT evil.com.

- [ ] **Step 7: Commit**

```bash
git add landing-page/src/components/auth/AuthShell.tsx landing-page/src/components/auth/TurnstileWidget.tsx landing-page/src/components/auth/AuthHub.tsx landing-page/src/pages/auth/index.astro
git commit -m "feat(landing): /auth hub — sign in/up, Google, editor deep-link state machine"
```

---

### Task 3: `/auth/success` — editor handoff page

**Files:**
- Create: `landing-page/src/components/auth/AuthSuccess.tsx`
- Create: `landing-page/src/pages/auth/success.astro`

**Interfaces:**
- Consumes: `loadEditorHandoff`, `clearEditorHandoff`, `EditorHandoff` from `@/lib/editor-login` (T1); `AuthShell` from `./AuthShell` (T2).
- Produces: the page Phase 3's desktop app depends on — auto deep-link attempt + gesture button + the copyable one-time code the app's manual-paste path reads. No exports consumed by other tasks.

- [ ] **Step 1: Create `landing-page/src/components/auth/AuthSuccess.tsx`** (complete file)

```tsx
import { useState, useEffect } from "react";
import { loadEditorHandoff, clearEditorHandoff, type EditorHandoff } from "@/lib/editor-login";
import { AuthShell } from "./AuthShell";

export default function AuthSuccess() {
    const [handoff, setHandoff] = useState<EditorHandoff | null | "loading">("loading");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        const h = loadEditorHandoff();
        setHandoff(h);
        // One-shot: clear immediately so a refresh (or another tab) can't replay
        // the code. The React state keeps this render working.
        clearEditorHandoff();
        // Auto-attempt the deep link; most browsers require a user gesture for
        // custom schemes, so the button below is the reliable path.
        if (h) window.location.href = h.deepLink;
    }, []);

    if (handoff === "loading") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">Loading…</p>
            </AuthShell>
        );
    }

    if (handoff === null) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Nothing to hand off</h1>
                <p className="text-muted-foreground text-sm text-center">
                    This page finishes an editor sign-in, but there's no pending sign-in here
                    (codes are single-use). Start again from Arcane, or sign in on the site.
                </p>
                <a href="/auth" className="block mt-4 text-center text-primary text-sm hover:underline">Go to sign in</a>
            </AuthShell>
        );
    }

    const copyCode = async () => {
        try {
            await navigator.clipboard.writeText(handoff.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard blocked: the code is selectable text below */
        }
    };

    return (
        <AuthShell wide>
            <h1 className="font-display text-2xl font-bold mb-2 text-center">You're signed in</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                Sending you back to the Arcane editor…
            </p>

            <button
                className="h-11 w-full rounded-md bg-primary text-primary-foreground text-base font-semibold hover:bg-primary/90 glow-orange-sm transition-all"
                onClick={() => { window.location.href = handoff.deepLink; }}
            >
                Open Arcane
            </button>

            <div className="mt-6 border-t border-border/50 pt-5">
                <p className="text-sm font-medium text-foreground mb-2">Didn't open?</p>
                <p className="text-muted-foreground text-xs mb-3">
                    Paste this one-time code into Arcane instead. It works once and expires in about a minute.
                </p>
                <div className="flex gap-2">
                    <code className="flex-1 rounded-md border border-border bg-secondary/50 px-3 py-2 text-sm font-mono text-foreground break-all select-all">
                        {handoff.code}
                    </code>
                    <button
                        className="h-9 shrink-0 rounded-md px-3 text-xs font-semibold bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-all self-center"
                        onClick={copyCode}
                    >
                        {copied ? "Copied!" : "Copy"}
                    </button>
                </div>
            </div>

            <a href="/account" className="block mt-5 text-center text-muted-foreground text-xs hover:text-foreground">
                Manage your account
            </a>
        </AuthShell>
    );
}
```

- [ ] **Step 2: Create `landing-page/src/pages/auth/success.astro`** (complete file)

```astro
---
import LandingLayout from '../../layouts/LandingLayout.astro';
import AuthSuccess from '../../components/auth/AuthSuccess.tsx';
---

<LandingLayout>
  <AuthSuccess client:load />
</LandingLayout>
```

- [ ] **Step 3: Build gate**

Run: `cd /Users/inno/Documents/experiments/arcane-editor/landing-page && pnpm build`
Expected: exit 0; output lists `/auth/success/index.html`.

- [ ] **Step 4: Manual browser checks**

With `PUBLIC_API_URL=https://api-dev.arcaneai.org pnpm dev` running and signed in (T2 Step 6 account), visit `http://localhost:4321/auth?flow=editor&state=teststate-123&challenge=aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_aBcDe&scheme=arcane` and verify:

1. You land on `/auth/success`; the browser may show an OS "open arcane://?" dialog or silently no-op (no app installed) — either is correct.
2. "Open Arcane" button re-attempts the `arcane://auth/callback?...` navigation (watch the dialog reappear / devtools console).
3. The one-time code renders; Copy puts it on the clipboard; "Copied!" flashes.
4. sessionStorage `arcane_editor_login_handoff` is GONE (cleared on render); refresh → "Nothing to hand off" screen with a working "Go to sign in" link.
5. Direct visit to `/auth/success` with no pending flow → "Nothing to hand off".

- [ ] **Step 5: Commit**

```bash
git add landing-page/src/components/auth/AuthSuccess.tsx landing-page/src/pages/auth/success.astro
git commit -m "feat(landing): /auth/success — deep-link handoff + one-time code fallback"
```

---

### Task 4: `/verify`, `/forgot`, `/reset`

**Files:**
- Create: `landing-page/src/components/auth/VerifyEmail.tsx` + `landing-page/src/pages/verify.astro`
- Create: `landing-page/src/components/auth/ForgotPassword.tsx` + `landing-page/src/pages/forgot.astro`
- Create: `landing-page/src/components/auth/ResetPassword.tsx` + `landing-page/src/pages/reset.astro`

**Interfaces:**
- Consumes: `apiVerifyEmail`, `apiForgot`, `apiReset`, `setStoredToken`, `authErrorMessage` from `@/lib/auth` (T1); `loadEditorLoginRequest` from `@/lib/editor-login` (T1); `AuthShell`, `authInputClass`, `authPrimaryBtnClass`, `authErrorBannerClass` from `./AuthShell` (T2).
- Produces: the pages the Phase 2a emails link to (`${WEB}/verify?token=…`, `${WEB}/reset?token=…`). No exports consumed by other tasks.

- [ ] **Step 1: Create `landing-page/src/components/auth/VerifyEmail.tsx`** (complete file)

```tsx
import { useState, useEffect } from "react";
import { apiVerifyEmail, setStoredToken, authErrorMessage } from "@/lib/auth";
import { loadEditorLoginRequest } from "@/lib/editor-login";
import { AuthShell, authErrorBannerClass } from "./AuthShell";

type Status = "working" | "done" | "error";

export default function VerifyEmail() {
    const [status, setStatus] = useState<Status>("working");
    const [message, setMessage] = useState("");

    useEffect(() => {
        void (async () => {
            const params = new URLSearchParams(window.location.search);
            const token = params.get("token");
            window.history.replaceState(null, "", window.location.pathname);
            if (!token) {
                setStatus("error");
                setMessage("This verification link is missing its token. Open the link from the email again.");
                return;
            }
            try {
                const data = await apiVerifyEmail(token);
                // Swap any stored session for the fresh JWT (it carries the
                // verified claim; the old token may now fail version checks).
                setStoredToken(data.token);
                if (loadEditorLoginRequest()) {
                    // An editor sign-in was mid-flight — resume it through the hub.
                    window.location.href = "/auth";
                    return;
                }
                setStatus("done");
            } catch (err) {
                setStatus("error");
                setMessage(authErrorMessage((err as Error).message));
            }
        })();
    }, []);

    if (status === "working") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">Verifying your email…</p>
            </AuthShell>
        );
    }

    if (status === "error") {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-3 text-center">Verification failed</h1>
                <div className={authErrorBannerClass}>{message}</div>
                <p className="text-muted-foreground text-xs text-center mt-2">
                    You can request a new verification email from your account page.
                </p>
                <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">Go to your account</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-2 text-center">Email verified</h1>
            <p className="text-muted-foreground text-sm text-center">
                You're all set — AI features are now unlocked.
            </p>
            <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">Go to your account</a>
        </AuthShell>
    );
}
```

- [ ] **Step 2: Create `landing-page/src/pages/verify.astro`** (complete file; single `../` — this page sits at `pages/` root)

```astro
---
import LandingLayout from '../layouts/LandingLayout.astro';
import VerifyEmail from '../components/auth/VerifyEmail.tsx';
---

<LandingLayout>
  <VerifyEmail client:load />
</LandingLayout>
```

- [ ] **Step 3: Create `landing-page/src/components/auth/ForgotPassword.tsx`** (complete file)

```tsx
import { useState } from "react";
import { apiForgot } from "@/lib/auth";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

export default function ForgotPassword() {
    const [email, setEmail] = useState("");
    const [sent, setSent] = useState(false);
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async () => {
        if (!email) { setError("Enter your email address."); return; }
        setSubmitting(true);
        setError("");
        try {
            await apiForgot(email);
            // Server always answers {ok:true} — identical UX for known and
            // unknown emails (anti-enumeration). Never branch on existence.
            setSent(true);
        } catch {
            setError("Something went wrong. Please try again.");
        }
        setSubmitting(false);
    };

    if (sent) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Check your inbox</h1>
                <p className="text-muted-foreground text-sm text-center">
                    If an account exists for <span className="text-foreground">{email}</span>, a password
                    reset link is on its way. The link expires in 30 minutes.
                </p>
                <a href="/auth" className="block mt-4 text-center text-primary text-sm hover:underline">Back to sign in</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">Reset your password</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                Enter your email and we'll send you a reset link.
            </p>

            {error && <div className={authErrorBannerClass}>{error}</div>}

            <div className="flex flex-col gap-3">
                <input
                    className={authInputClass}
                    placeholder="Email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />
                <button className={authPrimaryBtnClass} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Sending…" : "Send reset link"}
                </button>
            </div>

            <a href="/auth" className="block mt-4 text-center text-muted-foreground text-xs hover:text-foreground">Back to sign in</a>
        </AuthShell>
    );
}
```

- [ ] **Step 4: Create `landing-page/src/pages/forgot.astro`** (complete file)

```astro
---
import LandingLayout from '../layouts/LandingLayout.astro';
import ForgotPassword from '../components/auth/ForgotPassword.tsx';
---

<LandingLayout>
  <ForgotPassword client:load />
</LandingLayout>
```

- [ ] **Step 5: Create `landing-page/src/components/auth/ResetPassword.tsx`** (complete file)

```tsx
import { useState, useEffect } from "react";
import { apiReset, setStoredToken, authErrorMessage } from "@/lib/auth";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

export default function ResetPassword() {
    const [resetToken, setResetToken] = useState<string | null>(null);
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [done, setDone] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setResetToken(params.get("token"));
        window.history.replaceState(null, "", window.location.pathname);
    }, []);

    const handleSubmit = async () => {
        if (!resetToken) return;
        if (password.length < 8) { setError(authErrorMessage("weak_password")); return; }
        if (password !== confirm) { setError("Passwords don't match."); return; }
        setSubmitting(true);
        setError("");
        try {
            const data = await apiReset(resetToken, password);
            // Fresh JWT: the reset bumped token_version, so every OTHER session
            // is now signed out. Store the new one — this browser stays in.
            setStoredToken(data.token);
            setDone(true);
        } catch (err) {
            setError(authErrorMessage((err as Error).message));
        }
        setSubmitting(false);
    };

    if (done) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Password updated</h1>
                <p className="text-muted-foreground text-sm text-center">
                    You're signed in here. All other sessions have been signed out.
                </p>
                <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">Go to your account</a>
            </AuthShell>
        );
    }

    if (resetToken === null) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-3 text-center">Invalid link</h1>
                <div className={authErrorBannerClass}>
                    This reset link is missing its token. Request a new one below.
                </div>
                <a href="/forgot" className="block mt-4 text-center text-primary text-sm hover:underline">Request a new link</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">Choose a new password</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">Minimum 8 characters.</p>

            {error && <div className={authErrorBannerClass}>{error}</div>}

            <div className="flex flex-col gap-3">
                <input
                    className={authInputClass}
                    placeholder="New password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />
                <input
                    className={authInputClass}
                    placeholder="Confirm new password"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />
                <button className={authPrimaryBtnClass} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Updating…" : "Update password"}
                </button>
            </div>

            <a href="/forgot" className="block mt-4 text-center text-muted-foreground text-xs hover:text-foreground">
                Link expired? Request a new one
            </a>
        </AuthShell>
    );
}
```

Note the mount effect: if `?token=` is absent, `setResetToken(null)` keeps it `null` — but the initial state is ALSO `null`, so the "Invalid link" screen shows one frame early during SSR/hydration. That's acceptable (static build renders it, then the effect confirms). If the flicker bothers review, initialize with `useState<string | null | "pending">("pending")` — not required.

- [ ] **Step 6: Create `landing-page/src/pages/reset.astro`** (complete file)

```astro
---
import LandingLayout from '../layouts/LandingLayout.astro';
import ResetPassword from '../components/auth/ResetPassword.tsx';
---

<LandingLayout>
  <ResetPassword client:load />
</LandingLayout>
```

- [ ] **Step 7: Build gate**

Run: `cd /Users/inno/Documents/experiments/arcane-editor/landing-page && pnpm build`
Expected: exit 0; output lists `/verify/index.html`, `/forgot/index.html`, `/reset/index.html`.

- [ ] **Step 8: Manual browser checks**

With the dev server against `api-dev`:

1. `http://localhost:4321/verify?token=garbage` → "Verification failed" with "This link is invalid or has expired. Request a new one and try again." and a link to `/account`. URL token stripped.
2. `http://localhost:4321/verify` (no token) → missing-token message.
3. `http://localhost:4321/forgot` → submit a KNOWN email and an UNKNOWN email → byte-identical success copy both times ("If an account exists for …").
4. `http://localhost:4321/reset?token=garbage` + valid new password → mapped invalid_token error + "Request a new link" → `/forgot`.
5. `/reset` password mismatch → "Passwords don't match."; 5-char password → weak-password message (client-side, no network call).
6. Real happy paths (verify + reset with genuine emailed tokens) are deferred to T7's checklist — they need Phase 2a email sending live.

- [ ] **Step 9: Commit**

```bash
git add landing-page/src/components/auth/VerifyEmail.tsx landing-page/src/pages/verify.astro landing-page/src/components/auth/ForgotPassword.tsx landing-page/src/pages/forgot.astro landing-page/src/components/auth/ResetPassword.tsx landing-page/src/pages/reset.astro
git commit -m "feat(landing): /verify, /forgot, /reset email-token pages"
```

---

### Task 5: `/auth/device` — device-code authorization page

**Files:**
- Create: `landing-page/src/components/auth/DeviceAuthorize.tsx`
- Create: `landing-page/src/pages/auth/device.astro`

**Interfaces:**
- Consumes: `getStoredToken`, `clearStoredToken`, `apiAuthorizeDevice` (existing), `authErrorMessage` from `@/lib/auth`; `AuthShell`, `authInputClass`, `authPrimaryBtnClass`, `authErrorBannerClass` from `./AuthShell` (T2).
- Produces: the page the server's `verification_uri` points at (Phase 2a already emits `${WEB_BASE_URL}/auth/device`). The editor's existing device flow appends `?user_code=`. No exports consumed by other tasks.

- [ ] **Step 1: Create `landing-page/src/components/auth/DeviceAuthorize.tsx`** (complete file)

```tsx
import { useState, useEffect } from "react";
import { getStoredToken, clearStoredToken, apiAuthorizeDevice, authErrorMessage } from "@/lib/auth";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

type State = "loading" | "signin" | "form" | "done";

export default function DeviceAuthorize() {
    const [state, setState] = useState<State>("loading");
    const [userCode, setUserCode] = useState("");
    const [token, setToken] = useState("");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const prefill = params.get("user_code");
        if (prefill) setUserCode(prefill.toUpperCase());
        // Keep ?user_code= in the URL: it must survive the sign-in round trip
        // (it's a short-lived pairing code, not a secret credential).
        const t = getStoredToken();
        if (!t) { setState("signin"); return; }
        setToken(t);
        setState("form");
    }, []);

    // Round-trip through /auth preserving the code via the internal ?return= param.
    const signInHref = `/auth?return=${encodeURIComponent(
        userCode ? `/auth/device?user_code=${encodeURIComponent(userCode)}` : "/auth/device"
    )}`;

    const handleAuthorize = async () => {
        const code = userCode.trim().toUpperCase();
        if (!code) { setError("Enter the code shown in the editor."); return; }
        setSubmitting(true);
        setError("");
        try {
            await apiAuthorizeDevice(token, code);
            setState("done");
        } catch (err) {
            const msg = (err as Error).message;
            if (msg === "Not authenticated" || msg.toLowerCase().includes("unauthorized")) {
                clearStoredToken();
                setState("signin");
                setError("Your session expired — sign in again.");
            } else {
                setError(authErrorMessage(msg));
            }
        }
        setSubmitting(false);
    };

    if (state === "loading") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">Loading…</p>
            </AuthShell>
        );
    }

    if (state === "signin") {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Connect your editor</h1>
                {error && <div className={authErrorBannerClass}>{error}</div>}
                <p className="text-muted-foreground text-sm mb-5 text-center">
                    Sign in first, then you'll come back here to approve the code from Arcane.
                </p>
                <a
                    href={signInHref}
                    className="block h-10 leading-10 w-full rounded-md bg-primary text-primary-foreground text-sm font-semibold text-center hover:bg-primary/90 transition-all"
                >
                    Sign in to continue
                </a>
            </AuthShell>
        );
    }

    if (state === "done") {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Device authorized</h1>
                <p className="text-muted-foreground text-sm text-center">
                    Return to the editor — it will finish signing in on its own within a few seconds.
                </p>
                <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">Manage your account</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">Connect your editor</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                Enter the code shown in Arcane to sign the editor in.
            </p>

            {error && <div className={authErrorBannerClass}>{error}</div>}

            <div className="flex flex-col gap-3">
                <input
                    className={`${authInputClass} text-center font-mono tracking-widest uppercase`}
                    placeholder="CODE"
                    autoComplete="off"
                    spellCheck={false}
                    value={userCode}
                    onChange={e => setUserCode(e.target.value.toUpperCase())}
                    onKeyDown={e => { if (e.key === "Enter") handleAuthorize(); }}
                />
                <button className={authPrimaryBtnClass} onClick={handleAuthorize} disabled={submitting}>
                    {submitting ? "Authorizing…" : "Authorize device"}
                </button>
            </div>

            <a href="/" className="block mt-4 text-center text-muted-foreground text-xs hover:text-foreground">Back to home</a>
        </AuthShell>
    );
}
```

- [ ] **Step 2: Create `landing-page/src/pages/auth/device.astro`** (complete file)

```astro
---
import LandingLayout from '../../layouts/LandingLayout.astro';
import DeviceAuthorize from '../../components/auth/DeviceAuthorize.tsx';
---

<LandingLayout>
  <DeviceAuthorize client:load />
</LandingLayout>
```

- [ ] **Step 3: Build gate**

Run: `cd /Users/inno/Documents/experiments/arcane-editor/landing-page && pnpm build`
Expected: exit 0; output lists `/auth/device/index.html`.

- [ ] **Step 4: Manual browser checks (full device round trip via curl — no editor needed)**

1. Mint a device code against dev: `curl -s -X POST https://api-dev.arcaneai.org/v1/auth/device/code` → note `user_code` (and that `verification_uri` is `https://dev.arcaneai.org/auth/device` — Phase 2a's `WEB_BASE_URL` fix).
2. Signed OUT (clear localStorage `arcane_auth_token`), open `http://localhost:4321/auth/device?user_code=<CODE>` → "Sign in to continue"; click it → `/auth` shows the forms; sign in → you land BACK on `/auth/device?user_code=<CODE>` with the code prefilled (proves the `?return=` round trip).
3. Click "Authorize device" → "Device authorized" screen.
4. Enter a made-up code while signed in → mapped error banner (raw server error passed through `authErrorMessage` — unknown codes fall back to the raw string, which is acceptable here).
5. `http://localhost:4321/auth/device` with no param, signed in → empty input, manual entry works.

- [ ] **Step 5: Commit**

```bash
git add landing-page/src/components/auth/DeviceAuthorize.tsx landing-page/src/pages/auth/device.astro
git commit -m "feat(landing): /auth/device — the missing device-flow authorization page"
```

---

### Task 6: `/account` + Navbar link

**Files:**
- Create: `landing-page/src/components/auth/AccountPanel.tsx`
- Create: `landing-page/src/pages/account.astro`
- Modify: `landing-page/src/components/Navbar.tsx`

**Interfaces:**
- Consumes: `getStoredToken`, `setStoredToken`, `clearStoredToken`, `apiGetMe`, `apiResendVerification`, `apiForgot`, `apiChangePassword`, `authErrorMessage`, `MeResponse` from `@/lib/auth` (T1); `authInputClass`, `authPrimaryBtnClass`, `authErrorBannerClass` from `./AuthShell` (T2).
- Produces: `/account` — the default post-login destination `AuthHub.afterAuthenticated` (T2) redirects to. Navbar link "Sign in" → `/auth` / "Account" → `/account`.

- [ ] **Step 1: Create `landing-page/src/components/auth/AccountPanel.tsx`** (complete file)

```tsx
import { useState, useEffect, useCallback } from "react";
import {
    getStoredToken, setStoredToken, clearStoredToken,
    apiGetMe, apiResendVerification, apiForgot, apiChangePassword,
    authErrorMessage, type MeResponse,
} from "@/lib/auth";
import { authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

type State = "loading" | "ready";

export default function AccountPanel() {
    const [state, setState] = useState<State>("loading");
    const [token, setToken] = useState("");
    const [me, setMe] = useState<MeResponse | null>(null);
    const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

    // Resend verification
    const [resending, setResending] = useState(false);

    // Change password
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [pwError, setPwError] = useState("");
    const [pwSubmitting, setPwSubmitting] = useState(false);

    // Set a password (Google-only accounts)
    const [setPwSent, setSetPwSent] = useState(false);

    const showToast = useCallback((msg: string, type: "success" | "error" = "success") => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3000);
    }, []);

    useEffect(() => {
        void (async () => {
            const t = getStoredToken();
            if (!t) { window.location.href = "/auth?return=/account"; return; }
            try {
                const data = await apiGetMe(t);
                setToken(t);
                setMe(data);
                setState("ready");
            } catch {
                clearStoredToken();
                window.location.href = "/auth?return=/account";
            }
        })();
    }, []);

    const handleResend = async () => {
        setResending(true);
        try {
            await apiResendVerification(token);
            showToast("Verification email sent — check your inbox.");
        } catch (err) {
            showToast(authErrorMessage((err as Error).message), "error");
        }
        setResending(false);
    };

    const handleChangePassword = async () => {
        if (!currentPassword || !newPassword) { setPwError("Both fields are required."); return; }
        if (newPassword.length < 8) { setPwError(authErrorMessage("weak_password")); return; }
        setPwSubmitting(true);
        setPwError("");
        try {
            const data = await apiChangePassword(token, currentPassword, newPassword);
            // The server minted a fresh JWT (version bump kills every other
            // session, including the old token in THIS browser) — store it.
            setStoredToken(data.token);
            setToken(data.token);
            setCurrentPassword("");
            setNewPassword("");
            showToast("Password changed. Other sessions were signed out.");
        } catch (err) {
            setPwError(authErrorMessage((err as Error).message));
        }
        setPwSubmitting(false);
    };

    const handleSetPassword = async () => {
        if (!me) return;
        try {
            // Google-only account: reuse the reset flow for the user's own email.
            await apiForgot(me.user.email);
            setSetPwSent(true);
        } catch {
            showToast("Something went wrong. Please try again.", "error");
        }
    };

    const handleSignOut = () => {
        clearStoredToken();
        window.location.href = "/";
    };

    if (state === "loading" || !me) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="text-muted-foreground text-sm">Loading...</div>
            </div>
        );
    }

    const rowClass = "flex items-center justify-between py-3 border-b border-border/30";
    const labelClass = "text-sm text-muted-foreground";

    return (
        <div className="container mx-auto px-4 py-24 max-w-2xl">
            <h1 className="font-display text-2xl font-bold mb-1">Your Account</h1>
            <p className="text-muted-foreground text-sm mb-8">Manage how you sign in to Arcane</p>

            {/* Profile */}
            <div className="glass rounded-2xl p-6 mb-6">
                <div className={rowClass}>
                    <span className={labelClass}>Email</span>
                    <span className="text-sm text-foreground flex items-center gap-2">
                        {me.user.email}
                        {me.user.emailVerified ? (
                            <span className="rounded-full bg-green-500/10 border border-green-500/20 px-2 py-0.5 text-[11px] font-semibold text-green-500">
                                Verified
                            </span>
                        ) : (
                            <span className="rounded-full bg-destructive/10 border border-destructive/20 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                                Unverified
                            </span>
                        )}
                    </span>
                </div>
                {!me.user.emailVerified && (
                    <div className="flex items-center justify-between py-3 border-b border-border/30">
                        <span className="text-xs text-muted-foreground">
                            AI features stay locked until you verify your email.
                        </span>
                        <button
                            className="h-8 shrink-0 rounded-md px-3 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-50"
                            onClick={handleResend}
                            disabled={resending}
                        >
                            {resending ? "Sending…" : "Resend email"}
                        </button>
                    </div>
                )}
                <div className={rowClass}>
                    <span className={labelClass}>Google</span>
                    <span className="text-sm text-foreground">{me.googleLinked ? "Connected" : "Not connected"}</span>
                </div>
                <div className="flex items-center justify-between py-3">
                    <span className={labelClass}>AI requests used</span>
                    <span className="text-sm font-mono text-foreground">{me.usage.totalRequests}</span>
                </div>
            </div>

            {/* Password */}
            <div className="glass rounded-2xl p-6 mb-6">
                <h2 className="font-display text-lg font-bold mb-4">
                    {me.hasPassword ? "Change password" : "Set a password"}
                </h2>

                {me.hasPassword ? (
                    <>
                        {pwError && <div className={authErrorBannerClass}>{pwError}</div>}
                        <div className="flex flex-col gap-3 max-w-sm">
                            <input
                                className={authInputClass}
                                placeholder="Current password"
                                type="password"
                                autoComplete="current-password"
                                value={currentPassword}
                                onChange={e => setCurrentPassword(e.target.value)}
                            />
                            <input
                                className={authInputClass}
                                placeholder="New password (min 8 characters)"
                                type="password"
                                autoComplete="new-password"
                                value={newPassword}
                                onChange={e => setNewPassword(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") handleChangePassword(); }}
                            />
                            <button className={authPrimaryBtnClass} onClick={handleChangePassword} disabled={pwSubmitting}>
                                {pwSubmitting ? "Updating…" : "Update password"}
                            </button>
                        </div>
                    </>
                ) : setPwSent ? (
                    <p className="text-muted-foreground text-sm">
                        We've emailed <span className="text-foreground">{me.user.email}</span> a link to set
                        a password. It expires in 30 minutes.
                    </p>
                ) : (
                    <>
                        <p className="text-muted-foreground text-sm mb-4">
                            You sign in with Google. Add a password to also sign in with email.
                        </p>
                        <button
                            className="h-10 rounded-md px-4 bg-secondary text-secondary-foreground text-sm font-semibold hover:bg-secondary/80 transition-all"
                            onClick={handleSetPassword}
                        >
                            Email me a set-password link
                        </button>
                    </>
                )}
            </div>

            {/* Sign out */}
            <div className="glass rounded-2xl p-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="font-display text-lg font-bold">Sign out</h2>
                        <p className="text-muted-foreground text-xs mt-1">Signs this browser out of Arcane.</p>
                    </div>
                    <button
                        className="h-9 rounded-md px-4 text-sm font-semibold bg-destructive/10 border border-destructive/20 text-destructive hover:bg-destructive/20 transition-all"
                        onClick={handleSignOut}
                    >
                        Sign out
                    </button>
                </div>
            </div>

            {/* Toast */}
            {toast && (
                <div className={`fixed bottom-5 right-5 rounded-lg px-4 py-3 text-sm font-medium text-white z-50 animate-[fadeIn_0.2s_ease] ${
                    toast.type === "success" ? "bg-green-600" : "bg-destructive"
                }`}>
                    {toast.msg}
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Create `landing-page/src/pages/account.astro`** (complete file — destination page, so Navbar + Footer like `features.astro`)

```astro
---
import LandingLayout from '../layouts/LandingLayout.astro';
import Navbar from '../components/Navbar.tsx';
import Footer from '../components/Footer.astro';
import AccountPanel from '../components/auth/AccountPanel.tsx';
---

<LandingLayout>
  <Navbar client:load />
  <AccountPanel client:load />
  <Footer />
</LandingLayout>
```

- [ ] **Step 3: Add the Sign in / Account link to `landing-page/src/components/Navbar.tsx`** (2-space indent — match the file)

3a. Extend the imports (line 1) and add auth state. Replace:

```tsx
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
```

with:

```tsx
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
```

3b. Inside the component, after `const [scrolled, setScrolled] = useState(false);` add:

```tsx
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    // localStorage only after hydration — the island is pre-rendered at build time.
    setAuthed(!!getStoredToken());
  }, []);
```

3c. Desktop menu — insert BETWEEN the `links.map(...)` block's closing `})}` and the `<Button variant="hero" ...>` Download button:

```tsx
          <a
            href={authed ? "/account" : "/auth"}
            className="relative rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {authed ? "Account" : "Sign in"}
          </a>
```

3d. Mobile menu — insert after the mobile `links.map(...)` block's closing `))}`, before the mobile Download `<Button>`:

```tsx
            <a
              href={authed ? "/account" : "/auth"}
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-primary"
            >
              {authed ? "Account" : "Sign in"}
            </a>
```

- [ ] **Step 4: Build gate**

Run: `cd /Users/inno/Documents/experiments/arcane-editor/landing-page && pnpm build`
Expected: exit 0; output lists `/account/index.html`.

- [ ] **Step 5: Manual browser checks**

1. Signed out: `http://localhost:4321/account` → bounced to `/auth` (with `return=/account` honored after signing in — you land back on `/account`).
2. Signed in (email/password account): email row + "Unverified" badge (new accounts start unverified) + "Resend email" — click twice more; 4th within an hour should show "You've requested too many verification emails..." (server throttle is 3/hr).
3. Google row shows "Not connected"; password section shows the change form (`hasPassword: true`).
4. Change password with wrong current password → "Incorrect email or password." (mapped `invalid_credentials`). With correct current → success toast; hard-refresh → still signed in (fresh JWT stored); any OTHER browser/tab session is signed out (its next request 401s → bounced to `/auth`).
5. Sign out → localStorage token gone → landing page; Navbar now shows "Sign in".
6. Navbar on `/` shows "Sign in" when signed out, "Account" when signed in (desktop + mobile menu).
7. Google-only rendering (`hasPassword:false` → "Email me a set-password link") can't be exercised until Google OAuth is configured — covered in T7's checklist as a deferred item.

- [ ] **Step 6: Commit**

```bash
git add landing-page/src/components/auth/AccountPanel.tsx landing-page/src/pages/account.astro landing-page/src/components/Navbar.tsx
git commit -m "feat(landing): /account page + navbar sign-in/account link"
```

---

### Task 7: Deploy to dev + full manual verification checklist

**Files:**
- Modify: `.github/workflows/deploy-landing.yml`

**Interfaces:**
- Consumes: everything T1–T6 shipped; the existing dev job (push to `dev` touching `landing-page/**` → Pages project `arcane-landing-dev` → `https://dev.arcaneai.org`, `PUBLIC_API_URL=https://api-dev.arcaneai.org` already wired).
- Produces: `PUBLIC_TURNSTILE_SITE_KEY` plumbed into BOTH build jobs via a GitHub Actions **repository variable** (`vars.PUBLIC_TURNSTILE_SITE_KEY`). Unset variable → empty string → `turnstileEnabled()` is false → no widget. When the owner creates the Turnstile widget (design runbook B4.3) they set the variable and re-run the deploy — zero code change.

- [ ] **Step 1: Add `PUBLIC_TURNSTILE_SITE_KEY` to `.github/workflows/deploy-landing.yml`**

1a. Update the stale header comment. Replace:

```yaml
# Phase 2 adds PUBLIC_TURNSTILE_SITE_KEY next to PUBLIC_API_URL below.
```

with:

```yaml
# PUBLIC_TURNSTILE_SITE_KEY comes from a repo Actions VARIABLE (not secret —
# site keys are public). Unset => empty => the site renders no Turnstile
# widget (graceful degradation). Owner sets it once the widget exists (B4.3).
```

1b. In the `deploy-dev` job, replace:

```yaml
      - name: Build (dev API baked in)
        env:
          PUBLIC_API_URL: https://api-dev.arcaneai.org
        run: pnpm build
```

with:

```yaml
      - name: Build (dev API baked in)
        env:
          PUBLIC_API_URL: https://api-dev.arcaneai.org
          PUBLIC_TURNSTILE_SITE_KEY: ${{ vars.PUBLIC_TURNSTILE_SITE_KEY }}
        run: pnpm build
```

1c. In the `deploy-prod` job, replace:

```yaml
      - name: Build (prod API baked in)
        env:
          PUBLIC_API_URL: https://api.arcaneai.org
        run: pnpm build
```

with:

```yaml
      - name: Build (prod API baked in)
        env:
          PUBLIC_API_URL: https://api.arcaneai.org
          PUBLIC_TURNSTILE_SITE_KEY: ${{ vars.PUBLIC_TURNSTILE_SITE_KEY }}
        run: pnpm build
```

(Single Turnstile widget covers arcaneai.org + dev.arcaneai.org + localhost per design B4.3, so one variable serves both jobs.)

- [ ] **Step 2: Final local build gate, commit, and push to `dev`**

```bash
cd /Users/inno/Documents/experiments/arcane-editor/landing-page && pnpm build
git add .github/workflows/deploy-landing.yml
git commit -m "ci(landing): pass PUBLIC_TURNSTILE_SITE_KEY (repo var, empty until owner provides)"
```

Then merge/push this work onto the `dev` branch (per the design's Part A5 branch policy — all Phase 2 work lands on `dev`; the push is what triggers the deploy):

```bash
git push origin HEAD:dev   # or merge the working branch into dev first if it diverged
```

- [ ] **Step 3: Watch the deploy**

Run: `gh run watch $(gh run list --workflow deploy-landing.yml --limit 1 --json databaseId --jq '.[0].databaseId')`
Expected: `deploy-dev` job green; `https://dev.arcaneai.org/auth` serves the new page (hard-refresh to bust Pages cache).

- [ ] **Step 4: MANUAL VERIFICATION CHECKLIST on https://dev.arcaneai.org** (the merge gate — every line must pass or be explicitly deferred with a reason)

**Email/password (fully live today):**
1. `/auth` → Create account (fresh email, 8+ char password) → lands on `/account`, "Unverified" badge showing.
2. `/auth` sign-in with wrong password → exactly "Incorrect email or password." (prose-string mapping).
3. Signup with bad email → "That doesn't look like a valid email address."; 5-char password → weak-password message.
4. Signup with an email that already exists → server error surfaced via the map (raw code fallback acceptable if the server returns an unlisted code — note what it returns).
5. Sign out from `/account` → Navbar flips to "Sign in"; `/account` bounces to `/auth` and returns after signing back in.

**Editor round-trip (mocked scheme — no app needed):**
6. Signed in, visit `https://dev.arcaneai.org/auth?flow=editor&state=teststate-123&challenge=aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_aBcDe&scheme=arcane` → "Connecting to Arcane…" → `/auth/success` → OS may prompt to open `arcane://` (or silently no-op) → one-time code visible + Copy works → refresh → "Nothing to hand off".
7. Same but signed OUT → forms show "The Arcane editor is asking to sign in…" → sign in → grant proceeds automatically → `/auth/success`.
8. Same with `scheme=arcane-dev` → deep link is `arcane-dev://auth/callback?...` (check the OS prompt / sessionStorage before redirect).
9. `scheme=evil` → hard error screen, NO deep link, no request in sessionStorage. `challenge=short` → hard error.
10. Verify the grant code is single-use: copy the code from `/auth/success`, then `curl -s -X POST https://api-dev.arcaneai.org/v1/auth/editor/exchange -H 'Content-Type: application/json' -d '{"code":"<CODE>","verifier":"x"}'` → `invalid_code` (wrong verifier/consumed — opaque by design; proves the endpoint is live and opaque).

**Device flow (fully live today):**
11. `curl -s -X POST https://api-dev.arcaneai.org/v1/auth/device/code` → `verification_uri` is `https://dev.arcaneai.org/auth/device`; open it with `?user_code=<CODE>` signed out → sign-in round trip preserves the code → Authorize → "Device authorized"; then `curl` the device poll endpoint or re-authorize the same code → error (single-use).

**Email-token pages (happy path needs Phase 2a email sending live — else defer with note):**
12. If email sending is onboarded: signup → verification email arrives from no-reply@arcaneai.org → link opens `/verify?token=…` → "Email verified" → `/account` badge now "Verified". If NOT yet onboarded: `/account` → "Resend email" → confirm `{ok:true}` (toast), mark happy path DEFERRED (owner runbook B4.2).
13. Mid-editor-flow verify resume: start an editor flow signed out (step 7's URL), then in the SAME TAB complete a `/verify` link → you are routed back through `/auth` and the grant completes to `/auth/success`. (Defer with the same note if emails aren't live.)
14. `/forgot` known + unknown email → identical success copy. Reset email link → `/reset?token=…` → new password → "Password updated", other sessions signed out (second browser 401s). Garbage tokens on `/verify` and `/reset` → friendly invalid-link errors (testable TODAY without email).

**Graceful degradation (owner-pending config):**
15. Turnstile: `vars.PUBLIC_TURNSTILE_SITE_KEY` unset → no widget anywhere; signup/login still work. (When the owner later sets the var + `TURNSTILE_SECRET`, re-run: widget renders on both `/auth` tabs and `/forgot` is NOT gated — the widget only sits in AuthHub per this plan; server-side forgot enforcement, if enabled later, would surface via `turnstile_failed` mapping.)
16. Google: "Continue with Google" → bounces back to `/auth` with the "Google sign-in isn't set up yet." banner (until runbook B4.1 is done). After the owner configures Google: full loop — Google account → consent → `/auth?code=…` → exchange → `/account`; Google-only account's `/account` shows "Not connected"→"Connected", `hasPassword:false` → "Email me a set-password link" flow. Mark DEFERRED until then.
17. `/auth?code=garbage` → "This code is invalid or has expired." banner; `/auth?return=//evil.com` after sign-in → `/account`, never evil.com.

**Account/session:**
18. Change password with wrong current → mapped error; with correct → toast, this browser stays signed in (fresh JWT), a second signed-in browser gets bounced on next action (token_version bump).
19. Resend throttle: 4th resend within an hour → "You've requested too many verification emails…" (429 `resend_throttled`).

**Prod untouched:** `https://arcaneai.org` unchanged (no auth pages yet — prod deploy is Phase 4); `curl -s https://api.arcaneai.org/health` still 200.

- [ ] **Step 5: Record results**

Append pass/fail/deferred per line to the PR description or `docs/superpowers/plans/` sibling notes — deferred items (12, 13 pending email; 15, 16 pending Turnstile/Google) carry forward to the Phase 4 cutover checklist. Do NOT mark Phase 2b complete with any non-deferred line failing.

---

## Testing philosophy (read before "improving" it)

This is a static Astro site with NO test harness, and this plan deliberately does not add one. The gate for every task is: `pnpm build` exits 0 + that task's manual browser checks. The logic worth unit-testing is already extracted into pure, framework-free functions — `editor-login.ts` (validators, parser, deep-link builder, `sanitizeInternalReturn`) and `authErrorMessage` in `auth.ts` — so a lightweight vitest (`pnpm add -D vitest`, zero config, `*.test.ts` beside the libs) COULD cover them later. That is a documented option, not a requirement; do not stand up vitest/playwright/astro-check as part of this plan.

## Execution notes

- Work belongs on the `dev` branch (design Part A5); pushing `landing-page/**` to `dev` auto-deploys to dev.arcaneai.org via `deploy-landing.yml`.
- T1 → T2 → T3 are strictly ordered (each imports the previous). T4, T5, T6 are independent of each other (all depend on T1+T2) and can run in any order or in parallel worktrees. T7 is last.
- Phase 3 (editor app) consumes: the `/auth?flow=editor&state=&challenge=&scheme=` entry, the `${scheme}://auth/callback?code=&state=` deep link, and the manual-paste code on `/auth/success`. Do not rename any of these params.





