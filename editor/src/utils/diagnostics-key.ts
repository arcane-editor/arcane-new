import { pathFromFileUri } from './file-uri';

/**
 * The one key a file's diagnostics are stored under.
 *
 * Four producers write into the diagnostics store and two consumers read from
 * it, and until this existed they did not agree. Producers key by
 * `model.uri.toString()`, which Monaco renders with a lower-cased,
 * percent-encoded drive letter (`file:///c%3A/x/A.cs`). Consumers have a path
 * and keyed by `fileUri(path)` (`file:///C:/x/A.cs`) with a raw-path fallback.
 * On macOS those coincide, because there is no drive letter. On Windows they
 * never match, and the visible results are a tab that shows no error badge for
 * a file full of errors, and diagnostics that survive closing the file that
 * produced them — then reappear duplicated when it is reopened.
 *
 * Normalising to the decoded path removes the question: every spelling of the
 * same file lands on one entry, whichever side produced it.
 */
export function diagnosticsKey(uriOrPath: string): string {
  const path = uriOrPath.startsWith('file://') ? pathFromFileUri(uriOrPath) : uriOrPath;
  // Upper-case a Windows drive letter. `C:/x` and `c:/x` name the same file,
  // and the two sides of this disagree about which they use: Monaco
  // lower-cases it, the workspace tree preserves whatever the OS reported.
  return /^[a-z]:/.test(path) ? path[0].toUpperCase() + path.slice(1) : path;
}
