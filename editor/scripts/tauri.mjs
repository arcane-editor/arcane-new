#!/usr/bin/env node
// Thin wrapper around the Tauri CLI that makes `tauri dev` the DEV channel.
//
// Why this exists: "dev-ness" is set in two independent places. Vite's mode
// picks the API endpoints (`.env.development`), and the Tauri config file picks
// the bundle identifier — which is what selects the config dir (`~/.arcane` vs
// `~/.arcane-dev`) and the deep-link scheme. A plain `tauri dev` took the base
// config, so it ran the dev endpoints under the PRODUCTION identifier and wrote
// dev-API tokens into the real app's `~/.arcane`.
//
// So `dev` defaults to the dev overlay. `build` is untouched: a release build
// must stay production unless it explicitly asks for `tauri.dev.conf.json`
// (which `tauri:build:dev-app` does).
//
// An explicit `--config` always wins, so overriding this is still possible.
// `auth_check_channel` catches whatever slips past either way.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the local CLI rather than trusting PATH, so this works when invoked
// directly and not only through `bun run` (which adds node_modules/.bin).
const here = dirname(fileURLToPath(import.meta.url));
const local = join(here, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const cli = existsSync(local) ? local : 'tauri';

const argv = process.argv.slice(2);
const subcommand = argv.find((a) => !a.startsWith('-'));
const hasExplicitConfig = argv.some((a) => a === '--config' || a.startsWith('--config='));

const args =
  subcommand === 'dev' && !hasExplicitConfig
    ? [...argv, '--config', 'src-tauri/tauri.dev.conf.json']
    : argv;

const child = spawn(cli, args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('[tauri] failed to launch the Tauri CLI:', err.message);
  process.exit(1);
});
