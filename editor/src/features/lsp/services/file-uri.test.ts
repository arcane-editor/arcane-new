import { describe, it, expect } from 'bun:test';
import { fileUri, pathFromFileUri } from './document-sync';

describe('fileUri', () => {
  describe('posix', () => {
    it('builds a three-slash file URI from an absolute path', () => {
      expect(fileUri('/Users/me/proj/A.cs')).toBe('file:///Users/me/proj/A.cs');
    });

    it('percent-encodes spaces without touching separators', () => {
      expect(fileUri('/Users/me/My Proj/A.cs')).toBe('file:///Users/me/My%20Proj/A.cs');
    });
  });

  describe('windows', () => {
    // Paths reach the frontend `/`-separated (see src-tauri path_util), so a
    // Windows path arrives as `D:/...`. Splitting that on '/' makes the drive
    // its own segment, and encodeURIComponent turns `D:` into `D%3A` — which
    // yields `file://D%3A/...`: a URI whose *authority* is the drive. Language
    // servers resolve that to nothing, so every didOpen/diagnostic silently
    // targets a document the server has never heard of.
    it('keeps the drive letter in the path, not the authority', () => {
      expect(fileUri('D:/Unity/proj/A.cs')).toBe('file:///D:/Unity/proj/A.cs');
    });

    it('encodes spaces in a drive path (the reported project has one)', () => {
      expect(fileUri('D:/Unity/UnityProject/Private Investigator/Assets/Scripts/A.cs')).toBe(
        'file:///D:/Unity/UnityProject/Private%20Investigator/Assets/Scripts/A.cs',
      );
    });

    it('preserves drive-letter case', () => {
      expect(fileUri('c:/x/y.cs')).toBe('file:///c:/x/y.cs');
    });

    it('maps a UNC path to a file URI with the host as authority', () => {
      expect(fileUri('//server/share/proj/A.cs')).toBe('file://server/share/proj/A.cs');
    });

    it('encodes spaces in a UNC path', () => {
      expect(fileUri('//server/share/My Proj/A.cs')).toBe('file://server/share/My%20Proj/A.cs');
    });
  });

  it('never emits a bare backslash or a verbatim prefix', () => {
    const uri = fileUri('D:/Unity/Private Investigator/A.cs');
    expect(uri).not.toContain('\\');
    expect(uri).not.toContain('?');
  });
});

describe('pathFromFileUri', () => {
  // The bug this replaces: `decodeURIComponent(uri.replace('file://', ''))`
  // left the third slash in front of the drive, and opening `/D:/x/A.cs` fails
  // with os error 123 (see src-tauri/src/path_util.rs).
  it('does not leave a slash in front of a Windows drive', () => {
    expect(pathFromFileUri('file:///D:/Unity/proj/A.cs')).toBe('D:/Unity/proj/A.cs');
  });

  it('restores the two leading slashes of a UNC path', () => {
    expect(pathFromFileUri('file://server/share/proj/A.cs')).toBe('//server/share/proj/A.cs');
  });

  it('keeps the leading slash of a POSIX path', () => {
    expect(pathFromFileUri('file:///Users/me/proj/A.cs')).toBe('/Users/me/proj/A.cs');
  });

  it('decodes percent-escapes per segment', () => {
    expect(pathFromFileUri('file:///Users/me/My%20Proj/A.cs')).toBe('/Users/me/My Proj/A.cs');
  });

  it('returns a non-file uri untouched (matches the call sites that do not pre-filter)', () => {
    expect(pathFromFileUri('diff://staged/Assets/Foo.cs')).toBe('diff://staged/Assets/Foo.cs');
  });

  describe('round-trips fileUri', () => {
    const paths = [
      '/Users/me/proj/A.cs',
      '/Users/me/My Proj/A.cs',
      'D:/Unity/proj/A.cs',
      'D:/Unity/UnityProject/Private Investigator/Assets/Scripts/A.cs',
      'c:/x/y.cs',
      '//server/share/proj/A.cs',
      '//server/share/My Proj/A.cs',
    ];
    for (const p of paths) {
      it(`survives ${p}`, () => {
        expect(pathFromFileUri(fileUri(p))).toBe(p);
      });
    }
  });
});
