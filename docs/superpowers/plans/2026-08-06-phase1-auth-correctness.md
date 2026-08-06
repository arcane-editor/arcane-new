# Phase 1: Auth Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make editor sign-in work in every real-world path — including when the app was not running — and stop unverified-email users from being logged out in a loop.

**Architecture:** A new `editor_attempts` table makes every editor login PKCE-bound at creation and gives all three delivery channels (deep link, loopback, poll) one atomic single-use consume. The client persists its pending attempt so a cold-start deep link can complete, and silently re-initiates when a deep link arrives with nothing to match. The `/v1/auth/device/*` flow — a PKCE-less parallel login path — is deleted.

**Tech Stack:** Cloudflare Workers + Hono + D1 (server, vitest via `@cloudflare/vitest-pool-workers`); Tauri v2 + React 19 + Zustand (editor, `bun test`); Astro + React (website, vitest).

## Global Constraints

- **Branch:** all work lands on `heads/v0.3.0`. Never commit to `dev` or `master`.
- **Spec:** `docs/superpowers/specs/2026-08-06-auth-onboarding-subscriptions-design.md`.
- **Only 401 ends a session.** Every 403, 5xx, timeout and network error must preserve it.
- **One opaque error per auth failure mode.** The exchange and poll endpoints return a single indistinguishable error for unknown / expired / replayed / wrong-verifier. Never add a distinguishing code.
- **Deep modules (editor):** import features only via their `index.ts` barrel — see `editor/CLAUDE.md`. `bun run check:modules` enforces this.
- **Server tests must stay green:** 147 tests / 23 files at the start of this phase.
- **`ALTER TABLE ADD COLUMN` is not idempotent** on D1 — a partial migration failure is reconciled by hand, never blind re-run (precedent: `0013_billing.sql`).
- **Migration numbering:** this phase owns `0016`. Phase 2/3 lifecycle columns land later in `0017`.
- **PKCE challenge validation regex** (already in use, do not change): `/^[A-Za-z0-9_-]{43,128}$/`.
- Run server tests with `npm test` in `arcane-server/`; editor tests with `bun test src` in `editor/`; website tests with `npx vitest run` in `landing-page/`.

---

## File Structure

**Server (`arcane-server/`)**
- Create `migrations/0016_editor_attempts.sql` — new table, drop `device_codes`.
- Create `src/lib/attempts.ts` — all `editor_attempts` queries. Kept out of the already-630-line `db.ts`.
- Modify `src/routes/auth-editor.ts` — add `attempt` + `poll`, repoint `grant`/`exchange`.
- Modify `src/routes/auth.ts` — delete the three device routes.
- Modify `src/lib/db.ts` — delete six device-code helpers.
- Modify `src/lib/tokens.ts` — retire the `editor_login` TTL entry.
- Modify `index.ts` — rate-limit the new endpoints, drop device rate limits.
- Create `test/auth-attempts.test.ts`; modify `test/auth-editor.test.ts`, `test/auth-routes.test.ts`.

**Editor (`editor/`)**
- Create `src/features/auth/services/attempt-store.ts` — persist/load/clear the pending attempt.
- Modify `src/features/auth/services/browser-login.ts` — attempt registration, cold-start resume, re-initiate.
- Modify `src/features/auth/services/login-transport.ts` — add the poll transport.
- Modify `src/features/auth/services/auth-client.ts` — exchange contract, `createAttempt`, `pollAttempt`, delete device methods.
- Modify `src/features/ai-panel/services/arcane-stream.ts` — split 401 from 403.
- Modify `src/stores/ai.ts` — `verificationRequired` state.
- Modify `src/stores/auth.ts` — consume `plan`/`credits` from exchange.
- Modify `src/features/auth/components/AuthTab.tsx` — delete device UI.
- Create `src/features/ai-panel/components/AiVerifyEmailGate.tsx`.

**Website (`landing-page/`)**
- Modify `src/lib/editor-login.ts` — carry `attempt` through the request.
- Modify `src/components/auth/AuthHub.tsx` — pass `attempt_id` to grant.

---

## Task 1: Stop 403 `email_unverified` from logging the user out

This is the live bug. It is worth shipping on its own.

**Files:**
- Modify: `editor/src/features/ai-panel/services/arcane-stream.ts:308-320`
- Modify: `editor/src/stores/ai.ts:191` (state), `:626` (setter)
- Test: `editor/src/features/ai-panel/services/arcane-stream.test.ts`

**Interfaces:**
- Consumes: `useAiStore.getState().setAuthNotice(notice: string | null)` — exists.
- Produces: `useAiStore.getState().setVerificationRequired(required: boolean)` — consumed by Task 2.

- [ ] **Step 1: Write the failing test**

Add to `arcane-stream.test.ts`. First extend the existing `mock.module` for `../../../stores/ai` (around line 31) with a recorder, alongside `setAuthNotice`:

```ts
let verificationRequiredCalls: boolean[] = [];
// …inside the getState() object literal, next to setAuthNotice:
      setVerificationRequired: (required: boolean) => {
        verificationRequiredCalls.push(required);
      },
```

Then add the test:

```ts
describe('403 email_unverified', () => {
  it('does NOT log the user out and flags verification instead', async () => {
    logoutCalls = 0;
    authNoticeCalls = [];
    verificationRequiredCalls = [];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'email_unverified' }), { status: 403 })) as typeof fetch;

    const stream = createArcaneStreamFn();
    await expect(drain(stream(ctx, opts()))).rejects.toThrow(/verify/i);

    expect(logoutCalls).toBe(0);
    expect(verificationRequiredCalls).toEqual([true]);
  });

  it('still logs out on 401', async () => {
    logoutCalls = 0;
    verificationRequiredCalls = [];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as typeof fetch;

    const stream = createArcaneStreamFn();
    await expect(drain(stream(ctx, opts()))).rejects.toThrow();

    expect(logoutCalls).toBe(1);
    expect(verificationRequiredCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/ai-panel/services/arcane-stream.test.ts`
Expected: FAIL — the `email_unverified` case reports `logoutCalls` of 1, and `setVerificationRequired` is not a function.

- [ ] **Step 3: Add `verificationRequired` to the AI store**

In `editor/src/stores/ai.ts`, beside `authNotice: string | null;` in the state interface (line ~191):

```ts
  /** True when the server rejected an AI call with 403 email_unverified.
   *  Distinct from authNotice: the session is VALID, the mailbox is not
   *  confirmed, so the user must never be signed out over it. */
  verificationRequired: boolean;
```

Beside the `authNotice: null` initialisers (lines ~425, ~672, ~695) add `verificationRequired: false`. Beside `setAuthNotice` (line ~626):

```ts
  setVerificationRequired: (required: boolean) => set({ verificationRequired: required }),
```

Add `setVerificationRequired: (required: boolean) => void;` to the actions interface.

- [ ] **Step 4: Split 401 from 403 in the stream**

Replace the combined branch at `arcane-stream.ts:309`:

```ts
      if (attemptResponse.status === 401 || attemptResponse.status === 403) {
```

with:

```ts
      // 403 email_unverified is a VALID session whose mailbox isn't confirmed.
      // Logging out here is the bug that trapped every email/password signup
      // in a sign-in loop: log out → sign in → same 403 → log out again.
      // Only 401 (and a 403 that is genuinely not about verification) ends a
      // session; see the spec's "only 401 ends a session" invariant.
      if (attemptResponse.status === 403) {
        const body = (await attemptResponse.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'email_unverified') {
          useAiStore.getState().setVerificationRequired(true);
          throw new Error(
            'Verify your email address to use AI features. Check your inbox for the verification link.',
          );
        }
        throw new Error(body.error ?? `Request forbidden (${attemptResponse.status})`);
      }

      if (attemptResponse.status === 401) {
```

Leave the existing 401 body (the `setAuthNotice` + `logout()` calls) untouched inside the new `if`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd editor && bun test src/features/ai-panel/services/arcane-stream.test.ts`
Expected: PASS, including all pre-existing cases in the file.

- [ ] **Step 6: Clear the flag on a successful call**

In `ai.ts`, wherever `authNotice: null` is reset at the start of a run (line ~446, `set({ isAgentRunning: true, errorMessage: null, authNotice: null })`), add `verificationRequired: false` so a user who verifies and retries gets a clean panel.

- [ ] **Step 7: Run the full editor suite**

Run: `cd editor && bun test src`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add editor/src/features/ai-panel/services/arcane-stream.ts \
        editor/src/features/ai-panel/services/arcane-stream.test.ts \
        editor/src/stores/ai.ts
git commit -m "fix(auth): stop 403 email_unverified from logging the user out

requireVerifiedEmail() returns 403 for a VALID session whose mailbox isn't
confirmed, but the stream treated 403 exactly like 401 and signed the user
out. Every email/password signup was trapped: sign in -> first AI message ->
403 -> logged out with 'session expired' -> repeat. Google signups are
auto-verified, which is why it looked intermittent.

Only 401 ends a session now; email_unverified raises verificationRequired."
```

---

## Task 2: Show a verification panel instead of a dead end

**Files:**
- Create: `editor/src/features/ai-panel/components/AiVerifyEmailGate.tsx`
- Modify: `editor/src/features/ai-panel/components/AiChatPanel.tsx:25,42-44`
- Modify: `editor/src/features/auth/services/auth-client.ts` (add `resendVerification`)

**Interfaces:**
- Consumes: `useAiStore().verificationRequired` (Task 1); `useAuthStore().email`, `.token`.
- Produces: `authClient.resendVerification(token: string): Promise<void>` — throws on non-2xx.

- [ ] **Step 1: Add the client method**

In `auth-client.ts`, after `fetchUsage`:

```ts
  /** Re-send the verification email for the signed-in user. The server
   *  throttles this (countRecentAuthTokens); a 429 surfaces as a thrown
   *  error the panel renders verbatim. */
  async resendVerification(token: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/v1/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `Could not resend (${res.status})`);
    }
  }
```

- [ ] **Step 2: Create the gate component**

`editor/src/features/ai-panel/components/AiVerifyEmailGate.tsx`:

```tsx
import { useState } from 'react';
import { MailCheck, Loader2 } from 'lucide-react';
import { useAuthStore } from '../../../stores/auth';
import { useAiStore } from '../../../stores/ai';
import { authClient } from '../../auth';

/** Shown when the server reported 403 email_unverified. The session is VALID —
 *  this panel must never offer or trigger a sign-out. */
function AiVerifyEmailGate() {
  const email = useAuthStore((s) => s.email);
  const token = useAuthStore((s) => s.token);
  const setVerificationRequired = useAiStore((s) => s.setVerificationRequired);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const resend = async () => {
    if (!token || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await authClient.resendVerification(token);
      setNotice(`Sent. Check ${email ?? 'your inbox'} for the link.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not resend the email.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <MailCheck size={20} style={{ color: 'var(--accent)', alignSelf: 'center' }} />
        <div style={titleStyle}>Verify your email</div>
        <div style={subtitleStyle}>
          We sent a link to <strong>{email ?? 'your address'}</strong>. Click it to unlock AI
          features — you'll stay signed in here.
        </div>
        {notice && <div style={noticeStyle}>{notice}</div>}
        <button onClick={() => void resend()} disabled={busy} style={primaryBtnStyle}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          {busy ? 'Sending…' : 'Resend verification email'}
        </button>
        <button onClick={() => setVerificationRequired(false)} style={secondaryBtnStyle}>
          I've verified — retry
        </button>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '24px', overflow: 'auto',
};
const cardStyle: React.CSSProperties = {
  width: '100%', maxWidth: 280, display: 'flex', flexDirection: 'column',
  alignItems: 'stretch', gap: 10, textAlign: 'center',
};
const titleStyle: React.CSSProperties = {
  fontSize: 15, fontWeight: 600, color: 'var(--text-primary)',
};
const subtitleStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
};
const noticeStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px',
  background: 'var(--bg-input)', borderRadius: 4,
};
const primaryBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '8px 14px', background: 'var(--button-primary-bg)', border: 'none',
  borderRadius: 6, color: 'var(--button-primary-text)', fontSize: 13,
  fontWeight: 600, cursor: 'pointer',
};
const secondaryBtnStyle: React.CSSProperties = {
  padding: '6px 14px', background: 'transparent', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, fontWeight: 500,
  cursor: 'pointer',
};

export default AiVerifyEmailGate;
```

- [ ] **Step 3: Render it from the panel**

In `AiChatPanel.tsx`, alongside the existing `authNotice` read (line 25):

```tsx
  const verificationRequired = useAiStore((s) => s.verificationRequired);
```

and before the main timeline render, after whatever sign-in gate check exists:

```tsx
  if (verificationRequired) return <AiVerifyEmailGate />;
```

Import it: `import AiVerifyEmailGate from './AiVerifyEmailGate';`

- [ ] **Step 4: Verify module boundaries and types**

Run: `cd editor && bun run check:modules && npx tsc --noEmit`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add editor/src/features/ai-panel/components/AiVerifyEmailGate.tsx \
        editor/src/features/ai-panel/components/AiChatPanel.tsx \
        editor/src/features/auth/services/auth-client.ts
git commit -m "feat(auth): verification panel with resend instead of a dead end"
```

---

## Task 3: Repair the exchange contract

The server already sends `plan` and `credits`; the editor's type drops them and hardcodes `plan: null`, forcing a second round-trip and showing `—` in the account view.

**Files:**
- Modify: `editor/src/features/auth/services/auth-client.ts:25-29,77-82`
- Modify: `editor/src/stores/auth.ts:72-93`
- Test: `editor/src/features/auth/services/auth-client.test.ts`

**Interfaces:**
- Produces: `ExchangeResult.user` gains `plan: string` and `credits: number`.

- [ ] **Step 1: Write the failing test**

Add to `auth-client.test.ts`:

```ts
it('returns plan and credits from the exchange response', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        token: 'jwt-abc',
        user: { id: 7, email: 'a@b.dev', role: 'user', emailVerified: true, plan: 'pro', credits: 1400 },
      }),
      { status: 200 },
    )) as typeof fetch;

  const result = await authClient.exchangeEditorCode('code', 'verifier');
  expect(result.success).toBe(true);
  expect(result.user?.plan).toBe('pro');
  expect(result.user?.credits).toBe(1400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/auth/services/auth-client.test.ts`
Expected: FAIL — `result.user.plan` is `undefined` (the type strips it).

- [ ] **Step 3: Widen the type**

In `auth-client.ts` replace the `ExchangeResult` interface:

```ts
export interface ExchangeResult {
  success: boolean;
  error?: string;
  /** Mirrors the server's makeUserResponse() exactly — `plan` and `credits`
   *  were previously dropped here, forcing a redundant /v1/usage round-trip
   *  and showing "—" in the account view until it landed. */
  user?: {
    id: number;
    email: string;
    role: string;
    emailVerified: boolean;
    plan: string;
    credits: number;
  };
}
```

and the inline response type at line ~77:

```ts
      const data = (await res.json()) as {
        token: string;
        user: {
          id: number; email: string; role: string;
          emailVerified: boolean; plan: string; credits: number;
        };
      };
```

- [ ] **Step 4: Consume it in the store**

In `stores/auth.ts`, replace the `plan: null` block (lines ~80-88) with:

```ts
            set({
              loggedIn: true,
              email: result.user.email,
              plan: result.user.plan,
              credits: result.user.credits,
              token: stored?.token ?? null,
              loginStatus: 'idle',
              error: null,
            });
```

and delete the now-stale comment above it about the exchange carrying no plan. Keep the `refreshUsage()` call — it also refreshes `planPeriodEnd`, which the exchange does not carry.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd editor && bun test src && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add editor/src/features/auth/services/auth-client.ts \
        editor/src/features/auth/services/auth-client.test.ts \
        editor/src/stores/auth.ts
git commit -m "fix(auth): consume plan+credits from the exchange response"
```

---

## Task 4: `editor_attempts` migration and the attempt endpoint

**Files:**
- Create: `arcane-server/migrations/0016_editor_attempts.sql`
- Create: `arcane-server/src/lib/attempts.ts`
- Modify: `arcane-server/src/routes/auth-editor.ts`
- Modify: `arcane-server/index.ts` (rate limit)
- Test: `arcane-server/test/auth-attempts.test.ts`

**Interfaces:**
- Produces, from `src/lib/attempts.ts`:
  - `interface EditorAttemptRow { attempt_id, challenge, status, user_id, code_hash, consumed_at, expires_at, created_at }`
  - `createAttempt(db: D1Database, challenge: string, ttlSeconds: number): Promise<string>` → the new `attempt_id`
  - `authorizeAttempt(db, attemptId: string, userId: number, codeHash: string): Promise<boolean>`
  - `consumeAttemptByCode(db, codeHash: string): Promise<EditorAttemptRow | null>`
  - `consumeAttemptById(db, attemptId: string): Promise<EditorAttemptRow | null>`
  - `findAttempt(db, attemptId: string): Promise<EditorAttemptRow | null>`
  - `cleanExpiredAttempts(db): Promise<void>`
  - `ATTEMPT_TTL_SECONDS = 600`

- [ ] **Step 1: Write the migration**

`arcane-server/migrations/0016_editor_attempts.sql`:

```sql
-- Editor login attempts. Replaces device_codes with a PKCE-bound record:
-- every attempt carries its S256 challenge from creation, so all three
-- delivery channels (deep link, loopback, poll) converge on ONE atomic
-- single-use consume — the `consumed_at IS NULL` predicate proven by
-- consumeAuthToken in src/lib/db.ts.
--
-- NOTE (prod cutover): CREATE/DROP here are idempotent, but the DROP is
-- destructive — any in-flight device_codes rows are abandoned. Device codes
-- live 15 minutes, so deploy is safe outside that window.

CREATE TABLE IF NOT EXISTS editor_attempts (
    attempt_id  TEXT PRIMARY KEY,
    challenge   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | authorized
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    code_hash   TEXT,
    consumed_at TEXT,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_editor_attempts_expires ON editor_attempts(expires_at);
CREATE INDEX IF NOT EXISTS idx_editor_attempts_code    ON editor_attempts(code_hash);

DROP TABLE IF EXISTS device_codes;
```

- [ ] **Step 2: Write the failing test**

`arcane-server/test/auth-attempts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateToken, s256Challenge } from '../src/lib/tokens.ts';
import { jsonPost } from './helpers.ts';

describe('POST /v1/auth/editor/attempt', () => {
    it('creates a pending attempt bound to the challenge', async () => {
        const challenge = await s256Challenge(generateToken());
        const res = await jsonPost('/v1/auth/editor/attempt', { challenge });
        expect(res.status).toBe(200);
        const body = await res.json<{ attempt_id: string; expires_in: number }>();
        expect(body.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.expires_in).toBe(600);
    });

    it('rejects malformed challenges', async () => {
        for (const challenge of ['short', 'x'.repeat(129), `${'A'.repeat(42)}+`, '']) {
            const res = await jsonPost('/v1/auth/editor/attempt', { challenge });
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'invalid_challenge' });
        }
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd arcane-server && npm test -- auth-attempts`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 4: Write the attempts library**

`arcane-server/src/lib/attempts.ts`:

```ts
// editor_attempts queries (migration 0016). Kept out of db.ts, which is
// already 630 lines and covers a different concern.

export interface EditorAttemptRow {
    attempt_id: string;
    challenge: string;
    status: string;
    user_id: number | null;
    code_hash: string | null;
    consumed_at: string | null;
    expires_at: string;
    created_at: string;
}

/** 10 minutes — matches the editor's LOGIN_TIMEOUT_MS so a client-side
 *  timeout and a server-side expiry can never disagree. */
export const ATTEMPT_TTL_SECONDS = 600;

/** expires_at is computed SQL-side so its format always matches the
 *  datetime('now') comparisons in the consume/clean statements. */
export async function createAttempt(
    db: D1Database, challenge: string, ttlSeconds: number = ATTEMPT_TTL_SECONDS,
): Promise<string> {
    const attemptId = crypto.randomUUID();
    await db.prepare(
        `INSERT INTO editor_attempts (attempt_id, challenge, expires_at)
         VALUES (?, ?, datetime('now', ?))`
    ).bind(attemptId, challenge, `+${ttlSeconds} seconds`).run();
    return attemptId;
}

export async function findAttempt(db: D1Database, attemptId: string): Promise<EditorAttemptRow | null> {
    return db.prepare('SELECT * FROM editor_attempts WHERE attempt_id = ?')
        .bind(attemptId).first<EditorAttemptRow>();
}

/** Bind a user + grant code to a still-pending, still-unexpired attempt.
 *  False when it is already authorized, consumed, expired, or unknown. */
export async function authorizeAttempt(
    db: D1Database, attemptId: string, userId: number, codeHash: string,
): Promise<boolean> {
    const res = await db.prepare(
        `UPDATE editor_attempts SET status = 'authorized', user_id = ?, code_hash = ?
         WHERE attempt_id = ? AND status = 'pending' AND consumed_at IS NULL
           AND expires_at > datetime('now')`
    ).bind(userId, codeHash, attemptId).run();
    return res.meta.changes > 0;
}

/** Atomic single-use consume by grant code. Only one caller can ever win,
 *  even when the deep-link and poll channels race — D1 serializes writes and
 *  `consumed_at IS NULL` makes the loser match zero rows. */
export async function consumeAttemptByCode(
    db: D1Database, codeHash: string,
): Promise<EditorAttemptRow | null> {
    return db.prepare(
        `UPDATE editor_attempts SET consumed_at = datetime('now')
         WHERE code_hash = ? AND status = 'authorized' AND consumed_at IS NULL
           AND expires_at > datetime('now')
         RETURNING *`
    ).bind(codeHash).first<EditorAttemptRow>();
}

/** Same guarantee, keyed by attempt id — the poll channel's consume. */
export async function consumeAttemptById(
    db: D1Database, attemptId: string,
): Promise<EditorAttemptRow | null> {
    return db.prepare(
        `UPDATE editor_attempts SET consumed_at = datetime('now')
         WHERE attempt_id = ? AND status = 'authorized' AND consumed_at IS NULL
           AND expires_at > datetime('now')
         RETURNING *`
    ).bind(attemptId).first<EditorAttemptRow>();
}

export async function cleanExpiredAttempts(db: D1Database): Promise<void> {
    await db.prepare("DELETE FROM editor_attempts WHERE expires_at < datetime('now')").run();
}
```

- [ ] **Step 5: Add the route**

In `arcane-server/src/routes/auth-editor.ts`, import the library and add above the grant route:

```ts
import {
    createAttempt, authorizeAttempt, consumeAttemptByCode, consumeAttemptById,
    findAttempt, cleanExpiredAttempts, ATTEMPT_TTL_SECONDS,
} from '../lib/attempts.ts';
```

```ts
// Step 0 (editor, public): register a PKCE-bound attempt. The challenge is
// stored server-side here so the browser never has to carry it, and so the
// poll channel has something to consume against.
authEditorRouter.post('/v1/auth/editor/attempt', async (c) => {
    const { challenge } = await c.req.json<{ challenge?: string }>().catch(() => ({}));
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) {
        return c.json({ error: 'invalid_challenge' }, 400);
    }
    const db = c.env.arcane_db;
    await cleanExpiredAttempts(db);
    const attemptId = await createAttempt(db, challenge);
    return c.json({ attempt_id: attemptId, expires_in: ATTEMPT_TTL_SECONDS });
});
```

- [ ] **Step 6: Rate-limit it**

In `arcane-server/index.ts`, add `'/v1/auth/editor/attempt'` to the `poll` rate-limit registrations near line 52:

```ts
app.use('/v1/auth/editor/attempt', poll);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd arcane-server && npm test -- auth-attempts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add arcane-server/migrations/0016_editor_attempts.sql \
        arcane-server/src/lib/attempts.ts \
        arcane-server/src/routes/auth-editor.ts \
        arcane-server/index.ts \
        arcane-server/test/auth-attempts.test.ts
git commit -m "feat(auth): PKCE-bound editor_attempts table and attempt endpoint"
```

---

## Task 5: Repoint grant and exchange at `editor_attempts`

**Files:**
- Modify: `arcane-server/src/routes/auth-editor.ts:18-64`
- Modify: `arcane-server/test/auth-editor.test.ts:63-75` (the expired-code test seeds `auth_tokens` directly)

**Interfaces:**
- Consumes: everything produced by Task 4.
- Produces: `POST /v1/auth/editor/grant` accepts `{attempt_id}` **or** legacy `{challenge}`; both return `{code, expires_in}`.

- [ ] **Step 1: Write the failing test**

Add to `test/auth-attempts.test.ts`:

```ts
import { seedPasswordUser, tokenFor } from './helpers.ts';

describe('attempt → grant → exchange', () => {
    it('completes a full attempt-based login', async () => {
        const verifier = generateToken();
        const challenge = await s256Challenge(verifier);
        const attempt = await (await jsonPost('/v1/auth/editor/attempt', { challenge }))
            .json<{ attempt_id: string }>();

        const user = await seedPasswordUser(`at-${crypto.randomUUID()}@test.dev`, 'password123');
        const jwt = await tokenFor(user);
        const grant = await jsonPost('/v1/auth/editor/grant', { attempt_id: attempt.attempt_id }, jwt);
        expect(grant.status).toBe(200);
        const { code } = await grant.json<{ code: string }>();

        const ex = await jsonPost('/v1/auth/editor/exchange', { code, verifier });
        expect(ex.status).toBe(200);
        const body = await ex.json<{ token: string; user: { plan: string; credits: number } }>();
        expect(body.token).toBeTruthy();
        expect(body.user.plan).toBe('free');
    });

    it('rejects a grant against an unknown attempt', async () => {
        const user = await seedPasswordUser(`at2-${crypto.randomUUID()}@test.dev`, 'password123');
        const jwt = await tokenFor(user);
        const res = await jsonPost('/v1/auth/editor/grant', { attempt_id: crypto.randomUUID() }, jwt);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_attempt' });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd arcane-server && npm test -- auth-attempts`
Expected: FAIL — grant ignores `attempt_id` and returns `invalid_challenge`.

- [ ] **Step 3: Rewrite grant**

Replace the whole `/v1/auth/editor/grant` handler body in `auth-editor.ts`:

```ts
// Step 1 (website, logged in): bind this user + a fresh one-time code to the
// attempt. Accepts `attempt_id` (current clients) or a bare `challenge`
// (older builds during dev rollout) — the legacy form creates an
// already-authorized attempt on the fly so BOTH paths share exactly one
// storage and one consume path.
authEditorRouter.post('/v1/auth/editor/grant', authMiddleware(), async (c) => {
    const body = await c.req.json<{ attempt_id?: string; challenge?: string }>().catch(() => ({}));
    const authUser = c.get('user') as AuthPayload;
    const userId = parseInt(authUser.sub);
    const db = c.env.arcane_db;

    await cleanExpiredAttempts(db);
    const rawCode = generateToken();
    const codeHash = await sha256Hex(rawCode);

    let attemptId: string;
    if (typeof body.attempt_id === 'string' && body.attempt_id.length > 0) {
        attemptId = body.attempt_id;
    } else if (typeof body.challenge === 'string' && CHALLENGE_RE.test(body.challenge)) {
        attemptId = await createAttempt(db, body.challenge);
    } else {
        return c.json({ error: 'invalid_challenge' }, 400);
    }

    if (!await authorizeAttempt(db, attemptId, userId, codeHash)) {
        // Unknown, expired, already-authorized or already-consumed.
        return c.json({ error: 'invalid_attempt' }, 400);
    }

    logAuthEvent('editor_grant', { userId: authUser.sub });
    return c.json({ code: rawCode, expires_in: ATTEMPT_TTL_SECONDS });
});
```

- [ ] **Step 4: Rewrite exchange**

```ts
// Step 2 (editor, public): code + verifier → 30-day session JWT.
// ONE opaque error for every failure mode — no oracle distinguishing
// unknown/expired/replayed codes from wrong verifiers. Consume FIRST so even
// a failed verifier attempt burns the code.
authEditorRouter.post('/v1/auth/editor/exchange', async (c) => {
    const { code, verifier } = await c.req.json<{ code?: string; verifier?: string }>().catch(() => ({}));
    const invalid = () => c.json({ error: 'invalid_code' }, 400);
    if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !verifier) {
        return invalid();
    }
    const db = c.env.arcane_db;
    const row = await consumeAttemptByCode(db, await sha256Hex(code));
    if (!row || row.user_id === null) { return invalid(); }
    if (await s256Challenge(verifier) !== row.challenge) { return invalid(); }
    const user = await findUserById(db, row.user_id);
    if (!user) { return invalid(); }
    logAuthEvent('editor_exchange', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});
```

Remove the now-unused imports (`createAuthToken`, `consumeAuthToken`, `cleanExpiredAuthTokens`, `TOKEN_TTL_SECONDS`) from `auth-editor.ts`.

- [ ] **Step 5: Update the legacy expired-code test**

In `test/auth-editor.test.ts`, the "rejects an expired code" case inserts into `auth_tokens` directly. Replace that insert with an `editor_attempts` insert:

```ts
        await env.arcane_db.prepare(
            `INSERT INTO editor_attempts (attempt_id, challenge, status, user_id, code_hash, expires_at)
             VALUES (?, ?, 'authorized', ?, ?, datetime('now', '-10 seconds'))`
        ).bind(crypto.randomUUID(), challenge, user.id, await sha256Hex(raw)).run();
```

Also update `grantCode()`'s `expires_in` assertion from `60` to `600`.

- [ ] **Step 6: Run the full server suite**

Run: `cd arcane-server && npm test`
Expected: PASS — all pre-existing tests plus the new ones.

- [ ] **Step 7: Commit**

```bash
git add arcane-server/src/routes/auth-editor.ts \
        arcane-server/test/auth-editor.test.ts \
        arcane-server/test/auth-attempts.test.ts
git commit -m "refactor(auth): resolve editor grant/exchange against editor_attempts"
```

---

## Task 6: The poll endpoint

**Files:**
- Modify: `arcane-server/src/routes/auth-editor.ts`
- Modify: `arcane-server/index.ts`
- Test: `arcane-server/test/auth-attempts.test.ts`

**Interfaces:**
- Produces: `POST /v1/auth/editor/poll {attempt_id, verifier}` → `428 {error:'authorization_pending'}` | `200 {token, user}` | `400 {error:'invalid_attempt'}`.

- [ ] **Step 1: Write the failing test**

```ts
describe('POST /v1/auth/editor/poll', () => {
    it('returns 428 while pending, then the session once granted', async () => {
        const verifier = generateToken();
        const challenge = await s256Challenge(verifier);
        const { attempt_id } = await (await jsonPost('/v1/auth/editor/attempt', { challenge }))
            .json<{ attempt_id: string }>();

        const pending = await jsonPost('/v1/auth/editor/poll', { attempt_id, verifier });
        expect(pending.status).toBe(428);
        expect(await pending.json()).toEqual({ error: 'authorization_pending' });

        const user = await seedPasswordUser(`pl-${crypto.randomUUID()}@test.dev`, 'password123');
        await jsonPost('/v1/auth/editor/grant', { attempt_id }, await tokenFor(user));

        const done = await jsonPost('/v1/auth/editor/poll', { attempt_id, verifier });
        expect(done.status).toBe(200);
        expect((await done.json<{ token: string }>()).token).toBeTruthy();
    });

    it('lets exactly one channel win when poll and exchange race', async () => {
        const verifier = generateToken();
        const challenge = await s256Challenge(verifier);
        const { attempt_id } = await (await jsonPost('/v1/auth/editor/attempt', { challenge }))
            .json<{ attempt_id: string }>();
        const user = await seedPasswordUser(`rc-${crypto.randomUUID()}@test.dev`, 'password123');
        const { code } = await (await jsonPost('/v1/auth/editor/grant', { attempt_id }, await tokenFor(user)))
            .json<{ code: string }>();

        const [a, b] = await Promise.all([
            jsonPost('/v1/auth/editor/poll', { attempt_id, verifier }),
            jsonPost('/v1/auth/editor/exchange', { code, verifier }),
        ]);
        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 400]);
    });

    it('rejects a wrong verifier with the same opaque error', async () => {
        const verifier = generateToken();
        const challenge = await s256Challenge(verifier);
        const { attempt_id } = await (await jsonPost('/v1/auth/editor/attempt', { challenge }))
            .json<{ attempt_id: string }>();
        const user = await seedPasswordUser(`wv-${crypto.randomUUID()}@test.dev`, 'password123');
        await jsonPost('/v1/auth/editor/grant', { attempt_id }, await tokenFor(user));

        const res = await jsonPost('/v1/auth/editor/poll', { attempt_id, verifier: generateToken() });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_attempt' });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd arcane-server && npm test -- auth-attempts`
Expected: FAIL with 404 on the poll route.

- [ ] **Step 3: Implement the route**

```ts
// Step 2b (editor, public): the pull channel. Covers environments where
// neither the custom scheme nor the loopback socket can deliver the callback
// (corporate/VPN filtering — see AuthSuccess.tsx). Same atomic consume as
// exchange, so exactly one channel can ever win.
authEditorRouter.post('/v1/auth/editor/poll', async (c) => {
    const { attempt_id, verifier } = await c.req
        .json<{ attempt_id?: string; verifier?: string }>().catch(() => ({}));
    const invalid = () => c.json({ error: 'invalid_attempt' }, 400);
    if (typeof attempt_id !== 'string' || !attempt_id
        || typeof verifier !== 'string' || !verifier) {
        return invalid();
    }
    const db = c.env.arcane_db;

    // Peek first: a still-pending attempt must stay consumable, so it cannot
    // go through the consuming statement.
    const peek = await findAttempt(db, attempt_id);
    if (!peek || peek.consumed_at !== null || peek.expires_at <= new Date().toISOString()) {
        return invalid();
    }
    if (peek.status === 'pending') {
        return c.json({ error: 'authorization_pending' }, 428);
    }

    const row = await consumeAttemptById(db, attempt_id);
    if (!row || row.user_id === null) { return invalid(); }
    if (await s256Challenge(verifier) !== row.challenge) { return invalid(); }
    const user = await findUserById(db, row.user_id);
    if (!user) { return invalid(); }
    logAuthEvent('editor_poll_exchange', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});
```

> **Note on the peek:** `expires_at` is stored via SQLite `datetime('now')`, which yields `YYYY-MM-DD HH:MM:SS` — **not** ISO-8601 with a `T` and `Z`. Comparing it to `new Date().toISOString()` in JS is therefore wrong. Use a SQL-side check instead: change `findAttempt` to select `(expires_at > datetime('now')) AS is_live` and branch on that. Fix this in Step 4 before moving on.

- [ ] **Step 4: Fix the expiry comparison SQL-side**

In `src/lib/attempts.ts`, change `findAttempt` to compute liveness in SQL:

```ts
export interface EditorAttemptPeek extends EditorAttemptRow {
    is_live: number; // 1 when expires_at is still in the future
}

/** Peek without consuming. `is_live` is computed SQL-side because expires_at
 *  is SQLite's `YYYY-MM-DD HH:MM:SS`, which does NOT compare correctly
 *  against a JS `toISOString()` (that has a `T` separator and a `Z`). */
export async function findAttempt(db: D1Database, attemptId: string): Promise<EditorAttemptPeek | null> {
    return db.prepare(
        `SELECT *, (expires_at > datetime('now')) AS is_live
         FROM editor_attempts WHERE attempt_id = ?`
    ).bind(attemptId).first<EditorAttemptPeek>();
}
```

and in the poll route replace the peek guard with:

```ts
    if (!peek || peek.consumed_at !== null || peek.is_live !== 1) {
        return invalid();
    }
```

- [ ] **Step 5: Rate-limit the poll route**

In `index.ts`: `app.use('/v1/auth/editor/poll', poll);`

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd arcane-server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add arcane-server/src/routes/auth-editor.ts arcane-server/src/lib/attempts.ts \
        arcane-server/index.ts arcane-server/test/auth-attempts.test.ts
git commit -m "feat(auth): PKCE-bound poll channel for editor sign-in"
```

---

## Task 7: Delete the device flow from the server

**Files:**
- Modify: `arcane-server/src/routes/auth.ts:144-221` (delete), `:1-16` (imports)
- Modify: `arcane-server/src/lib/db.ts:70-78,473-506` (delete row type + six helpers)
- Modify: `arcane-server/src/lib/tokens.ts:8` (drop `editor_login`)
- Modify: `arcane-server/index.ts:51-53`
- Modify: `arcane-server/test/auth-routes.test.ts` (delete device cases)

- [ ] **Step 1: Delete the routes**

Remove the entire `// ─── Device Auth Flow ───` section from `src/routes/auth.ts` (the three handlers) and `generateUserCode()`. Remove from its import block: `createDeviceCode`, `findDeviceCodeByDeviceCode`, `authorizeDeviceCode`, `deleteDeviceCode`, `cleanExpiredDeviceCodes`.

- [ ] **Step 2: Delete the db helpers**

From `src/lib/db.ts` remove `DeviceCodeRow` and the whole `// --- Device code queries ---` section (`createDeviceCode`, `findDeviceCodeByDeviceCode`, `findDeviceCodeByUserCode`, `authorizeDeviceCode`, `deleteDeviceCode`, `cleanExpiredDeviceCodes`).

- [ ] **Step 3: Retire the `editor_login` token purpose**

In `src/lib/tokens.ts` delete the `editor_login: 60,` line. `TokenPurpose` narrows automatically.

- [ ] **Step 4: Drop the device rate limits**

In `index.ts` delete:

```ts
app.use('/v1/auth/device/code', poll);
app.use('/v1/auth/device/token', poll);
```

- [ ] **Step 5: Delete the device tests**

Remove every `describe`/`it` in `test/auth-routes.test.ts` that targets `/v1/auth/device/*`.

- [ ] **Step 6: Run the full server suite and typecheck**

Run: `cd arcane-server && npx tsc --noEmit && npm test`
Expected: PASS. Any remaining reference to a deleted symbol fails the typecheck — fix it.

- [ ] **Step 7: Commit**

```bash
git add arcane-server/src/routes/auth.ts arcane-server/src/lib/db.ts \
        arcane-server/src/lib/tokens.ts arcane-server/index.ts \
        arcane-server/test/auth-routes.test.ts
git commit -m "refactor(auth): delete the PKCE-less device-code login flow

Its 8-char user code was protected only by rate limits, and it was a second
login path to harden forever. The PKCE-bound poll channel supersedes it."
```

---

## Task 8: Website — carry the attempt id through

**Files:**
- Modify: `landing-page/src/lib/editor-login.ts:13-17,110-159`
- Modify: `landing-page/src/components/auth/AuthHub.tsx:36-63`
- Modify: `landing-page/src/lib/auth.ts` (`apiEditorGrant` signature)
- Test: `landing-page/src/lib/editor-login.test.ts`

**Interfaces:**
- Produces: `EditorLoginRequest` gains `attemptId: string | null`.
- Produces: `apiEditorGrant(token: string, opts: { attemptId?: string; challenge?: string })`.

- [ ] **Step 1: Write the failing test**

Add to `editor-login.test.ts`:

```ts
it('parses an attempt id alongside the challenge', () => {
    const params = new URLSearchParams({
        flow: 'editor', state: 'st', challenge: 'A'.repeat(43),
        scheme: 'arcane', attempt: '11111111-2222-3333-4444-555555555555',
    });
    const result = parseEditorLoginParams(params);
    expect(result.ok).toBe(true);
    if (result.ok) {
        expect(result.request.attemptId).toBe('11111111-2222-3333-4444-555555555555');
    }
});

it('accepts a request with no attempt id (legacy client)', () => {
    const params = new URLSearchParams({
        flow: 'editor', state: 'st', challenge: 'A'.repeat(43), scheme: 'arcane',
    });
    const result = parseEditorLoginParams(params);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.attemptId).toBeNull();
});

it('rejects a malformed attempt id', () => {
    const params = new URLSearchParams({
        flow: 'editor', state: 'st', challenge: 'A'.repeat(43),
        scheme: 'arcane', attempt: 'not-a-uuid',
    });
    expect(parseEditorLoginParams(params).ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd landing-page && npx vitest run src/lib/editor-login.test.ts`
Expected: FAIL — `attemptId` does not exist.

- [ ] **Step 3: Extend the request type and parser**

In `editor-login.ts`, add to `EditorLoginRequest`:

```ts
    /** Server-side attempt id (migration 0016). Null for older app builds
     *  that still send only a bare challenge. */
    attemptId: string | null;
```

Add the validator beside the others:

```ts
const ATTEMPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidAttemptId(raw: string): boolean {
    return ATTEMPT_RE.test(raw);
}
```

In `parseEditorLoginParams`, after the state check:

```ts
    const attemptRaw = params.get('attempt');
    if (attemptRaw !== null && !isValidAttemptId(attemptRaw)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad attempt id). Return to Arcane and click Sign in again.' };
    }
    return { ok: true, request: { state, challenge, target, attemptId: attemptRaw } };
```

In `loadEditorLoginRequest`, re-validate on read (sessionStorage is same-origin writable):

```ts
        const attemptId = typeof parsed.attemptId === 'string' && isValidAttemptId(parsed.attemptId)
            ? parsed.attemptId : null;
        …
        return { ...parsed, target, attemptId };
```

- [ ] **Step 4: Pass it to grant**

In `landing-page/src/lib/auth.ts`, change `apiEditorGrant` to take an options object and send whichever field is present:

```ts
export async function apiEditorGrant(
    token: string, opts: { attemptId?: string | null; challenge?: string },
): Promise<{ code: string; expires_in: number }> {
    const body = opts.attemptId
        ? { attempt_id: opts.attemptId }
        : { challenge: opts.challenge };
    // …existing fetch, with `body` as the JSON payload
}
```

In `AuthHub.tsx:46`, change the call:

```ts
                const grant = await apiEditorGrant(token, {
                    attemptId: pending.attemptId,
                    challenge: pending.challenge,
                });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd landing-page && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add landing-page/src/lib/editor-login.ts landing-page/src/lib/editor-login.test.ts \
        landing-page/src/lib/auth.ts landing-page/src/components/auth/AuthHub.tsx
git commit -m "feat(auth): carry the editor attempt id through the website flow"
```

---

## Task 9: Editor — persist the pending attempt and resume on cold start

**Files:**
- Create: `editor/src/features/auth/services/attempt-store.ts`
- Create: `editor/src/features/auth/services/attempt-store.test.ts`
- Modify: `editor/src/features/auth/services/browser-login.ts`

**Interfaces:**
- Produces:
  - `interface PersistedAttempt { attemptId: string; state: string; verifier: string; expiresAt: number }`
  - `savePendingAttempt(a: PersistedAttempt): Promise<void>`
  - `loadPendingAttempt(now?: number): Promise<PersistedAttempt | null>` — returns null when absent or expired, and clears an expired record
  - `clearPendingAttempt(): Promise<void>`

- [ ] **Step 1: Write the failing test**

`attempt-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';

let store: Record<string, string> = {};
mock.module('@tauri-apps/plugin-store', () => ({
  load: async () => ({
    get: async (k: string) => (k in store ? JSON.parse(store[k]!) : null),
    set: async (k: string, v: unknown) => { store[k] = JSON.stringify(v); },
    delete: async (k: string) => { delete store[k]; },
    save: async () => {},
  }),
}));

const { savePendingAttempt, loadPendingAttempt, clearPendingAttempt } =
  await import('./attempt-store');

describe('attempt-store', () => {
  beforeEach(() => { store = {}; });

  it('round-trips a pending attempt', async () => {
    await savePendingAttempt({ attemptId: 'a1', state: 's1', verifier: 'v1', expiresAt: 2000 });
    expect(await loadPendingAttempt(1000)).toEqual({
      attemptId: 'a1', state: 's1', verifier: 'v1', expiresAt: 2000,
    });
  });

  it('returns null and clears an expired attempt', async () => {
    await savePendingAttempt({ attemptId: 'a1', state: 's1', verifier: 'v1', expiresAt: 500 });
    expect(await loadPendingAttempt(1000)).toBeNull();
    expect(await loadPendingAttempt(0)).toBeNull(); // was cleared, not merely filtered
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadPendingAttempt(1000)).toBeNull();
  });

  it('clears on demand', async () => {
    await savePendingAttempt({ attemptId: 'a1', state: 's1', verifier: 'v1', expiresAt: 2000 });
    await clearPendingAttempt();
    expect(await loadPendingAttempt(1000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/auth/services/attempt-store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the store**

`editor/src/features/auth/services/attempt-store.ts`:

```ts
// Persists the ONE pending browser-login attempt so a cold-start deep link
// can complete a sign-in.
//
// Why persisting a PKCE verifier is acceptable here: auth-client.ts already
// writes the 30-day session JWT to this same app-data directory via
// `auth_write_token`. A 10-minute verifier is strictly less valuable than
// what is already at rest, and without it the most common real journey —
// download the app, sign in on the website, get deep-linked back into an app
// that was never running — silently drops the callback.
//
// The record is deleted on use and whenever it is found expired.
import { load } from '@tauri-apps/plugin-store';

const STORE_FILE = 'auth-attempt.json';
const KEY = 'pending';

export interface PersistedAttempt {
  attemptId: string;
  state: string;
  verifier: string;
  /** Epoch ms. Mirrors the server's 600s attempt TTL. */
  expiresAt: number;
}

async function handle() {
  return load(STORE_FILE, { autoSave: false });
}

export async function savePendingAttempt(attempt: PersistedAttempt): Promise<void> {
  const s = await handle();
  await s.set(KEY, attempt);
  await s.save();
}

/** Null when absent, malformed, or expired. An expired record is DELETED so a
 *  later call can't resurrect it. `now` is injectable for tests. */
export async function loadPendingAttempt(now: number = Date.now()): Promise<PersistedAttempt | null> {
  const s = await handle();
  const raw = (await s.get(KEY)) as Partial<PersistedAttempt> | null;
  if (!raw || typeof raw.attemptId !== 'string' || typeof raw.state !== 'string'
      || typeof raw.verifier !== 'string' || typeof raw.expiresAt !== 'number') {
    return null;
  }
  if (raw.expiresAt <= now) {
    await s.delete(KEY);
    await s.save();
    return null;
  }
  return raw as PersistedAttempt;
}

export async function clearPendingAttempt(): Promise<void> {
  const s = await handle();
  await s.delete(KEY);
  await s.save();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd editor && bun test src/features/auth/services/attempt-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Confirm the Tauri store plugin is available**

Run: `cd editor && grep -n "plugin-store" package.json src-tauri/Cargo.toml`
Expected: both present. If either is missing, add them:
`bun add @tauri-apps/plugin-store` and `tauri-plugin-store = "2"` in `src-tauri/Cargo.toml`, plus `.plugin(tauri_plugin_store::Builder::new().build())` in the Rust setup and a `store:default` entry in `src-tauri/capabilities/default.json`.

- [ ] **Step 6: Commit**

```bash
git add editor/src/features/auth/services/attempt-store.ts \
        editor/src/features/auth/services/attempt-store.test.ts
git commit -m "feat(auth): persist the pending login attempt for cold-start resume"
```

---

## Task 10: Editor — register the attempt, resume, and re-initiate

**Files:**
- Modify: `editor/src/features/auth/services/browser-login.ts`
- Modify: `editor/src/features/auth/services/auth-client.ts` (add `createAttempt`)
- Modify: `editor/src/features/auth/index.ts` (barrel export `resumeFromColdStart`)
- Modify: `editor/src/features/auth/services/browser-login.test.ts`

**Interfaces:**
- Consumes: `savePendingAttempt`/`loadPendingAttempt`/`clearPendingAttempt` (Task 9); `authClient.createAttempt` (below).
- Produces:
  - `authClient.createAttempt(challenge: string): Promise<{ attemptId: string; expiresIn: number }>`
  - `resumeFromColdStart(handlers: BrowserLoginHandlers): Promise<boolean>` — true when a launch URL was matched and delivered.

- [ ] **Step 1: Add the client method**

In `auth-client.ts`:

```ts
  /** Register a PKCE-bound attempt before opening the browser. The challenge
   *  lives server-side from here on, so the poll channel has something to
   *  consume against and the browser never carries it. */
  async createAttempt(challenge: string): Promise<{ attemptId: string; expiresIn: number }> {
    const res = await fetch(`${this.serverUrl}/v1/auth/editor/attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge }),
    });
    if (!res.ok) throw new Error(`Could not start sign-in (${res.status})`);
    const data = (await res.json()) as { attempt_id: string; expires_in: number };
    return { attemptId: data.attempt_id, expiresIn: data.expires_in };
  }
```

- [ ] **Step 2: Write the failing test**

Add to `browser-login.test.ts`:

```ts
describe('cold-start resume', () => {
  it('completes a login from a launch URL matching the persisted attempt', async () => {
    await savePendingAttempt({
      attemptId: 'att-1', state: 'st-1', verifier: 'ver-1',
      expiresAt: Date.now() + 60_000,
    });
    setLaunchUrls([`arcane://auth/callback?code=CODE1&state=st-1`]);

    const codes: Array<[string, string]> = [];
    const matched = await resumeFromColdStart({
      onCode: (code, verifier) => { codes.push([code, verifier]); },
      onError: () => {},
    });

    expect(matched).toBe(true);
    expect(codes).toEqual([['CODE1', 'ver-1']]);
    expect(await loadPendingAttempt()).toBeNull(); // consumed
  });

  it('does not match when the state differs', async () => {
    await savePendingAttempt({
      attemptId: 'att-1', state: 'st-1', verifier: 'ver-1',
      expiresAt: Date.now() + 60_000,
    });
    setLaunchUrls([`arcane://auth/callback?code=CODE1&state=WRONG`]);

    const matched = await resumeFromColdStart({ onCode: () => {}, onError: () => {} });
    expect(matched).toBe(false);
  });

  it('returns false when there is no launch URL', async () => {
    setLaunchUrls([]);
    expect(await resumeFromColdStart({ onCode: () => {}, onError: () => {} })).toBe(false);
  });
});
```

Mock the deep-link plugin's `getCurrent` at the top of the file alongside the existing mocks:

```ts
let launchUrls: string[] = [];
export function setLaunchUrls(urls: string[]) { launchUrls = urls; }
mock.module('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: async () => () => {},
  getCurrent: async () => (launchUrls.length ? launchUrls : null),
}));
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd editor && bun test src/features/auth/services/browser-login.test.ts`
Expected: FAIL — `resumeFromColdStart` is not exported.

- [ ] **Step 4: Register the attempt in `beginBrowserLogin`**

In `browser-login.ts`, after computing `challenge` and before arming the transport, register the attempt and persist it. Add to the `PendingAttempt` interface: `attemptId: string;`. Then:

```ts
  const challenge = await challengeS256(verifier);
  if (pending?.epoch !== epoch) { clearTimeout(timer); return; }

  // Register server-side BEFORE opening the browser: the poll channel needs
  // an id to consume against, and the persisted record is what lets a
  // cold-start deep link finish this login.
  const { attemptId } = await authClient.createAttempt(challenge);
  if (pending?.epoch !== epoch) { clearTimeout(timer); return; }
  pending.attemptId = attemptId;
  await savePendingAttempt({
    attemptId, state, verifier, expiresAt: Date.now() + timeoutMs,
  });
```

Add `attempt: attemptId` to the URL params (reserved keys still win):

```ts
  const params = new URLSearchParams({
    ...armed.params, flow: 'editor', state, challenge, attempt: attemptId,
  });
```

In `teardown()`, clear the persisted record:

```ts
function teardown(): void {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);
  void clearPendingAttempt().catch(() => {});
  if (p.unlisten) { try { p.unlisten(); } catch { /* already gone */ } }
}
```

- [ ] **Step 5: Implement `resumeFromColdStart`**

Append to `browser-login.ts`:

```ts
/**
 * Complete a login from the URL the OS launched this process with.
 *
 * The deep-link plugin delivers cold-start URLs through `getCurrent()`, NOT
 * through the `new-url` event the running-process flow listens to — so this
 * is the only path that can see them. Returns true when a launch URL matched
 * the persisted attempt and the code was delivered to `onCode`.
 *
 * Call this ONCE at app startup. When it returns false and a launch URL was
 * nonetheless present, the caller should fall back to `beginBrowserLogin`
 * (the re-initiate path) — the browser still holds a session, so that
 * completes without a second login.
 */
export async function resumeFromColdStart(handlers: BrowserLoginHandlers): Promise<boolean> {
  let urls: string[] | null = null;
  try {
    urls = await getCurrent();
  } catch {
    return false; // plugin unavailable (e.g. loopback-only dev build)
  }
  if (!urls || urls.length === 0) return false;

  const stored = await loadPendingAttempt();
  if (!stored) return false;

  const scheme = await invoke<string>('auth_deep_link_scheme').catch(() => null);
  if (!scheme) return false;

  for (const url of urls) {
    const parsed = parseCallback(url, scheme);
    if (!parsed) continue;
    if (parsed.state !== stored.state) continue;
    await clearPendingAttempt();
    void handlers.onCode(parsed.code, stored.verifier);
    return true;
  }
  return false;
}

/** True when the OS launched this process with a deep link — used to decide
 *  whether to re-initiate after `resumeFromColdStart` returns false. */
export async function hadLaunchUrl(): Promise<boolean> {
  try {
    const urls = await getCurrent();
    return !!urls && urls.length > 0;
  } catch {
    return false;
  }
}
```

Add the imports: `getCurrent` from `@tauri-apps/plugin-deep-link`, `invoke` from `@tauri-apps/api/core`, and the three attempt-store functions.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd editor && bun test src/features/auth/services/browser-login.test.ts`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 7: Wire startup resume + re-initiate**

In `editor/src/stores/auth.ts`, add an action:

```ts
  /** Startup hook: finish a cold-start deep link, or re-initiate when one
   *  arrived with nothing to match (a website-initiated sign-in, an expired
   *  attempt, or a wiped data dir). The browser already holds a session, so
   *  the re-initiated round-trip completes without a second login. */
  resumeColdStartLogin: async () => {
    const handlers = {
      onCode: async (code: string, verifier: string) => {
        set({ loginStatus: 'exchanging' });
        const result = await authClient.exchangeEditorCode(code, verifier);
        if (result.success && result.user) {
          const stored = await authClient.loadFromDisk().catch(() => null);
          set({
            loggedIn: true, email: result.user.email, plan: result.user.plan,
            credits: result.user.credits, token: stored?.token ?? null,
            loginStatus: 'idle', error: null,
          });
          void emit('auth-changed');
        } else {
          set({ loginStatus: 'error', error: result.error ?? 'Sign-in failed' });
        }
      },
      onError: (message: string) => set({ loginStatus: 'error', error: message }),
    };
    if (await serviceResumeFromColdStart(handlers)) return;
    if (await serviceHadLaunchUrl()) {
      await useAuthStore.getState().beginBrowserLogin();
    }
  },
```

Export `resumeFromColdStart` and `hadLaunchUrl` from `features/auth/index.ts` and import them in the store as `serviceResumeFromColdStart` / `serviceHadLaunchUrl`. Call `void useAuthStore.getState().resumeColdStartLogin();` alongside the existing `loadFromDisk()` call at app startup in `App.tsx`.

- [ ] **Step 8: Verify boundaries, types and the full suite**

Run: `cd editor && bun run check:modules && npx tsc --noEmit && bun test src`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add editor/src/features/auth editor/src/stores/auth.ts editor/src/App.tsx
git commit -m "feat(auth): cold-start deep-link resume with re-initiate fallback

browser-login held the PKCE verifier in module memory only, so a deep link
that LAUNCHED the app could never complete a login -- the most common real
journey (download, sign in on the website, get sent back) silently dropped
the callback. The attempt is now persisted for its 10-minute life, and an
unmatched launch URL re-initiates instead of dead-ending."
```

---

## Task 11: Editor — poll channel and device-UI removal

**Files:**
- Modify: `editor/src/features/auth/services/login-transport.ts`
- Modify: `editor/src/features/auth/services/browser-login.ts`
- Modify: `editor/src/features/auth/services/auth-client.ts` (add `pollAttempt`, delete device methods)
- Modify: `editor/src/features/auth/components/AuthTab.tsx`

**Interfaces:**
- Produces: `authClient.pollAttempt(attemptId, verifier): Promise<{ status: 'pending' } | { status: 'ok'; user: ExchangeResult['user'] } | { status: 'invalid' }>`

- [ ] **Step 1: Add the poll client method**

```ts
  /** Pull channel for sign-in. 428 means keep waiting; 400 means this attempt
   *  is dead (expired, consumed by the deep-link channel, or wrong verifier). */
  async pollAttempt(
    attemptId: string, verifier: string,
  ): Promise<{ status: 'pending' } | { status: 'ok'; user: NonNullable<ExchangeResult['user']> } | { status: 'invalid' }> {
    const res = await fetch(`${this.serverUrl}/v1/auth/editor/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempt_id: attemptId, verifier }),
    });
    if (res.status === 428) return { status: 'pending' };
    if (!res.ok) return { status: 'invalid' };
    const data = (await res.json()) as {
      token: string;
      user: NonNullable<ExchangeResult['user']>;
    };
    await this.saveToken(data.token, data.user.email);
    return { status: 'ok', user: data.user };
  }
```

Delete `requestDeviceCode`, `pollDeviceToken`, `DeviceCodeResponse` and `DeviceTokenResult`.

- [ ] **Step 2: Start polling alongside the transport**

In `browser-login.ts`, after `pending.unlisten = armed.unlisten;` start a 2-second poll bounded by the same attempt lifetime. Store the interval on `PendingAttempt` as `pollTimer` and clear it in `teardown()`:

```ts
  // Pull channel: covers environments where neither the custom scheme nor
  // the loopback socket can deliver (corporate/VPN filtering). Whichever
  // channel arrives first wins — the server's consume is atomic, so the
  // loser simply gets `invalid` and stops.
  pending.pollTimer = setInterval(() => {
    void (async () => {
      if (pending?.epoch !== epoch) return;
      const result = await authClient.pollAttempt(attemptId, verifier).catch(() => null);
      if (!result || pending?.epoch !== epoch) return;
      if (result.status === 'ok') {
        const p = pending;
        teardown();
        void p.handlers.onCode('', verifier); // token already saved by pollAttempt
      }
      // 'pending' → keep waiting. 'invalid' → the deep-link channel likely
      // won; leave teardown to that path or to the timeout.
    })();
  }, 2000);
```

> **Note:** `onCode('')` is wrong — the poll path has no code to exchange because `pollAttempt` already saved the token. Add a second handler instead: extend `BrowserLoginHandlers` with `onSession: (user: NonNullable<ExchangeResult['user']>) => void | Promise<void>` and call `p.handlers.onSession(result.user)` here. Update the store's `beginBrowserLogin` to supply it, setting the same state the exchange path sets.

- [ ] **Step 3: Implement the `onSession` handler properly**

In `browser-login.ts`, extend the interface:

```ts
export interface BrowserLoginHandlers {
  onCode: (code: string, verifier: string) => void | Promise<void>;
  /** Poll channel completed — the session token is already on disk. */
  onSession: (user: NonNullable<ExchangeResult['user']>) => void | Promise<void>;
  onError: (message: string) => void;
}
```

and replace the `onCode('')` call above with `void p.handlers.onSession(result.user);`.

In `stores/auth.ts`'s `beginBrowserLogin`, add:

```ts
        onSession: async (user) => {
          const stored = await authClient.loadFromDisk().catch(() => null);
          set({
            loggedIn: true, email: user.email, plan: user.plan, credits: user.credits,
            token: stored?.token ?? null, loginStatus: 'idle', error: null,
          });
          void emit('auth-changed');
        },
```

Add the same to `resumeColdStartLogin`'s handlers (Task 10, Step 7).

- [ ] **Step 4: Delete the device UI**

In `AuthTab.tsx`: remove the `mode` state and both toggle buttons, all device state (`deviceCode`, `userCode`, `verificationUri`, `polling`, `pollIntervalRef`), `handleDeviceFlow`, its unmount cleanup effect, and the entire `mode === 'device'` branch. Keep the browser flow, the manual-paste fallback, and the signed-in account card. Remove the now-unused `Smartphone` import.

- [ ] **Step 5: Verify boundaries, types and the full suite**

Run: `cd editor && bun run check:modules && npx tsc --noEmit && bun test src`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add editor/src/features/auth editor/src/stores/auth.ts
git commit -m "feat(auth): poll channel in the editor; drop the device-code UI"
```

---

## Task 12: End-to-end verification and the manual checklist

**Files:**
- Create: `docs/superpowers/plans/2026-08-06-phase1-manual-verification.md`

- [ ] **Step 1: Run every suite**

```bash
cd arcane-server && npx tsc --noEmit && npm test
cd ../editor      && bun run check:modules && npx tsc --noEmit && bun test src
cd ../landing-page && npx tsc --noEmit && npx vitest run
```
Expected: all green. Server must be ≥ the 147 tests it started with.

- [ ] **Step 2: Write the manual checklist**

Create the file with these cases, each as a `- [ ]` item with expected result:

1. Fresh email/password signup → editor sign-in → send an AI message → **verification panel appears, user stays signed in** (regression guard for the original bug).
2. Click the verification link → "I've verified — retry" → AI responds.
3. Google signup → AI works immediately (auto-verified).
4. App running → Sign in → deep link returns → signed in, plan and credits populated with no `—` flash.
5. **App closed** → sign in from the website → app launches → signed in (cold-start resume).
6. App closed, no prior attempt → website "Open Arcane" → app launches, re-initiates, completes.
7. Block the loopback port, macOS dev build → sign-in still completes via poll within ~4s.
8. Start a sign-in, cancel it, replay the callback URL → no session created.
9. Two windows, sign in from one → the other reflects it via `auth-changed`.
10. Confirm `/v1/auth/device/code` now returns 404.

- [ ] **Step 3: Deploy to dev and verify**

Deploys are manual — the CI Cloudflare token is broken. The user must run the interactive login themselves:

```bash
npx --yes wrangler@4 login
cd arcane-server && npx wrangler d1 migrations apply arcane-db-dev --env dev --remote
npx wrangler deploy --env dev
cd ../landing-page && PUBLIC_API_URL=https://api-dev.arcaneai.org npm run build
npx wrangler@4 pages deploy dist --project-name arcane-landing-dev --branch main
```

Verify with `curl https://api-dev.arcaneai.org/health` and confirm
`POST /v1/auth/editor/attempt` answers 400 (not 404) for an empty body.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-06-phase1-manual-verification.md
git commit -m "docs: phase 1 manual verification checklist"
```

---

## Self-Review Notes

**Spec coverage.** §4.1 → Tasks 1–2. §4.2 → Task 3. §4.3 → Tasks 4, 5, 6, 8, 9, 10, 11. §4.4 → Tasks 7, 11. §3.3/§3.4 → Task 4. §9 (Phase-1 portion) → Tasks 1–12.

**Deferred to later plans (by design).** §3.1/§3.2 `users` and `subscriptions` columns, §5 lifecycle, §6 tier changes, §7 onboarding. The spec states one migration `0016`; splitting plans per phase splits it too — `0016` is Phase 1's `editor_attempts`, and `0017` carries Phase 2/3 columns. The spec has been amended to match.

**Known trap flagged inline.** Task 6 Step 3 writes a JS-side `expires_at` comparison that is *wrong* — SQLite's `datetime('now')` format has no `T`/`Z` and does not compare against `toISOString()`. Step 4 corrects it SQL-side. This is deliberate: the naive version is the obvious thing to write, and the plan catches it before it ships.

**Type consistency.** `PersistedAttempt` (Task 9) is consumed unchanged in Task 10. `ExchangeResult['user']` gains `plan`/`credits` in Task 3 and is referenced by that name in Tasks 10–11. `BrowserLoginHandlers` gains `onSession` in Task 11 Step 3 and every construction site is updated in the same step.
