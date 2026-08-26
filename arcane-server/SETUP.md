# UnityIDE Server — Setup & Deployment

## Prerequisites

- Node.js 18+
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Wrangler CLI (installed as a dev dependency, use via `npx wrangler`)

## First-Time Setup

### 1. Install dependencies

```bash
cd arcane-server
npm install
```

### 2. Configure secrets

All LLM calls route through **Cloudflare Workers AI via an AI Gateway** — there are
**no provider API keys** anymore. The only local secret is the JWT signing key.

Edit `.dev.vars`:

```
JWT_SECRET=some-strong-random-string
```

### 3. Authenticate with Cloudflare

```bash
npx wrangler login
```

This opens a browser window to authorize your Cloudflare account.

### 4. Enable Workers AI + create an AI Gateway

Workers AI is enabled by default on the account. Create an AI Gateway in the
dashboard (**AI → AI Gateway → Create Gateway**) and put its id in `wrangler.toml`:

```toml
[ai]
binding = "AI"

[vars]
CF_AI_GATEWAY_ID = "your-gateway-id"
```

The gateway gives caching, logging, analytics and rate-limits over every model call.

### 5. Create the D1 database

```bash
npx wrangler d1 create arcane-db
```

This outputs a `database_id`. Copy it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "arcane_db"
database_name = "arcane-db"
database_id = "paste-your-id-here"
```

### 6. Run database migrations

```bash
npm run db:migrate:local    # Create tables in local D1
```

## Local Development

```bash
npm run dev
```

Server starts at `https://api.unityide.app`. It uses a local D1 SQLite database stored in `.wrangler/state/`.

### Verify it works

```bash
curl http://localhost:8787/health
# → {"status":"ok"}
```

### Test signup & login

```bash
# Signup
curl -X POST http://localhost:8787/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123"}'

# Login
curl -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123"}'
```

Both return a JWT token. Use it for protected endpoints:

```bash
curl http://localhost:8787/v1/usage \
  -H "Authorization: Bearer <token>"
```

## Production Deployment

### 1. Set production secrets

```bash
npx wrangler secret put JWT_SECRET
```

Prompts you to paste the value (not stored in any file). If migrating from an
older deploy, remove the now-unused provider keys:

```bash
npx wrangler secret delete OPENAI_API_KEY
npx wrangler secret delete ANTHROPIC_API_KEY
npx wrangler secret delete ZAI_API_KEY
```

### 2. Run remote migrations

```bash
npm run db:migrate:remote   # Create tables in production D1
```

### 3. Deploy

```bash
npm run deploy
```

Outputs a URL like `https://arcane-server.<account>.workers.dev`.

### 4. Custom domain (optional)

1. Go to Cloudflare Dashboard → Workers & Pages → arcane-server → Settings → Domains
2. Add your domain (e.g. `api.unityide.app`)
3. Cloudflare handles SSL automatically

## NPM Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run dev` | Start local dev server (port 8787) |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run db:migrate:local` | Run migrations on local D1 |
| `npm run db:migrate:remote` | Run migrations on production D1 |

## Environment Variables & Bindings

| Variable / Binding | Where | Purpose |
|----------|-------|---------|
| `AI` (binding) | `wrangler.toml` `[ai]` | Cloudflare Workers AI — all LLM + embedding calls |
| `CF_AI_GATEWAY_ID` | `wrangler.toml` `[vars]` | AI Gateway id (caching/logging/rate-limits) |
| `arcane_db` (binding) | `wrangler.toml` `[[d1_databases]]` | D1 database |
| `JWT_SECRET` | `.dev.vars` (local) / `wrangler secret` (prod) | JWT signing key |

> Model selection is fully server-side: the editor sends an abstract
> `reasoningLevel` (`low`/`mid`/`high`/`super`) and the server maps it to a
> Workers AI model in `src/config/plans.ts`.
