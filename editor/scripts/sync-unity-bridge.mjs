// scripts/sync-unity-bridge.mjs
//
// Syncs the canonical Unity extension package — the single source of truth — from
// `arcane-extension/` at the repo root (package `com.unityide.editor`) into a local,
// gitignored `unity-bridge/` staging folder. Tauri bundles that folder as an app
// resource (see tauri.conf.json `resources`), and the Rust backend
// (`unity_install_bridge`) copies it into a user's `Packages/com.unityide.editor/`.
//
// Runs automatically before `tauri dev` / `tauri build` (wired via tauri.conf.json
// `beforeDevCommand` / `beforeBuildCommand`). Override the source location with the
// UNITYIDE_EXTENSION_DIR env var.

import { existsSync, rmSync, cpSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..'); // editor/
const dest = resolve(repoRoot, 'unity-bridge'); // editor/unity-bridge (gitignored staging)

// Source resolution. UNITYIDE_EXTENSION_DIR overrides everything; otherwise the
// in-tree package at the repo root, which is where it actually lives.
//
// The pre-monorepo sibling-checkout layout is kept as a fallback but is tried
// SECOND. It used to be first, which meant a stray `../arcane/arcane-extension`
// on someone's disk would silently shadow the in-tree source and bundle a
// different package than the one in this commit.
const srcCandidates = process.env.UNITYIDE_EXTENSION_DIR
  ? [resolve(process.env.UNITYIDE_EXTENSION_DIR)]
  : [
      resolve(repoRoot, '../arcane-extension'),        // monorepo (extension at repo root)
      resolve(repoRoot, '../arcane/arcane-extension'), // legacy sibling checkout
    ];
const src =
  srcCandidates.find((p) => existsSync(resolve(p, 'package.json'))) ??
  srcCandidates[srcCandidates.length - 1];

// Dev/release tooling that is NOT part of the shippable Unity package.
const DENY_NAMES = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '.wrangler',
  'Documentation~',
  'Tests',
  'deploy-prod.sh',
  'install-dev.sh',
]);
const DENY_SUFFIXES = ['.tgz'];

function keep(sourcePath) {
  const name = basename(sourcePath);
  // A denied asset's Unity .meta sidecar has to go with it. Matching only the
  // literal basename ships an orphaned `Tests.meta` next to no `Tests/`, and
  // Unity greets the user with a "meta file with no asset" warning on import.
  const asset = name.endsWith('.meta') ? name.slice(0, -'.meta'.length) : name;
  if (DENY_NAMES.has(name) || DENY_NAMES.has(asset)) return false;
  if (DENY_SUFFIXES.some((suffix) => asset.endsWith(suffix))) return false;
  return true;
}

if (!existsSync(src) || !statSync(src).isDirectory()) {
  console.error(
    `[sync-unity-bridge] Unity extension source not found at:\n  ${src}\n` +
      `Expected arcane-extension/ at the repo root, or set UNITYIDE_EXTENSION_DIR.`,
  );
  process.exit(1);
}
if (!existsSync(resolve(src, 'package.json'))) {
  console.error(`[sync-unity-bridge] ${src} has no package.json — not a Unity package.`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: keep });

console.log(`[sync-unity-bridge] synced ${src} -> ${dest}`);
