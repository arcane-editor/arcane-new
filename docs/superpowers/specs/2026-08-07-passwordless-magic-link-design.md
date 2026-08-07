# Passwordless sign-in (magic link) — design

**Date:** 2026-08-07
**Status:** approved, ready for implementation

## Why

Users want to sign in without inventing and remembering a password. "Continue
with Google" would deliver that, but it is blocked on a Google Cloud OAuth
client that only the domain owner can create — and no miniature version exists:
Google's authorization endpoint requires a registered `client_id`, refuses
unregistered `redirect_uri`s, and offers no dynamic client registration.

A magic link delivers the same *convenience* outcome with infrastructure this
repo already has. It is not a replacement for Google — it does nothing for the
"Google logo builds trust" axis — and it trades one click for an app-switch and
a mail-delivery wait. It is worth building because the redemption half already
exists and is tested.

## What already works (do not rebuild)

The Google callback does nothing special at the end: it mints a `web_login`
token and redirects to `/auth?code=…`. A magic link lands on the same path.

- `auth_tokens` — SHA-256 hashed, TTL'd, single-use via an atomic consume
  `UPDATE` (`db.ts:550`)
- `POST /v1/auth/web/exchange` — one-time code → session JWT
  (`auth-google.ts:182`)
- `AuthHub.tsx:96` — the `?code=` branch already exchanges and continues into
  `afterAuthenticated`, so the **editor loopback and post-auth return come
  along free**
- `[[send_email]]` bound to `no-reply@arcaneai.org`; SPF/DKIM/DMARC live

### The storage split that makes this safe

The session token lives in `localStorage` (`auth.ts:74`) — shared across all
tabs on the origin. The editor's pending request lives in `sessionStorage` —
scoped to one tab. So the warm path needs no changes:

1. User is signed in on the website → token in `localStorage`
2. Editor opens the browser at `/auth?flow=editor&…` → new tab
3. `AuthHub` saves the editor request to that tab's `sessionStorage`
4. Step 5 reads the token from `localStorage`, validates via `apiGetMe`, and
   `afterAuthenticated` finds the pending request in the same tab → mints the
   grant → deep-links back

Magic link only has to establish the website session. The editor auto-signin
follows on its own.

### The one gap, accepted deliberately

A user who clicks *Sign in* **in the editor while cold** (no website session)
holds the editor request in Tab A; the emailed link opens Tab B with an empty
`sessionStorage`. They land signed-in on `/account` and the editor is still
waiting. Recovery: return to the editor, click Sign in again — now instant,
because `localStorage` has the token.

Rejected alternative: carry the editor request server-side on
`auth_tokens.meta` so the link completes the handoff in one pass. This makes an
**emailed link carry editor-grant capability** — a forwarded or leaked email
would grant access to the desktop app, not just the website. That widens blast
radius on the most security-sensitive path to save one click in the rarer flow.
Not worth it.

## Design

### Token purpose

Add to `TOKEN_TTL_SECONDS` (`tokens.ts`):

```ts
magic_login: 15 * 60,   // 15 min (emailed sign-in link)
```

A separate purpose, not a longer `web_login`. `web_login` is deliberately 60s
because it is an instant redirect handoff; stretching it to 15 min would leave
Google's code sitting in browser history far too long.

### `POST /v1/auth/magic/request`

Body `{ email, turnstileToken? }`. Modelled directly on `/v1/auth/forgot`
(`auth-email.ts:64`), which already solves the same problems.

1. Verify Turnstile → `400 turnstile_failed` on failure
2. Non-string/empty email → `{ok:true}` (no shape oracle)
3. `findUserByEmail`; **unknown → `{ok:true}`, send nothing**
4. `countRecentAuthTokens(user, 'magic_login') >= 3` → `{ok:true}` (silent
   throttle, so throttling cannot be probed either)
5. Mint token, store hash, `waitUntil(sendMagicLinkEmail(...))`
6. `logAuthEvent('magic_link_requested', { userId })`
7. Always `{ok:true}`

**Login-only, not login-or-register.** This endpoint is unauthenticated and
wired to the `send_email` binding. Auto-registering would let anyone mint
`users` rows for arbitrary addresses *and* make `no-reply@arcaneai.org` send to
them — a spam-relay vector against the sending reputation the domain has
already established. New users continue through the existing signup form.
Responses are identical either way, so there is no enumeration oracle.

### Email

`sendMagicLinkEmail` in `lib/email.ts`, following the existing helpers. Link:

```
${WEB_BASE_URL}/auth?code=${rawToken}
```

Copy must state the 15-minute expiry, single use, and "if this wasn't you,
ignore this email — nothing has changed."

### Exchange

`/v1/auth/web/exchange` currently consumes only `web_login`. It tries
`web_login`, then `magic_login`. On a `magic_login` consume it also calls
`setEmailVerified(db, user.id)` — clicking a link delivered to that address is
proof of ownership, the same reasoning the Google path uses when it sets
`email_verified = 1` on link.

No `token_version` bump: this mints a session, it does not revoke others.

### Rate limiting

Add `/v1/auth/magic/request` to the `RL_AUTH_STRICT` path list
(`index.ts:44-50`).

### Frontend

`AuthHub.tsx` gains an "Email me a sign-in link" action and a "check your
email" state. The `?code=` landing branch is **unchanged**.

## Testing

- Unknown email → `200 {ok:true}`, no token minted, no mail sent
- Known email → token minted with purpose `magic_login`, mail dispatched
- Turnstile failure → `400 turnstile_failed`
- Fourth request within the hour → `{ok:true}`, no new token
- Exchange accepts `magic_login`, returns a session JWT, flips
  `email_verified` to 1
- Exchange still accepts `web_login` (no Google regression)
- Consumed or expired `magic_login` → `400 invalid_code`
- Single-use: two concurrent exchanges of one code — exactly one wins

## Out of scope

- GitHub sign-in (does not exist; separate build)
- Google configuration (owner action; unblocks independently)
- Auto-registration via magic link (deliberately rejected above)
