/**
 * Pure helpers for `verify-csharp-intellisense.ts` — discovery and parsing,
 * separated from the process driving so they can be unit-tested.
 *
 * Why any of this exists: the probe it serves is the only check that catches
 * an ENVIRONMENTAL break in C# IntelliSense, and for its whole life it could
 * not run on Windows. Its project list, its csharp-ls lookup and its
 * `DOTNET_ROOT` default were all macOS paths (`/Users/inno/…`,
 * `/usr/local/share/dotnet`), so on the platform most Unity developers use it
 * printed SKIPPED and exited 0 — which is indistinguishable from a pass unless
 * you read the output. It was skipping on the very machine whose IntelliSense
 * was completely dead.
 *
 * So discovery is the feature here. A check that needs three environment
 * variables before it will run is a check that does not run.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Unity project discovery ─────────────────────────────────────

/**
 * Recent projects from the Windows registry.
 *
 * Unity Hub 3 keeps its project list in an internal database, but the Editor
 * itself still writes `RecentlyUsedProjectPaths-<n>_h<hash>` under
 * `HKCU\Software\Unity Technologies\Unity Editor 5.x` as a NUL-terminated
 * UTF-8 path in REG_BINARY. `<n>` is the recency rank.
 *
 * Input is the raw `reg query` output:
 *
 *     RecentlyUsedProjectPaths-0_h1085040554    REG_BINARY    433A2F55736572...00
 */
export function parseRegistryRecentProjects(regOutput: string): string[] {
  const found: Array<{ rank: number; path: string }> = [];
  const line = /RecentlyUsedProjectPaths-(\d+)(?:_h\d+)?\s+REG_BINARY\s+([0-9A-Fa-f]+)/g;
  let m: RegExpExecArray | null;
  while ((m = line.exec(regOutput)) !== null) {
    const decoded = Buffer.from(m[2], 'hex').toString('utf8').replace(/\0+$/, '');
    if (decoded) found.push({ rank: Number(m[1]), path: decoded.replace(/\\/g, '/') });
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.path);
}

/**
 * Recent projects from macOS's Unity Editor preferences, as exported by
 * `defaults export com.unity3d.UnityEditor5.x -` (an XML plist). Same key
 * names as the registry; the value is base64 rather than hex.
 */
export function parsePlistRecentProjects(plistXml: string): string[] {
  const found: Array<{ rank: number; path: string }> = [];
  const entry =
    /<key>RecentlyUsedProjectPaths-(\d+)(?:_h\d+)?<\/key>\s*<data>([\s\S]*?)<\/data>/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(plistXml)) !== null) {
    const decoded = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
      .toString('utf8')
      .replace(/\0+$/, '');
    if (decoded) found.push({ rank: Number(m[1]), path: decoded });
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.path);
}

/**
 * Projects from Unity Hub's `projects-v1.json`, newest first.
 *
 * Hub 3 leaves this file behind as `{"schema_version":"v1","data":{}}` on some
 * machines, which is why it is one source among several rather than the only
 * one.
 */
export function parseHubProjects(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const data = (parsed as { data?: Record<string, { path?: string; lastModified?: number }> })
    ?.data;
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data)
    .map(([key, value]) => ({
      path: (value?.path ?? key).replace(/\\/g, '/'),
      lastModified: value?.lastModified ?? 0,
    }))
    .sort((a, b) => b.lastModified - a.lastModified)
    .map((p) => p.path);
}

/** Does this directory look like a Unity project we can probe? */
export function looksLikeUnityProject(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'Assets')) &&
    fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))
  );
}

export interface DiscoveryEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  /** Injected so the discovery order is testable without a registry. */
  readRegistry?: () => string;
  readPlist?: () => string;
  readFileIfExists?: (p: string) => string | null;
  exists?: (p: string) => boolean;
}

function defaultReadRegistry(): string {
  try {
    return execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Unity Technologies\\Unity Editor 5.x'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return '';
  }
}

function defaultReadPlist(): string {
  try {
    return execFileSync('defaults', ['export', 'com.unity3d.UnityEditor5.x', '-'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * Every Unity project worth probing, best first.
 *
 * The explicit environment variable wins, then whatever the user actually
 * opened most recently, then the historical developer-machine fallbacks. Those
 * last three are real directories on someone's disk, not brand strings — a
 * rename sweep once rewrote one of them and the check silently stopped finding
 * anything.
 */
export function discoverUnityProjects(cfg: DiscoveryEnv): string[] {
  const exists = cfg.exists ?? looksLikeUnityProject;
  const readFile = cfg.readFileIfExists ?? ((p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null));

  const candidates: string[] = [];
  const push = (p: string | undefined | null) => {
    if (!p) return;
    const normalised = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalised && !candidates.includes(normalised)) candidates.push(normalised);
  };

  push(cfg.env.UNITYIDE_SMOKE_UNITY_PROJECT);

  if (cfg.platform === 'win32') {
    for (const p of parseRegistryRecentProjects((cfg.readRegistry ?? defaultReadRegistry)())) {
      push(p);
    }
  } else if (cfg.platform === 'darwin') {
    for (const p of parsePlistRecentProjects((cfg.readPlist ?? defaultReadPlist)())) push(p);
  }

  const hubPath =
    cfg.platform === 'win32'
      ? path.join(cfg.env.APPDATA ?? '', 'UnityHub', 'projects-v1.json')
      : cfg.platform === 'darwin'
        ? path.join(cfg.home, 'Library', 'Application Support', 'UnityHub', 'projects-v1.json')
        : path.join(cfg.home, '.config', 'UnityHub', 'projects-v1.json');
  const hubJson = readFile(hubPath);
  if (hubJson) for (const p of parseHubProjects(hubJson)) push(p);

  push('/Users/inno/UnityIDE Demo');
  push('/Users/inno/Arcane Demo');
  push('/Users/inno/My project');

  return candidates.filter(exists);
}

// ── csharp-ls discovery ─────────────────────────────────────────

/**
 * The directory `dirs::data_dir()` resolves to in Rust, which is where
 * `csharp_ls.rs` unpacks the managed server. Kept in step with that crate by
 * `discovers_the_managed_server_where_rust_puts_it` in the sibling test.
 */
export function dataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') return env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
}

export interface CsharpLsCommand {
  program: string;
  leadingArgs: string[];
  /** For display: how a human would type this. */
  describe: string;
  source: 'env-dll' | 'env-path' | 'managed' | 'user-tool' | 'path';
}

export interface CsharpLsLookup extends DiscoveryEnv {
  /** The version pinned in `src-tauri/src/csharp_ls.rs`. */
  pinnedVersion: string;
}

/**
 * How to start csharp-ls, in the same precedence order `resolve_existing` uses
 * in `csharp_ls.rs` — except that the MANAGED copy is preferred here.
 *
 * The app prefers a user's own global tool so it never overrides a working
 * setup. This probe wants the opposite: it exists to verify the server this
 * build ships, at the version this build pins. A developer with an older
 * global tool would otherwise get a green check for a server their users never
 * run.
 */
export function discoverCsharpLs(cfg: CsharpLsLookup): CsharpLsCommand | null {
  const exists = cfg.exists ?? ((p: string) => fs.existsSync(p));

  const dll = cfg.env.UNITYIDE_CSHARP_LS_DLL;
  if (dll && exists(dll)) {
    return { program: 'dotnet', leadingArgs: [dll], describe: `dotnet ${dll}`, source: 'env-dll' };
  }

  const override = cfg.env.UNITYIDE_CSHARP_LS_PATH;
  if (override && exists(override)) {
    return { program: override, leadingArgs: [], describe: override, source: 'env-path' };
  }

  const managed = path.join(
    dataDir(cfg.platform, cfg.env, cfg.home),
    'editor',
    'lsp',
    'csharp-ls',
    cfg.pinnedVersion,
    'CSharpLanguageServer.dll',
  );
  if (exists(managed)) {
    return {
      program: 'dotnet',
      leadingArgs: [managed],
      describe: `dotnet ${managed}`,
      source: 'managed',
    };
  }

  const exe = cfg.platform === 'win32' ? 'csharp-ls.exe' : 'csharp-ls';
  const userTool = path.join(cfg.home, '.dotnet', 'tools', exe);
  if (exists(userTool)) {
    return { program: userTool, leadingArgs: [], describe: userTool, source: 'user-tool' };
  }

  const onPath = '/usr/local/bin/csharp-ls';
  if (cfg.platform !== 'win32' && exists(onPath)) {
    return { program: onPath, leadingArgs: [], describe: onPath, source: 'path' };
  }

  return null;
}

/**
 * Where the .NET host lives. csharp-ls loads projects through MSBuildLocator,
 * which needs this to find the SDK.
 */
export function resolveDotnetRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  which: (cmd: string) => string | null,
): string | undefined {
  if (env.DOTNET_ROOT) return env.DOTNET_ROOT;
  const found = which(platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  if (found) return path.dirname(found);
  if (platform === 'win32') return 'C:/Program Files/dotnet';
  if (platform === 'darwin') return '/usr/local/share/dotnet';
  return undefined;
}

/**
 * The csharp-ls version this build pins, read from the Rust module that owns
 * it. Reading rather than duplicating means the probe follows the pin through
 * an upgrade instead of quietly checking the previous server.
 */
export function readPinnedCsharpLsVersion(rustSource: string): string | null {
  const match = rustSource.match(/pub const CSHARP_LS_VERSION: &str = "([^"]+)"/);
  return match ? match[1] : null;
}

/** `a` vs `b` as dotted numeric versions: -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ── Probe source construction ───────────────────────────────────

/**
 * A position inside probe text, located by searching for an anchor rather than
 * hardcoded.
 *
 * A literal `character: 40` once stopped pointing at `MonoBehaviour` when the
 * class name changed length, and the check then reported "hover resolved
 * nothing" — a broken-IntelliSense failure for a cursor bug of its own making.
 */
export function locate(
  source: string,
  anchor: string,
  offsetInAnchor = anchor.length,
): { line: number; character: number } {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(anchor);
    if (col >= 0) return { line: i, character: col + offsetInAnchor };
  }
  throw new Error(`probe text no longer contains ${JSON.stringify(anchor)}`);
}
