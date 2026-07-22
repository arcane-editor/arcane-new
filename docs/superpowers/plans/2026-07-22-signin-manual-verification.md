# Sign-In Manual Verification (merge gate)

Nothing here is covered by automated tests. The loopback path in particular has
never worked end-to-end, so a green unit suite is not evidence that it does.

## What this run changed

- Added a loopback (`http://127.0.0.1:<port>/callback`) transport for editor
  sign-in, alongside the existing deep link — the deep link remains primary on
  platforms/builds where the `arcane-dev://` scheme is actually registered.
- Un-gated browser sign-in on **all** platforms. Device code is now a manual
  fallback only, offered alongside browser sign-in — it is never the default.
- Replaced the title bar's `?` circle (shown when signed out) with a labelled
  "Sign in" button.
- Added `redirect_uri` validation (with canonicalization) to the landing-page
  `/auth` route, closing off open-redirect vectors while still accepting
  equivalent loopback encodings.
- Made landing-page TypeScript typechecking actually work for the first time —
  `landing-page` had no React type packages installed before this run, so its
  `.tsx` files had never been typechecked.

## A. Google OAuth setup (owner)

- [ ] Google Cloud Console → APIs & Services → OAuth consent screen. User type
      External, app name "Arcane", support + developer contact email set.
- [ ] Credentials → Create Credentials → OAuth client ID → **Web application**.
- [ ] Authorized redirect URIs — all three, exactly:
      - `https://api.arcaneai.org/v1/auth/google/callback`
      - `https://api-dev.arcaneai.org/v1/auth/google/callback`
      - `http://localhost:8787/v1/auth/google/callback`
- [ ] From `arcane-server/`, set the dev secrets (paste when prompted):
      - `wrangler secret put GOOGLE_CLIENT_ID --env dev`
      - `wrangler secret put GOOGLE_CLIENT_SECRET --env dev`
- [ ] `curl -sI https://api-dev.arcaneai.org/v1/auth/google/start | grep -i location`
      → must point at `accounts.google.com`, NOT `?error=google_not_configured`.
- [ ] Sign in with Google at https://dev.arcaneai.org/auth → lands signed in.
- [ ] Sign in with Google using the SAME address as an existing email/password
      account → links rather than duplicating (`auth-google.ts` linking paths).

## B. Loopback sign-in, macOS `tauri dev` (the whole point)

- [ ] `cd editor && bun tauri dev`. Account tab shows "Continue in browser" —
      NOT "Generate Device Code".
- [ ] Click it. Browser opens `dev.arcaneai.org/auth?flow=editor&…` and the URL
      carries `redirect_uri=http://127.0.0.1:<port>/callback` (no `scheme=`).
- [ ] Complete sign-in. Browser lands on a plain "You're signed in" page and the
      editor flips to signed-in **without any manual paste**.
- [ ] Title bar shows the initial avatar; Account tab shows email, plan, credits.
- [ ] Title bar check (implemented but never visually confirmed):
      - Signed out: a labelled **"Sign in"** pill is shown — NOT a `?` circle.
      - Signed in: the first-initial avatar is shown, with a tooltip reading
        `Signed in as <email>` on hover.
      - Clicking either the "Sign in" pill or the avatar opens the Account tab.
- [ ] `lsof -nP -iTCP:<port>` → nothing listening. The socket is single-use.

## C. Loopback edge cases

- [ ] Start sign-in, click Cancel, start again → second attempt completes. (Two
      listeners exist briefly; the stale one is reaped by its 10-minute TTL.)
- [ ] Start sign-in, complete it, then reload the success page → editor does NOT
      sign in a second time (code is consumed).
- [ ] Start sign-in, then visit `http://127.0.0.1:<port>/callback?code=x&state=WRONG`
      by hand → editor ignores it and stays waiting; the real flow still completes.
- [ ] Start sign-in and visit `http://127.0.0.1:<port>/favicon.ico` → 404, and
      the real callback still lands afterwards.

## D. Deep link must not regress

- [ ] `cd editor && bunx tauri build --config src-tauri/tauri.dev.conf.json`,
      launch the built `Arcane Dev.app`, sign in → completes via `arcane-dev://`.
      The URL carries `scheme=arcane-dev` and NO `redirect_uri`.
- [ ] Note: `arcane-dev:` is registered to the bundle under
      `editor/src-tauri/target/release/bundle/macos/`. If that bundle is deleted
      the OS has nothing to route to — rebuild before blaming the code. This is
      expected, pre-existing behavior and is **not** what the loopback transport
      fixes — loopback covers the `tauri dev` process, which is a separate
      binary from the bundled `.app`.

## E. Rejection paths

- [ ] Hand-open `dev.arcaneai.org/auth?flow=editor&state=s&challenge=<43 chars>&redirect_uri=http://evil.com/callback`
      → hard-error banner, no redirect.
- [ ] Same with `redirect_uri=http://localhost:53411/callback` → hard-error.
- [ ] Same with `redirect_uri=http://127.0.0.1:80/callback` → hard-error.
- [ ] Same with both `scheme=` and `redirect_uri=` present → hard-error.
- [ ] Alternate-encoding vectors — these are all equivalent to
      `http://127.0.0.1:<port>/callback` and, after the canonicalization fix,
      must be **accepted and complete sign-in normally**, not rejected. Exercise
      each by hand-editing `redirect_uri` in the `/auth` URL:
      - `http://2130706433:<port>/callback` (decimal IPv4)
      - `http://127.1:<port>/callback` (short form)
      - `http://[0:0:0:0:0:0:0:1]:<port>/callback` (expanded IPv6)

## F. Suites

- [ ] `cd editor && bun test src` — ≥ 819 passing, zero failures
- [ ] `cd editor && bunx tsc --noEmit` — clean
- [ ] `cd editor/src-tauri && cargo test` — ≥ 310 passing, zero failures
- [ ] `cd landing-page && pnpm test` — ≥ 21 passing, zero failures
- [ ] `cd landing-page && pnpm exec tsc --noEmit` — clean (astro build does NOT
      typecheck tsx). This is now a real, enforceable gate: `landing-page`
      previously had no `@types/react` at all and reported 40 errors because
      its `.tsx` had never been typechecked. The type packages were added
      during this run and it currently exits 0 — a non-zero count from here on
      is a genuine regression, not pre-existing noise.
- [ ] `cd landing-page && pnpm build` — succeeds

## Merge

- [ ] Once every section above is green, merge to `dev` (owner-gated):
      ```bash
      git checkout dev
      git merge --no-ff fix/auth-loopback-and-signin
      ```
