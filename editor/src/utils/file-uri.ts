/**
 * `file://` URI construction and its exact inverse.
 *
 * Shared rather than owned by the LSP feature because three unrelated things
 * need to agree on how a path becomes a URI — the language-server wire
 * protocol, Monaco's model registry, and the diagnostics store — and the last
 * of those is a store, which cannot import a feature without a cycle.
 *
 * There is exactly one implementation of each direction, and that is the
 * point: a hand-rolled `file://` + path is unencoded and drive-unaware, and
 * the resulting mismatch is invisible on macOS and total on Windows. See
 * `features/lsp/services/file-uri-single-source.test.ts`, which forbids the
 * shape returning anywhere in the tree.
 */

export function fileUri(filePath: string): string {
  // Encode path components for valid URIs (spaces → %20, etc.). Split first
  // so separators survive — encodeURIComponent would escape them.
  const encodeSegments = (p: string) => p.split('/').map(encodeURIComponent).join('/');

  // Windows drive path (`D:/x/y`). Paths reach the frontend `/`-separated
  // (src-tauri/src/path_util.rs), so the drive would otherwise become its own
  // segment and encode to `D%3A` — producing `file://D%3A/x/y`, where the
  // drive is parsed as the URI *authority*. The drive must sit in the path:
  // `file:///D:/x/y`. The colon is left literal, matching what VS Code and
  // Roslyn-based servers emit.
  const drive = /^([A-Za-z]:)\/(.*)$/.exec(filePath);
  if (drive) return `file:///${drive[1]}/${encodeSegments(drive[2])}`;

  // UNC (`//server/share/x`) — here the host genuinely IS the authority, so
  // it collapses to `file://server/share/x` rather than gaining slashes.
  const unc = /^\/\/([^/]+)\/(.*)$/.exec(filePath);
  if (unc) return `file://${unc[1]}/${encodeSegments(unc[2])}`;

  // POSIX: the leading empty segment supplies the third slash.
  return 'file://' + encodeSegments(filePath);
}

/**
 * Exact inverse of [`fileUri`]: `file:///D:/x/A.cs` → `D:/x/A.cs`,
 * `file://server/share/A.cs` → `//server/share/A.cs`,
 * `file:///Users/me/A.cs` → `/Users/me/A.cs`.
 *
 * The naive `decodeURIComponent(uri.replace('file://', ''))` this replaces got
 * both Windows shapes wrong: it left the third slash in front of the drive
 * (`/D:/x/A.cs`, which Win32 rejects with os error 123 — see
 * `src-tauri/src/path_util.rs`), and it dropped the two leading slashes of a
 * UNC path along with its host's authority position.
 *
 * Decoding per segment (not over the whole string) matters for the same reason
 * `fileUri` encodes per segment: a `%2F` inside a file name must not decode
 * into a separator.
 *
 * Non-`file://` input is returned unchanged, matching the previous behaviour
 * at the call sites that don't pre-filter.
 */
export function pathFromFileUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  const decodeSegments = (p: string) => p.split('/').map(decodeURIComponent).join('/');
  const rest = uri.slice('file://'.length);

  // Empty authority (`file:///…`) — a POSIX or Windows-drive path.
  if (rest.startsWith('/')) {
    // Decode BEFORE testing for a drive. Monaco renders the drive colon as
    // `%3A` (`file:///c%3A/x/A.cs` — see `lspDocumentUri` in model-context.ts),
    // and testing the still-encoded body misses that shape and returns
    // `/c:/x/A.cs`, which Win32 rejects with os error 123. Decoding is still
    // per segment, so a `%2F` inside a file name cannot become a separator.
    const body = decodeSegments(rest.slice(1));
    // The drive letter belongs to the path, so it must NOT keep that slash.
    if (/^[A-Za-z]:(\/|$)/.test(body)) return body;
    return '/' + body;
  }

  // Non-empty authority = a UNC host, which `fileUri` collapsed from
  // `//host/share` to `file://host/share`; restore the leading slashes.
  return '//' + decodeSegments(rest);
}
