#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { checkVersionSync } from './version-sync.mjs';

const problems = checkVersionSync({
  pkg: readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  tauriConf: readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  cargoToml: readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8'),
});

if (problems.length > 0) {
  console.error('Version/updater configuration problems:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('version sync OK');
