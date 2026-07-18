import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.arcane_db, env.TEST_MIGRATIONS);
