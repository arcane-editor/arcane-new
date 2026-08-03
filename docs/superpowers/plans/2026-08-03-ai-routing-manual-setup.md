# AI Routing Manual Setup (owner-gated)

One-time steps to activate MiniMax/Kimi routing. Until done, low/high tiers
serve their CF fallbacks (qwen-coder / glm-5.2) and log `provider_config_fallback`.

## 1. Rotate the leaked MiniMax key
`editor/.env` contains a plaintext `MINMAX="sk-api-…"` key. Rotate it in the
MiniMax console FIRST, then delete that line from `editor/.env`.

## 2. Account id
`cd arcane-server && npx wrangler whoami` → set `CF_ACCOUNT_ID` in BOTH
`[vars]` and `[env.dev.vars]` of `wrangler.toml` (it is not a secret).

## 3. Register custom providers (both gateways: arcane-ai-gateway, arcane-ai-gateway-dev)
Dashboard → AI → AI Gateway → <gateway> → Custom Providers → Create:
- slug `minimax`  → base URL = MiniMax's OpenAI-compatible endpoint (from their current API docs)
- slug `moonshot` → base URL = Moonshot's OpenAI-compatible endpoint (from their current API docs)
Slugs MUST be exactly `minimax` / `moonshot` — the router derives keys from the
`custom-minimax/` / `custom-moonshot/` model prefixes.

## 4. Verify model ids + prices
Confirm the exact model-id strings for MiniMax 3 and Kimi 3 in the provider
docs. If they differ from `MiniMax-M3` / `kimi-k3`, update BOTH
`src/config/plans.ts` (INTENSITY_CONFIG) and `src/lib/costs.ts` (MODEL_CATALOG
keys). Update the provisional prices in MODEL_CATALOG from the pricing pages.

## 5. Secrets
    cd arcane-server
    npx wrangler secret put MINIMAX_API_KEY
    npx wrangler secret put MOONSHOT_API_KEY
    npx wrangler secret put MINIMAX_API_KEY --env dev
    npx wrangler secret put MOONSHOT_API_KEY --env dev

## 6. Verify on dev before prod
Deploy: `npm run deploy:dev`. In the editor (dev build), send a chat at Low and
at High effort. Check: gateway logs show custom-provider requests; no
`provider_fallback` / `provider_config_fallback` events in
`wrangler tail arcane-server-dev`; `/v1/usage` shows non-zero cost. Then deploy prod.
