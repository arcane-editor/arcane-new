import { describe, it, expect } from 'bun:test';
import { fileUri } from './document-sync';

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
