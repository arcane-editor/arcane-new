#!/usr/bin/env bun
/**
 * Vendor the pinned `Microsoft.Unity.Analyzers` package (MIT) into the app
 * bundle.
 *
 * **What it buys.** 43 Unity-specific Roslyn analyzers and 23 suppressors —
 * the same engine Visual Studio's Unity workload ships. They are what turns
 * "the C# compiles" into "this is wrong for Unity": an empty `Update()`, a
 * `tag == "Player"` comparison, a message whose signature does not match, a
 * `GetComponent` whose type argument is not a Component. The suppressors
 * matter as much in the other direction — they stop Roslyn reporting a
 * `[SerializeField]` field as unused, which is otherwise a warning on almost
 * every MonoBehaviour anyone writes.
 *
 * **Why a NuGet package and not a compiler flag.** csharp-ls runs the
 * analyzers a project references (`Roslyn/Analyzers.fs`, since 0.24), so the
 * unit of delivery is an analyzer assembly named by an `<Analyzer Include>`
 * item in the generated `.unityide.csproj`. Shipping it means Unity
 * inspections work offline, at a pinned version, on a machine that has never
 * installed anything but this app.
 *
 *   bun run scripts/fetch-unity-analyzers-package.ts [--require]
 */

import { join } from 'node:path';
import {
  assertNoVersionDrift,
  flatContainerUrl,
  readPinnedRustConst,
  sha512Hex,
  vendorPackage,
  verifyExisting,
} from './nupkg-vendoring';

/** Pinned release. Must match `UNITY_ANALYZERS_VERSION` in `unity_analyzers.rs`. */
export const UNITY_ANALYZERS_VERSION = '1.27.0';

/** The NuGet package id. */
export const PACKAGE_ID = 'Microsoft.Unity.Analyzers';

/** SHA-512 of the pinned package as served by nuget.org, hex-encoded. */
export const NUPKG_SHA512 =
  '2234a4e2693ca719a4ab3326ea5d2a1a7f8bbcd7efe144233b64dcdadeb4b45994ea216d6729ff14f1be29ea14ab75312eb8073a56b0a4d1d8dee7086b5f236a';

export function packageFileName(version = UNITY_ANALYZERS_VERSION): string {
  return `${PACKAGE_ID.toLowerCase()}.${version}.nupkg`;
}

export function packageUrl(version = UNITY_ANALYZERS_VERSION): string {
  return flatContainerUrl(PACKAGE_ID, version);
}

/** Re-exported so the sibling test can exercise them through this module. */
export { sha512Hex, verifyExisting };

export function readPinnedRustVersion(source: string): string | null {
  return readPinnedRustConst(source, 'UNITY_ANALYZERS_VERSION');
}

const TAG = '[fetch-unity-analyzers]';

async function main(): Promise<void> {
  const required = process.argv.includes('--require');
  const root = join(import.meta.dir, '..');
  const targetDir = join(root, 'src-tauri', 'resources', 'unity-analyzers');

  assertNoVersionDrift(
    TAG,
    join(root, 'src-tauri', 'src', 'unity_analyzers.rs'),
    'UNITY_ANALYZERS_VERSION',
    UNITY_ANALYZERS_VERSION,
  );

  await vendorPackage({
    tag: TAG,
    url: packageUrl(),
    targetDir,
    target: join(targetDir, packageFileName()),
    expectedSha512: NUPKG_SHA512,
    required,
    // Unlike the language server, a missing analyzer package is a degradation
    // rather than a broken editor: C# still compiles, completes and hovers,
    // it just stops pointing out Unity mistakes. The csproj omits the
    // `<Analyzer>` item when the assembly is absent.
    degradedWarning:
      'continuing without it — the app this build produces will have no Unity inspections.',
  });
}

if (import.meta.main) {
  await main();
}
