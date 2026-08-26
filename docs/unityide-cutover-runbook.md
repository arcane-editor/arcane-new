# UnityIDE cutover runbook

Everything needed to take the Arcane → UnityIDE rename from a merged branch to a
live dev and prod environment. The code side is done and on
`feat/unityide-rebrand`; this is the part that lives in dashboards.

**The decision this all follows from: a hard cut.** `arcaneai.org` and every
subdomain, `releases.arcaneai.org` included, stop being used. Every installed
Arcane build loses auth, AI and auto-update permanently, and every Unity project
with the extension fails to restore `com.arcane.editor` on next open. That is
accepted and deliberate. Do not half-do it — a partially-detached old domain is
worse than either end state.

The zone `unityide.app` is already delegated to the same Cloudflare account
(verified: same nameserver pair as arcaneai.org), with no records yet.

---

## Phase 0 — prerequisites, all before any deploy

Do **P1 first**: DKIM propagation is the slowest thing on this list and
everything about email waits on it.

Two prerequisites that a reading of the code implies are blockers turn out not to
be, because the features behind them were never switched on. Both are struck
through below with the evidence, so nobody re-adds them from the source alone.
**The only genuine owner-gated step left is P6, the GitHub OAuth Apps.**

| # | What | Where | Blocks |
|---|---|---|---|
| **P1** | Onboard `unityide.app` in **Email Sending**. Add the MX/SPF on `cf-bounce`, DKIM on `cf-bounce._domainkey`, DMARC on `_dmarc`, and confirm all four verify. **Do not offboard `arcaneai.org`** — the hard cut removes product hostnames, not the zone. | Cloudflare → Compute → Email Service | worker deploy |
| **P2** | ~~Turnstile hostnames~~ — **not applicable.** Verified 2026-08-26: the account has no Turnstile widget, the repo has no `PUBLIC_TURNSTILE_SITE_KEY` Actions variable, and neither worker has a `TURNSTILE_SECRET`. Turnstile was never provisioned, so the graceful-degradation path is live and signup does not depend on it. If it is ever turned on, the new hostnames must be on the widget from the start. | — | nothing |
| **P3** | Attach `releases.unityide.app` as a custom domain on the **`arcane-releases`** bucket (bucket name unchanged). | Cloudflare → R2 | release build |
| **P4** | Add `dev.unityide.app` to Pages project `arcane-landing-dev`; add `unityide.app` + `www.unityide.app` to `arcane-landing`. Project names unchanged. | Cloudflare → Pages | landing deploy |
| **P5** | ~~Google redirect URIs~~ — **not applicable.** Verified 2026-08-26: neither worker has `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, so `/v1/auth/google/start` already answers `google_not_configured` and the button is dead on both channels today. Nothing to migrate. When Google sign-in is set up, register the `unityide.app` callbacks then. | — | nothing |
| **P6** | Two OAuth Apps, one per environment, because GitHub allows exactly one callback each. Point dev at `https://api-dev.unityide.app/v1/auth/github/callback` and prod at the `api.unityide.app` equivalent. Update Homepage URL too. Edit at the moment of the matching worker deploy — see the window note below. | GitHub → Developer settings | GitHub sign-in |

**Do not hand-create DNS records** for the apex, `www`, `dev`, `api`, `api-dev`
or `releases`. Workers Custom Domains refuse a hostname that already has a
CNAME, and Pages and R2 create their own records. The only records you add by
hand are the ones Email Sending asks for.

---

## Phase 1 — dev

1. Flip the **dev** GitHub OAuth App callback (P6, dev half).
2. Merge `feat/unityide-rebrand` → `dev` and push. Three workflows fire:
   `deploy-server` (dev), `deploy-landing` (dev), `dev-build`.
   The worker deploy creates the `api-dev.unityide.app` custom domain from
   `wrangler.toml`.

### Dev gate — every line must pass before prod is touched

```
dig +short api-dev.unityide.app dev.unityide.app releases.unityide.app
curl -s  https://api-dev.unityide.app/health
curl -si -X OPTIONS https://api-dev.unityide.app/v1/auth/login \
     -H 'Origin: https://dev.unityide.app' -H 'Access-Control-Request-Method: POST'
```

- [ ] All three hostnames resolve; `/health` returns ok; the preflight echoes the origin
- [ ] `dev.unityide.app` serves the new build — check `<title>`, `rel=canonical`, the `ld+json` block
- [ ] Turnstile **renders** on `/auth` and a signup with a fresh address succeeds (not `turnstile_failed`)
- [ ] The verification email **arrives**, from `no-reply@unityide.app`. This is the only real test of P1 — a green dashboard tick is not
- [ ] `/forgot` → email arrives → link points at `dev.unityide.app` → reset completes
- [ ] Google sign-in round-trips
- [ ] GitHub sign-in round-trips
- [ ] Dodo **test** checkout completes and credits land. A 503 here means the `DODO_PRODUCT_*` secrets got shadowed by same-named plaintext vars — see the comment in `wrangler.toml`
- [ ] Download cards point at `releases.unityide.app/dev/latest/UnityIDE-Dev-*`, **not** `/latest/`. This is the `isDevChannel` check in `releases.ts`
- [ ] The dev installer launches as "UnityIDE Dev", installs side by side, and shows **no** "Release channel mismatch" dialog at boot
- [ ] `unityide-dev://auth/callback` deep-links back into the app and signs in
- [ ] A clean Unity project gets `Packages/com.unityide.editor/`, `Library/UnityIDE/` fills with `bridge.json` + both journals, and Unity compiles clean
- [ ] A project that already had `Packages/com.arcane.editor/` has it **removed**, with no duplicate-GUID errors
- [ ] `~/.arcane` was copied to `~/.unityide` and the user is still signed in

A dev-channel updater 404 is **expected** — `dev-build.yml` publishes no
manifests. Do not "fix" it during the cutover.

---

## Phase 2 — prod

3. Merge `dev` → `master`. This deploys **nothing**: both prod jobs are
   `workflow_dispatch` and require `ref == master`. Free checkpoint.
4. Detach `releases.arcaneai.org` from the `arcane-releases` bucket.
5. Re-tag and release:
   ```
   cd editor && bun run check:version     # CI does NOT run this; a stale Cargo.toml ships silently
   git tag -f v0.3.2 && git push -f origin v0.3.2
   ```
   Verify each artifact over `https://releases.unityide.app/...` before continuing.
6. Dispatch **Deploy Server** with `environment=production`, and flip the **prod**
   GitHub OAuth App callback at the same moment.
7. Dispatch **Deploy Landing** with `environment=production`. Do this *after*
   step 5: `DownloadSection.astro` reads the version out of the live manifest at
   build time, so releasing first is what stops the version cards falling back.
8. Detach `arcaneai.org`, `www.arcaneai.org` and `dev.arcaneai.org` from the two
   Pages projects.
9. Dodo: **update the existing endpoint's URL in place** to
   `https://api.unityide.app/v1/billing/webhook` rather than creating a new one.
   Same endpoint id means the same signing secret, so `DODO_WEBHOOK_SECRET` does
   not rotate and there is no window at all — strictly better than the
   create → swap secret → verify → delete sequence, which was the original plan
   here and is only needed if the endpoint cannot be edited.

   Then rename the five live products (`Arcane Starter` → `UnityIDE Starter`, …);
   those names appear on checkout pages and invoices. Product **ids** do not
   change, so no `DODO_PRODUCT_*` var or secret moves.

   If you ever do have to create-and-swap: it is still zero-loss, because both
   endpoints receive every event and the one whose signature does not match the
   currently-set secret returns 400 from `verifyDodoWebhook` *before*
   `recordBillingEvent` runs. No double grants, no dropped events.
10. Google Search Console: add `unityide.app`, verify, submit
    `https://unityide.app/sitemap-index.xml`. Do **not** use Change of Address —
    it requires 301s from the old domain, which the hard cut forbids.

### The one unavoidable window

Between the prod worker deploy and the GitHub OAuth edit, the worker sends a
`redirect_uri` the GitHub App does not yet list, so **GitHub sign-in only**
returns `redirect_uri_mismatch`. Google is unaffected (both URIs registered since
P5). Email/password login, editor sign-in, AI and billing are unaffected.
Rollback is instant: edit the callback back.

Creating *new* GitHub Apps instead does not help — the worker holds one client
id/secret per environment and `wrangler secret put` is not atomic with
`wrangler deploy`, so it is the same window with more moving parts and no
instant undo.

---

## What is irreversible

| Step | Blast radius | Rollback |
|---|---|---|
| Bundle identifier change | Absolute, per install. No server-side action reaches an installed app | none |
| Detaching `releases.arcaneai.org` | Every existing install's update check fails; old download links 404 | re-attachable in minutes; the failed polls already happened, and the updater retries in 6h |
| Detaching `api.arcaneai.org` | Every old install loses AI, auth refresh and billing. Tokens stay valid in D1 — only the host is gone | put the pattern back in `routes` and redeploy |
| Tag + release | R2 objects are written and `put` never deletes | `arcane-releases/v0.3.2/` still holds the Arcane artifacts, so `latest/` can be restored by copying them back; manifests would need rebuilding by hand |
| Deleting the old Dodo endpoint | Recreatable, but with a new signing secret | recreate + `wrangler secret put` |

Everything else — Google URI additions, Turnstile hostnames, custom-domain
attach/detach, GitHub callback edits, worker and Pages deploys, product renames —
is reversible.

---

## Not part of the cutover

- `arcaneai.org`'s **zone** stays. The hard cut removes product hostnames; the
  zone still carries the Email Sending records, and deleting it would remove the
  fallback that makes P1 safe to get wrong.
- Names that deliberately did not change are listed in `AGENTS.md` under
  "Naming After The UnityIDE Rename", and `node scripts/brand-audit.mjs`
  enforces them.
