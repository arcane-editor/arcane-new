// Parity between the URI a document is OPENED under and the URI it is asked
// about.
//
// These two must be byte-identical or the language server answers `null` to
// every position request, which is exactly what shipped: notifications used
// `fileUri(path)` (`file:///C:/x/A.cs`) while requests used
// `model.uri.toString()`, and Monaco renders that same model as
// `file:///c%3A/x/A.cs` — lower-cased drive, percent-encoded colon. On macOS
// there is no drive letter, so the bug was invisible on the machine it was
// written on.
//
// The test drives the REAL `monaco-editor` URI implementation rather than a
// stand-in: the failure was a property of Monaco's formatting, so a hand-rolled
// mock would have agreed with the buggy code and passed.

import { describe, expect, it } from 'bun:test';
// Deep import on purpose: this module is standalone, while the bare
// `monaco-editor` entry point pulls the whole editor bundle and does not load
// outside a browser. Typed by `src/types/monaco-uri.d.ts`.
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
import { fileUri, pathFromFileUri } from './document-sync';
import { lspDocumentUri, modelFilePath } from './model-context';

/** A Monaco model as this app creates it: `EditorPanel` passes `fileUri(path)`
 *  to `@monaco-editor/react`, which calls `monaco.Uri.parse` on it. */
function modelFor(filePath: string) {
  return { uri: URI.parse(fileUri(filePath)) };
}

const PATHS = [
  'C:/Users/sd120/First Project pm Windows/Assets/Scripts/Player.cs',
  'C:/proj/A.cs',
  'D:/a#b/c%d/E F.cs',
  '/Users/me/proj/Assets/Player.cs',
  '/home/me/a b/c.cs',
  '//server/share/Assets/A.cs',
];

describe('lspDocumentUri', () => {
  for (const p of PATHS) {
    it(`round-trips ${p} to the URI didOpen used`, () => {
      expect(lspDocumentUri(modelFor(p))).toBe(fileUri(p));
    });

    it(`recovers the original path of ${p}`, () => {
      expect(modelFilePath(modelFor(p))).toBe(p);
    });
  }

  it('does not send what Monaco renders for a Windows path', () => {
    const p = 'C:/proj/A.cs';
    const model = modelFor(p);
    // The regression, pinned: Monaco's own spelling differs from the wire one.
    expect(model.uri.toString()).toBe('file:///c%3A/proj/A.cs');
    expect(lspDocumentUri(model)).toBe('file:///C:/proj/A.cs');
    expect(lspDocumentUri(model)).not.toBe(model.uri.toString());
  });

  it('keeps a UNC host in the authority position', () => {
    expect(lspDocumentUri(modelFor('//server/share/A.cs'))).toBe(
      'file://server/share/A.cs',
    );
  });
});

describe('pathFromFileUri', () => {
  it("decodes Monaco's percent-encoded drive colon", () => {
    // Before the fix this returned `/c:/proj/A.cs` — a leading slash Win32
    // rejects with os error 123.
    expect(pathFromFileUri('file:///c%3A/proj/A.cs')).toBe('c:/proj/A.cs');
  });

  for (const p of PATHS) {
    it(`inverts fileUri for ${p}`, () => {
      expect(pathFromFileUri(fileUri(p))).toBe(p);
    });
  }

  it('is idempotent through a second fileUri round trip', () => {
    for (const p of PATHS) {
      expect(fileUri(pathFromFileUri(fileUri(p)))).toBe(fileUri(p));
    }
  });
});
