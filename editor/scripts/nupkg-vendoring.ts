/**
 * Shared machinery for vendoring a pinned NuGet package into the app bundle.
 *
 * Two packages ship inside the app — the C# language server and the Unity
 * Roslyn analyzers — and they are fetched the same way for the same reasons:
 * pinned so a build is reproducible, hash-verified so a corrupted or
 * substituted download cannot reach a user's machine, and written via a
 * temporary name so an interrupted download can never leave a truncated file
 * that later "verifies" by existing.
 *
 * The drift guard is the subtle one. Each package's version lives in two
 * places by necessity — Rust decides what to look for at runtime, these
 * scripts decide what to fetch at build time — and when they disagree the app
 * looks for something that never shipped. That failure appears only on an end
 * user's offline machine, so it is checked here and in `bun run verify`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export function sha512Hex(bytes: Uint8Array): string {
  return createHash('sha512').update(bytes).digest('hex');
}

/** NuGet's flat container serves the raw package with no auth or session. */
export function flatContainerUrl(packageId: string, version: string): string {
  const id = packageId.toLowerCase();
  return `https://api.nuget.org/v3-flatcontainer/${id}/${version}/${id}.${version}.nupkg`;
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

/** Read a `pub const <NAME>: &str = "…";` version out of a Rust module. */
export function readPinnedRustConst(source: string, name: string): string | null {
  const match = source.match(new RegExp(`pub const ${name}: &str = "([^"]+)"`));
  return match ? match[1] : null;
}

export interface VendorOptions {
  tag: string;
  url: string;
  targetDir: string;
  target: string;
  expectedSha512: string;
  /** With `--require`, a failed fetch is a build failure. */
  required: boolean;
  /** Printed when the package is missing and the build is allowed to continue. */
  degradedWarning: string;
}

/**
 * Download, verify and install one package. Returns true when the package is
 * on disk and verified afterwards.
 */
export async function vendorPackage(opts: VendorOptions): Promise<boolean> {
  const { tag, url, targetDir, target, expectedSha512, required } = opts;

  if (verifyExisting(target, expectedSha512)) {
    console.log(`${tag} ${target.split(/[\\/]/).pop()} already present and verified`);
    return true;
  }

  mkdirSync(targetDir, { recursive: true });

  try {
    console.log(`${tag} downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    const actual = sha512Hex(bytes);
    if (actual !== expectedSha512) {
      throw new Error(`SHA-512 mismatch — expected ${expectedSha512}, got ${actual}`);
    }

    const partial = `${target}.part`;
    writeFileSync(partial, bytes);
    renameSync(partial, target);
    console.log(`${tag} verified ${bytes.byteLength} bytes → ${target}`);
    return true;
  } catch (err) {
    rmSync(`${target}.part`, { force: true });
    const detail = err instanceof Error ? err.message : String(err);
    if (required) {
      console.error(`${tag} could not vendor the package: ${detail}`);
      console.error(`${tag} --require was passed, so this build cannot continue.`);
      process.exit(1);
    }
    console.warn(`${tag} could not vendor the package: ${detail}`);
    console.warn(`${tag} ${opts.degradedWarning}`);
    return false;
  }
}

/**
 * Fail the build when the version this script pins and the version Rust looks
 * for have drifted apart. Applies whether or not the package is required —
 * drift is a bug in both modes.
 */
export function assertNoVersionDrift(
  tag: string,
  rustFile: string,
  constName: string,
  scriptVersion: string,
): void {
  const rustVersion = readPinnedRustConst(readFileSync(rustFile, 'utf8'), constName);
  if (rustVersion !== scriptVersion) {
    console.error(
      `${tag} version drift: ${constName} is ${rustVersion} in Rust, ` +
        `${scriptVersion} in this script.`,
    );
    process.exit(1);
  }
}
