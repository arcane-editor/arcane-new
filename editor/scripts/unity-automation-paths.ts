import { posix, win32 } from 'node:path';

export function compilerLayout(resources: string, platform: NodeJS.Platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  const scripting = platform === 'win32' ? paths.normalize(resources) : paths.join(resources, 'Scripting');
  return {
    scripting,
    mono: paths.join(scripting, 'MonoBleedingEdge/bin', platform === 'win32' ? 'mono.exe' : 'mono'),
    csc: paths.join(scripting, 'MonoBleedingEdge/lib/mono/4.5/csc.exe'),
  };
}

export function isOptionalInputSource(path: string): boolean {
  return path.replace(/\\/g, '/').includes('/Editor/InputSystem/');
}

/**
 * The Unity version a resolved Resources directory belongs to, read from the
 * Hub's version-named install folder (`…/Hub/Editor/6000.3.5f2/…` on every
 * platform). Null when the path carries no such segment, e.g. a hand-built
 * editor; `UNITYIDE_UNITY_VERSION` then names it explicitly.
 */
export function unityVersionFromResources(resources: string): string | null {
  const versionSegment = /^(\d{4})\.(\d+)\.(\d+)[abfpx]\d+$/;
  for (const segment of resources.split(/[\\/]+/).reverse()) if (versionSegment.test(segment)) return segment;
  return null;
}

/**
 * Minor versions Unity has shipped per major, in release order. Every
 * `UNITY_<major>_<minor>_OR_NEWER` symbol up to the resolved version is defined,
 * exactly as the editor does, so a `#if` on any of them compiles the branch
 * that editor would actually take. Unity 6 is open-ended: minors beyond the
 * latest known one are harmless to define for a newer major.
 */
const UNITY_MINORS: Array<[major: number, minors: number[]]> = [
  [2017, [1, 2, 3, 4]], [2018, [1, 2, 3, 4]], [2019, [1, 2, 3, 4]],
  [2020, [1, 2, 3]], [2021, [1, 2, 3]], [2022, [1, 2, 3]], [2023, [1, 2, 3]],
  [6000, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
];

/** The version symbols Unity defines when compiling for `version` (e.g. `6000.3.5f2`). */
export function unityVersionDefines(version: string): string[] {
  const match = /^(\d{4})\.(\d+)\./.exec(version);
  if (!match) throw new Error(`Unrecognized Unity version "${version}"; expected e.g. 6000.3.5f2.`);
  const major = Number(match[1]), minor = Number(match[2]);
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  const defines = ['UNITY_5_3_OR_NEWER', 'UNITY_5_4_OR_NEWER', 'UNITY_5_5_OR_NEWER', 'UNITY_5_6_OR_NEWER', `UNITY_${major}`, `UNITY_${major}_${minor}`];
  let majorKnown = false;
  for (const [knownMajor, minors] of UNITY_MINORS) {
    if (knownMajor > major) break;
    majorKnown ||= knownMajor === major;
    const last = minors[minors.length - 1];
    const covered = knownMajor < major ? minors : [...minors.filter((m) => m <= minor), ...range(last + 1, minor)];
    for (const m of covered) defines.push(`UNITY_${knownMajor}_${m}_OR_NEWER`);
  }
  if (!majorKnown) for (const m of range(0, minor)) defines.push(`UNITY_${major}_${m}_OR_NEWER`);
  return defines;
}
