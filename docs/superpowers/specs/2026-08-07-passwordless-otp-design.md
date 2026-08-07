# Passwordless sign-in (emailed one-time code) — design

**Date:** 2026-08-07
**Status:** implemented

## Why

Users want to sign in without inventing and remembering a password. "Continue
with Google" would deliver that, but it is blocked on a Google Cloud OAuth
client that only the domain owner can create — and no reduced version exists:
Google's authorization endpoint requires a registered `client_id`, refuses
unregistered `redirect_uri`s, and offers no dynamic client registration.

Rather than leave a button that always errors, the Google entry point is
removed from the UI and replaced with an emailed 6-digit code.

### Why a code and not a link

Both were designed; the code won on one decisive point.

`editor-login.ts` keeps a pending editor sign-in request in **`sessionStorage`**,
which is scoped to a single tab. An emailed *link* opens from the mail client in
a **new tab**, where that storage is empty — so a cold-start editor sign-in
would strand the editor and need a second attempt. A **code is typed back into
the tab that requested it**, so the pending request is still there and the
editor handoff completes in one pass.

## What already existed (reused, not rebuilt)

- `auth_tokens` — SHA-256 hashed, TTL'd, single-use via an atomic consume
  `UPDATE` (`db.ts`)
- `/v1/auth/forgot` — the always-200, Turnstile-gated, silently-throttled shape
  this route is modelled on
- `[[send_email]]` bound to `no-reply@arcaneai.org`; SPF/DKIM/DMARC live

### Cloudflare Email Sending

Verified against the docs: **before** onboarding a sending domain you may only
mail verified destination addresses in your own account; **after onboarding you
can send to any recipient.** `arcaneai.org` is already onboarded and sending
verification and reset mail, so OTP needed no new infrastructure.

Operational note: Email Sending is in beta on the Workers Paid plan, and new
accounts start on a conservative daily quota that scales with sending behaviour
and deliverability. OTP produces more mail than links do, because users resend
when a code is slow or mistyped. A limit-increase form exists if the quota
bites.

`env.EMAIL.send()` accepts `to`/`from`/`cc`/`bcc`/`replyTo` as either a plain
string or an `{email, name}` object — the existing `from: { email, name:
'Arcane' }` is valid.

## Design

### Token purpose

`otp_login`, TTL **10 min** (`tokens.ts`). Shorter than the link-style purposes
because a 6-digit code is guessable in a way a 256-bit token is not; TTL is the
main lever bounding an attacker's window.

### Two problems a 6-digit code has that a link does not

**1. Collisions.** `auth_tokens.token_hash` is `UNIQUE`, and 10⁶ is small enough
that two concurrent users can draw the same code — the second `INSERT` would
fail. Codes are therefore stored as `sha256(userId:code)` (`otpHash`). This also
means a code minted for one account is useless against another.

**2. Online brute force.** The per-IP limiter alone (10/60s) permits roughly
6000 guesses inside a 10-minute TTL against a 10⁶ space — about a 0.6% chance
per target. So `auth_tokens` gains an `attempts` column (migration `0018`); the
verify route increments it on every miss and consumes the row at
`OTP_MAX_ATTEMPTS = 5`, destroying the code well before brute force is viable.

`generateOtp` uses rejection sampling rather than `% 1e6`, since 2³² is not a
multiple of 10⁶ and plain modulo would make low codes measurably likelier.

### `POST /v1/auth/otp/request`

Body `{ email, turnstileToken? }`. Turnstile failure → `400 turnstile_failed`.
Everything else → `{ok:true}`: unknown email, malformed email, and throttled
(3/hour) are indistinguishable, so neither account existence nor throttle state
is probeable. Mints a code, stores `otpHash`, sends via `waitUntil`.

**Login-only, never login-or-register.** The endpoint is unauthenticated and
wired to the `send_email` binding; auto-registering would let anyone mint
`users` rows for arbitrary addresses *and* make `no-reply@arcaneai.org` send to
them — a spam-relay vector against the domain's sending reputation. New users
continue through `/v1/auth/signup`.

### `POST /v1/auth/otp/verify`

Body `{ email, code }` → session JWT, or `400 invalid_code`.

**One rejection for every failure mode** — unknown account, wrong code, expired,
replayed, burnt by too many guesses. Distinguishing them would hand an attacker
both an account oracle and a brute-force progress meter.

On success it sets `email_verified`: receiving a code sent to that address
proves ownership, the same reasoning the Google path uses.

### Rate limiting

Both routes are on `RL_AUTH_STRICT` (`index.ts`).

### Frontend

`/auth` drops the Google button entirely and offers "Email me a sign-in code"
on the Sign in tab only (the route is login-only, so offering it under Create
account would promise mail that never arrives). Submitting swaps the card to
code entry **in the same tab**.

`AccountPanel`'s "Google — Connected/Not connected" row is removed too: with no
way to link an account it read "Not connected" for every user.

`/v1/auth/web/exchange` reverts to `web_login`-only — nothing lands on `/auth`
with a `?code=` any more except a Google callback.

## What was deliberately kept

`auth-google.ts` and its 13 tests stay. They cost nothing, and if the OAuth
client is ever provisioned the route works immediately with no code changes.
`googleStartUrl` and `google_sub` likewise remain; only the UI entry points are
gone. The `use_google` / `google_account` error strings were reworded to stop
directing users to a button that no longer exists.

## Testing

- `generateOtp` always 6 digits, well spread across the range
- `otpHash` differs for the same code under different users
- request: unknown email mints nothing; known email mints one row; throttle at
  3/hour stays `{ok:true}`
- verify: correct code → JWT; `email_verified` flips; wrong code → `400` and
  `attempts` increments; 5 misses destroy the code so the *correct* one then
  fails; another user's code rejected; replay rejected; expired rejected;
  unknown email indistinguishable from a wrong code
- `sendOtpEmail` puts the code in subject and both bodies and contains no link

## Out of scope

- GitHub sign-in (does not exist; separate build)
- Google configuration (owner action; unblocks independently)
- Auto-registration via OTP (deliberately rejected above)
