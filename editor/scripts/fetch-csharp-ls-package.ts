#!/usr/bin/env bun
/**
 * Vendor the pinned `csharp-ls` NuGet package (MIT) into the app bundle.
 *
 * **Why the package and not a binary.** csharp-ls is a .NET *global tool*, so
 * the shippable artifact is a nupkg. At first C# start the app runs
 * `dotnet tool install` against this file as the only NuGet source, which
 * makes provisioning offline and version-pinned — see `csharp_ls.rs`.
 *
 * **Why it is not committed.** It is 22 MB of binary that changes only when
 * the pin moves; git is the wrong place for it. It is fetched instead, and
 * verified against a SHA-512 recorded here so a corrupted or substituted
 * download cannot reach a user's machine.
 *
 * **Failure behaviour is deliberately asymmetric.** A developer building
 * offline gets a warning and a working build (the app falls back to
 * installing from nuget.org at runtime). CI passes `--require`, where a
 * missing package is a build failure — shipping an installer that silently
 * lost its offline package is exactly the regression this guards.
 *
 *   bun run scripts/fetch-csharp-ls-package.ts [--require]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Pinned release. Must match `CSHARP_LS_VERSION` in `src-tauri/src/csharp_ls.rs`. */
export const CSHARP_LS_VERSION = '0.22.0';

/**
 * SHA-512 of `csharp-ls.0.22.0.nupkg` as served by nuget.org, hex-encoded.
 * Captured from the published package and cross-checked against a copy
 * installed by `dotnet tool install` — the two are byte-identical.
 */
export const NUPKG_SHA512 =
  '12b303bccc29e6f9de98b6e81ffd3e33b8a61b3adfd3ce1095d5e22d2e8c2b6ecd777edbede7848f707cd0d445363a0ec9b4d97ef37d3b21825cadb25a42acd1';

export function packageFileName(version = CSHARP_LS_VERSION): string {
  return `csharp-ls.${version}.nupkg`;
}

/** NuGet's flat container serves the raw package with no auth or session. */
export function packageUrl(version = CSHARP_LS_VERSION): string {
  return `https://api.nuget.org/v3-flatcontainer/csharp-ls/${version}/${packageFileName(version)}`;
}

export function sha512Hex(bytes: Uint8Array): string {
  return createHash('sha512').update(bytes).digest('hex');
}

/**
 * Read `CSHARP_LS_VERSION` out of the Rust module.
 *
 * The version lives in two places by necessity — Rust builds the install
 * command, this script fetches what that command will look for. If they drift
 * the app installs a version whose package never shipped, and the failure
 * only appears on an end user's offline machine. Cheap to check here.
 */
export function readPinnedRustVersion(source: string): string | null {
  const match = source.match(/pub const CSHARP_LS_VERSION: &str = "([^"]+)"/);
  return match ? match[1] : null;
}

/** True when the file on disk is byte-for-byte the package we expect. */
export function verifyExisting(path: string, expectedSha512: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return sha512Hex(readFileSync(path)) === expectedSha512;
  } catch {
    return false;
  }
}

const TAG = '[fetch-csharp-ls]';

async function main(): Promise<void> {
  const required = process.argv.includes('--require');
  const root = join(import.meta.dir, '..');
  const targetDir = join(root, 'src-tauri', 'resources', 'csharp-ls');
  const target = join(targetDir, packageFileName());

  // Version drift is a bug whether or not this build requires the package,
  // so it fails the same way in both modes.
  const rustSource = readFileSync(join(root, 'src-tauri', 'src', 'csharp_ls.rs'), 'utf8');
  const rustVersion = readPinnedRustVersion(rustSource);
  if (rustVersion !== CSHARP_LS_VERSION) {
    console.error(
      `${TAG} version drift: csharp_ls.rs pins ${rustVersion}, this script pins ${CSHARP_LS_VERSION}.`,
    );
    process.exit(1);
  }

  if (verifyExisting(target, NUPKG_SHA512)) {
    console.log(`${TAG} ${packageFileName()} already present and verified`);
    return;
  }

  mkdirSync(targetDir, { recursive: true });

  try {
    console.log(`${TAG} downloading ${packageUrl()}`);
    const response = await fetch(packageUrl());
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());

    const actual = sha512Hex(bytes);
    if (actual !== NUPKG_SHA512) {
      throw new Error(`SHA-512 mismatch — expected ${NUPKG_SHA512}, got ${actual}`);
    }

    // Write beside the target then rename, so an interrupted download can
    // never leave a truncated package that later "verifies" by existing.
    const partial = `${target}.part`;
    writeFileSync(partial, bytes);
    renameSync(partial, target);
    console.log(`${TAG} verified ${bytes.byteLength} bytes → ${target}`);
  } catch (err) {
    rmSync(`${target}.part`, { force: true });
    const detail = err instanceof Error ? err.message : String(err);
    if (required) {
      console.error(`${TAG} could not vendor the package: ${detail}`);
      console.error(`${TAG} --require was passed, so this build cannot continue.`);
      process.exit(1);
    }
    console.warn(`${TAG} could not vendor the package: ${detail}`);
    console.warn(
      `${TAG} continuing without it — the app will install csharp-ls from nuget.org at runtime.`,
    );
  }
}

if (import.meta.main) {
  await main();
}
