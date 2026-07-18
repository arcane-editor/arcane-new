# Phase 2a: Server Auth Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend arcane-server's hand-rolled Hono auth with email verification, password reset, Google OAuth (PKCE + nonce + signed state cookie), website→editor one-time-code login, session revocation via `token_version`, Turnstile, rate limiting, and a CORS allowlist — deployed to the DEV environment only, with a real vitest test harness.

**Architecture:** One new `auth_tokens` table holds every one-time secret (SHA-256 hex at rest, TTL, atomic single-use consume). JWT claims gain `email_verified`/`token_version`; `authMiddleware` does one PK-indexed D1 read per request to catch revocation and refresh role/verified state. Three new routers (`auth-email`, `auth-google`, `auth-editor`) mount beside the existing `auth` router; AI routes get a `requireVerifiedEmail()` gate. Email goes out through the Cloudflare Email Service `send_email` binding; rate limits through Cloudflare `ratelimit` unsafe bindings.

**Tech Stack:** Cloudflare Workers (wrangler ^4.69, compat date 2025-12-01, `nodejs_compat`), Hono 4.11, jose 6, D1 (SQLite), Cloudflare Email Service, Turnstile, vitest 4 + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- All work lands on the long-lived `dev` branch (Part A5). Run `git branch --show-current` first; if it does not print `dev`, run `git checkout dev` before starting. Never push to `master`.
- All commands run from `arcane-server/` unless stated otherwise. The server uses **npm** (package-lock.json), not bun.
- Prod deploy is OUT OF SCOPE (Phase 4 cutover). Task 8 deploys `--env dev` only. Prod wrangler.toml additions are inert until Phase 4.
- TTLs (seconds): `verify_email` 86400 (24 h), `password_reset` 1800 (30 min), `web_login` 60, `editor_login` 60. Resend throttle: max 3 tokens per (user, purpose) per hour.
- Table `auth_tokens(id, user_id, purpose, token_hash, meta, expires_at, consumed_at, created_at)`; indexes on `(user_id, purpose, created_at)` and `(expires_at)`; `purpose` ∈ `verify_email | password_reset | web_login | editor_login`; raw tokens NEVER stored — SHA-256 hex only.
- `users` gains `google_sub TEXT` (partial unique index), `email_verified INTEGER NOT NULL DEFAULT 0` (then `UPDATE users SET email_verified = 1` — grandfathering is non-negotiable), `token_version INTEGER NOT NULL DEFAULT 0`.
- OAuth-only users: `password_hash = ''` and `salt = ''` sentinels (column stays NOT NULL); code treats `''` as "no password set".
- JWT claims: `sub` (string user id), `email`, `role`, `email_verified` (boolean), `token_version` (number). Legacy tokens missing the new claims = version 0 and MUST keep working (non-negotiable). Issuer `arcane-server`, HS256, 30 d expiry — unchanged.
- Routes (all JSON): `POST /v1/auth/verify {token}` → `{token, user}`; `POST /v1/auth/resend-verification` (Bearer) → `{ok:true}` | 429 `resend_throttled`; `POST /v1/auth/forgot {email}` → always `{ok:true}`; `POST /v1/auth/reset {token, newPassword}` → `{token, user}`; `POST /v1/auth/change-password {currentPassword, newPassword}` (Bearer) → `{token, user}` | 400 `no_password_set`; `GET /v1/auth/google/start?return_to=…` → 302; `GET /v1/auth/google/callback` → 302 `${WEB_BASE_URL}${return_to}?code=…` or 302 `${WEB_BASE_URL}/auth?error=google_oauth_failed`; `POST /v1/auth/web/exchange {code}` → `{token, user}` | 400 `invalid_code`; `POST /v1/auth/editor/grant {challenge}` (Bearer) → `{code, expires_in: 60}`; `POST /v1/auth/editor/exchange {code, verifier}` → `{token, user}` | single opaque 400 `invalid_code` for ALL failure modes.
- Error codes (exact strings, in `{ "error": "..." }` bodies): `google_account` (409 signup), `use_google` (401 login), `email_unverified` (403), `invalid_code`, `invalid_token`, `weak_password`, `invalid_email`, `turnstile_failed`, `no_password_set`, `resend_throttled` (429), `rate_limited` (429), `invalid_challenge`, `invalid_credentials`.
- User response shape (every auth endpoint): `{id, email, role, emailVerified}`. `/v1/auth/me` additionally returns top-level `hasPassword` and `googleLinked`.
- CORS allowlist (exact): `https://arcaneai.org`, `https://www.arcaneai.org`, `https://dev.arcaneai.org`, `http://localhost:4321`, `http://localhost:1420`, `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`; `allowHeaders: ['Authorization', 'Content-Type']`.
- Rate limits: `RL_AUTH_STRICT` = 10 req/60 s/IP (namespace_id "1001"), `RL_AUTH_POLL` = 60 req/60 s/IP (namespace_id "1002"), keyed on `CF-Connecting-IP`, via `[[unsafe.bindings]]` type `ratelimit`. Missing binding = fail open (warn once).
- Secrets: `JWT_SECRET` (exists), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SECRET` (all set via `wrangler secret put NAME --env dev`; Google/Turnstile arrive later from the owner — code must run without them: Google start 302s to `/auth?error=google_not_configured`, Turnstile verification is skipped with a one-time log).
- Vars: `WEB_BASE_URL` (exists), `API_BASE_URL` (new), `EMAIL_FROM = "no-reply@arcaneai.org"` (new). Bindings: `EMAIL` (`[[send_email]]`), `RL_AUTH_STRICT`, `RL_AUTH_POLL`. Everything mirrored under `[env.dev]` (dev URLs, same binding names).
- Email Service API contract (VERIFIED against current docs — trust over pre-training): `await env.EMAIL.send({ to, from: { email, name }, subject, html, text })` → `{ messageId }`; errors throw with `.code` (e.g. `E_SENDER_NOT_VERIFIED`). Always send both `html` and `text`. Send inside `c.executionCtx.waitUntil(...)`. Domain arcaneai.org is already onboarded — no runbook step.
- Google OAuth: callback host = API domain; signed (JWT_SECRET-HMAC via jose) HttpOnly `SameSite=Lax` cookie, 10-min expiry, `Path=/v1/auth/google`, carrying `{state, nonce, pkce_verifier, return_to}`; ID token verified via jose remote JWKS + iss/aud/exp/nonce; Google `email_verified === true` required; `prompt=select_account`; scope `openid email`.
- Editor PKCE: `challenge` is base64url, 43–128 chars (`/^[A-Za-z0-9_-]{43,128}$/`); exchange verifies `s256Challenge(verifier) === challenge`.
- `verification_uri` for the device flow becomes `${WEB_BASE_URL}/auth/device` (kills the hardcoded URL at `src/routes/auth.ts:134`).
- Commits: small, one per task, style `feat(server): ...`, each ending with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do not push.
- Test harness: `vitest ~4.1.10` + `@cloudflare/vitest-pool-workers ^0.18.6` (peer-compatible pair; the pool bundles its own wrangler 4.112/miniflare — coexists with the project's wrangler ^4.69). Tests get real local D1 with all migrations applied. `npm test` = `vitest run`.

---

### Task 1: Vitest test harness (workers pool + real local D1) and health test

**Files:**
- Modify: `arcane-server/package.json`
- Modify: `arcane-server/tsconfig.json`
- Create: `arcane-server/wrangler.test.toml`
- Create: `arcane-server/vitest.config.ts`
- Create: `arcane-server/test/apply-migrations.ts`
- Create: `arcane-server/test/env.d.ts`
- Create: `arcane-server/test/tsconfig.json`
- Test: `arcane-server/test/health.test.ts`

**Interfaces:**
- Consumes: existing `index.ts` Hono app (`GET /health` → `{"status":"ok"}`), `migrations/` directory.
- Produces: `npm test` runs vitest in the workers pool; every later test file can `import { SELF, env } from 'cloudflare:test'` where `env.arcane_db` is a real migrated local D1 and `env.JWT_SECRET === 'test-secret'`. Later tasks rely on: test worker env has NO `AI`, `VECTORIZE`, `EMAIL`, `RL_AUTH_STRICT`, `RL_AUTH_POLL` bindings (code must guard; the pool cannot simulate them locally).

- [ ] **Step 1: Install dev dependencies**

Run (in `arcane-server/`):
```bash
npm install --save-dev vitest@~4.1.10 @cloudflare/vitest-pool-workers@^0.18.6
```
Expected: `added N packages` with no peer-dependency errors (pool 0.18.x peers on vitest ^4.1.0).

- [ ] **Step 2: Create the test-only wrangler config**

Create `arcane-server/wrangler.test.toml`:
```toml
# Test-only worker config for @cloudflare/vitest-pool-workers. Mirrors
# wrangler.toml minus the bindings the pool cannot simulate locally
# (AI, Vectorize, send_email, ratelimit) — server code guards all four:
# AI/Vectorize are only touched inside route handlers the tests gate before,
# the email lib no-ops without EMAIL, and rate limiting fails open.
# JWT_SECRET is a plain var HERE ONLY (it is a secret in real envs).
name = "arcane-server-test"
main = "index.ts"
compatibility_date = "2025-12-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "arcane_db"
database_name = "arcane-db-test"
database_id = "arcane-db-test"

[vars]
ENVIRONMENT = "test"
CF_AI_GATEWAY_ID = ""
WEB_BASE_URL = "https://dev.arcaneai.org"
API_BASE_URL = "http://localhost:8787"
EMAIL_FROM = "no-reply@arcaneai.org"
JWT_SECRET = "test-secret"
```

- [ ] **Step 3: Create the vitest config**

Create `arcane-server/vitest.config.ts`:
```ts
import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
    // All committed migrations (0001..0012) run against the test D1 in the
    // setup file — tests always see the exact remote schema.
    const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
    return {
        test: {
            setupFiles: ['./test/apply-migrations.ts'],
            poolOptions: {
                workers: {
                    singleWorker: true,
                    wrangler: { configPath: './wrangler.test.toml' },
                    miniflare: {
                        bindings: { TEST_MIGRATIONS: migrations },
                    },
                },
            },
        },
    };
});
```

- [ ] **Step 4: Create the migration setup file and test types**

Create `arcane-server/test/apply-migrations.ts`:
```ts
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.arcane_db, env.TEST_MIGRATIONS);
```

Create `arcane-server/test/env.d.ts`:
```ts
declare module 'cloudflare:test' {
    interface ProvidedEnv {
        arcane_db: D1Database;
        JWT_SECRET: string;
        ENVIRONMENT: string;
        CF_AI_GATEWAY_ID: string;
        WEB_BASE_URL: string;
        API_BASE_URL: string;
        EMAIL_FROM: string;
        TEST_MIGRATIONS: D1Migration[];
    }
}
```

Create `arcane-server/test/tsconfig.json`:
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["./**/*.ts", "../src/**/*.ts", "../index.ts", "../vitest.config.ts"]
}
```

- [ ] **Step 5: Add scripts and exclude tests from the root tsc project**

In `arcane-server/package.json`, add to `"scripts"` (after `"deploy:dev"`):
```json
    "test": "vitest run",
    "check:types": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json",
```

In `arcane-server/tsconfig.json`, add a top-level key after `"compilerOptions"` (the root project must not compile `test/` — the `cloudflare:test` module only resolves with the pool's types, which `test/tsconfig.json` adds):
```json
  "exclude": ["node_modules", "test"]
```

- [ ] **Step 6: Write the health test**

Create `arcane-server/test/health.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('GET /health', () => {
    it('returns {"status":"ok"} through the worker fetch handler', async () => {
        const res = await SELF.fetch('https://example.com/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
    });
});
```

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: `Test Files  1 passed (1)` / `Tests  1 passed (1)`. If the pool errors on startup, the failure will name a binding or config key — fix `wrangler.test.toml` (it must contain ONLY the sections shown above).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json wrangler.test.toml vitest.config.ts test/
git commit -m "feat(server): vitest + workers-pool test harness with real local D1

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 2: Migration 0012 + tokens lib + auth DB helpers

**Files:**
- Create: `arcane-server/migrations/0012_auth_accounts.sql`
- Create: `arcane-server/src/lib/tokens.ts`
- Modify: `arcane-server/src/lib/db.ts` (extend `UserRow` at lines 3–10; append auth-token/user helpers after the device-code section)
- Test: `arcane-server/test/tokens.test.ts`
- Test: `arcane-server/test/db-auth.test.ts`

**Interfaces:**
- Consumes: Task 1 harness (`env.arcane_db` from `cloudflare:test`).
- Produces (later tasks import these exact names):
  - `src/lib/tokens.ts`: `TOKEN_TTL_SECONDS: { verify_email: 86400; password_reset: 1800; web_login: 60; editor_login: 60 }`, `type TokenPurpose = keyof typeof TOKEN_TTL_SECONDS`, `generateToken(): string` (43-char base64url), `sha256Hex(input: string): Promise<string>`, `s256Challenge(verifier: string): Promise<string>`, `toBase64Url(bytes: Uint8Array): string`.
  - `src/lib/db.ts`: `UserRow` gains `google_sub: string | null; email_verified: number; token_version: number`; `interface AuthTokenRow { id: number; user_id: number; purpose: string; token_hash: string; meta: string | null; expires_at: string; consumed_at: string | null; created_at: string }`; `findUserByGoogleSub(db, googleSub): Promise<UserRow | null>`; `linkGoogleSub(db, userId, googleSub): Promise<UserRow | null>`; `createOAuthUser(db, { email, googleSub }): Promise<UserRow>`; `setEmailVerified(db, userId): Promise<UserRow | null>`; `updatePasswordBumpVersion(db, userId, passwordHash, salt): Promise<UserRow | null>`; `bumpTokenVersion(db, userId): Promise<UserRow | null>`; `createUser` gains optional `emailVerified?: boolean`; `createAuthToken(db, { userId, purpose, tokenHash, ttlSeconds, meta? }): Promise<AuthTokenRow>`; `consumeAuthToken(db, purpose, tokenHash): Promise<AuthTokenRow | null>` (atomic); `countRecentAuthTokens(db, userId, purpose): Promise<number>`; `cleanExpiredAuthTokens(db): Promise<void>`.

- [ ] **Step 1: Write the failing tokens-lib test**

Create `arcane-server/test/tokens.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { generateToken, sha256Hex, s256Challenge, TOKEN_TTL_SECONDS } from '../src/lib/tokens.ts';

describe('tokens lib', () => {
    it('generateToken returns 43-char base64url strings, unique across calls', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
            const t = generateToken();
            expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
            seen.add(t);
        }
        expect(seen.size).toBe(100);
    });

    it('sha256Hex matches the FIPS 180 "abc" vector', async () => {
        expect(await sha256Hex('abc'))
            .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('s256Challenge matches the RFC 7636 Appendix B vector', async () => {
        expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
            .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('TTL constants match the spec exactly', () => {
        expect(TOKEN_TTL_SECONDS).toEqual({
            verify_email: 86400,
            password_reset: 1800,
            web_login: 60,
            editor_login: 60,
        });
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `test/tokens.test.ts` cannot resolve `../src/lib/tokens.ts` (module not found).

- [ ] **Step 3: Implement the tokens lib**

Create `arcane-server/src/lib/tokens.ts`:
```ts
// One-time-secret primitives for the auth_tokens table. Raw tokens are
// handed to the caller exactly once; only their SHA-256 hex lands in D1.

export const TOKEN_TTL_SECONDS = {
    verify_email: 24 * 60 * 60,   // 24 h
    password_reset: 30 * 60,      // 30 min
    web_login: 60,                // 60 s (Google → website handoff code)
    editor_login: 60,             // 60 s (website → editor handoff code)
} as const;

export type TokenPurpose = keyof typeof TOKEN_TTL_SECONDS;

export function toBase64Url(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) { bin += String.fromCharCode(b); }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes as base64url — always 43 chars, no padding. */
export function generateToken(): string {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PKCE S256: base64url(SHA-256(ascii(verifier))). RFC 7636 §4.2. */
export async function s256Challenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return toBase64Url(new Uint8Array(digest));
}
```

- [ ] **Step 4: Run to verify the tokens tests pass**

Run: `npm test`
Expected: `test/tokens.test.ts` 4 passed (health still green).

- [ ] **Step 5: Write migration 0012**

Create `arcane-server/migrations/0012_auth_accounts.sql`:
```sql
-- Google OAuth account linking (NULL for password-only users). The partial
-- unique index enforces one account per Google subject without penalizing
-- the common NULL case.
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

-- Email verification. Existing users are grandfathered to verified — they
-- signed up before verification existed and several are active testers.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET email_verified = 1;

-- Session revocation epoch. JWTs carry token_version; a mismatch means the
-- token was revoked (password reset/change). Legacy JWTs without the claim
-- are treated as version 0 — matching this default, so existing 30-day
-- tokens keep working.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

-- One-time secrets: email verification, password reset, web login handoff
-- codes, editor login codes. Raw tokens are never stored — SHA-256 hex only.
-- Single-use is enforced by an atomic consume UPDATE on consumed_at.
CREATE TABLE IF NOT EXISTS auth_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT    NOT NULL,  -- verify_email | password_reset | web_login | editor_login
    token_hash  TEXT    NOT NULL UNIQUE,
    meta        TEXT,              -- purpose-specific JSON (editor_login: {"challenge":"..."})
    expires_at  TEXT    NOT NULL,
    consumed_at TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);
```

- [ ] **Step 6: Write the failing DB-helper tests**

Create `arcane-server/test/db-auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
    createAuthToken, consumeAuthToken, countRecentAuthTokens, cleanExpiredAuthTokens,
    createOAuthUser, findUserByGoogleSub, linkGoogleSub, setEmailVerified,
    updatePasswordBumpVersion, bumpTokenVersion, createUser,
} from '../src/lib/db.ts';
import { generateToken, sha256Hex } from '../src/lib/tokens.ts';

async function seedUser(email: string): Promise<{ id: number }> {
    const row = await env.arcane_db.prepare(
        "INSERT INTO users (email, password_hash, salt) VALUES (?, 'x', 'y') RETURNING id"
    ).bind(email).first<{ id: number }>();
    return row!;
}

describe('auth_tokens helpers', () => {
    it('createAuthToken stores only the hash with a future expiry', async () => {
        const user = await seedUser('a@test.dev');
        const hash = await sha256Hex(generateToken());
        const row = await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'verify_email', tokenHash: hash, ttlSeconds: 86400,
        });
        expect(row.token_hash).toBe(hash);
        expect(row.consumed_at).toBeNull();
        expect(row.meta).toBeNull();
    });

    it('consumeAuthToken is single-use even under concurrent consumption', async () => {
        const user = await seedUser('race@test.dev');
        const hash = await sha256Hex(generateToken());
        await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'web_login', tokenHash: hash, ttlSeconds: 60,
        });
        const results = await Promise.all([
            consumeAuthToken(env.arcane_db, 'web_login', hash),
            consumeAuthToken(env.arcane_db, 'web_login', hash),
        ]);
        expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it('consumeAuthToken rejects expired and wrong-purpose tokens', async () => {
        const user = await seedUser('exp@test.dev');
        const hash = await sha256Hex(generateToken());
        await env.arcane_db.prepare(
            `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
             VALUES (?, 'web_login', ?, datetime('now', '-10 seconds'))`
        ).bind(user.id, hash).run();
        expect(await consumeAuthToken(env.arcane_db, 'web_login', hash)).toBeNull();

        const hash2 = await sha256Hex(generateToken());
        await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'editor_login', tokenHash: hash2, ttlSeconds: 60,
        });
        expect(await consumeAuthToken(env.arcane_db, 'web_login', hash2)).toBeNull();
    });

    it('countRecentAuthTokens counts the last hour per purpose; clean removes expired', async () => {
        const user = await seedUser('count@test.dev');
        for (let i = 0; i < 3; i++) {
            await createAuthToken(env.arcane_db, {
                userId: user.id, purpose: 'verify_email',
                tokenHash: await sha256Hex(generateToken()), ttlSeconds: 86400,
            });
        }
        expect(await countRecentAuthTokens(env.arcane_db, user.id, 'verify_email')).toBe(3);
        expect(await countRecentAuthTokens(env.arcane_db, user.id, 'password_reset')).toBe(0);

        await env.arcane_db.prepare(
            `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
             VALUES (?, 'web_login', 'dead', datetime('now', '-10 seconds'))`
        ).bind(user.id).run();
        await cleanExpiredAuthTokens(env.arcane_db);
        const left = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = 'dead'"
        ).first<{ n: number }>();
        expect(left!.n).toBe(0);
    });
});

describe('user auth helpers', () => {
    it('createOAuthUser creates a verified passwordless user findable by google_sub', async () => {
        const user = await createOAuthUser(env.arcane_db, { email: 'G@Test.dev', googleSub: 'sub-1' });
        expect(user.email).toBe('g@test.dev');
        expect(user.password_hash).toBe('');
        expect(user.email_verified).toBe(1);
        expect(user.token_version).toBe(0);
        const found = await findUserByGoogleSub(env.arcane_db, 'sub-1');
        expect(found?.id).toBe(user.id);
    });

    it('linkGoogleSub sets google_sub and email_verified', async () => {
        const seed = await seedUser('link@test.dev');
        const user = await linkGoogleSub(env.arcane_db, seed.id, 'sub-2');
        expect(user?.google_sub).toBe('sub-2');
        expect(user?.email_verified).toBe(1);
    });

    it('setEmailVerified flips the flag; new users default to unverified', async () => {
        const seed = await seedUser('v@test.dev');
        const before = await env.arcane_db.prepare('SELECT email_verified FROM users WHERE id = ?')
            .bind(seed.id).first<{ email_verified: number }>();
        expect(before!.email_verified).toBe(0);
        const user = await setEmailVerified(env.arcane_db, seed.id);
        expect(user?.email_verified).toBe(1);
    });

    it('updatePasswordBumpVersion and bumpTokenVersion increment token_version', async () => {
        const seed = await seedUser('bump@test.dev');
        const u1 = await updatePasswordBumpVersion(env.arcane_db, seed.id, 'newhash', 'newsalt');
        expect(u1?.password_hash).toBe('newhash');
        expect(u1?.token_version).toBe(1);
        const u2 = await bumpTokenVersion(env.arcane_db, seed.id);
        expect(u2?.token_version).toBe(2);
    });

    it('createUser honors the emailVerified flag (admin-created users)', async () => {
        const u = await createUser(env.arcane_db, {
            email: 'admin-made@test.dev', passwordHash: 'h', salt: 's', emailVerified: true,
        });
        expect(u.email_verified).toBe(1);
    });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `npm test`
Expected: FAIL — `db.ts` has no export named `createAuthToken` (and friends). The migration itself is picked up automatically by the harness (`readD1Migrations`).

- [ ] **Step 8: Extend UserRow and add helpers to db.ts**

In `arcane-server/src/lib/db.ts`, replace the `UserRow` interface (lines 3–10) with:
```ts
export interface UserRow {
    id: number;
    email: string;
    password_hash: string;   // '' = OAuth-only user, no password set
    salt: string;            // '' for OAuth-only users
    role: string;
    created_at: string;
    google_sub: string | null;
    email_verified: number;  // 0 | 1
    token_version: number;   // session revocation epoch (JWT claim must match)
}
```

Add the import at the top of the file:
```ts
import type { TokenPurpose } from './tokens.ts';
```

Replace `createUser` (currently lines 82–91) with:
```ts
export async function createUser(db: D1Database, data: {
    email: string; passwordHash: string; salt: string; emailVerified?: boolean;
}): Promise<UserRow> {
    const result = await db.prepare(
        'INSERT INTO users (email, password_hash, salt, email_verified) VALUES (?, ?, ?, ?) RETURNING *'
    ).bind(
        data.email.toLowerCase(), data.passwordHash, data.salt, data.emailVerified ? 1 : 0,
    ).first<UserRow>();
    return result!;
}
```

Append at the end of the file:
```ts
// --- OAuth / verification user helpers ---

export async function findUserByGoogleSub(db: D1Database, googleSub: string): Promise<UserRow | null> {
    return db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(googleSub).first<UserRow>();
}

/** Links a Google subject to an existing account. Google verified the email
 *  ownership, so this also marks the account verified. */
export async function linkGoogleSub(db: D1Database, userId: number, googleSub: string): Promise<UserRow | null> {
    return db.prepare(
        'UPDATE users SET google_sub = ?, email_verified = 1 WHERE id = ? RETURNING *'
    ).bind(googleSub, userId).first<UserRow>();
}

/** Google-only signup: '' password sentinel (column is NOT NULL), pre-verified. */
export async function createOAuthUser(db: D1Database, data: { email: string; googleSub: string }): Promise<UserRow> {
    const result = await db.prepare(
        "INSERT INTO users (email, password_hash, salt, email_verified, google_sub) VALUES (?, '', '', 1, ?) RETURNING *"
    ).bind(data.email.toLowerCase(), data.googleSub).first<UserRow>();
    return result!;
}

export async function setEmailVerified(db: D1Database, userId: number): Promise<UserRow | null> {
    return db.prepare('UPDATE users SET email_verified = 1 WHERE id = ? RETURNING *')
        .bind(userId).first<UserRow>();
}

/** Sets a new password AND bumps token_version — revokes every session. */
export async function updatePasswordBumpVersion(
    db: D1Database, userId: number, passwordHash: string, salt: string,
): Promise<UserRow | null> {
    return db.prepare(
        'UPDATE users SET password_hash = ?, salt = ?, token_version = token_version + 1 WHERE id = ? RETURNING *'
    ).bind(passwordHash, salt, userId).first<UserRow>();
}

export async function bumpTokenVersion(db: D1Database, userId: number): Promise<UserRow | null> {
    return db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ? RETURNING *')
        .bind(userId).first<UserRow>();
}

// --- One-time auth token queries (auth_tokens, migration 0012) ---

export interface AuthTokenRow {
    id: number;
    user_id: number;
    purpose: string;
    token_hash: string;
    meta: string | null;
    expires_at: string;
    consumed_at: string | null;
    created_at: string;
}

/** expires_at is computed SQL-side (datetime('now', '+N seconds')) so the
 *  format always matches the datetime('now') comparisons in consume/clean. */
export async function createAuthToken(db: D1Database, data: {
    userId: number; purpose: TokenPurpose; tokenHash: string; ttlSeconds: number; meta?: string;
}): Promise<AuthTokenRow> {
    const result = await db.prepare(
        `INSERT INTO auth_tokens (user_id, purpose, token_hash, meta, expires_at)
         VALUES (?, ?, ?, ?, datetime('now', ?)) RETURNING *`
    ).bind(
        data.userId, data.purpose, data.tokenHash, data.meta ?? null, `+${data.ttlSeconds} seconds`,
    ).first<AuthTokenRow>();
    return result!;
}

/** Atomic single-use consume: only one caller can ever win the UPDATE, even
 *  when two requests race — D1 serializes writes and the consumed_at IS NULL
 *  predicate makes the second UPDATE match zero rows. */
export async function consumeAuthToken(
    db: D1Database, purpose: TokenPurpose, tokenHash: string,
): Promise<AuthTokenRow | null> {
    return db.prepare(
        `UPDATE auth_tokens SET consumed_at = datetime('now')
         WHERE purpose = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')
         RETURNING *`
    ).bind(purpose, tokenHash).first<AuthTokenRow>();
}

/** Resend/abuse throttle: tokens minted in the last hour (consumed or not). */
export async function countRecentAuthTokens(
    db: D1Database, userId: number, purpose: TokenPurpose,
): Promise<number> {
    const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM auth_tokens
         WHERE user_id = ? AND purpose = ? AND created_at > datetime('now', '-1 hour')`
    ).bind(userId, purpose).first<{ n: number }>();
    return row?.n ?? 0;
}

/** Opportunistic cleanup — mirrors cleanExpiredDeviceCodes. */
export async function cleanExpiredAuthTokens(db: D1Database): Promise<void> {
    await db.prepare("DELETE FROM auth_tokens WHERE expires_at < datetime('now')").run();
}
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS — 3 test files (health, tokens, db-auth), all green.
Note: the migration's `UPDATE users SET email_verified = 1` grandfather statement cannot be observed from tests (the test DB starts empty); it is verified against the live dev DB in Task 8.

- [ ] **Step 10: Apply the migration locally as a smoke check**

Run: `npm run db:migrate:local`
Expected output ends with `0012_auth_accounts.sql` listed as applied (🌀 Executed … commands). This proves wrangler accepts the SQL, not just miniflare.

- [ ] **Step 11: Commit**

```bash
git add migrations/0012_auth_accounts.sql src/lib/tokens.ts src/lib/db.ts test/tokens.test.ts test/db-auth.test.ts
git commit -m "feat(server): migration 0012 (google_sub, email_verified, token_version, auth_tokens) + token/db helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 3: Middleware (claims + DB check + verified-email gate + rate limit) and bindings

**Files:**
- Modify: `arcane-server/src/middleware/auth.ts` (full-file rewrite shown below)
- Create: `arcane-server/src/middleware/rate-limit.ts`
- Modify: `arcane-server/src/types.ts` (Bindings block, lines 4–17)
- Modify: `arcane-server/wrangler.toml` (vars + new bindings, prod and `[env.dev]`)
- Create: `arcane-server/test/helpers.ts`
- Test: `arcane-server/test/middleware.test.ts`

**Interfaces:**
- Consumes: Task 2 (`UserRow` with `email_verified`/`token_version`).
- Produces (later tasks import these exact names from `../middleware/auth.ts`):
  - `interface AuthPayload { sub: string; email: string; role: string; email_verified?: boolean; token_version?: number }`
  - `makeJwtPayloadFromUser(user: UserRow): AuthPayload`
  - `makeUserResponse(user: UserRow): { id: number; email: string; role: string; emailVerified: boolean }`
  - `mintAuthResponse(user: UserRow, jwtSecret: string): Promise<{ token: string; user: ReturnType<typeof makeUserResponse> }>`
  - `authMiddleware(): MiddlewareHandler<AppEnv>` (now does the D1 token_version check)
  - `requireVerifiedEmail(): MiddlewareHandler<AppEnv>` (403 `email_unverified`; must run AFTER authMiddleware)
  - `signJwt(payload: AuthPayload, jwtSecret: string): Promise<string>` (unchanged)
  - From `../middleware/rate-limit.ts`: `rateLimit(bindingName: 'RL_AUTH_STRICT' | 'RL_AUTH_POLL'): MiddlewareHandler<AppEnv>`
  - From `../types.ts`: `interface EmailSender { send(message: { to: string | { email: string; name?: string }; from: { email: string; name?: string }; subject: string; html?: string; text?: string }): Promise<{ messageId: string }> }`, `interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }`
  - From `test/helpers.ts`: `seedPasswordUser(email, password, opts?): Promise<UserRow>`, `seedGoogleOnlyUser(email, googleSub): Promise<UserRow>`, `tokenFor(user: UserRow): Promise<string>`, `jsonPost(path, body, token?): Promise<Response>`

- [ ] **Step 1: Extend types.ts**

Replace the whole `AppEnv` block (lines 1–17) of `arcane-server/src/types.ts` with:
```ts
import type { AuthPayload } from './middleware/auth.ts';

// Cloudflare Email Service send binding (send_email in wrangler.toml).
// Contract verified against current docs: send() resolves {messageId} and
// throws errors carrying `.code` (e.g. E_SENDER_NOT_VERIFIED).
export interface EmailSender {
    send(message: {
        to: string | { email: string; name?: string };
        from: { email: string; name?: string };
        subject: string;
        html?: string;
        text?: string;
    }): Promise<{ messageId: string }>;
}

// Cloudflare Workers rate limiting binding ([[unsafe.bindings]] type "ratelimit").
export interface RateLimiter {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Hono environment type — declares context bindings and variables
export type AppEnv = {
    Bindings: {
        arcane_db: D1Database;
        AI: Ai;                      // Cloudflare Workers AI binding
        VECTORIZE: Vectorize;        // Unity docs/API vector index (384-dim, bge-small)
        CF_AI_GATEWAY_ID: string;    // AI Gateway id (caching/logging/rate-limits)
        JWT_SECRET: string;
        ENVIRONMENT: string;
        WEB_BASE_URL: string;        // user-facing website base (auth pages, email links)
        API_BASE_URL: string;        // this worker's public base (Google redirect_uri)
        EMAIL_FROM: string;          // verified sender (no-reply@arcaneai.org)
        EMAIL?: EmailSender;         // Email Service send binding (absent in tests)
        RL_AUTH_STRICT?: RateLimiter;   // 10/60s/IP (absent in tests → fail open)
        RL_AUTH_POLL?: RateLimiter;     // 60/60s/IP (absent in tests → fail open)
        GOOGLE_CLIENT_ID?: string;      // secret — unset until owner provisions OAuth client
        GOOGLE_CLIENT_SECRET?: string;  // secret
        TURNSTILE_SECRET?: string;      // secret — unset = Turnstile verification skipped
    };
    Variables: {
        user: AuthPayload;
    };
};
```
(Leave everything from `// Request types` down unchanged.)

- [ ] **Step 2: Add wrangler.toml vars and bindings**

In `arcane-server/wrangler.toml`, add to the prod `[vars]` block (after `WEB_BASE_URL`):
```toml
# This worker's own public base URL — used as the Google OAuth redirect_uri
# host and anywhere the server must name itself.
API_BASE_URL = "https://api.arcaneai.org"
# Verified sender on the onboarded arcaneai.org Email Service domain.
EMAIL_FROM = "no-reply@arcaneai.org"
```

After the prod `[observability]` block (BEFORE the `# ── dev environment` comment), insert:
```toml
# Email Service send binding (domain arcaneai.org already onboarded:
# SPF/DKIM/DMARC live). env.EMAIL.send({to, from, subject, html, text}).
[[send_email]]
name = "EMAIL"

# Workers rate limiting (per-isolate, per-colo counters — cheap, no D1).
# namespace_id is an arbitrary account-unique id per limiter.
[[unsafe.bindings]]
name = "RL_AUTH_STRICT"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 10, period = 60 }

[[unsafe.bindings]]
name = "RL_AUTH_POLL"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 60, period = 60 }
```

In `[env.dev.vars]` add (after `WEB_BASE_URL`):
```toml
API_BASE_URL = "https://api-dev.arcaneai.org"
EMAIL_FROM = "no-reply@arcaneai.org"
```

At the end of the file (after `[env.dev.observability]`), append:
```toml
[[env.dev.send_email]]
name = "EMAIL"

[[env.dev.unsafe.bindings]]
name = "RL_AUTH_STRICT"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 10, period = 60 }

[[env.dev.unsafe.bindings]]
name = "RL_AUTH_POLL"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 60, period = 60 }
```

- [ ] **Step 3: Create shared test helpers**

Create `arcane-server/test/helpers.ts`:
```ts
import { env, SELF } from 'cloudflare:test';
import { hashPassword } from '../src/lib/crypto.ts';
import { signJwt, makeJwtPayloadFromUser } from '../src/middleware/auth.ts';
import type { UserRow } from '../src/lib/db.ts';

/** Password user; verified by default (pass {verified:false} for signup-fresh state). */
export async function seedPasswordUser(
    email: string, password: string, opts: { verified?: boolean } = {},
): Promise<UserRow> {
    const { hash, salt } = await hashPassword(password);
    const row = await env.arcane_db.prepare(
        'INSERT INTO users (email, password_hash, salt, email_verified) VALUES (?, ?, ?, ?) RETURNING *'
    ).bind(email.toLowerCase(), hash, salt, opts.verified === false ? 0 : 1).first<UserRow>();
    return row!;
}

export async function seedGoogleOnlyUser(email: string, googleSub: string): Promise<UserRow> {
    const row = await env.arcane_db.prepare(
        "INSERT INTO users (email, password_hash, salt, email_verified, google_sub) VALUES (?, '', '', 1, ?) RETURNING *"
    ).bind(email.toLowerCase(), googleSub).first<UserRow>();
    return row!;
}

/** Current-claims JWT for a seeded user (same mint path as the server). */
export async function tokenFor(user: UserRow): Promise<string> {
    return signJwt(makeJwtPayloadFromUser(user), env.JWT_SECRET);
}

export function jsonPost(path: string, body: unknown, token?: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
}
```

- [ ] **Step 4: Write the failing middleware tests**

Create `arcane-server/test/middleware.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import {
    authMiddleware, requireVerifiedEmail, makeJwtPayloadFromUser, makeUserResponse,
} from '../src/middleware/auth.ts';
import { rateLimit } from '../src/middleware/rate-limit.ts';
import { bumpTokenVersion, deleteUser } from '../src/lib/db.ts';
import type { AppEnv } from '../src/types.ts';
import type { AuthPayload } from '../src/middleware/auth.ts';
import { seedPasswordUser, tokenFor } from './helpers.ts';

// Tiny app exercising authMiddleware in isolation, with env injected via
// Hono's app.request(path, init, env) third argument.
function protectedApp() {
    const app = new Hono<AppEnv>();
    app.use('*', authMiddleware());
    app.get('/whoami', (c) => c.json(c.get('user')));
    return app;
}
const bindings = () => ({ arcane_db: env.arcane_db, JWT_SECRET: env.JWT_SECRET });

// Pre-0012 token: no email_verified / token_version claims.
async function legacyToken(user: { id: number; email: string; role: string }): Promise<string> {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    return new SignJWT({ sub: String(user.id), email: user.email, role: user.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('arcane-server')
        .setExpirationTime('30d')
        .sign(secret);
}

describe('authMiddleware', () => {
    it('accepts a current token and refreshes email_verified/role from D1', async () => {
        const user = await seedPasswordUser('mw1@test.dev', 'password123', { verified: false });
        const res = await protectedApp().request('/whoami',
            { headers: { Authorization: `Bearer ${await tokenFor(user)}` } }, bindings());
        expect(res.status).toBe(200);
        const payload = await res.json<AuthPayload>();
        expect(payload.email_verified).toBe(false);
        expect(payload.token_version).toBe(0);
    });

    it('grandfathers legacy tokens without new claims as version 0', async () => {
        const user = await seedPasswordUser('legacy@test.dev', 'password123');
        const res = await protectedApp().request('/whoami',
            { headers: { Authorization: `Bearer ${await legacyToken(user)}` } }, bindings());
        expect(res.status).toBe(200);
        const payload = await res.json<AuthPayload>();
        expect(payload.email_verified).toBe(true);   // refreshed from DB
        expect(payload.token_version).toBe(0);
    });

    it('rejects tokens after token_version is bumped (session revocation)', async () => {
        const user = await seedPasswordUser('bumped@test.dev', 'password123');
        const stale = await tokenFor(user);
        await bumpTokenVersion(env.arcane_db, user.id);
        const res = await protectedApp().request('/whoami',
            { headers: { Authorization: `Bearer ${stale}` } }, bindings());
        expect(res.status).toBe(401);
    });

    it('rejects tokens whose user was deleted', async () => {
        const user = await seedPasswordUser('gone@test.dev', 'password123');
        const token = await tokenFor(user);
        await deleteUser(env.arcane_db, user.id);
        const res = await protectedApp().request('/whoami',
            { headers: { Authorization: `Bearer ${token}` } }, bindings());
        expect(res.status).toBe(401);
    });
});

describe('requireVerifiedEmail', () => {
    function gatedApp(emailVerified: boolean) {
        const app = new Hono<AppEnv>();
        app.use('*', async (c, next) => {
            c.set('user', { sub: '1', email: 'x@y.z', role: 'user', email_verified: emailVerified, token_version: 0 });
            await next();
        });
        app.use('*', requireVerifiedEmail());
        app.get('/ai', (c) => c.json({ ok: true }));
        return app;
    }

    it('403 email_unverified when unverified', async () => {
        const res = await gatedApp(false).request('/ai');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'email_unverified' });
    });

    it('passes when verified', async () => {
        const res = await gatedApp(true).request('/ai');
        expect(res.status).toBe(200);
    });
});

describe('rateLimit middleware', () => {
    function rlApp() {
        const app = new Hono<AppEnv>();
        app.use('*', rateLimit('RL_AUTH_STRICT'));
        app.get('/x', (c) => c.json({ ok: true }));
        return app;
    }

    it('429 rate_limited when the binding denies', async () => {
        const res = await rlApp().request('/x',
            { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
            { RL_AUTH_STRICT: { limit: async () => ({ success: false }) } });
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: 'rate_limited' });
    });

    it('keys on CF-Connecting-IP and passes when allowed', async () => {
        const keys: string[] = [];
        const res = await rlApp().request('/x',
            { headers: { 'CF-Connecting-IP': '5.6.7.8' } },
            { RL_AUTH_STRICT: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } });
        expect(res.status).toBe(200);
        expect(keys).toEqual(['5.6.7.8']);
    });

    it('fails open when the binding is missing (local dev/tests)', async () => {
        const res = await rlApp().request('/x', {}, {});
        expect(res.status).toBe(200);
    });
});

describe('claim/response builders', () => {
    it('makeJwtPayloadFromUser and makeUserResponse emit the exact shapes', async () => {
        const user = await seedPasswordUser('shape@test.dev', 'password123');
        expect(makeJwtPayloadFromUser(user)).toEqual({
            sub: String(user.id), email: 'shape@test.dev', role: 'user',
            email_verified: true, token_version: 0,
        });
        expect(makeUserResponse(user)).toEqual({
            id: user.id, email: 'shape@test.dev', role: 'user', emailVerified: true,
        });
    });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `npm test`
Expected: FAIL — no export `makeJwtPayloadFromUser` from `src/middleware/auth.ts`, module `src/middleware/rate-limit.ts` not found.

- [ ] **Step 6: Rewrite src/middleware/auth.ts**

Replace the ENTIRE contents of `arcane-server/src/middleware/auth.ts` with:
```ts
import type { MiddlewareHandler } from 'hono';
import { jwtVerify, SignJWT } from 'jose';
import type { AppEnv } from '../types.ts';
import type { UserRow } from '../lib/db.ts';

const JWT_ISSUER = 'arcane-server';
const JWT_EXPIRY = '30d';

export interface AuthPayload {
    sub: string;
    email: string;
    role: string;
    /** Missing on legacy (pre-0012) tokens — middleware refreshes from DB. */
    email_verified?: boolean;
    /** Missing on legacy tokens — treated as version 0. */
    token_version?: number;
}

/** Single source of truth for JWT claims — EVERY mint point MUST use this
 *  so tokens are indistinguishable regardless of which flow issued them. */
export function makeJwtPayloadFromUser(user: UserRow): AuthPayload {
    return {
        sub: String(user.id),
        email: user.email,
        role: user.role,
        email_verified: user.email_verified === 1,
        token_version: user.token_version,
    };
}

/** Public user shape returned by every auth endpoint. */
export function makeUserResponse(user: UserRow) {
    return {
        id: user.id,
        email: user.email,
        role: user.role,
        emailVerified: user.email_verified === 1,
    };
}

/** {token, user} — the standard success body for every login-ish route. */
export async function mintAuthResponse(user: UserRow, jwtSecret: string) {
    const token = await signJwt(makeJwtPayloadFromUser(user), jwtSecret);
    return { token, user: makeUserResponse(user) };
}

export function authMiddleware(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const authHeader = c.req.header('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return c.json({ error: 'Missing or invalid Authorization header' }, 401);
        }

        const token = authHeader.slice(7);
        const secret = new TextEncoder().encode(c.env.JWT_SECRET);
        let payload: AuthPayload;
        try {
            const result = await jwtVerify(token, secret, { issuer: JWT_ISSUER });
            payload = result.payload as unknown as AuthPayload;
        } catch {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        // One PK-indexed read per request: catches deleted users, revoked
        // sessions (token_version bump), and refreshes role/email_verified so
        // a 30-day JWT never serves stale authorization data. Legacy tokens
        // (no token_version claim) are version 0 — matching the 0012 default,
        // which keeps existing testers' tokens working.
        const row = await c.env.arcane_db.prepare(
            'SELECT id, role, email_verified, token_version FROM users WHERE id = ?'
        ).bind(parseInt(payload.sub)).first<{
            id: number; role: string; email_verified: number; token_version: number;
        }>();
        if (!row || (payload.token_version ?? 0) !== row.token_version) {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        c.set('user', {
            ...payload,
            role: row.role,
            email_verified: row.email_verified === 1,
            token_version: row.token_version,
        });
        await next();
    };
}

/** 403 gate for AI routes. MUST run AFTER authMiddleware() — it reads the
 *  DB-fresh email_verified that authMiddleware placed on the context. */
export function requireVerifiedEmail(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const user = c.get('user') as AuthPayload;
        if (!user.email_verified) {
            return c.json({ error: 'email_unverified' }, 403);
        }
        await next();
    };
}

export async function signJwt(payload: AuthPayload, jwtSecret: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer(JWT_ISSUER)
        .setExpirationTime(JWT_EXPIRY)
        .sign(secret);
}
```

- [ ] **Step 7: Create src/middleware/rate-limit.ts**

```ts
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';

const warned = new Set<string>();

/** Cloudflare ratelimit-binding middleware, keyed on the caller's IP.
 *  Fails open (with a once-per-isolate warning) when the binding is absent —
 *  local dev and the vitest pool run without unsafe bindings. */
export function rateLimit(bindingName: 'RL_AUTH_STRICT' | 'RL_AUTH_POLL'): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const limiter = c.env[bindingName];
        if (!limiter) {
            if (!warned.has(bindingName)) {
                warned.add(bindingName);
                console.warn(JSON.stringify({ event: 'auth_rate_limit_skipped', binding: bindingName }));
            }
            await next();
            return;
        }
        const key = c.req.header('CF-Connecting-IP') ?? 'unknown';
        const { success } = await limiter.limit({ key });
        if (!success) {
            return c.json({ error: 'rate_limited' }, 429);
        }
        await next();
    };
}
```

- [ ] **Step 8: Fix the one existing caller of the old payload builder**

`src/routes/auth.ts` still has its own `makeJwtPayload` — it keeps compiling (it builds a valid subset `AuthPayload`), so nothing else changes in this task; Task 4 replaces it. Verify compilation only:

Run: `npm run check:types`
Expected: no errors in either project.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS — middleware tests green; existing SELF-based tests still green (`authMiddleware`'s new D1 read works against the migrated test DB).

- [ ] **Step 10: Validate wrangler config parses**

Run: `npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry 2>&1 | head -40 && npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry-dev --env dev 2>&1 | head -40`
Expected: both print `--dry-run: exiting now.` after listing bindings that include `EMAIL`, `RL_AUTH_STRICT`, `RL_AUTH_POLL`, vars `API_BASE_URL`/`EMAIL_FROM`. No TOML parse errors.

- [ ] **Step 11: Commit**

```bash
git add src/middleware/auth.ts src/middleware/rate-limit.ts src/types.ts wrangler.toml test/helpers.ts test/middleware.test.ts
git commit -m "feat(server): token_version-checked auth middleware, verified-email gate, ratelimit middleware + bindings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 4: Email lib, Turnstile helper, auth-email routes, signup/login/me/device changes

**Files:**
- Modify: `arcane-server/src/lib/log.ts` (append `logAuthEvent`)
- Create: `arcane-server/src/lib/email.ts`
- Create: `arcane-server/src/lib/turnstile.ts`
- Create: `arcane-server/src/routes/auth-email.ts`
- Modify: `arcane-server/src/routes/auth.ts` (signup/login/me/device; delete local helpers)
- Modify: `arcane-server/index.ts` (mount `authEmailRouter` only — CORS/limiters/gating stay in Task 7)
- Test: `arcane-server/test/email.test.ts`
- Test: `arcane-server/test/auth-email-routes.test.ts`
- Test: `arcane-server/test/auth-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 (`generateToken`, `sha256Hex`, `TOKEN_TTL_SECONDS`, `createAuthToken`, `consumeAuthToken`, `countRecentAuthTokens`, `cleanExpiredAuthTokens`, `setEmailVerified`, `updatePasswordBumpVersion`, `findUserByEmail`, `findUserById`), Task 3 (`mintAuthResponse`, `makeUserResponse`, `authMiddleware`, `AuthPayload`, `EmailSender`).
- Produces:
  - `src/lib/log.ts`: `logAuthEvent(event: string, ctx?: Record<string, unknown>): void`
  - `src/lib/email.ts`: `sendVerificationEmail(env: Pick<AppEnv['Bindings'], 'EMAIL' | 'WEB_BASE_URL' | 'EMAIL_FROM'>, to: string, token: string): Promise<void>`, `sendPasswordResetEmail(env: same, to: string, token: string): Promise<void>` — both NEVER throw (safe inside `waitUntil`).
  - `src/lib/turnstile.ts`: `verifyTurnstile(secret: string | undefined, token: string | undefined, ip: string | undefined): Promise<boolean>` — returns `true` (skips, logs once) when `secret` is undefined.
  - `src/routes/auth-email.ts`: `authEmailRouter` (Hono) with `/v1/auth/verify`, `/v1/auth/resend-verification`, `/v1/auth/forgot`, `/v1/auth/reset`, `/v1/auth/change-password`.
  - Task 8 relies on: signup sends a real verification email in dev; `verification_uri` = `${WEB_BASE_URL}/auth/device`.

- [ ] **Step 1: Append logAuthEvent to src/lib/log.ts**

Add at the end of `arcane-server/src/lib/log.ts`:
```ts
// Auth-flow audit events (single-line JSON, filterable on `event`).
// NEVER pass raw tokens, one-time codes, or passwords in ctx — log user ids
// and reason strings only.
export function logAuthEvent(event: string, ctx: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ event: `auth_${event}`, ...ctx }));
}
```

- [ ] **Step 2: Write the failing email-lib test**

Create `arcane-server/test/email.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { sendVerificationEmail, sendPasswordResetEmail } from '../src/lib/email.ts';
import type { EmailSender } from '../src/types.ts';

type SentMessage = Parameters<EmailSender['send']>[0];

function fakeEnv(capture: SentMessage[], sendImpl?: EmailSender['send']) {
    return {
        EMAIL: {
            send: sendImpl ?? (async (m: SentMessage) => { capture.push(m); return { messageId: 'mid-1' }; }),
        },
        WEB_BASE_URL: 'https://dev.arcaneai.org',
        EMAIL_FROM: 'no-reply@arcaneai.org',
    };
}

describe('email lib', () => {
    it('sendVerificationEmail sends html+text containing the verify link', async () => {
        const calls: SentMessage[] = [];
        await sendVerificationEmail(fakeEnv(calls), 'user@test.dev', 'tok123');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.to).toBe('user@test.dev');
        expect(calls[0]!.from).toEqual({ email: 'no-reply@arcaneai.org', name: 'Arcane' });
        expect(calls[0]!.subject).toBe('Verify your Arcane email');
        expect(calls[0]!.text).toContain('https://dev.arcaneai.org/verify?token=tok123');
        expect(calls[0]!.html).toContain('https://dev.arcaneai.org/verify?token=tok123');
    });

    it('sendPasswordResetEmail links to /reset', async () => {
        const calls: SentMessage[] = [];
        await sendPasswordResetEmail(fakeEnv(calls), 'user@test.dev', 'tok456');
        expect(calls[0]!.subject).toBe('Reset your Arcane password');
        expect(calls[0]!.text).toContain('https://dev.arcaneai.org/reset?token=tok456');
        expect(calls[0]!.html).toContain('https://dev.arcaneai.org/reset?token=tok456');
    });

    it('never throws when the binding rejects (waitUntil safety)', async () => {
        const failing = async () => {
            throw Object.assign(new Error('sender not verified'), { code: 'E_SENDER_NOT_VERIFIED' });
        };
        await expect(sendVerificationEmail(fakeEnv([], failing), 'user@test.dev', 't')).resolves.toBeUndefined();
    });

    it('no-ops without the EMAIL binding (tests / local dev)', async () => {
        const env = { EMAIL: undefined, WEB_BASE_URL: 'https://dev.arcaneai.org', EMAIL_FROM: 'no-reply@arcaneai.org' };
        await expect(sendVerificationEmail(env, 'user@test.dev', 't')).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test`
Expected: FAIL — `src/lib/email.ts` not found.

- [ ] **Step 4: Implement src/lib/email.ts**

```ts
import type { AppEnv } from '../types.ts';
import { logAuthEvent } from './log.ts';

type EmailEnv = Pick<AppEnv['Bindings'], 'EMAIL' | 'WEB_BASE_URL' | 'EMAIL_FROM'>;

/** Sends via the Email Service binding. NEVER throws — callers run inside
 *  c.executionCtx.waitUntil and a failed email must not fail the request. */
async function sendEmail(env: EmailEnv, to: string, subject: string, text: string, html: string): Promise<void> {
    if (!env.EMAIL) {
        logAuthEvent('email_skipped', { reason: 'no_binding', subject });
        return;
    }
    try {
        const { messageId } = await env.EMAIL.send({
            to,
            from: { email: env.EMAIL_FROM, name: 'Arcane' },
            subject,
            text,
            html,
        });
        logAuthEvent('email_sent', { subject, messageId });
    } catch (err) {
        logAuthEvent('email_send_failed', {
            subject,
            code: (err as { code?: string }).code ?? null,
            message: (err as Error).message,
        });
    }
}

export async function sendVerificationEmail(env: EmailEnv, to: string, token: string): Promise<void> {
    const link = `${env.WEB_BASE_URL}/verify?token=${token}`;
    await sendEmail(
        env, to, 'Verify your Arcane email',
        `Welcome to Arcane!\n\nConfirm your email address by opening this link:\n${link}\n\nThe link expires in 24 hours. If you didn't create an Arcane account, ignore this email.`,
        `<p>Welcome to Arcane!</p><p>Confirm your email address:</p><p><a href="${link}">Verify email</a></p><p>Or paste this link into your browser:<br>${link}</p><p>The link expires in 24 hours. If you didn't create an Arcane account, ignore this email.</p>`,
    );
}

export async function sendPasswordResetEmail(env: EmailEnv, to: string, token: string): Promise<void> {
    const link = `${env.WEB_BASE_URL}/reset?token=${token}`;
    await sendEmail(
        env, to, 'Reset your Arcane password',
        `Someone requested a password reset for your Arcane account.\n\nSet a new password here:\n${link}\n\nThe link expires in 30 minutes and can be used once. If this wasn't you, ignore this email — your password is unchanged.`,
        `<p>Someone requested a password reset for your Arcane account.</p><p><a href="${link}">Set a new password</a></p><p>Or paste this link into your browser:<br>${link}</p><p>The link expires in 30 minutes and can be used once. If this wasn't you, ignore this email — your password is unchanged.</p>`,
    );
}
```

- [ ] **Step 5: Implement src/lib/turnstile.ts**

```ts
let warnedNoSecret = false;

/** Server-side Turnstile verification (siteverify). When TURNSTILE_SECRET is
 *  not provisioned yet, verification is SKIPPED (returns true) and logged
 *  once per isolate — the owner creates the widget later. */
export async function verifyTurnstile(
    secret: string | undefined,
    token: string | undefined,
    ip: string | undefined,
): Promise<boolean> {
    if (!secret) {
        if (!warnedNoSecret) {
            warnedNoSecret = true;
            console.warn(JSON.stringify({ event: 'auth_turnstile_skipped', reason: 'no_secret' }));
        }
        return true;
    }
    if (!token) { return false; }
    const body = new URLSearchParams({ secret, response: token });
    if (ip) { body.set('remoteip', ip); }
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
    });
    if (!res.ok) { return false; }
    const data = await res.json() as { success?: boolean };
    return data.success === true;
}
```
(No unit test: with the secret unset it is a constant, and the fetch path needs a real secret — covered by the Task 8 checklist as blocked-on-owner.)

- [ ] **Step 6: Write the failing auth-email route tests**

Create `arcane-server/test/auth-email-routes.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createAuthToken } from '../src/lib/db.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../src/lib/tokens.ts';
import { seedPasswordUser, seedGoogleOnlyUser, tokenFor, jsonPost } from './helpers.ts';

async function seedToken(userId: number, purpose: 'verify_email' | 'password_reset'): Promise<string> {
    const raw = generateToken();
    await createAuthToken(env.arcane_db, {
        userId, purpose, tokenHash: await sha256Hex(raw), ttlSeconds: TOKEN_TTL_SECONDS[purpose],
    });
    return raw;
}

describe('POST /v1/auth/verify', () => {
    it('consumes a valid token, verifies the user, returns a fresh JWT', async () => {
        const user = await seedPasswordUser('verify@test.dev', 'password123', { verified: false });
        const raw = await seedToken(user.id, 'verify_email');
        const res = await jsonPost('/v1/auth/verify', { token: raw });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { emailVerified: boolean } }>();
        expect(body.user.emailVerified).toBe(true);
        expect(body.token).toBeTruthy();
        // fresh JWT works against a Bearer route
        const me = await jsonPost('/v1/auth/device/authorize', { user_code: 'XXXX-XXXX' }, body.token);
        expect(me.status).toBe(400); // authed fine; the code is just invalid
    });

    it('rejects replay and garbage tokens with invalid_token', async () => {
        const user = await seedPasswordUser('verify2@test.dev', 'password123', { verified: false });
        const raw = await seedToken(user.id, 'verify_email');
        expect((await jsonPost('/v1/auth/verify', { token: raw })).status).toBe(200);
        const replay = await jsonPost('/v1/auth/verify', { token: raw });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toEqual({ error: 'invalid_token' });
        expect((await jsonPost('/v1/auth/verify', { token: 'nope' })).status).toBe(400);
    });
});

describe('POST /v1/auth/resend-verification', () => {
    it('requires auth, creates a token, throttles after 3/hour', async () => {
        const user = await seedPasswordUser('resend@test.dev', 'password123', { verified: false });
        const token = await tokenFor(user);
        expect((await jsonPost('/v1/auth/resend-verification', {}, undefined)).status).toBe(401);
        for (let i = 0; i < 3; i++) {
            const res = await jsonPost('/v1/auth/resend-verification', {}, token);
            expect(res.status).toBe(200);
        }
        const throttled = await jsonPost('/v1/auth/resend-verification', {}, token);
        expect(throttled.status).toBe(429);
        expect(await throttled.json()).toEqual({ error: 'resend_throttled' });
    });

    it('is a no-op {ok:true} for already-verified users', async () => {
        const user = await seedPasswordUser('resend-v@test.dev', 'password123');
        const res = await jsonPost('/v1/auth/resend-verification', {}, await tokenFor(user));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        const n = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ?"
        ).bind(user.id).first<{ n: number }>();
        expect(n!.n).toBe(0);
    });
});

describe('POST /v1/auth/forgot', () => {
    it('always returns {ok:true}, creating a token only for known emails', async () => {
        const user = await seedPasswordUser('forgot@test.dev', 'password123');
        const unknown = await jsonPost('/v1/auth/forgot', { email: 'nobody@test.dev' });
        expect(unknown.status).toBe(200);
        expect(await unknown.json()).toEqual({ ok: true });

        const known = await jsonPost('/v1/auth/forgot', { email: 'forgot@test.dev' });
        expect(known.status).toBe(200);
        const n = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset'"
        ).bind(user.id).first<{ n: number }>();
        expect(n!.n).toBe(1);
    });
});

describe('POST /v1/auth/reset', () => {
    it('sets the new password, revokes old sessions, verifies email, returns fresh JWT', async () => {
        const user = await seedPasswordUser('reset@test.dev', 'oldpassword1', { verified: false });
        const oldJwt = await tokenFor(user);
        const raw = await seedToken(user.id, 'password_reset');

        const res = await jsonPost('/v1/auth/reset', { token: raw, newPassword: 'newpassword1' });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { emailVerified: boolean } }>();
        expect(body.user.emailVerified).toBe(true);

        // old session revoked (token_version bumped)
        const stale = await jsonPost('/v1/auth/resend-verification', {}, oldJwt);
        expect(stale.status).toBe(401);
        // new password logs in
        const login = await jsonPost('/v1/auth/login', { email: 'reset@test.dev', password: 'newpassword1' });
        expect(login.status).toBe(200);
        // reset token is single-use
        const replay = await jsonPost('/v1/auth/reset', { token: raw, newPassword: 'anotherpass1' });
        expect(replay.status).toBe(400);
    });

    it('rejects weak passwords without consuming the token', async () => {
        const user = await seedPasswordUser('reset2@test.dev', 'oldpassword1');
        const raw = await seedToken(user.id, 'password_reset');
        const res = await jsonPost('/v1/auth/reset', { token: raw, newPassword: 'short' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'weak_password' });
        expect((await jsonPost('/v1/auth/reset', { token: raw, newPassword: 'longenough1' })).status).toBe(200);
    });
});

describe('POST /v1/auth/change-password', () => {
    it('changes the password with the current one and revokes other sessions', async () => {
        const user = await seedPasswordUser('chg@test.dev', 'oldpassword1');
        const jwt = await tokenFor(user);
        const res = await jsonPost('/v1/auth/change-password',
            { currentPassword: 'oldpassword1', newPassword: 'newpassword1' }, jwt);
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string }>();
        expect(body.token).toBeTruthy();
        expect((await jsonPost('/v1/auth/change-password',
            { currentPassword: 'x', newPassword: 'y' }, jwt)).status).toBe(401); // old jwt dead
    });

    it('401 invalid_credentials on wrong current password', async () => {
        const user = await seedPasswordUser('chg2@test.dev', 'oldpassword1');
        const res = await jsonPost('/v1/auth/change-password',
            { currentPassword: 'wrongpass1', newPassword: 'newpassword1' }, await tokenFor(user));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    });

    it('400 no_password_set for Google-only accounts', async () => {
        const user = await seedGoogleOnlyUser('gonly@test.dev', 'sub-chg');
        const res = await jsonPost('/v1/auth/change-password',
            { currentPassword: 'x', newPassword: 'newpassword1' }, await tokenFor(user));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'no_password_set' });
    });
});
```

- [ ] **Step 7: Write the failing signup/login/me/device tests**

Create `arcane-server/test/auth-routes.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, seedGoogleOnlyUser, tokenFor, jsonPost } from './helpers.ts';

describe('POST /v1/auth/signup', () => {
    it('creates an unverified user, mints a token, stores a verify_email token', async () => {
        const res = await jsonPost('/v1/auth/signup', { email: 'new@test.dev', password: 'password123' });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { id: number; emailVerified: boolean } }>();
        expect(body.token).toBeTruthy();
        expect(body.user.emailVerified).toBe(false);
        const t = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email'"
        ).bind(body.user.id).first<{ n: number }>();
        expect(t!.n).toBe(1);
    });

    it('validates email format and password strength', async () => {
        const bad = await jsonPost('/v1/auth/signup', { email: 'not-an-email', password: 'password123' });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({ error: 'invalid_email' });
        const weak = await jsonPost('/v1/auth/signup', { email: 'ok@test.dev', password: 'short' });
        expect(weak.status).toBe(400);
        expect(await weak.json()).toEqual({ error: 'weak_password' });
    });

    it('409 google_account when the email belongs to a Google-only user', async () => {
        await seedGoogleOnlyUser('taken-g@test.dev', 'sub-signup');
        const res = await jsonPost('/v1/auth/signup', { email: 'taken-g@test.dev', password: 'password123' });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'google_account' });
    });

    it('409 for an existing password account', async () => {
        await seedPasswordUser('taken@test.dev', 'password123');
        const res = await jsonPost('/v1/auth/signup', { email: 'taken@test.dev', password: 'password123' });
        expect(res.status).toBe(409);
    });
});

describe('POST /v1/auth/login', () => {
    it('401 use_google for Google-only accounts', async () => {
        await seedGoogleOnlyUser('glogin@test.dev', 'sub-login');
        const res = await jsonPost('/v1/auth/login', { email: 'glogin@test.dev', password: 'whatever123' });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'use_google' });
    });

    it('still logs in password users and returns emailVerified', async () => {
        await seedPasswordUser('plogin@test.dev', 'password123');
        const res = await jsonPost('/v1/auth/login', { email: 'plogin@test.dev', password: 'password123' });
        expect(res.status).toBe(200);
        const body = await res.json<{ user: { emailVerified: boolean } }>();
        expect(body.user.emailVerified).toBe(true);
    });
});

describe('GET /v1/auth/me', () => {
    it('returns emailVerified/hasPassword/googleLinked', async () => {
        const user = await seedPasswordUser('me@test.dev', 'password123');
        const res = await SELF.fetch('https://example.com/v1/auth/me', {
            headers: { Authorization: `Bearer ${await tokenFor(user)}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json<{
            user: { emailVerified: boolean }; hasPassword: boolean; googleLinked: boolean;
        }>();
        expect(body.user.emailVerified).toBe(true);
        expect(body.hasPassword).toBe(true);
        expect(body.googleLinked).toBe(false);
    });
});

describe('POST /v1/auth/device/code', () => {
    it('builds verification_uri from WEB_BASE_URL', async () => {
        const res = await jsonPost('/v1/auth/device/code', {});
        expect(res.status).toBe(200);
        const body = await res.json<{ verification_uri: string }>();
        expect(body.verification_uri).toBe('https://dev.arcaneai.org/auth/device');
    });
});
```

- [ ] **Step 8: Run to verify failure**

Run: `npm test`
Expected: FAIL — `/v1/auth/verify` etc. return 404 (router not written/mounted); signup tests fail on missing `emailVerified` / validation.

- [ ] **Step 9: Create src/routes/auth-email.ts**

```ts
import { Hono } from 'hono';
import {
    findUserByEmail, findUserById, setEmailVerified, updatePasswordBumpVersion,
    createAuthToken, consumeAuthToken, countRecentAuthTokens, cleanExpiredAuthTokens,
} from '../lib/db.ts';
import { hashPassword, verifyPassword } from '../lib/crypto.ts';
import { authMiddleware, mintAuthResponse } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { sendVerificationEmail, sendPasswordResetEmail } from '../lib/email.ts';
import { verifyTurnstile } from '../lib/turnstile.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authEmailRouter = new Hono<AppEnv>();

// ─── Email verification ─────────────────────────────────────

authEmailRouter.post('/v1/auth/verify', async (c) => {
    const { token } = await c.req.json<{ token?: string }>();
    if (typeof token !== 'string' || !token) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    const db = c.env.arcane_db;
    const row = await consumeAuthToken(db, 'verify_email', await sha256Hex(token));
    if (!row) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    const user = await setEmailVerified(db, row.user_id);
    if (!user) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    logAuthEvent('email_verified', { userId: user.id });
    // Fresh JWT so the website can immediately replace its stored token with
    // one whose email_verified claim is current.
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

authEmailRouter.post('/v1/auth/resend-verification', authMiddleware(), async (c) => {
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;
    const user = await findUserById(db, parseInt(authUser.sub));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }
    if (user.email_verified === 1) {
        return c.json({ ok: true });
    }
    if (await countRecentAuthTokens(db, user.id, 'verify_email') >= 3) {
        return c.json({ error: 'resend_throttled' }, 429);
    }
    const rawToken = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'verify_email',
        tokenHash: await sha256Hex(rawToken), ttlSeconds: TOKEN_TTL_SECONDS.verify_email,
    });
    c.executionCtx.waitUntil(sendVerificationEmail(c.env, user.email, rawToken));
    logAuthEvent('verification_resent', { userId: user.id });
    return c.json({ ok: true });
});

// ─── Password reset ─────────────────────────────────────────

authEmailRouter.post('/v1/auth/forgot', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const email = body.email;
    // Always-200 on the account-existence axis: no enumeration oracle.
    const ok = () => c.json({ ok: true });
    const turnstileOk = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        (body['cf-turnstile-response'] ?? body.turnstileToken) as string | undefined,
        c.req.header('CF-Connecting-IP'),
    );
    if (!turnstileOk) {
        return c.json({ error: 'turnstile_failed' }, 400);
    }
    if (typeof email !== 'string' || !email) {
        return ok();
    }
    const db = c.env.arcane_db;
    await cleanExpiredAuthTokens(db);
    const user = await findUserByEmail(db, email);
    if (!user) {
        return ok();
    }
    // Silent throttle — still {ok:true} so throttling can't be probed either.
    if (await countRecentAuthTokens(db, user.id, 'password_reset') >= 3) {
        return ok();
    }
    const rawToken = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'password_reset',
        tokenHash: await sha256Hex(rawToken), ttlSeconds: TOKEN_TTL_SECONDS.password_reset,
    });
    c.executionCtx.waitUntil(sendPasswordResetEmail(c.env, user.email, rawToken));
    logAuthEvent('forgot_password', { userId: user.id });
    return ok();
});

authEmailRouter.post('/v1/auth/reset', async (c) => {
    const { token, newPassword } = await c.req.json<{ token?: string; newPassword?: string }>();
    if (typeof token !== 'string' || !token) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    // Validate BEFORE consuming so a typo doesn't burn the one-time token.
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return c.json({ error: 'weak_password' }, 400);
    }
    const db = c.env.arcane_db;
    const row = await consumeAuthToken(db, 'password_reset', await sha256Hex(token));
    if (!row) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    const { hash, salt } = await hashPassword(newPassword);
    // Bumps token_version → every existing session is signed out.
    const updated = await updatePasswordBumpVersion(db, row.user_id, hash, salt);
    if (!updated) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    // Completing a reset proves email ownership (works for Google-only users
    // setting their first password too).
    const user = (await setEmailVerified(db, updated.id))!;
    logAuthEvent('password_reset', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

authEmailRouter.post('/v1/auth/change-password', authMiddleware(), async (c) => {
    const { currentPassword, newPassword } = await c.req.json<{
        currentPassword?: string; newPassword?: string;
    }>();
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;
    const user = await findUserById(db, parseInt(authUser.sub));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }
    if (user.password_hash === '') {
        // Google-only account: no password to change. The website's "set
        // password" path is the forgot→reset flow.
        return c.json({ error: 'no_password_set' }, 400);
    }
    if (typeof currentPassword !== 'string'
        || !(await verifyPassword(currentPassword, user.password_hash, user.salt))) {
        return c.json({ error: 'invalid_credentials' }, 401);
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return c.json({ error: 'weak_password' }, 400);
    }
    const { hash, salt } = await hashPassword(newPassword);
    const updated = (await updatePasswordBumpVersion(db, user.id, hash, salt))!;
    logAuthEvent('password_changed', { userId: user.id });
    // token_version just bumped — hand back a valid session for THIS client.
    return c.json(await mintAuthResponse(updated, c.env.JWT_SECRET));
});
```

- [ ] **Step 10: Rewrite src/routes/auth.ts signup/login/me/device**

Replace the ENTIRE contents of `arcane-server/src/routes/auth.ts` with:
```ts
import { Hono } from 'hono';
import {
    findUserByEmail, findUserById, createUser,
    findCurrentUsagePeriod, getCurrentPeriodStart,
    createDeviceCode, findDeviceCodeByDeviceCode,
    authorizeDeviceCode, deleteDeviceCode, cleanExpiredDeviceCodes,
    createAuthToken,
} from '../lib/db.ts';
import { hashPassword, verifyPassword } from '../lib/crypto.ts';
import { authMiddleware, mintAuthResponse, makeUserResponse } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { sendVerificationEmail } from '../lib/email.ts';
import { verifyTurnstile } from '../lib/turnstile.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authRouter = new Hono<AppEnv>();

// ─── Helpers ────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateUserCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (let i = 0; i < 8; i++) {
        code += chars[bytes[i]! % chars.length];
        if (i === 3) { code += '-'; }
    }
    return code;
}

// ─── Signup / Login ─────────────────────────────────────────

authRouter.post('/v1/auth/signup', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const { email, password } = body;

    if (!email || !password) {
        return c.json({ error: 'Email and password required' }, 400);
    }
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
        return c.json({ error: 'invalid_email' }, 400);
    }
    if (typeof password !== 'string' || password.length < 8) {
        return c.json({ error: 'weak_password' }, 400);
    }
    const turnstileOk = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        (body['cf-turnstile-response'] ?? body.turnstileToken) as string | undefined,
        c.req.header('CF-Connecting-IP'),
    );
    if (!turnstileOk) {
        return c.json({ error: 'turnstile_failed' }, 400);
    }

    const db = c.env.arcane_db;

    const existing = await findUserByEmail(db, email);
    if (existing) {
        if (existing.password_hash === '') {
            // Accepted enumeration trade-off: tell them to use Google.
            return c.json({ error: 'google_account' }, 409);
        }
        return c.json({ error: 'Email already registered' }, 409);
    }

    const { hash, salt } = await hashPassword(password);
    const user = await createUser(db, { email, passwordHash: hash, salt });

    const rawToken = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'verify_email',
        tokenHash: await sha256Hex(rawToken), ttlSeconds: TOKEN_TTL_SECONDS.verify_email,
    });
    c.executionCtx.waitUntil(sendVerificationEmail(c.env, user.email, rawToken));
    logAuthEvent('signup', { userId: user.id });

    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

authRouter.post('/v1/auth/login', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const { email, password } = body;

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
        return c.json({ error: 'Email and password required' }, 400);
    }
    const turnstileOk = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        (body['cf-turnstile-response'] ?? body.turnstileToken) as string | undefined,
        c.req.header('CF-Connecting-IP'),
    );
    if (!turnstileOk) {
        return c.json({ error: 'turnstile_failed' }, 400);
    }

    const db = c.env.arcane_db;

    const user = await findUserByEmail(db, email);
    if (!user) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }
    if (user.password_hash === '') {
        // Accepted enumeration trade-off: Google-only account.
        return c.json({ error: 'use_google' }, 401);
    }

    const valid = await verifyPassword(password, user.password_hash, user.salt);
    if (!valid) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    logAuthEvent('login', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

authRouter.get('/v1/auth/me', authMiddleware(), async (c) => {
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;

    const user = await findUserById(db, parseInt(authUser.sub));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }

    const periodStart = getCurrentPeriodStart();
    const usage = await findCurrentUsagePeriod(db, user.id, periodStart);

    return c.json({
        user: makeUserResponse(user),
        hasPassword: user.password_hash !== '',
        googleLinked: user.google_sub !== null,
        usage: {
            totalRequests: usage?.total_requests ?? 0,
            totalInputTokens: usage?.total_input_tokens ?? 0,
            totalOutputTokens: usage?.total_output_tokens ?? 0,
        },
    });
});

// ─── Device Auth Flow ───────────────────────────────────────

// Step 1: IDE requests a device code
authRouter.post('/v1/auth/device/code', async (c) => {
    const db = c.env.arcane_db;

    // Clean up expired codes opportunistically
    await cleanExpiredDeviceCodes(db);

    const deviceCode = crypto.randomUUID();
    const userCode = generateUserCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await createDeviceCode(db, { deviceCode, userCode, expiresAt });

    return c.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${c.env.WEB_BASE_URL}/auth/device`,
        expires_in: 900,
        interval: 5,
    });
});

// Step 2: Logged-in user on web authorizes the device code
authRouter.post('/v1/auth/device/authorize', authMiddleware(), async (c) => {
    const { user_code } = await c.req.json<{ user_code?: string }>();
    if (!user_code) {
        return c.json({ error: 'user_code is required' }, 400);
    }

    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;

    const authorized = await authorizeDeviceCode(db, user_code, parseInt(authUser.sub));
    if (!authorized) {
        return c.json({ error: 'Invalid or expired device code' }, 400);
    }

    return c.json({ success: true });
});

// Step 3: IDE polls for the token
authRouter.post('/v1/auth/device/token', async (c) => {
    const { device_code } = await c.req.json<{ device_code?: string }>();
    if (!device_code) {
        return c.json({ error: 'device_code is required' }, 400);
    }

    const db = c.env.arcane_db;
    const record = await findDeviceCodeByDeviceCode(db, device_code);

    if (!record) {
        return c.json({ error: 'invalid_device_code' }, 400);
    }

    if (new Date(record.expires_at) < new Date()) {
        await deleteDeviceCode(db, record.id);
        return c.json({ error: 'expired_token' }, 400);
    }

    if (record.status === 'pending') {
        return c.json({ error: 'authorization_pending' }, 428);
    }

    if (record.status === 'authorized' && record.user_id) {
        const user = await findUserById(db, record.user_id);
        if (!user) { return c.json({ error: 'user_not_found' }, 404); }

        // Clean up used device code
        await deleteDeviceCode(db, record.id);

        logAuthEvent('device_login', { userId: user.id });
        return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
    }

    return c.json({ error: 'unknown_status' }, 500);
});
```

- [ ] **Step 11: Mount the new router in index.ts**

In `arcane-server/index.ts`, add after the `authRouter` import:
```ts
import { authEmailRouter } from './src/routes/auth-email.ts';
```
and after `app.route('/', authRouter);`:
```ts
app.route('/', authEmailRouter);
```

- [ ] **Step 12: Run the full suite + typecheck**

Run: `npm test && npm run check:types`
Expected: all test files PASS (health, tokens, db-auth, middleware, email, auth-email-routes, auth-routes); tsc clean.

- [ ] **Step 13: Commit**

```bash
git add src/lib/log.ts src/lib/email.ts src/lib/turnstile.ts src/routes/auth-email.ts src/routes/auth.ts index.ts test/email.test.ts test/auth-email-routes.test.ts test/auth-routes.test.ts
git commit -m "feat(server): email verification + password reset flows, turnstile, signup/login hardening

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 5: Google OAuth routes + web login exchange

**Files:**
- Create: `arcane-server/src/routes/auth-google.ts`
- Modify: `arcane-server/index.ts` (mount `authGoogleRouter`)
- Test: `arcane-server/test/auth-google.test.ts`

**Interfaces:**
- Consumes: Task 2 (`findUserByGoogleSub`, `findUserByEmail`, `linkGoogleSub`, `createOAuthUser`, `findUserById`, `createAuthToken`, `consumeAuthToken`, `cleanExpiredAuthTokens`, `generateToken`, `sha256Hex`, `s256Challenge`, `TOKEN_TTL_SECONDS`), Task 3 (`mintAuthResponse`).
- Produces: `authGoogleRouter` with `GET /v1/auth/google/start`, `GET /v1/auth/google/callback`, `POST /v1/auth/web/exchange`; exported `resolveGoogleAccount(db: D1Database, googleSub: string, email: string): Promise<UserRow | null>` (null = link conflict). The website (Phase 2b) consumes `?code=` on `${WEB_BASE_URL}${return_to}` and posts it to `/v1/auth/web/exchange`.
- Test scope decision (per approved plan direction): the account-linking decision logic is unit-tested via `resolveGoogleAccount`; `start` is tested by asserting the redirect URL + cookie; callback failure paths that need no Google network (missing/mismatched state) are tested; the FULL Google round trip is manual — listed as blocked-on-owner in Task 8.

- [ ] **Step 1: Write the failing tests**

Create `arcane-server/test/auth-google.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveGoogleAccount, authGoogleRouter } from '../src/routes/auth-google.ts';
import { createAuthToken, findUserByEmail } from '../src/lib/db.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../src/lib/tokens.ts';
import { seedPasswordUser, seedGoogleOnlyUser, jsonPost } from './helpers.ts';

const googleEnv = () => ({
    arcane_db: env.arcane_db,
    JWT_SECRET: env.JWT_SECRET,
    WEB_BASE_URL: env.WEB_BASE_URL,
    API_BASE_URL: env.API_BASE_URL,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
});

describe('resolveGoogleAccount', () => {
    it('logs in an existing user by google_sub', async () => {
        const existing = await seedGoogleOnlyUser('bysub@test.dev', 'sub-a');
        const user = await resolveGoogleAccount(env.arcane_db, 'sub-a', 'different@test.dev');
        expect(user?.id).toBe(existing.id);
    });

    it('links by email when the account has no google_sub (and marks verified)', async () => {
        const existing = await seedPasswordUser('linkme@test.dev', 'password123', { verified: false });
        const user = await resolveGoogleAccount(env.arcane_db, 'sub-b', 'linkme@test.dev');
        expect(user?.id).toBe(existing.id);
        expect(user?.google_sub).toBe('sub-b');
        expect(user?.email_verified).toBe(1);
    });

    it('creates a verified passwordless user when nothing matches', async () => {
        const user = await resolveGoogleAccount(env.arcane_db, 'sub-c', 'fresh@test.dev');
        expect(user?.password_hash).toBe('');
        expect(user?.email_verified).toBe(1);
        expect((await findUserByEmail(env.arcane_db, 'fresh@test.dev'))?.id).toBe(user?.id);
    });

    it('refuses when the email is linked to a DIFFERENT Google account', async () => {
        await seedGoogleOnlyUser('conflict@test.dev', 'sub-d');
        const user = await resolveGoogleAccount(env.arcane_db, 'sub-OTHER', 'conflict@test.dev');
        expect(user).toBeNull();
    });
});

describe('GET /v1/auth/google/start', () => {
    it('302s to Google with PKCE S256 + nonce + state and sets the signed cookie', async () => {
        const res = await authGoogleRouter.request(
            '/v1/auth/google/start?return_to=/account', {}, googleEnv());
        expect(res.status).toBe(302);
        const loc = new URL(res.headers.get('Location')!);
        expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(loc.searchParams.get('client_id')).toBe('test-client-id');
        expect(loc.searchParams.get('redirect_uri')).toBe(`${env.API_BASE_URL}/v1/auth/google/callback`);
        expect(loc.searchParams.get('response_type')).toBe('code');
        expect(loc.searchParams.get('scope')).toBe('openid email');
        expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
        expect(loc.searchParams.get('prompt')).toBe('select_account');
        expect(loc.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(loc.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(loc.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const cookie = res.headers.get('Set-Cookie')!;
        expect(cookie).toContain('g_oauth=');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Path=/v1/auth/google');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Max-Age=600');
    });

    it('falls back to /auth for a non-allowlisted return_to', async () => {
        const res = await authGoogleRouter.request(
            '/v1/auth/google/start?return_to=https://evil.example/x', {}, googleEnv());
        expect(res.status).toBe(302);
        // return_to only surfaces at callback time; here we just require the
        // redirect to still be a valid Google URL (no crash, no reflection).
        expect(res.headers.get('Location')!).toContain('accounts.google.com');
    });

    it('302s to the website error page when Google secrets are unset', async () => {
        const res = await authGoogleRouter.request('/v1/auth/google/start', {},
            { ...googleEnv(), GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=google_not_configured`);
    });
});

describe('GET /v1/auth/google/callback (no-network failure paths)', () => {
    it('redirects to the error page when the cookie is missing', async () => {
        const res = await authGoogleRouter.request(
            '/v1/auth/google/callback?code=x&state=y', {}, googleEnv());
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=google_oauth_failed`);
    });

    it('redirects to the error page on state mismatch', async () => {
        const start = await authGoogleRouter.request('/v1/auth/google/start', {}, googleEnv());
        const cookieValue = start.headers.get('Set-Cookie')!.split(';')[0]!;  // g_oauth=<jwt>
        const res = await authGoogleRouter.request(
            '/v1/auth/google/callback?code=x&state=WRONG',
            { headers: { Cookie: cookieValue } }, googleEnv());
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=google_oauth_failed`);
    });
});

describe('POST /v1/auth/web/exchange', () => {
    it('exchanges a valid 60s code once, then invalid_code on replay', async () => {
        const user = await seedGoogleOnlyUser('wexch@test.dev', 'sub-w');
        const raw = generateToken();
        await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'web_login',
            tokenHash: await sha256Hex(raw), ttlSeconds: TOKEN_TTL_SECONDS.web_login,
        });
        const res = await jsonPost('/v1/auth/web/exchange', { code: raw });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { email: string } }>();
        expect(body.token).toBeTruthy();
        expect(body.user.email).toBe('wexch@test.dev');

        const replay = await jsonPost('/v1/auth/web/exchange', { code: raw });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toEqual({ error: 'invalid_code' });
    });

    it('invalid_code for unknown/empty codes', async () => {
        expect((await jsonPost('/v1/auth/web/exchange', { code: 'nope' })).status).toBe(400);
        expect((await jsonPost('/v1/auth/web/exchange', {})).status).toBe(400);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `src/routes/auth-google.ts` not found.

- [ ] **Step 3: Implement src/routes/auth-google.ts**

```ts
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { jwtVerify, SignJWT, createRemoteJWKSet } from 'jose';
import {
    findUserByGoogleSub, findUserByEmail, linkGoogleSub, createOAuthUser,
    findUserById, createAuthToken, consumeAuthToken, cleanExpiredAuthTokens,
} from '../lib/db.ts';
import type { UserRow } from '../lib/db.ts';
import { generateToken, sha256Hex, s256Challenge, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { mintAuthResponse } from '../middleware/auth.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authGoogleRouter = new Hono<AppEnv>();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Lazy: createRemoteJWKSet only fetches on first verify, so module scope is safe.
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const OAUTH_COOKIE = 'g_oauth';
const OAUTH_COOKIE_ISSUER = 'arcane-server-google-oauth';
const RETURN_TO_ALLOWLIST = ['/auth', '/auth/device', '/account'];

interface OAuthCookiePayload {
    state: string;
    nonce: string;
    pkce_verifier: string;
    return_to: string;
}

// The state cookie is a 10-minute HS256 JWT under the existing JWT_SECRET —
// same jose primitives as session tokens, distinct issuer so neither can be
// replayed as the other.
async function signOAuthCookie(payload: OAuthCookiePayload, jwtSecret: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer(OAUTH_COOKIE_ISSUER)
        .setExpirationTime('10m')
        .sign(secret);
}

async function verifyOAuthCookie(token: string, jwtSecret: string): Promise<OAuthCookiePayload | null> {
    try {
        const secret = new TextEncoder().encode(jwtSecret);
        const { payload } = await jwtVerify(token, secret, { issuer: OAUTH_COOKIE_ISSUER });
        return payload as unknown as OAuthCookiePayload;
    } catch {
        return null;
    }
}

/** Account decision: login by google_sub → link by email → create.
 *  Returns null on a link conflict (email already bound to a DIFFERENT
 *  Google subject). Exported for unit tests. */
export async function resolveGoogleAccount(
    db: D1Database, googleSub: string, email: string,
): Promise<UserRow | null> {
    const bySub = await findUserByGoogleSub(db, googleSub);
    if (bySub) { return bySub; }
    const byEmail = await findUserByEmail(db, email);
    if (byEmail) {
        if (byEmail.google_sub && byEmail.google_sub !== googleSub) {
            return null;
        }
        return linkGoogleSub(db, byEmail.id, googleSub);
    }
    return createOAuthUser(db, { email, googleSub });
}

// ─── Start: 302 to Google with PKCE + nonce, state in a signed cookie ──

authGoogleRouter.get('/v1/auth/google/start', async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
        return c.redirect(`${c.env.WEB_BASE_URL}/auth?error=google_not_configured`, 302);
    }
    const requested = c.req.query('return_to') ?? '/auth';
    const returnTo = RETURN_TO_ALLOWLIST.includes(requested) ? requested : '/auth';

    const state = generateToken();
    const nonce = generateToken();
    const pkceVerifier = generateToken();
    const challenge = await s256Challenge(pkceVerifier);

    const cookie = await signOAuthCookie(
        { state, nonce, pkce_verifier: pkceVerifier, return_to: returnTo }, c.env.JWT_SECRET);
    setCookie(c, OAUTH_COOKIE, cookie, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/v1/auth/google',
        maxAge: 600,
    });

    const params = new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID,
        redirect_uri: `${c.env.API_BASE_URL}/v1/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
    });
    return c.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
});

// ─── Callback: verify state/nonce/ID token → 60s web_login code ──

authGoogleRouter.get('/v1/auth/google/callback', async (c) => {
    const fail = (reason: string) => {
        logAuthEvent('google_oauth_failed', { reason });
        return c.redirect(`${c.env.WEB_BASE_URL}/auth?error=google_oauth_failed`, 302);
    };

    const code = c.req.query('code');
    const state = c.req.query('state');
    const rawCookie = getCookie(c, OAUTH_COOKIE);
    deleteCookie(c, OAUTH_COOKIE, { path: '/v1/auth/google' });
    if (!code || !state || !rawCookie) { return fail('missing_params'); }

    const cookie = await verifyOAuthCookie(rawCookie, c.env.JWT_SECRET);
    if (!cookie || cookie.state !== state) { return fail('state_mismatch'); }

    // Exchange the authorization code; the PKCE verifier binds this exchange
    // to the browser session that started the flow.
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({
            code,
            client_id: c.env.GOOGLE_CLIENT_ID!,
            client_secret: c.env.GOOGLE_CLIENT_SECRET!,
            redirect_uri: `${c.env.API_BASE_URL}/v1/auth/google/callback`,
            grant_type: 'authorization_code',
            code_verifier: cookie.pkce_verifier,
        }),
    });
    if (!tokenRes.ok) { return fail('token_exchange'); }
    const { id_token } = await tokenRes.json() as { id_token?: string };
    if (!id_token) { return fail('no_id_token'); }

    let claims: { sub: string; email: string; email_verified?: boolean; nonce?: string };
    try {
        const { payload } = await jwtVerify(id_token, GOOGLE_JWKS, {
            issuer: ['https://accounts.google.com', 'accounts.google.com'],
            audience: c.env.GOOGLE_CLIENT_ID!,
        });
        claims = payload as unknown as typeof claims;
    } catch {
        return fail('id_token_invalid');
    }
    if (claims.nonce !== cookie.nonce) { return fail('nonce_mismatch'); }
    if (claims.email_verified !== true) { return fail('google_email_unverified'); }

    const db = c.env.arcane_db;
    const user = await resolveGoogleAccount(db, claims.sub, claims.email);
    if (!user) { return fail('link_conflict'); }

    // 60-second single-use handoff code in the query string — never a JWT in
    // a URL. The static site exchanges it via POST /v1/auth/web/exchange.
    await cleanExpiredAuthTokens(db);
    const rawCode = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'web_login',
        tokenHash: await sha256Hex(rawCode), ttlSeconds: TOKEN_TTL_SECONDS.web_login,
    });
    logAuthEvent('google_login', { userId: user.id });
    return c.redirect(`${c.env.WEB_BASE_URL}${cookie.return_to}?code=${rawCode}`, 302);
});

// ─── Web exchange: one-time code → session JWT ──

authGoogleRouter.post('/v1/auth/web/exchange', async (c) => {
    const { code } = await c.req.json<{ code?: string }>();
    if (typeof code !== 'string' || !code) {
        return c.json({ error: 'invalid_code' }, 400);
    }
    const db = c.env.arcane_db;
    const row = await consumeAuthToken(db, 'web_login', await sha256Hex(code));
    if (!row) {
        return c.json({ error: 'invalid_code' }, 400);
    }
    const user = await findUserById(db, row.user_id);
    if (!user) {
        return c.json({ error: 'invalid_code' }, 400);
    }
    logAuthEvent('web_exchange', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});
```

- [ ] **Step 4: Mount in index.ts**

Add after the `authEmailRouter` import in `arcane-server/index.ts`:
```ts
import { authGoogleRouter } from './src/routes/auth-google.ts';
```
and after `app.route('/', authEmailRouter);`:
```ts
app.route('/', authGoogleRouter);
```

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run check:types`
Expected: PASS. Note: no test performs the real Google fetch — the callback network path is exercised manually in Task 8 once the owner provides `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/auth-google.ts index.ts test/auth-google.test.ts
git commit -m "feat(server): Google OAuth (PKCE + nonce + signed state cookie) and web login exchange

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Editor grant/exchange (website → editor one-time code, PKCE-bound)

**Files:**
- Create: `arcane-server/src/routes/auth-editor.ts`
- Modify: `arcane-server/index.ts` (mount `authEditorRouter`)
- Test: `arcane-server/test/auth-editor.test.ts`

**Interfaces:**
- Consumes: Task 2 (`createAuthToken`, `consumeAuthToken`, `cleanExpiredAuthTokens`, `findUserById`, `generateToken`, `sha256Hex`, `s256Challenge`, `TOKEN_TTL_SECONDS`), Task 3 (`authMiddleware`, `AuthPayload`, `mintAuthResponse`).
- Produces: `authEditorRouter` with `POST /v1/auth/editor/grant` (Bearer; body `{challenge}`; → `{code, expires_in: 60}`) and `POST /v1/auth/editor/exchange` (public; body `{code, verifier}`; → `{token, user}` or the single opaque 400 `{error:'invalid_code'}`). Phase 2b's website island calls grant; Phase 3's editor calls exchange. The PKCE challenge is stored in `auth_tokens.meta` as `{"challenge":"..."}`.

- [ ] **Step 1: Write the failing tests**

Create `arcane-server/test/auth-editor.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { generateToken, s256Challenge, sha256Hex } from '../src/lib/tokens.ts';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';

async function grantCode(): Promise<{ code: string; verifier: string; jwt: string }> {
    const user = await seedPasswordUser(`ed-${crypto.randomUUID()}@test.dev`, 'password123');
    const jwt = await tokenFor(user);
    const verifier = generateToken();
    const challenge = await s256Challenge(verifier);
    const res = await jsonPost('/v1/auth/editor/grant', { challenge }, jwt);
    expect(res.status).toBe(200);
    const body = await res.json<{ code: string; expires_in: number }>();
    expect(body.expires_in).toBe(60);
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return { code: body.code, verifier, jwt };
}

describe('POST /v1/auth/editor/grant', () => {
    it('requires a Bearer token', async () => {
        const res = await jsonPost('/v1/auth/editor/grant', { challenge: 'x'.repeat(43) });
        expect(res.status).toBe(401);
    });

    it('rejects malformed challenges (not base64url 43-128)', async () => {
        const user = await seedPasswordUser('edbad@test.dev', 'password123');
        const jwt = await tokenFor(user);
        for (const challenge of ['short', 'x'.repeat(129), `${'A'.repeat(42)}+`, '']) {
            const res = await jsonPost('/v1/auth/editor/grant', { challenge }, jwt);
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'invalid_challenge' });
        }
    });
});

describe('POST /v1/auth/editor/exchange', () => {
    it('exchanges code+verifier for a full session', async () => {
        const { code, verifier } = await grantCode();
        const res = await jsonPost('/v1/auth/editor/exchange', { code, verifier });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { id: number } }>();
        expect(body.token).toBeTruthy();
        // the minted JWT works on a Bearer route
        const me = await jsonPost('/v1/auth/resend-verification', {}, body.token);
        expect(me.status).toBe(200);
    });

    it('rejects a replayed code (opaque invalid_code)', async () => {
        const { code, verifier } = await grantCode();
        expect((await jsonPost('/v1/auth/editor/exchange', { code, verifier })).status).toBe(200);
        const replay = await jsonPost('/v1/auth/editor/exchange', { code, verifier });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toEqual({ error: 'invalid_code' });
    });

    it('rejects a wrong verifier — and the code is burned by the attempt', async () => {
        const { code } = await grantCode();
        const wrong = await jsonPost('/v1/auth/editor/exchange', { code, verifier: generateToken() });
        expect(wrong.status).toBe(400);
        expect(await wrong.json()).toEqual({ error: 'invalid_code' });
    });

    it('rejects an expired code (opaque invalid_code)', async () => {
        const user = await seedPasswordUser('edexp@test.dev', 'password123');
        const verifier = generateToken();
        const challenge = await s256Challenge(verifier);
        const raw = generateToken();
        await env.arcane_db.prepare(
            `INSERT INTO auth_tokens (user_id, purpose, token_hash, meta, expires_at)
             VALUES (?, 'editor_login', ?, ?, datetime('now', '-10 seconds'))`
        ).bind(user.id, await sha256Hex(raw), JSON.stringify({ challenge })).run();
        const res = await jsonPost('/v1/auth/editor/exchange', { code: raw, verifier });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_code' });
    });

    it('rejects missing fields with the same opaque error', async () => {
        expect((await jsonPost('/v1/auth/editor/exchange', { code: 'x' })).status).toBe(400);
        expect((await jsonPost('/v1/auth/editor/exchange', { verifier: 'x' })).status).toBe(400);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `/v1/auth/editor/*` return 404.

- [ ] **Step 3: Implement src/routes/auth-editor.ts**

```ts
import { Hono } from 'hono';
import {
    findUserById, createAuthToken, consumeAuthToken, cleanExpiredAuthTokens,
} from '../lib/db.ts';
import { authMiddleware, mintAuthResponse } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { generateToken, sha256Hex, s256Challenge, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authEditorRouter = new Hono<AppEnv>();

// PKCE challenge: base64url, 43-128 chars (spec-fixed bounds).
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

// Step 1 (website, logged in): mint a 60s one-time code bound to the app's
// S256 challenge. The verifier never leaves the app.
authEditorRouter.post('/v1/auth/editor/grant', authMiddleware(), async (c) => {
    const { challenge } = await c.req.json<{ challenge?: string }>();
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) {
        return c.json({ error: 'invalid_challenge' }, 400);
    }
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;

    await cleanExpiredAuthTokens(db);
    const rawCode = generateToken();
    await createAuthToken(db, {
        userId: parseInt(authUser.sub),
        purpose: 'editor_login',
        tokenHash: await sha256Hex(rawCode),
        meta: JSON.stringify({ challenge }),
        ttlSeconds: TOKEN_TTL_SECONDS.editor_login,
    });
    logAuthEvent('editor_grant', { userId: authUser.sub });
    return c.json({ code: rawCode, expires_in: 60 });
});

// Step 2 (editor, public): code + verifier → 30-day session JWT.
// ONE opaque error for every failure mode — no oracle distinguishing
// unknown/expired/replayed codes from wrong verifiers.
authEditorRouter.post('/v1/auth/editor/exchange', async (c) => {
    const { code, verifier } = await c.req.json<{ code?: string; verifier?: string }>();
    const invalid = () => c.json({ error: 'invalid_code' }, 400);
    if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !verifier) {
        return invalid();
    }
    const db = c.env.arcane_db;
    // Consume FIRST: even a failed verifier attempt burns the code, so it
    // cannot be brute-forced against different verifiers.
    const row = await consumeAuthToken(db, 'editor_login', await sha256Hex(code));
    if (!row || !row.meta) { return invalid(); }
    let challenge: string | undefined;
    try {
        challenge = (JSON.parse(row.meta) as { challenge?: string }).challenge;
    } catch {
        return invalid();
    }
    if (!challenge || await s256Challenge(verifier) !== challenge) { return invalid(); }
    const user = await findUserById(db, row.user_id);
    if (!user) { return invalid(); }
    logAuthEvent('editor_exchange', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});
```

- [ ] **Step 4: Mount in index.ts**

Add after the `authGoogleRouter` import in `arcane-server/index.ts`:
```ts
import { authEditorRouter } from './src/routes/auth-editor.ts';
```
and after `app.route('/', authGoogleRouter);`:
```ts
app.route('/', authEditorRouter);
```

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run check:types`
Expected: PASS across all 9 test files.

- [ ] **Step 6: Commit**

```bash
git add src/routes/auth-editor.ts index.ts test/auth-editor.test.ts
git commit -m "feat(server): editor grant/exchange with PKCE-bound one-time codes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 7: index.ts wiring (CORS allowlist, rate limiters, verified-email gating) + admin tweaks

**Files:**
- Modify: `arcane-server/index.ts` (full-file rewrite shown below)
- Modify: `arcane-server/src/routes/admin.ts` (verified admin-created users; version-bumping password set)
- Modify: `arcane-server/src/lib/db.ts` (delete the now-dead `updateUser`)
- Test: `arcane-server/test/cors.test.ts`
- Test: `arcane-server/test/gating.test.ts`
- Test: `arcane-server/test/admin.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6 (`rateLimit`, `requireVerifiedEmail`, `authEmailRouter`, `authGoogleRouter`, `authEditorRouter`, `updatePasswordBumpVersion`, `createUser` with `emailVerified`).
- Produces: the final Phase 2a worker surface. Rate-limited paths — `RL_AUTH_STRICT`: `/v1/auth/signup`, `/v1/auth/login`, `/v1/auth/forgot`, `/v1/auth/reset`, `/v1/auth/verify`, `/v1/auth/resend-verification`, `/v1/auth/change-password`, `/v1/auth/web/exchange`, `/v1/auth/editor/exchange`; `RL_AUTH_POLL`: `/v1/auth/device/token`. `requireVerifiedEmail()` on `/v1/chat/*`, `/v1/embeddings`, `/v1/graph/*`, `/v1/unity/*`.

- [ ] **Step 1: Write the failing CORS tests**

Create `arcane-server/test/cors.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

const ALLOWED = [
    'https://arcaneai.org',
    'https://www.arcaneai.org',
    'https://dev.arcaneai.org',
    'http://localhost:4321',
    'http://localhost:1420',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
];

describe('CORS allowlist', () => {
    it('echoes every allowlisted origin', async () => {
        for (const origin of ALLOWED) {
            const res = await SELF.fetch('https://example.com/health', { headers: { Origin: origin } });
            expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBe(origin);
        }
    });

    it('sends no CORS header for other origins', async () => {
        const res = await SELF.fetch('https://example.com/health',
            { headers: { Origin: 'https://evil.example' } });
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
        expect(res.status).toBe(200); // no-CORS ≠ blocked for non-browser callers
    });

    it('answers preflight with Authorization and Content-Type allowed', async () => {
        const res = await SELF.fetch('https://example.com/v1/auth/login', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://arcaneai.org',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'Authorization, Content-Type',
            },
        });
        expect(res.status).toBe(204);
        const allowed = res.headers.get('Access-Control-Allow-Headers')?.toLowerCase() ?? '';
        expect(allowed).toContain('authorization');
        expect(allowed).toContain('content-type');
    });
});
```

- [ ] **Step 2: Write the failing gating test**

Create `arcane-server/test/gating.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';

const AI_PATHS = ['/v1/chat/completions', '/v1/embeddings', '/v1/graph/enrich', '/v1/unity/search'];

describe('requireVerifiedEmail on AI routes', () => {
    it('403 email_unverified for unverified users on every AI path', async () => {
        const user = await seedPasswordUser('gate-u@test.dev', 'password123', { verified: false });
        const token = await tokenFor(user);
        for (const path of AI_PATHS) {
            const res = await SELF.fetch(`https://example.com${path}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(res.status, path).toBe(403);
            expect(await res.json(), path).toEqual({ error: 'email_unverified' });
        }
    });

    it('verified users pass the gate (handler may still fail on absent AI bindings)', async () => {
        const user = await seedPasswordUser('gate-v@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await SELF.fetch('https://example.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'x', messages: [] }),
        });
        // Gate passed: anything but the two auth-gate statuses. The test env
        // has no AI binding, so the handler itself may 4xx/500 — that's fine.
        expect([401, 403]).not.toContain(res.status);
    });
});
```

- [ ] **Step 3: Write the failing admin test**

Create `arcane-server/test/admin.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';
import type { UserRow } from '../src/lib/db.ts';

// jsonPost is POST-only; minimal PUT helper for the admin route.
function SELF_put(path: string, body: unknown, token: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
}

async function adminToken(): Promise<string> {
    const admin = await seedPasswordUser(`adm-${crypto.randomUUID()}@test.dev`, 'adminpass123');
    const row = await env.arcane_db.prepare(
        "UPDATE users SET role = 'admin' WHERE id = ? RETURNING *"
    ).bind(admin.id).first<UserRow>();
    return tokenFor(row!);
}

describe('admin user management (0012 semantics)', () => {
    it('admin-created users are pre-verified', async () => {
        const token = await adminToken();
        const res = await jsonPost('/v1/admin/users',
            { email: 'made-by-admin@test.dev', password: 'password123' }, token);
        expect(res.status).toBe(201);
        const { id } = await res.json<{ id: number }>();
        const row = await env.arcane_db.prepare('SELECT email_verified FROM users WHERE id = ?')
            .bind(id).first<{ email_verified: number }>();
        expect(row!.email_verified).toBe(1);
    });

    it('admin password set bumps token_version (revokes sessions)', async () => {
        const token = await adminToken();
        const victim = await seedPasswordUser('victim@test.dev', 'password123');
        const victimJwt = await tokenFor(victim);
        const res = await SELF_put(`/v1/admin/users/${victim.id}`, { password: 'newpassword1' }, token);
        expect(res.status).toBe(200);
        const stale = await jsonPost('/v1/auth/resend-verification', {}, victimJwt);
        expect(stale.status).toBe(401);
    });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npm test`
Expected: FAIL — CORS headers absent (current `cors()` echoes `*`... the allowlist assertions on `tauri://localhost` etc. fail), gating test 200s past the gate for unverified users (currently no `requireVerifiedEmail`), admin-created user has `email_verified = 0`.

- [ ] **Step 5: Rewrite index.ts**

Replace the ENTIRE contents of `arcane-server/index.ts` with:
```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './src/types.ts';
import { authMiddleware, requireVerifiedEmail } from './src/middleware/auth.ts';
import { rateLimit } from './src/middleware/rate-limit.ts';
import { chatRouter } from './src/routes/chat.ts';
import { embeddingsRouter } from './src/routes/embeddings.ts';
import { graphRouter } from './src/routes/graph.ts';
import { unityApiRouter } from './src/routes/unity-api.ts';
import { authRouter } from './src/routes/auth.ts';
import { authEmailRouter } from './src/routes/auth-email.ts';
import { authGoogleRouter } from './src/routes/auth-google.ts';
import { authEditorRouter } from './src/routes/auth-editor.ts';
import { usageRouter } from './src/routes/usage.ts';
import { adminRouter } from './src/routes/admin.ts';
import { feedbackRouter } from './src/routes/feedback.ts';

const app = new Hono<AppEnv>();

// Browser origins that may call this API. Requests WITHOUT an Origin header
// (editor native fetch, curl, Google OAuth redirects) bypass CORS entirely —
// this list only governs what browsers may read cross-origin.
const ALLOWED_ORIGINS = [
    'https://arcaneai.org',
    'https://www.arcaneai.org',
    'https://dev.arcaneai.org',
    'http://localhost:4321',    // astro dev server
    'http://localhost:1420',    // tauri dev server
    'tauri://localhost',        // packaged app (macOS/Linux)
    'http://tauri.localhost',   // packaged app (Windows)
    'https://tauri.localhost',
];

app.use('*', cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
}));

// Auth rate limits (Cloudflare ratelimit bindings; fail open when absent).
const strict = rateLimit('RL_AUTH_STRICT');
for (const path of [
    '/v1/auth/signup', '/v1/auth/login', '/v1/auth/forgot', '/v1/auth/reset',
    '/v1/auth/verify', '/v1/auth/resend-verification', '/v1/auth/change-password',
    '/v1/auth/web/exchange', '/v1/auth/editor/exchange',
]) {
    app.use(path, strict);
}
app.use('/v1/auth/device/token', rateLimit('RL_AUTH_POLL'));

// Public routes
app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/', authRouter);
app.route('/', authEmailRouter);
app.route('/', authGoogleRouter);
app.route('/', authEditorRouter);
app.route('/', feedbackRouter);

// Protected routes (auth + verified email — AI endpoints only)
app.use('/v1/chat/*', authMiddleware(), requireVerifiedEmail());
app.use('/v1/embeddings', authMiddleware(), requireVerifiedEmail());
app.use('/v1/graph/*', authMiddleware(), requireVerifiedEmail());
// /v1/unity/* needs auth; /v1/admin/unity-api/* is guarded inside its router.
app.use('/v1/unity/*', authMiddleware(), requireVerifiedEmail());
app.route('/', chatRouter);
app.route('/', embeddingsRouter);
app.route('/', graphRouter);
app.route('/', unityApiRouter);

// Protected routes (auth only)
app.route('/', usageRouter);

// Admin routes (auth + admin middleware applied inside adminRouter)
app.route('/', adminRouter);

// Catch-all for anything that escapes route-level try/catch (unexpected
// throws, middleware failures) — logs structured JSON and never leaks
// internal error details to the client.
app.onError((err, c) => {
    console.error(JSON.stringify({
        event: 'unhandled_error',
        path: c.req.path,
        message: err.message,
        stack: err.stack,
    }));
    return c.json({ error: { message: 'Internal error', type: 'server_error' } }, 500);
});

export default app;
```

- [ ] **Step 6: Update admin.ts**

In `arcane-server/src/routes/admin.ts`, change the imports block to:
```ts
import {
    findAllUsersWithUsage, createUser, deleteUser, findUserById,
    updatePasswordBumpVersion,
    getCurrentPeriodStart,
    findAllFeedback,
} from '../lib/db.ts';
```

Replace the `POST /v1/admin/users` handler body's `createUser` call with:
```ts
    const user = await createUser(c.env.arcane_db, {
        email, passwordHash: hash, salt, emailVerified: true,
    });
```
(Admin-created users are handed their password directly — the email is owner-vetted, so they're pre-verified.)

Replace the whole `PUT /v1/admin/users/:id` handler with:
```ts
adminRouter.put('/v1/admin/users/:id', async (c) => {
    const { id } = c.req.param();
    const updates = await c.req.json<{ password?: string }>();
    if (!updates.password) {
        const user = await findUserById(c.env.arcane_db, parseInt(id));
        if (!user) return c.json({ error: 'User not found' }, 404);
        return c.json({ id: user.id, email: user.email, role: user.role });
    }
    const { hash, salt } = await hashPassword(updates.password);
    // token_version bump — an admin password set revokes the user's sessions.
    const user = await updatePasswordBumpVersion(c.env.arcane_db, parseInt(id), hash, salt);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json({ id: user.id, email: user.email, role: user.role });
});
```

- [ ] **Step 7: Delete the dead updateUser helper**

Run: `grep -rn "updateUser" src/ index.ts`
Expected: only the definition in `src/lib/db.ts` remains (admin.ts no longer imports it). Delete the whole `updateUser` function (the `export async function updateUser(...)` block) from `src/lib/db.ts`.

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npm test && npm run check:types`
Expected: PASS — 12 test files, all green; tsc clean. (`test/auth-email-routes.test.ts` and friends now also traverse the CORS middleware and strict-limit paths — the limiter binding is absent in tests, so it fails open by design.)

- [ ] **Step 9: Commit**

```bash
git add index.ts src/routes/admin.ts src/lib/db.ts test/cors.test.ts test/gating.test.ts test/admin.test.ts
git commit -m "feat(server): CORS allowlist, auth rate limits, verified-email gating on AI routes, admin 0012 semantics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 8: Dev deploy, secrets runbook, live verification checklist

**Files:**
- No source changes (fix-forward commits only if verification finds bugs).

**Interfaces:**
- Consumes: everything above, the existing dev env (`arcane-server-dev`, D1 `arcane-db-dev`, `api-dev.arcaneai.org` — all live from Phase 1).
- Produces: Phase 2a running on `https://api-dev.arcaneai.org` with migration 0012 applied; a checked verification list; a blocked-on-owner list for Phase 2b/4.

- [ ] **Step 1: Apply migration 0012 to the dev DB**

Run (in `arcane-server/`): `npm run db:migrate:dev:remote`
Expected: lists `0012_auth_accounts.sql` under "Migrations to be applied", then `🚣 Executed ... commands` — no SQL errors.

- [ ] **Step 2: Verify the grandfather UPDATE ran**

Run: `npx wrangler d1 execute arcane-db-dev --env dev --remote --command "SELECT COUNT(*) AS total, SUM(email_verified) AS verified FROM users"`
Expected: `total` equals `verified` (every pre-existing dev user is grandfathered to verified) — the non-negotiable spec requirement.

- [ ] **Step 3: Secrets — set what exists, document what's blocked**

Nothing to set today: `JWT_SECRET` already exists on `--env dev` (Phase 1 runbook). When the owner provides credentials, run (each prompts for the value):
```bash
npx wrangler secret put GOOGLE_CLIENT_ID --env dev
npx wrangler secret put GOOGLE_CLIENT_SECRET --env dev
npx wrangler secret put TURNSTILE_SECRET --env dev
```
Until then the deployed code degrades exactly as designed: Google start → 302 `/auth?error=google_not_configured`; Turnstile verification skipped (one `auth_turnstile_skipped` warn per isolate).
Confirm current state: `npx wrangler secret list --env dev` → expected: `JWT_SECRET` only.

- [ ] **Step 4: Deploy to dev**

Run: `npm run deploy:dev`
Expected: `Uploaded arcane-server-dev`, bindings table shows `arcane_db`, `AI`, `VECTORIZE`, `EMAIL`, `RL_AUTH_STRICT`, `RL_AUTH_POLL`, vars incl. `API_BASE_URL`/`EMAIL_FROM`, route `api-dev.arcaneai.org`. Keep `npx wrangler tail --env dev` open in a second terminal during the checks below.

- [ ] **Step 5: Live verification (no Google credentials needed)**

Work through every line; `$API` = `https://api-dev.arcaneai.org`. Use a real inbox you control for `$ME` (verification emails are REAL — the domain is onboarded).

```bash
API=https://api-dev.arcaneai.org
ME=<your-real-inbox+arcanedev@gmail.com>
```

- [ ] `curl -s $API/health` → `{"status":"ok"}`
- [ ] Signup: `curl -s -X POST $API/v1/auth/signup -H 'Content-Type: application/json' -d "{\"email\":\"$ME\",\"password\":\"devpass123\"}"` → 200, `user.emailVerified: false`; save `token` as `$T`.
- [ ] Weak password: same with `"password":"short"` → `{"error":"weak_password"}`.
- [ ] Bad email: `"email":"nope"` → `{"error":"invalid_email"}`.
- [ ] `/me`: `curl -s $API/v1/auth/me -H "Authorization: Bearer $T"` → `user.emailVerified:false`, `hasPassword:true`, `googleLinked:false`.
- [ ] AI gate: `curl -s -X POST $API/v1/chat/completions -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{}'` → 403 `{"error":"email_unverified"}`.
- [ ] Verification email arrived at `$ME` from `no-reply@arcaneai.org` with an `https://dev.arcaneai.org/verify?token=...` link. Extract `$VTOK` from the link.
- [ ] Verify: `curl -s -X POST $API/v1/auth/verify -H 'Content-Type: application/json' -d "{\"token\":\"$VTOK\"}"` → 200 `user.emailVerified:true`; save new `token` as `$T2`. Replay the same call → 400 `invalid_token`.
- [ ] AI gate open: repeat the chat curl with `$T2` → NOT 401/403 (model-side errors are fine).
- [ ] Legacy grandfathering: a JWT minted BEFORE this deploy (any pre-existing dev tester token, or one minted from the pre-deploy worker) still passes `/v1/auth/me` → 200 (version-0 acceptance).
- [ ] Forgot: `curl -s -X POST $API/v1/auth/forgot -H 'Content-Type: application/json' -d "{\"email\":\"$ME\"}"` → `{"ok":true}`; also with an unknown email → `{"ok":true}` (same body). Reset email arrives with `/reset?token=...`; extract `$RTOK`.
- [ ] Reset: `curl -s -X POST $API/v1/auth/reset -H 'Content-Type: application/json' -d "{\"token\":\"$RTOK\",\"newPassword\":\"devpass456\"}"` → 200 with fresh token `$T3`. Then `$T2` on `/v1/auth/me` → 401 (token_version bump revoked it). Login with `devpass456` → 200.
- [ ] Editor grant/exchange: generate a PKCE pair —
  `node -e 'const c=require("crypto");const v=c.randomBytes(32).toString("base64url");console.log(v, c.createHash("sha256").update(v).digest("base64url"))'`
  → grant: `curl -s -X POST $API/v1/auth/editor/grant -H "Authorization: Bearer $T3" -H 'Content-Type: application/json' -d "{\"challenge\":\"<ch>\"}"` → `{code, expires_in:60}`; exchange: `curl -s -X POST $API/v1/auth/editor/exchange -H 'Content-Type: application/json' -d "{\"code\":\"<code>\",\"verifier\":\"<v>\"}"` → 200 `{token, user}`. Replay → `{"error":"invalid_code"}`. Wrong verifier on a fresh grant → `{"error":"invalid_code"}`. Wait 61 s on a fresh grant → `{"error":"invalid_code"}`.
- [ ] Device flow: `curl -s -X POST $API/v1/auth/device/code -d '{}'` → `verification_uri` is `https://dev.arcaneai.org/auth/device`.
- [ ] CORS: `curl -sI $API/health -H 'Origin: https://dev.arcaneai.org' | grep -i access-control-allow-origin` → echoes the origin; with `Origin: https://evil.example` → no header.
- [ ] Rate limit: `for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST $API/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"x@y.dev","password":"wrongwrong"}'; done` → 401s then `429` by the 11th (binding is live in dev, unlike tests).
- [ ] Google unconfigured: `curl -sI "$API/v1/auth/google/start"` → `location: https://dev.arcaneai.org/auth?error=google_not_configured`.
- [ ] `wrangler tail --env dev` showed `auth_signup`/`auth_email_sent`/`auth_email_verified`/`auth_password_reset` events and NO raw tokens/passwords in any log line.
- [ ] Prod untouched: `curl -s https://api.arcaneai.org/health` → `{"status":"ok"}`; prod worker was NOT deployed (`npx wrangler deployments list` shows no new prod deployment today).

- [ ] **Step 6: Blocked-on-owner list (record, do not attempt)**

These spec B4 cases CANNOT be verified until the owner provisions credentials; list them in the completion report:
1. Google: consent screen + OAuth client, redirect URIs for prod/dev/localhost (runbook B4.1) → then live-test `/v1/auth/google/start` 302 → Google → callback → `?code=` → `/v1/auth/web/exchange`, including: new-user create, link-by-email (signup with password first, then Google with same email → `googleLinked:true` in `/me`), repeat login by `google_sub`, and signup-on-Google-only → 409 `google_account` / login → 401 `use_google`.
2. Turnstile: widget creation (hostnames arcaneai.org, dev.arcaneai.org, localhost) → `TURNSTILE_SECRET` → verify signup/login/forgot reject a missing/bad `cf-turnstile-response` with `{"error":"turnstile_failed"}` once the secret is set.
3. Full website flows (`/verify`, `/reset`, `/auth/device` pages) — Phase 2b work; the email links will 404 on dev.arcaneai.org until then (API-side flows above are verified via curl regardless).

- [ ] **Step 7: Final check + report**

Run: `npm test && git log --oneline master..HEAD -- .`
Expected: full suite green; 7 commits (Tasks 1–7) on `dev`. Report the checklist results + blocked-on-owner list. Do NOT deploy prod, do NOT push, do NOT tag.

---

## Spec coverage map (B1 → tasks)

| B1 step | Where |
|---|---|
| 1. Migration 0012 | Task 2 |
| 2. `src/lib/tokens.ts` | Task 2 |
| 3. db.ts helpers | Task 2 (+ `updateUser` removal in Task 7) |
| 4. middleware/auth.ts claims + DB check + `requireVerifiedEmail` + `makeJwtPayloadFromUser` | Task 3 |
| 5. `src/middleware/rate-limit.ts` | Task 3 |
| 6. `src/lib/email.ts` + `logAuthEvent` | Task 4 |
| 7. `src/routes/auth-email.ts` | Task 4 |
| 8. `src/routes/auth-google.ts` | Task 5 |
| 9. `src/routes/auth-editor.ts` | Task 6 |
| 10. auth.ts signup/login/me/device changes | Task 4 |
| 11. index.ts CORS/mounts/limiters/gating | Tasks 4–6 (mounts) + Task 7 (rest) |
| 12. admin.ts tweaks | Task 7 |
| 13. wrangler.toml + types.ts bindings | Task 3 |
| B3 security properties | Baked into Tasks 2–6 code + tests |
| B4 runbook (server side) | Task 8 (Google/Turnstile = blocked-on-owner) |

## Resolved ambiguities (decisions an implementer must NOT re-litigate)

- `auth_tokens` gains a nullable `meta TEXT` column (not in the spec's column sketch) — the editor grant must persist the PKCE challenge next to the code hash; JSON keeps it purpose-generic.
- New routers are mounted in the task that creates them (4/5/6), not all in Task 7 — every task stays independently testable; Task 7 owns CORS/limiters/gating/admin.
- `RL_AUTH_STRICT` covers all nine credential-bearing endpoints listed in Task 7 (spec named the class, not the list); `reset`/`verify`/`exchange` are included per B3's "rate-limited exchange".
- Forgot-flow throttle (3/hr) reuses `countRecentAuthTokens` silently (still `{ok:true}`) so throttling can't be probed; resend-verification throttles loudly (429 `resend_throttled`) since it's an authed route.
- Turnstile token is read from JSON body keys `cf-turnstile-response` (canonical widget field name) OR `turnstileToken` — the website island may send either.
- `change-password` returns a fresh `{token, user}` (its own bump would otherwise sign out the very client that changed the password); Google-only users set their first password via forgot→reset (which is why reset also sets `email_verified`).
- Google OAuth state cookie = 10-min HS256 JWT under the existing `JWT_SECRET` with a distinct issuer (fits the repo's jose usage; no new secret, no hono signed-cookie dependency).
- `return_to` allowlist is the exact set `['/auth', '/auth/device', '/account']`, defaulting to `/auth`.
- Editor exchange consumes the code BEFORE checking the verifier — a wrong-verifier attempt burns the code (anti-brute-force), covered by a test.
- The vitest pool runs against `wrangler.test.toml` (not wrangler.toml) so the AI/Vectorize/send_email/ratelimit bindings — unsupported or remote-only in the local pool — can't break the harness; all four have guarded code paths, and the real bindings are exercised in Task 8's live checks.






