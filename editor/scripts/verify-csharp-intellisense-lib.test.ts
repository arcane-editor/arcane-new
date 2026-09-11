import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareVersions,
  dataDir,
  discoverCsharpLs,
  discoverUnityProjects,
  locate,
  parseHubProjects,
  parsePlistRecentProjects,
  parseRegistryRecentProjects,
  readPinnedCsharpLsVersion,
  resolveDotnetRoot,
} from './verify-csharp-intellisense-lib';

// What these protect: the end-to-end IntelliSense probe could not run on
// Windows for its entire life, because every path it knew was a macOS one. It
// printed SKIPPED and exited 0 on the machine whose IntelliSense was dead. The
// discovery below is what makes it run without being told where anything is,
// so it is worth testing at the same level as the thing it checks.

const EDITOR_DIR = path.resolve(import.meta.dir, '..');

describe('parseRegistryRecentProjects', () => {
  // Verbatim `reg query` output, hex included.
  const REG = [
    '',
    'HKEY_CURRENT_USER\\Software\\Unity Technologies\\Unity Editor 5.x',
    '    RecentlyUsedProjectPaths-1_h2222222222    REG_BINARY    443A2F776F726B2F5365636F6E6400',
    '    RecentlyUsedProjectPaths-0_h1085040554    REG_BINARY    433A2F55736572732F73643132302F46697273742050726F6A65637420706D2057696E646F777300',
    '    kHarmonyRecent_h1111    REG_DWORD    0x1',
    '',
  ].join('\r\n');

  it('decodes the NUL-terminated UTF-8 path out of REG_BINARY', () => {
    expect(parseRegistryRecentProjects(REG)[0]).toBe(
      'C:/Users/sd120/First Project pm Windows',
    );
  });

  it('orders by recency rank, not by the order reg happened to print', () => {
    expect(parseRegistryRecentProjects(REG)).toEqual([
      'C:/Users/sd120/First Project pm Windows',
      'D:/work/Second',
    ]);
  });

  it('ignores unrelated values and survives empty output', () => {
    expect(parseRegistryRecentProjects('')).toEqual([]);
    expect(parseRegistryRecentProjects('    Other_h1    REG_SZ    hello')).toEqual([]);
  });
});

describe('parsePlistRecentProjects', () => {
  const PLIST = `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>RecentlyUsedProjectPaths-1</key>
  <data>
  L1VzZXJzL21lL1NlY29uZA==
  </data>
  <key>RecentlyUsedProjectPaths-0</key>
  <data>L1VzZXJzL21lL0ZpcnN0</data>
</dict></plist>`;

  it('decodes base64 paths in recency order', () => {
    expect(parsePlistRecentProjects(PLIST)).toEqual(['/Users/me/First', '/Users/me/Second']);
  });

  it('returns nothing for a plist without the key', () => {
    expect(parsePlistRecentProjects('<plist><dict></dict></plist>')).toEqual([]);
  });
});

describe('parseHubProjects', () => {
  it('sorts by lastModified, newest first', () => {
    const json = JSON.stringify({
      schema_version: 'v1',
      data: {
        'C:\\a\\Old': { path: 'C:\\a\\Old', lastModified: 1 },
        'C:\\a\\New': { path: 'C:\\a\\New', lastModified: 99 },
      },
    });
    expect(parseHubProjects(json)).toEqual(['C:/a/New', 'C:/a/Old']);
  });

  it('tolerates the empty file Hub 3 leaves behind, and malformed JSON', () => {
    // This is literally what is on the machine this was written on.
    expect(parseHubProjects('{"schema_version":"v1","data":{}}')).toEqual([]);
    expect(parseHubProjects('not json')).toEqual([]);
    expect(parseHubProjects('{}')).toEqual([]);
  });
});

describe('discoverUnityProjects', () => {
  const base = {
    home: '/home/me',
    readFileIfExists: () => null,
    readRegistry: () => '',
    readPlist: () => '',
  };

  it('puts the explicit env override first', () => {
    const found = discoverUnityProjects({
      ...base,
      env: { UNITYIDE_SMOKE_UNITY_PROJECT: 'C:/explicit' },
      platform: 'win32',
      readRegistry: () =>
        '    RecentlyUsedProjectPaths-0_h1    REG_BINARY    433A2F726563656E7400',
      exists: () => true,
    });
    expect(found[0]).toBe('C:/explicit');
    expect(found).toContain('C:/recent');
  });

  it('finds the most recent project with no configuration at all', () => {
    const found = discoverUnityProjects({
      ...base,
      env: {},
      platform: 'win32',
      readRegistry: () =>
        '    RecentlyUsedProjectPaths-0_h1    REG_BINARY    433A2F726563656E7400',
      exists: () => true,
    });
    expect(found[0]).toBe('C:/recent');
  });

  it('drops candidates that are not Unity projects', () => {
    const found = discoverUnityProjects({
      ...base,
      env: { UNITYIDE_SMOKE_UNITY_PROJECT: 'C:/not-unity' },
      platform: 'win32',
      exists: (p) => p === 'C:/real',
      readRegistry: () =>
        '    RecentlyUsedProjectPaths-0_h1    REG_BINARY    433A2F7265616C00',
    });
    expect(found).toEqual(['C:/real']);
  });

  it('never returns the same project twice', () => {
    const found = discoverUnityProjects({
      ...base,
      env: { UNITYIDE_SMOKE_UNITY_PROJECT: 'C:/dup' },
      platform: 'win32',
      exists: () => true,
      readRegistry: () => '    RecentlyUsedProjectPaths-0_h1    REG_BINARY    433A2F64757000',
    });
    expect(found.filter((p) => p === 'C:/dup')).toHaveLength(1);
  });

  it('still knows the historical macOS fallbacks', () => {
    const found = discoverUnityProjects({
      ...base,
      env: {},
      platform: 'darwin',
      exists: (p) => p === '/Users/inno/UnityIDE Demo',
    });
    expect(found).toEqual(['/Users/inno/UnityIDE Demo']);
  });
});

describe('discoverCsharpLs', () => {
  const base = { home: '/home/me', pinnedVersion: '0.22.0' };

  it('discovers the managed server where the Rust side unpacks it', () => {
    // Must stay in step with `dirs::data_dir()` + the layout in csharp_ls.rs.
    const managed =
      'C:/Users/me/AppData/Roaming/editor/lsp/csharp-ls/0.22.0/CSharpLanguageServer.dll';
    const found = discoverCsharpLs({
      ...base,
      env: { APPDATA: 'C:/Users/me/AppData/Roaming' },
      platform: 'win32',
      exists: (p) => p.replace(/\\/g, '/') === managed,
    });
    expect(found?.source).toBe('managed');
    expect(found?.program).toBe('dotnet');
    expect(found?.leadingArgs[0]?.replace(/\\/g, '/')).toBe(managed);
  });

  it('follows the pinned version rather than a hardcoded one', () => {
    const found = discoverCsharpLs({
      ...base,
      pinnedVersion: '0.27.0',
      env: { APPDATA: 'C:/AppData' },
      platform: 'win32',
      exists: (p) => p.includes('0.27.0'),
    });
    expect(found?.leadingArgs[0]).toContain('0.27.0');
  });

  it('prefers an explicit dll override over everything', () => {
    const found = discoverCsharpLs({
      ...base,
      env: { UNITYIDE_CSHARP_LS_DLL: '/tmp/custom.dll', APPDATA: 'C:/AppData' },
      platform: 'win32',
      exists: () => true,
    });
    expect(found?.source).toBe('env-dll');
    expect(found?.leadingArgs).toEqual(['/tmp/custom.dll']);
  });

  it('prefers the managed copy over a user global tool', () => {
    // The app prefers the user's tool so it never overrides a working setup.
    // The probe wants the opposite: it verifies the server this build SHIPS,
    // at the version it pins. A stale global tool must not produce a green
    // check for a server no user runs.
    const found = discoverCsharpLs({
      ...base,
      env: { APPDATA: 'C:/AppData' },
      platform: 'win32',
      exists: () => true,
    });
    expect(found?.source).toBe('managed');
  });

  it('falls back to a user global tool, then to /usr/local/bin', () => {
    const tool = discoverCsharpLs({
      ...base,
      env: {},
      platform: 'darwin',
      exists: (p) => p.replace(/\\/g, '/') === '/home/me/.dotnet/tools/csharp-ls',
    });
    expect(tool?.source).toBe('user-tool');

    const onPath = discoverCsharpLs({
      ...base,
      env: {},
      platform: 'darwin',
      exists: (p) => p === '/usr/local/bin/csharp-ls',
    });
    expect(onPath?.source).toBe('path');
  });

  it('returns null when there is nothing to run', () => {
    expect(
      discoverCsharpLs({ ...base, env: {}, platform: 'win32', exists: () => false }),
    ).toBeNull();
  });
});

describe('dataDir', () => {
  it('matches what dirs::data_dir() resolves to on each platform', () => {
    expect(dataDir('win32', { APPDATA: 'C:/AppData/Roaming' }, 'C:/Users/me')).toBe(
      'C:/AppData/Roaming',
    );
    expect(dataDir('darwin', {}, '/Users/me').replace(/\\/g, '/')).toBe(
      '/Users/me/Library/Application Support',
    );
    expect(dataDir('linux', {}, '/home/me').replace(/\\/g, '/')).toBe(
      '/home/me/.local/share',
    );
    expect(dataDir('linux', { XDG_DATA_HOME: '/custom' }, '/home/me')).toBe('/custom');
  });
});

describe('resolveDotnetRoot', () => {
  it('prefers an explicit DOTNET_ROOT', () => {
    expect(resolveDotnetRoot('win32', { DOTNET_ROOT: '/explicit' }, () => null)).toBe(
      '/explicit',
    );
  });

  it('derives the root from dotnet on PATH', () => {
    expect(
      resolveDotnetRoot('win32', {}, () => 'C:/Program Files/dotnet/dotnet.exe')?.replace(
        /\\/g,
        '/',
      ),
    ).toBe('C:/Program Files/dotnet');
  });

  it('falls back per platform when dotnet is not on PATH', () => {
    expect(resolveDotnetRoot('win32', {}, () => null)).toBe('C:/Program Files/dotnet');
    expect(resolveDotnetRoot('darwin', {}, () => null)).toBe('/usr/local/share/dotnet');
  });
});

describe('readPinnedCsharpLsVersion', () => {
  it('reads the version the Rust module actually pins', () => {
    // Not a fixture: if this drifts, the probe checks a server users do not run.
    const rust = fs.readFileSync(
      path.join(EDITOR_DIR, 'src-tauri', 'src', 'csharp_ls.rs'),
      'utf8',
    );
    const version = readPinnedCsharpLsVersion(rust);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('returns null rather than a wrong answer when the constant moves', () => {
    expect(readPinnedCsharpLsVersion('const OTHER: &str = "1.0.0";')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('0.27.0', '0.22.0')).toBe(1);
    // Lexically "0.9.0" > "0.27.0"; numerically it is not.
    expect(compareVersions('0.9.0', '0.27.0')).toBe(-1);
    expect(compareVersions('0.24.0', '0.24.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('locate', () => {
  const SRC = ['using UnityEngine;', '', 'public class P : MonoBehaviour', '{', '}'].join('\n');

  it('finds a position by anchor rather than by a hardcoded column', () => {
    expect(locate(SRC, 'MonoBehaviour', 1)).toEqual({ line: 2, character: 18 });
  });

  it('defaults to the end of the anchor, which is where you type', () => {
    expect(locate('        transform.', 'transform.')).toEqual({ line: 0, character: 18 });
  });

  it('throws loudly when the probe text stops containing the anchor', () => {
    // Silence here would look like a broken server rather than a stale probe.
    expect(() => locate(SRC, 'NotThere')).toThrow(/no longer contains/);
  });
});

it('dotnet discovery follows a symlinked launcher to the SDK root', () => {
  expect(resolveDotnetRoot('darwin', {}, () => '/opt/homebrew/bin/dotnet', () => '/usr/local/share/dotnet/dotnet')).toBe('/usr/local/share/dotnet');
});
