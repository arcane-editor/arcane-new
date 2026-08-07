# Signup email verification by 6-digit code — design

**Date:** 2026-08-07
**Status:** implemented

## Why

Email verification is a **hard gate**, not a nicety: `requireVerifiedEmail()`
guards `/v1/chat/*`, `/v1/embeddings`, `/v1/graph/*`, `/v1/unity/*`,
`/v1/completions/*` and billing checkout. A new account can sign in but cannot
use the product at all until it verifies.

That makes verification the critical path immediately after signup, and it was
a **link** — which bounces the user out to a mail client and back into a fresh
tab. A **code** keeps them in the tab they signed up in: fewer steps at the
moment of highest drop-off, and any pending editor sign-in (held in
`sessionStorage`, which is per-tab) survives.

## History

An earlier iteration put OTP on *sign-in* ("Email me a sign-in code") and left
verification as a link. That was rejected: sign-in already works by password,
so the code was redundant there, while the genuinely blocking step — signup
verification — still cost a tab switch. The OTP machinery moved to where the
gate actually is.

Google sign-in was removed from the UI in the same period (unprovisioned OAuth
client, owner-only to create). `auth-google.ts` and its tests remain intact.

## Design

### Token purpose

`verify_email`, TTL **15 min** — down from 24 h, because it is now a 6-digit
code rather than a 256-bit link token. A short life is the main lever bounding
brute force. Users who miss the window request a new code.

`otp_login` is gone, along with `/v1/auth/otp/request` and
`/v1/auth/otp/verify`.

### Two problems a 6-digit code has that a link does not

**1. Collisions.** `auth_tokens.token_hash` is `UNIQUE`, and 10⁶ is small
enough that two concurrent signups can draw the same code — the second `INSERT`
would fail. Codes are stored as `sha256(userId:code)` (`otpHash`), which also
makes one account's code useless against another.

**2. Online brute force.** `auth_tokens.attempts` (migration `0018`) is
incremented on every miss; the row is consumed at `OTP_MAX_ATTEMPTS = 5`, so a
code self-destructs long before guessing is viable.

`generateOtp` uses rejection sampling rather than `% 1e6`, since 2³² is not a
multiple of 10⁶ and plain modulo would make low codes measurably likelier.

### `POST /v1/auth/verify` — now authenticated

Body `{ code }`, `Authorization: Bearer <session>`.

Signup already returns a session JWT, so **the account comes from the token,
not the request body**. This is the key security property: a bare
`{email, code}` endpoint would let anyone grind a 6-digit space against any
address they choose. Requiring the session means an attacker must already hold
that account's token, at which point the code buys them nothing.

Returns a fresh JWT so the client can replace a stored token whose
`email_verified` claim is stale. Failures return `invalid_code` uniformly
(wrong, expired, replayed, burnt).

### Signup and resend

`POST /v1/auth/signup` mints a code instead of a link token.
`POST /v1/auth/resend-verification` (already authenticated, throttled at
3/hour) mints a fresh one.

`sendVerificationEmail` leads the subject with the code — `"481920 is your
Arcane verification code"` — so mail clients preview it unopened. The body
contains no link.

### Frontend

- **`AuthHub`** — signup no longer falls through to `afterAuthenticated`; it
  shows an inline code step in the same tab, then continues once verified.
  Sign-in is unchanged (email + password).
- **`/verify`** (`VerifyEmail.tsx`) — was a link handler reading `?token=`; now
  a standalone code entry for a signed-in but unverified account. Redirects to
  `/auth` when signed out, and resumes a pending editor sign-in on success.
- **`AccountPanel`** — the unverified row links to `/verify` rather than
  resending inline, so there is exactly one place to type a code.

## Testing

- signup mints exactly one `verify_email` code and the account starts unverified
- correct code verifies and returns a fresh JWT
- **unauthenticated verify is rejected (401)** — the code alone is not enough
- wrong code → `400 invalid_code`, `attempts` increments
- 5 misses destroy the code, so the *correct* one then fails
- another account's code is refused
- replayed and expired codes are refused
- resend mints a fresh code
- the OTP sign-in routes 404
- `sendVerificationEmail` carries the code in subject and both bodies, no link

## Out of scope

- GitHub sign-in (does not exist)
- Google configuration (owner action; code retained and unblocks independently)
