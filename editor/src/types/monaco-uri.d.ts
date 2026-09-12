/**
 * Declarations for `monaco-editor/esm/vs/base/common/uri.js`.
 *
 * `monaco-editor` ships no `.d.ts` beside that file, but the module itself is
 * standalone and side-effect free — unlike the bare `monaco-editor` entry
 * point, which pulls the whole editor bundle and cannot be loaded outside a
 * browser. That makes it the one way to exercise Monaco's REAL URI formatting
 * from a test (`features/lsp/services/model-context.test.ts`), which matters
 * because the bug those tests pin was a property of that formatting: a
 * hand-rolled stand-in would have agreed with the broken code and passed.
 *
 * Only the members the tests use are declared. The `Uri` type itself is the
 * one the package does publish.
 */
declare module 'monaco-editor/esm/vs/base/common/uri.js' {
  import type { Uri } from 'monaco-editor';

  export const URI: {
    /** Parse a URI string. Percent-decodes the path; preserves its case. */
    parse(value: string, strict?: boolean): Uri;
    /** Build a URI from a filesystem path. */
    file(path: string): Uri;
  };
}
