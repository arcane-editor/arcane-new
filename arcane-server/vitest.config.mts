// NOTE: deviates from the brief's exact snippet in three ways, all forced by
// the pinned @cloudflare/vitest-pool-workers@0.18.6 (peers on vitest ^4.1.0):
// 1. That version removed the `@cloudflare/vitest-pool-workers/config`
//    subpath, `defineWorkersConfig`, and `singleWorker` entirely — confirmed
//    via the package's own bundled `dist/codemods/vitest-v3-to-v4.mjs`
//    migration codemod, which rewrites exactly this old shape into a
//    `cloudflareTest` Vite plugin + `defineConfig` from `vitest/config`.
//    `readD1Migrations` still lives on the main package entrypoint. Same
//    architecture (workers pool, wrangler.test.toml, D1 migrations bound via
//    TEST_MIGRATIONS) — only the config wiring changed.
// 2. `@cloudflare/vitest-pool-workers` is ESM-only; this repo's package.json
//    has no `"type": "module"`, so Vite's config loader tries to `require()`
//    it and fails ("This package is ESM only but it was tried to load by
//    `require`"). Fix: `.mts` extension (Vite's documented fix for this
//    exact error) so the config file itself loads as native ESM — no other
//    file in the repo is affected.
// 3. No `@types/node` exists anywhere in this project (checked — not even
//    transitively), so `node:path`/`__dirname` cannot type-check under
//    `check:types` no matter which tsconfig picks this file up. `vitest run`
//    is always invoked with CWD = arcane-server/ (npm script + brief's Step
//    1), and readD1Migrations passes its argument straight to
//    `fs.readdirSync` (resolved against CWD) — so a plain relative path
//    works without needing node:path/__dirname at all.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
    // All committed migrations (0001..0011) run against the test D1 in the
    // setup file — tests always see the exact remote schema.
    const migrations = await readD1Migrations('./migrations');
    return {
        plugins: [
            cloudflareTest({
                wrangler: { configPath: './wrangler.test.toml' },
                miniflare: {
                    bindings: {
                        TEST_MIGRATIONS: migrations,
                        // Re-assert wrangler.test.toml's [vars] here. Miniflare
                        // loads a developer's local .dev.vars (resolved next to
                        // the wrangler config — same directory as wrangler.toml)
                        // and it wins over [vars] on overlapping keys, so a real
                        // local JWT_SECRET silently leaked into the test worker
                        // and broke the `env.JWT_SECRET === 'test-secret'`
                        // guarantee. Explicit miniflare bindings win the final
                        // merge, making the test worker deterministic regardless
                        // of what's in .dev.vars on any given machine.
                        JWT_SECRET: 'test-secret',
                        ENVIRONMENT: 'test',
                        CF_AI_GATEWAY_ID: '',
                        WEB_BASE_URL: 'https://dev.arcaneai.org',
                        API_BASE_URL: 'http://localhost:8787',
                        EMAIL_FROM: 'no-reply@arcaneai.org',
                    },
                },
            }),
        ],
        test: {
            setupFiles: ['./test/apply-migrations.ts'],
        },
    };
});
