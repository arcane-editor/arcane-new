# Sign in with GitHub — deploy + manual verification (dev)

Branch `feat/github-auth` off `heads/v0.3.0`. Target: dev only
(`api-dev.arcaneai.org` + `dev.arcaneai.org`); prod is a separate OAuth App and
a later cutover.

## What shipped

| Area | Change |
|---|---|
| `migrations/0020_github_auth.sql` | `users.github_id TEXT` + partial unique index |
| `src/lib/db.ts` | `findUserByGitHubId`, `linkGitHubId`, `linkGitHubIdClearingCredentials`; `createOAuthUser` now takes `{ email, googleSub?, githubId? }` |
| `src/routes/auth-github.ts` | `/v1/auth/github/start`, `/v1/auth/github/callback`, `exchangeGitHubCode`, `fetchGitHubIdentity`, `resolveGitHubAccount` |
| `index.ts` | router mounted; `/v1/auth/github/start` on the strict rate limiter |
| `src/routes/auth.ts` | `/v1/auth/me` gains `githubLinked` |
| landing `lib/auth.ts` | `githubStartUrl`, `MeResponse.githubLinked`, 4 error codes |
| landing `AuthHub.tsx` | "Continue with GitHub" button + divider |
| landing `AccountPanel.tsx` | GitHub row when linked; provider-accurate set-password copy |

The editor is untouched. It opens the browser at `/auth?flow=editor&…` and the
pending request lives in `sessionStorage`, so it survives the GitHub round-trip
and reaches `apiEditorGrant` exactly as the email/password path does.

## Automated gate — PASS

- `arcane-server`: 244 vitest tests (29 files), was 208. `bun run check:types` clean.
- `landing-page`: 33 vitest tests (3 files), was 29. `tsc --noEmit` clean, `astro build` clean.
  (`astro build` does **not** typecheck `.tsx` — run `tsc` directly.)
- Covered without network: token-exchange quirks, identity fetch, account
  resolution incl. the pre-account-takeover guard, and the full callback with
  global `fetch` stubbed (happy path, return_to, unverified email, link
  conflict, rejected exchange).

## OWNER step 1 — register the OAuth App

**Two Apps, one per environment.** An OAuth App holds exactly one authorization
callback URL and GitHub requires the `redirect_uri` to match it, so dev and prod
cannot share one. Separate Apps also keep a leaked dev secret away from prod.

Both are owned by the **`arcane-editor` org** (which already owns this repo), not
a personal account — the prod consent screen then reads "*Arcane by
arcane-editor*", and ownership outlives any one account.

<https://github.com/organizations/arcane-editor/settings/applications> →
**New OAuth App** (org → Settings → Developer settings → OAuth Apps). The
`…/settings/applications/new` form prefills from
`?oauth_application[name]=…&oauth_application[url]=…&oauth_application[callback_url]=…`.

Only org **owners** can administer OAuth Apps — the org "App manager" role covers
GitHub Apps only, so it cannot be delegated. An App created personally by mistake
can be moved with **Transfer ownership** at the bottom of its page; that preserves
the Client ID and secret, so no redeploy is needed.

| Field | Dev App | Prod App |
|---|---|---|
| Application name | `Arcane Dev` | `Arcane` |
| Homepage URL | `https://dev.arcaneai.org` | `https://arcaneai.org` |
| Authorization callback URL | `https://api-dev.arcaneai.org/v1/auth/github/callback` | `https://api.arcaneai.org/v1/auth/github/callback` |

Leave **Enable Device Flow** unchecked — device codes were dropped in migration
`0017`. Register → copy the **Client ID** (re-readable any time) → **Generate a
new client secret** and copy it immediately; GitHub shows it once.

The prod App's name and logo are what real users read on the consent screen
("*Arcane by <owner>* wants to access your account"), so upload a logo there.
Nothing in the code depends on either name.

## OWNER step 2 — set the secrets + deploy

Dev (note `--env dev` on every command):

```bash
cd arcane-server
wrangler secret put GITHUB_CLIENT_ID     --env dev   # prompts; value is not echoed
wrangler secret put GITHUB_CLIENT_SECRET --env dev
wrangler d1 migrations apply arcane-db-dev --env dev --remote
wrangler deploy --env dev
```

Prod, only after the browser checks below pass (top-level env — **no** `--env`):

```bash
cd arcane-server
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler d1 migrations apply arcane-db --remote
wrangler deploy
```

`0020` is `ALTER TABLE ADD COLUMN` — **not idempotent**. A partial failure needs
manual reconciliation, not a blind re-run.

Landing deploys from CI on push to the branch's dev pipeline
(`deploy-landing.yml`), or `pnpm build` + Pages direct upload.

Until the secrets are set, `/v1/auth/github/start` 302s to
`/auth?error=github_not_configured` and the button shows "GitHub sign-in isn't
set up yet." Nothing else changes — the deploy is safe to land before step 1.

Wiring check per environment, once deployed:

```bash
curl -sI "https://api-dev.arcaneai.org/v1/auth/github/start" | grep -i location
```

`https://github.com/login/oauth/authorize?client_id=…` = wired;
`…/auth?error=github_not_configured` = secrets missing on that worker. If GitHub
itself answers *"The redirect_uri MUST match the registered callback URL"*, the
App's callback field disagrees with `API_BASE_URL` — fix the App, not the code.

## OWNER-MANUAL browser checks

On <https://dev.arcaneai.org/auth>:

1. **New account** — "Continue with GitHub" with a GitHub account that has never
   signed in → GitHub consent → back on `/account`, signed in, email **Verified**,
   GitHub row shows **Connected**. No password set → the password card offers
   "Email me a set-password link" and says *"You sign in with GitHub."*
2. **Returning** — sign out, click GitHub again → straight back in, same account
   id (check `/account` shows the same email and usage count).
3. **Linking onto an existing password account** — create an email/password
   account with the same address as your GitHub primary email, verify it, sign
   out, then sign in with GitHub → lands on the **same** account, password still
   works afterwards.
4. **Cancel** — click GitHub, then press "Cancel" on GitHub's consent screen →
   back on `/auth` with "GitHub sign-in failed. Please try again." (no crash,
   no partial session).
5. **Editor round-trip** — from Arcane Dev click Sign in, then choose GitHub in
   the browser → `/auth/success` → deep link returns to the app signed in.
   Confirms the editor request survived the GitHub redirect.
6. **URL hygiene** — after any GitHub sign-in, the address bar shows no `?code=`
   (AuthHub `replaceState`-scrubs it) and no token anywhere in the URL.
7. **Unverified primary email** (optional) — a GitHub account whose primary
   address is unverified → "Your primary GitHub email address is not verified…".

## Known limits

- **`wrangler dev` on `http://localhost:8787` will not work as-is**: the state
  cookie is `Secure`, so browsers drop it over plain HTTP and every callback
  fails `state_mismatch`. Test against deployed dev, or register a third
  localhost App and temporarily relax the flag.
- No **Connect GitHub** action on `/account`. The callback resolves the account
  by verified email, so connecting while signed in under a different address
  would switch accounts rather than link the current one. Linking from a signed-in
  session needs its own design (bind to the session user id, not the email).
- Google's routes and `google_sub` stay in place and stay unwired from the UI.
