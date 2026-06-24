#!/usr/bin/env bun
/**
 * Compile bundled LSP server sidecars via `@yao-pkg/pkg`.
 *
 * Bun's `--compile` mode was the first choice (same toolchain as the rest of
 * the project) but fails on both targets: typescript-language-server reads
 * its own package.json via `readFileSync(import.meta.url)` which Bun doesn't
 * auto-embed, and pyright uses webpack-style dynamic chunk loading
 * (`require('./vendor.js')`) that Bun's static bundler can't follow.
 *
 * pkg handles both: it snapshots the entire dep tree (so dynamic requires
 * resolve) and lets us declare static assets (package.json, typeshed files)
 * via the `pkg.assets` config in each generated wrapper.
 *
 * Outputs single-file native binaries to `src-tauri/binaries/` using Tauri's
 * naming convention `<name>-<target-triple>[.exe]`. By default we compile
 * only for the host triple; pass `--all-targets` to build the full matrix.
 */

import { existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Sidecar {
  /** Output binary name (without target triple). */
  name: string;
  /** Directory (relative to repo root) of the npm package being snapshotted —
   *  pkg's `assets` / `scripts` globs in the wrapper resolve relative to this. */
  pkgDir: string;
  /** Path (relative to pkgDir) of the JS entrypoint. */
  entry: string;
  /** Asset globs (relative to pkgDir) to embed in the snapshot. */
  assets: string[];
  /** Extra JS files (relative to pkgDir) for dynamic require() targets that
   *  pkg's static analysis can't follow (e.g. pyright's webpack chunks). */
  scripts: string[];
}

const SIDECARS: Sidecar[] = [
  {
    name: 'typescript-language-server',
    pkgDir: 'node_modules/typescript-language-server',
    entry: 'lib/cli.mjs',
    assets: [
      // ts-ls reads its own package.json for the version string via
      // readFileSync(new URL("../package.json", import.meta.url)).
      'package.json',
      // ts-ls dynamically resolves the `typescript` package at runtime (it's
      // a peer dep). Embed the whole tree so require.resolve('typescript')
      // succeeds inside the snapshot.
      '../typescript/**/*',
    ],
    scripts: [],
  },
  // pyright bundling is deferred: pkg + pyright's webpack-style dynamic chunk
  // loading exits silently on --stdio inside the snapshot. The PATH fallback
  // in lsp.rs (still in place) keeps Python LSP working for users with
  // pyright installed globally. See DISTRIBUTION.md for the follow-up plan.
];

interface Target {
  /** pkg's target token (node{version}-{platform}-{arch}) */
  pkg: string;
  /** Tauri's target triple (the suffix on the output filename) */
  tauri: string;
  /** True for Windows targets — appends .exe */
  windows?: boolean;
}

// Match the Node version that pkg ships with by default. node22 is current LTS.
const TARGETS: Target[] = [
  { pkg: 'node22-macos-arm64', tauri: 'aarch64-apple-darwin' },
  { pkg: 'node22-macos-x64', tauri: 'x86_64-apple-darwin' },
  { pkg: 'node22-linux-x64', tauri: 'x86_64-unknown-linux-gnu' },
  { pkg: 'node22-win-x64', tauri: 'x86_64-pc-windows-msvc', windows: true },
];

function hostTauriTriple(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`Unsupported host: ${platform}/${arch}`);
}

const repoRoot = resolve(import.meta.dir, '..');
const outDir = join(repoRoot, 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });

const buildAll = process.argv.includes('--all-targets') || process.env.CI === 'true';
const hostTriple = hostTauriTriple();
const targetsToBuild = buildAll
  ? TARGETS
  : TARGETS.filter((t) => t.tauri === hostTriple);

if (targetsToBuild.length === 0) {
  console.error(`[build-lsp-sidecars] No target matches host triple ${hostTriple}`);
  process.exit(1);
}

let failures = 0;

/**
 * pkg resolves `assets` / `scripts` globs relative to the package.json's
 * directory. To keep globs intuitive we write a `pkg.json` inside each
 * package's own directory and pass it as pkg's config — this avoids pasting
 * absolute paths everywhere and lets `package.json` resolve correctly when
 * the bundled source does `new URL('../package.json', import.meta.url)`.
 *
 * Returns the path to the temporary config file (deleted by the caller).
 */
function writePkgConfig(sidecar: Sidecar): string {
  const pkgDirAbs = join(repoRoot, sidecar.pkgDir);
  const cfg = {
    bin: sidecar.entry,
    pkg: {
      assets: sidecar.assets,
      scripts: [sidecar.entry, ...sidecar.scripts],
    },
  };
  const cfgPath = join(pkgDirAbs, `.pkg-sidecar-config-${Date.now()}.json`);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

for (const sidecar of SIDECARS) {
  const entryAbs = join(repoRoot, sidecar.pkgDir, sidecar.entry);
  if (!existsSync(entryAbs)) {
    console.error(
      `[build-lsp-sidecars] Missing entry ${sidecar.pkgDir}/${sidecar.entry} — run \`bun install\` first.`,
    );
    failures++;
    continue;
  }

  const cfgPath = writePkgConfig(sidecar);

  try {
    for (const target of targetsToBuild) {
      const suffix = target.windows ? '.exe' : '';
      const outName = `${sidecar.name}-${target.tauri}${suffix}`;
      const outPath = join(outDir, outName);

      console.log(`[build-lsp-sidecars] ${sidecar.name} → ${target.tauri}`);
      // --no-bytecode lets pkg ship .mjs/ESM as plain source (V8 bytecode
      //   generation fails for ESM modules).
      // --public-packages='*' silences the dependency-license warnings.
      // --config points pkg at the per-package config file we just wrote.
      // Use spawnSync to avoid Bun's shell glob expansion mangling `*`.
      const pkgArgs = [
        'pkg',
        `--target=${target.pkg}`,
        '--no-bytecode',
        '--public-packages=*',
        '--public',
        `--config=${cfgPath}`,
        `--output=${outPath}`,
        entryAbs,
      ];
      const result = Bun.spawnSync(['bunx', ...pkgArgs], {
        stdout: 'inherit',
        stderr: 'inherit',
      });
      if (!result.success) {
        console.error(`[build-lsp-sidecars]   ✗ ${outName}: pkg exit ${result.exitCode}`);
        failures++;
        continue;
      }
      const size = statSync(outPath).size;
      console.log(
        `[build-lsp-sidecars]   ✓ ${outName} (${(size / 1024 / 1024).toFixed(1)} MB)`,
      );
    }
  } finally {
    try { unlinkSync(cfgPath); } catch { /* ignore */ }
  }
}

if (failures > 0) {
  console.error(`[build-lsp-sidecars] ${failures} build(s) failed.`);
  process.exit(1);
}

console.log('[build-lsp-sidecars] All sidecars built.');
