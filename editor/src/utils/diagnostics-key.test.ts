import { describe, expect, it } from 'bun:test';
import { diagnosticsKey } from './diagnostics-key';
import { fileUri } from './file-uri';

// What this protects, concretely, on Windows: a tab shows no error badge for a
// file full of errors, and diagnostics survive closing the file that produced
// them — then appear twice when it is reopened.
//
// The cause was that four producers key by `model.uri.toString()`, which
// Monaco renders as `file:///c%3A/x/A.cs`, while the two consumers hold a path
// and keyed by `fileUri(path)` — `file:///C:/x/A.cs` — with a raw-path
// fallback. Neither matched. On macOS all three spellings coincide, because
// there is no drive letter, so this was invisible where it was written.

const PATH = 'C:/Users/me/Game/Assets/Scripts/Player.cs';

describe('diagnosticsKey', () => {
  it('maps every spelling of one file to one key', () => {
    const spellings = [
      PATH,
      fileUri(PATH), // what a consumer holding a path produces
      'file:///c%3A/Users/me/Game/Assets/Scripts/Player.cs', // what Monaco renders
      'file:///C:/Users/me/Game/Assets/Scripts/Player.cs',
      'c:/Users/me/Game/Assets/Scripts/Player.cs',
    ];
    const keys = new Set(spellings.map(diagnosticsKey));
    expect([...keys]).toEqual([PATH]);
  });

  it('decodes an encoded path', () => {
    const spaced = 'C:/Users/me/First Project/Assets/A.cs';
    expect(diagnosticsKey(fileUri(spaced))).toBe(spaced);
  });

  it('leaves a POSIX path alone', () => {
    expect(diagnosticsKey('/Users/me/Game/Assets/A.cs')).toBe('/Users/me/Game/Assets/A.cs');
    expect(diagnosticsKey('file:///Users/me/Game/Assets/A.cs')).toBe(
      '/Users/me/Game/Assets/A.cs',
    );
  });

  it('keeps a UNC path whole', () => {
    const unc = '//server/share/Assets/A.cs';
    expect(diagnosticsKey(unc)).toBe(unc);
    expect(diagnosticsKey(fileUri(unc))).toBe(unc);
  });

  it('does not confuse two different files', () => {
    expect(diagnosticsKey('C:/a/A.cs')).not.toBe(diagnosticsKey('C:/b/A.cs'));
    expect(diagnosticsKey('D:/a/A.cs')).not.toBe(diagnosticsKey('C:/a/A.cs'));
  });

  it('is idempotent', () => {
    expect(diagnosticsKey(diagnosticsKey(fileUri(PATH)))).toBe(PATH);
  });
});
