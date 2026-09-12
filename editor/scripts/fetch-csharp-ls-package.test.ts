import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CSHARP_LS_VERSION,
  NUPKG_SHA512,
  packageFileName,
  packageUrl,
  readPinnedRustVersion,
  sha512Hex,
  verifyExisting,
} from './fetch-csharp-ls-package.ts';

// What these protect: the vendored package is the only thing standing between
// an offline user and a C#-less editor, and every failure mode here is silent.
// A drifted version pin fetches a package the app will never look for; a
// truncated download "exists" and passes an existence check. Both only surface
// on an end user's machine.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'csharp-ls-pkg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('package naming', () => {
  it('derives the file name and URL from the pinned version', () => {
    expect(packageFileName()).toBe(`csharp-ls.${CSHARP_LS_VERSION}.nupkg`);
    expect(packageUrl()).toBe(
      `https://api.nuget.org/v3-flatcontainer/csharp-ls/${CSHARP_LS_VERSION}/csharp-ls.${CSHARP_LS_VERSION}.nupkg`,
    );
  });

  it('tracks a different version through both', () => {
    expect(packageFileName('9.9.9')).toBe('csharp-ls.9.9.9.nupkg');
    expect(packageUrl('9.9.9')).toContain('/csharp-ls/9.9.9/csharp-ls.9.9.9.nupkg');
  });
});

describe('version pin', () => {
  it('reads the constant out of the Rust module', () => {
    const source = 'pub const CSHARP_LS_VERSION: &str = "1.2.3";\n';
    expect(readPinnedRustVersion(source)).toBe('1.2.3');
  });

  it('returns null when the constant is gone', () => {
    expect(readPinnedRustVersion('// nothing here')).toBeNull();
  });

  // The drift guard, run against the real file rather than a fixture: if
  // someone bumps one side only, this fails in `bun run verify` instead of on
  // a user's offline machine.
  it('matches what csharp_ls.rs actually pins today', () => {
    const rust = readFileSync(
      path.join(import.meta.dir, '..', 'src-tauri', 'src', 'csharp_ls.rs'),
      'utf8',
    );
    expect(readPinnedRustVersion(rust)).toBe(CSHARP_LS_VERSION);
  });
});

describe('integrity check', () => {
  it('hashes bytes with SHA-512', () => {
    // Standard vector for the empty input.
    expect(sha512Hex(new Uint8Array())).toBe(
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
        '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    );
  });

  it('accepts a file whose contents hash to the expected value', () => {
    const file = path.join(dir, 'pkg.nupkg');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    writeFileSync(file, bytes);
    expect(verifyExisting(file, sha512Hex(bytes))).toBe(true);
  });

  // The case that matters: a partial or substituted download is present on
  // disk, so anything checking only for existence would accept it.
  it('rejects a file with the wrong contents', () => {
    const file = path.join(dir, 'pkg.nupkg');
    writeFileSync(file, new Uint8Array([9, 9, 9]));
    expect(verifyExisting(file, NUPKG_SHA512)).toBe(false);
  });

  it('rejects a missing file without throwing', () => {
    expect(verifyExisting(path.join(dir, 'absent.nupkg'), NUPKG_SHA512)).toBe(false);
  });

  it('pins a full-length SHA-512', () => {
    expect(NUPKG_SHA512).toMatch(/^[0-9a-f]{128}$/);
  });
});
