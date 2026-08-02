import { describe, it, expect } from 'bun:test';
import { normalizeLegacyPath } from './legacy-path';

describe('normalizeLegacyPath', () => {
  // Builds before the Rust-side `path_util` normalization persisted the raw
  // output of `std::fs::canonicalize`, so existing installs have recents and
  // window state holding verbatim `\\?\` paths. Left alone they render as
  // `\\?\D:\...` in the UI and dedup as a separate entry from the normalized
  // path the same project now produces.
  it('strips the verbatim prefix from a legacy recents entry', () => {
    expect(normalizeLegacyPath(String.raw`\\?\D:\Unity\UnityProject\Private Investigator\Assets\Scripts`))
      .toBe('D:/Unity/UnityProject/Private Investigator/Assets/Scripts');
  });

  it('converts verbatim UNC to plain UNC', () => {
    expect(normalizeLegacyPath(String.raw`\\?\UNC\server\share\proj`)).toBe('//server/share/proj');
  });

  it('converts a plain drive path', () => {
    expect(normalizeLegacyPath(String.raw`D:\a\b`)).toBe('D:/a/b');
  });

  it('converts a plain UNC path', () => {
    expect(normalizeLegacyPath(String.raw`\\server\share\proj`)).toBe('//server/share/proj');
  });

  it('is idempotent', () => {
    const once = normalizeLegacyPath(String.raw`\\?\D:\Unity\My Project`);
    expect(once).toBe('D:/Unity/My Project');
    expect(normalizeLegacyPath(once)).toBe(once);
  });

  it('leaves POSIX paths untouched', () => {
    expect(normalizeLegacyPath('/Users/me/proj')).toBe('/Users/me/proj');
    expect(normalizeLegacyPath('D:/already/normal')).toBe('D:/already/normal');
  });

  // A backslash is a legal filename character on macOS/Linux, so a path that
  // isn't recognisably Windows-native must never be rewritten.
  it('does not rewrite a POSIX path containing a backslash in a file name', () => {
    expect(normalizeLegacyPath('/Users/me/weird\\name.cs')).toBe('/Users/me/weird\\name.cs');
  });

  it('leaves virtual tab paths alone', () => {
    expect(normalizeLegacyPath('diff://D:/proj/A.cs')).toBe('diff://D:/proj/A.cs');
    expect(normalizeLegacyPath('auth://callback')).toBe('auth://callback');
  });

  it('passes through empty and nullish input unchanged', () => {
    expect(normalizeLegacyPath('')).toBe('');
    expect(normalizeLegacyPath(null)).toBe(null);
    expect(normalizeLegacyPath(undefined)).toBe(undefined);
  });
});
