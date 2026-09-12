import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyChannel, remapGuid, CHANNELS } from '../../scripts/unity-extension-channel.mjs';

// The dev-channel package is generated, not written, so these are the only
// checks that stand between "the transform ran" and "the transform produced a
// package that works". Nothing in the C# suite can see them: by the time that
// code compiles, the transform has already happened or already failed.

let dir: string;

const CHANNEL_CS = `namespace UnityIDE.Editor
{
    internal static class UnityIDEChannel
    {
        public const string DisplayName = "UnityIDE";
        public const string Scheme = "unityide";
        public const string ConfigDirName = ".unityide";
        public const string LinuxBinaryName = "unityide";
        public const string PackageName = "com.unityide.editor";
        public const string DownloadUrl = "https://unityide.app/download";
        public const string LegacyAppName = "Arcane";
        public const bool IsDev = false;
    }
}
`;

function meta(guid: string) {
  return `fileFormatVersion: 2\nguid: ${guid}\nMonoImporter:\n  externalObjects: {}\n`;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'unityide-channel-'));
  mkdirSync(path.join(dir, 'Editor'), { recursive: true });
  mkdirSync(path.join(dir, 'Tests', 'Editor'), { recursive: true });

  writeFileSync(path.join(dir, 'Editor', 'UnityIDEChannel.cs'), CHANNEL_CS);
  writeFileSync(path.join(dir, 'Editor', 'UnityIDEChannel.cs.meta'), meta('a'.repeat(32)));
  writeFileSync(
    path.join(dir, 'Editor', 'AssemblyInfo.cs'),
    '[assembly: InternalsVisibleTo("UnityIDE.Editor.Tests")]\n',
  );
  writeFileSync(path.join(dir, 'Editor', 'AssemblyInfo.cs.meta'), meta('b'.repeat(32)));
  writeFileSync(
    path.join(dir, 'Editor', 'UnityIDE.Editor.asmdef'),
    JSON.stringify({ name: 'UnityIDE.Editor', references: ['UnityEditor.TestRunner'] }, null, 4),
  );
  writeFileSync(
    path.join(dir, 'Tests', 'Editor', 'UnityIDE.Editor.Tests.asmdef'),
    JSON.stringify(
      { name: 'UnityIDE.Editor.Tests', references: ['UnityIDE.Editor', 'UnityEngine.TestRunner'] },
      null,
      4,
    ),
  );
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'com.unityide.editor', displayName: 'UnityIDE Integration', version: '0.1.0' }, null, 4),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (...p: string[]) => readFileSync(path.join(dir, ...p), 'utf8');
const json = (...p: string[]) => JSON.parse(read(...p));

describe('applyChannel — release', () => {
  /** The checked-in source already IS the release package. */
  it('changes nothing', () => {
    const before = read('Editor', 'UnityIDEChannel.cs');
    const result = applyChannel(dir, 'release');
    expect(result.guids).toBe(0);
    expect(read('Editor', 'UnityIDEChannel.cs')).toBe(before);
    expect(json('package.json').name).toBe('com.unityide.editor');
  });
});

describe('applyChannel — dev', () => {
  beforeEach(() => applyChannel(dir, 'dev'));

  it('rewrites every channel constant', () => {
    const cs = read('Editor', 'UnityIDEChannel.cs');
    expect(cs).toContain('DisplayName = "UnityIDE Dev"');
    expect(cs).toContain('Scheme = "unityide-dev"');
    expect(cs).toContain('ConfigDirName = ".unityide-dev"');
    expect(cs).toContain('LinuxBinaryName = "unityide-dev"');
    expect(cs).toContain('PackageName = "com.unityide.editor.dev"');
    expect(cs).toContain('IsDev = true');
  });

  /** There was never a dev build under the pre-rename name. Empty, not "Arcane". */
  it('clears the legacy app name', () => {
    expect(read('Editor', 'UnityIDEChannel.cs')).toContain('LegacyAppName = ""');
  });

  it('gives the package its own UPM id, so Unity sees two packages not two versions', () => {
    expect(json('package.json').name).toBe('com.unityide.editor.dev');
    expect(json('package.json').displayName).toBe('UnityIDE Dev Integration');
    expect(json('package.json').version).toBe('0.1.0');
  });

  /** Unity refuses to compile two assemblies with the same name in one project. */
  it('suffixes the assembly names', () => {
    expect(json('Editor', 'UnityIDE.Editor.asmdef').name).toBe('UnityIDE.Editor.Dev');
    expect(json('Tests', 'Editor', 'UnityIDE.Editor.Tests.asmdef').name).toBe(
      'UnityIDE.Editor.Tests.Dev',
    );
  });

  it('follows the rename through asmdef references, leaving Unity’s own alone', () => {
    const refs = json('Tests', 'Editor', 'UnityIDE.Editor.Tests.asmdef').references;
    expect(refs).toEqual(['UnityIDE.Editor.Dev', 'UnityEngine.TestRunner']);
  });

  /**
   * Missing this does not fail the build that produces the package. It fails
   * later, inside Unity, when the dev test assembly cannot see the internal
   * types it exists to test.
   */
  it('follows the rename through InternalsVisibleTo', () => {
    expect(read('Editor', 'AssemblyInfo.cs')).toContain(
      'InternalsVisibleTo("UnityIDE.Editor.Tests.Dev")',
    );
  });

  /**
   * The one that looks optional and is not: two packages declaring the same
   * asset GUIDs in one project is a GUID conflict, and Unity resolves it by
   * picking a winner arbitrarily.
   */
  it('remaps every asset GUID away from the release ones', () => {
    const a = read('Editor', 'UnityIDEChannel.cs.meta');
    const b = read('Editor', 'AssemblyInfo.cs.meta');
    expect(a).not.toContain('a'.repeat(32));
    expect(b).not.toContain('b'.repeat(32));
    expect(a).toMatch(/^guid: [0-9a-f]{32}$/m);
    expect(b).toMatch(/^guid: [0-9a-f]{32}$/m);
    // Distinct assets must stay distinct.
    expect(a).not.toBe(b);
  });
});

describe('remapGuid', () => {
  /** A build has to produce the same GUIDs as the last one, or every upgrade
   *  breaks the asmdef references that point at them. */
  it('is deterministic', () => {
    expect(remapGuid('a'.repeat(32), 'dev')).toBe(remapGuid('a'.repeat(32), 'dev'));
  });

  it('produces a Unity-shaped guid', () => {
    expect(remapGuid('a'.repeat(32), 'dev')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('separates channels and distinct assets', () => {
    expect(remapGuid('a'.repeat(32), 'dev')).not.toBe(remapGuid('a'.repeat(32), 'release'));
    expect(remapGuid('a'.repeat(32), 'dev')).not.toBe(remapGuid('b'.repeat(32), 'dev'));
  });
});

describe('applyChannel — refusals', () => {
  it('refuses an unknown channel', () => {
    expect(() => applyChannel(dir, 'staging')).toThrow(/unknown channel/);
  });

  /** Pointed at the wrong directory, it must say so rather than quietly
   *  rewriting nothing and reporting success. */
  it('refuses a directory that is not the extension package', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'not-the-package-'));
    writeFileSync(path.join(empty, 'package.json'), '{"name":"x"}');
    try {
      expect(() => applyChannel(empty, 'dev')).toThrow(/UnityIDEChannel\.cs/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('CHANNELS', () => {
  /** These mirror editor/src-tauri/tauri.dev.conf.json and auth::config_dir_name.
   *  A drift here sends the dev package at the release application. */
  it('keeps the dev channel distinct from release on every axis', () => {
    for (const key of Object.keys(CHANNELS.release)) {
      if (key === 'isDev') continue;
      expect(CHANNELS.dev[key]).not.toBe(CHANNELS.release[key]);
    }
  });
});
