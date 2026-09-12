#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { checkVersionSync } from './version-sync.mjs';

const problems = checkVersionSync({
  pkg: readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  tauriConf: readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  cargoToml: readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8'),
  // The dev channel ships its own installers through `dev-build.yml` and needs
  // the same pubkey guarantee as production.
  tauriDevConf: readFileSync(new URL('../src-tauri/tauri.dev.conf.json', import.meta.url), 'utf8'),
  // Reported to external ACP agents in `clientInfo`. A literal, because the
  // handshake cannot await Tauri's async getVersion() — so it needs a guard.
  claudeBackend: readFileSync(
    new URL('../src/features/ai-panel/services/claude-backend.ts', import.meta.url),
    'utf8',
  ),
  // Both channels. A workflow that builds installers but publishes no update
  // manifest leaves its endpoint serving a 404, and the app swallows that
  // after one stderr line — so nothing but this check reports it.
  channelWorkflows: ['release.yml', 'dev-build.yml'].map((name) => ({
    name,
    source: readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'),
  })),
});

if (problems.length > 0) {
  console.error('Version/updater configuration problems:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('version sync OK');
