//! One canonical spelling for every path that crosses the Rust → frontend
//! boundary: forward-slash separated, with no Windows verbatim (`\\?\`) prefix.
//!
//! ## Why this exists
//!
//! The frontend treats paths as `/`-separated strings in ~100 places — it
//! joins (`` `${dir}/${name}` ``), splits (`path.split('/').pop()`), and
//! prefix-matches (`ancestorDirs`) on that assumption. That is fine on
//! Windows for ordinary paths, because Win32 accepts `/` and `\`
//! interchangeably and normalizes them.
//!
//! It stops being fine the moment a path carries the verbatim `\\?\`
//! prefix. `\\?\` explicitly *disables* Win32 path normalization: the
//! characters after it are passed to the object manager as-is, so a `/` is
//! no longer a separator — it is an illegal character in a file name. So
//! `\\?\D:\Proj` + `/Assets` = `\\?\D:\Proj/Assets`, which fails with
//! `ERROR_INVALID_NAME` (os error 123, "The filename, directory name, or
//! volume label syntax is incorrect").
//!
//! `std::fs::canonicalize` returns exactly that verbatim form on Windows,
//! and we hand its result to the frontend (window label, `?path=` query
//! param, recents, window title). Normalizing here — at the boundary, once —
//! keeps every downstream `/` assumption correct instead of rewriting them
//! all. Paths coming back the other way need no special handling: Win32
//! accepts `D:/a/b` natively once the verbatim prefix is gone.
//!
//! On Unix this is a deliberate no-op: `\` is a legal character in a file
//! name there, so rewriting it would corrupt real paths.

/// Rewrite a Windows path into the frontend's canonical form.
///
/// Kept platform-independent (not `cfg`-gated) so the transformation itself
/// is unit-testable on any host; the `cfg` lives on [`to_ui_path`] instead.
///
/// - `\\?\D:\a\b`          → `D:/a/b`
/// - `\\?\UNC\srv\share\a` → `//srv/share/a`  (verbatim UNC → plain UNC)
/// - `\\srv\share\a`       → `//srv/share/a`
/// - `D:\a\b`              → `D:/a/b`
/// - `D:/a/b`              → unchanged (idempotent)
pub fn normalize_windows_path(path: &str) -> String {
    let unprefixed = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // Verbatim UNC. `\\?\UNC\srv\share` denotes `\\srv\share`; re-add the
        // two leading separators so the host survives the rewrite below.
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    };
    unprefixed.replace('\\', "/")
}

/// Shared body for [`to_ui_path`], with the platform decision passed in
/// rather than applied via `#[cfg]`.
///
/// Deliberately *not* `cfg`-gated: this way the Windows behaviour is
/// compiled — and unit-testable — on every host, instead of being a branch
/// that only ever type-checks on Windows. `to_ui_path` supplies
/// `cfg!(windows)`, which is a compile-time constant, so the unused branch
/// still optimizes away.
fn to_ui_path_impl(path: &std::path::Path, rewrite_separators: bool) -> String {
    let raw = path.to_string_lossy();
    if rewrite_separators {
        normalize_windows_path(&raw)
    } else {
        raw.into_owned()
    }
}

/// Normalize a path for hand-off to the frontend.
///
/// A no-op off Windows by design — see the module docs on why this must not
/// touch Unix paths.
pub fn to_ui_path(path: impl AsRef<std::path::Path>) -> String {
    to_ui_path_impl(path.as_ref(), cfg!(windows))
}

#[cfg(test)]
mod tests {
    use super::{normalize_windows_path, to_ui_path_impl};
    use std::path::Path;

    /// Exercises the Windows branch of `to_ui_path` on any host — the whole
    /// point of threading the platform flag through instead of `#[cfg]`.
    #[test]
    fn to_ui_path_rewrites_when_on_windows() {
        assert_eq!(
            to_ui_path_impl(Path::new(r"\\?\D:\Unity\My Project\Assets"), true),
            "D:/Unity/My Project/Assets",
        );
    }

    /// Off Windows the path must survive byte-for-byte, backslashes included
    /// — they are legal characters in a Unix file name.
    #[test]
    fn to_ui_path_is_a_no_op_off_windows() {
        assert_eq!(
            to_ui_path_impl(Path::new(r"/Users/me/weird\name.cs"), false),
            r"/Users/me/weird\name.cs",
        );
    }

    /// The exact path from the Windows bug report: a verbatim drive path
    /// whose project name contains a space.
    #[test]
    fn strips_verbatim_drive_prefix() {
        assert_eq!(
            normalize_windows_path(r"\\?\D:\Unity\UnityProject\Private Investigator"),
            "D:/Unity/UnityProject/Private Investigator",
        );
    }

    /// Regression guard for the actual failure: the frontend appends
    /// `/Assets` to the workspace path. On the verbatim form that produced
    /// `\\?\D:\...\Private Investigator/Assets` → os error 123. After
    /// normalization the same concatenation is a valid Windows path.
    #[test]
    fn normalized_path_survives_frontend_style_join() {
        let root = normalize_windows_path(r"\\?\D:\Unity\UnityProject\Private Investigator");
        let joined = format!("{root}/Assets");
        assert_eq!(joined, "D:/Unity/UnityProject/Private Investigator/Assets");
        assert!(!joined.contains('\\'), "no backslashes may survive: {joined}");
        assert!(!joined.starts_with(r"\\?\"), "verbatim prefix must be gone: {joined}");
    }

    #[test]
    fn converts_verbatim_unc_to_plain_unc() {
        assert_eq!(
            normalize_windows_path(r"\\?\UNC\server\share\proj"),
            "//server/share/proj",
        );
    }

    #[test]
    fn preserves_plain_unc_host() {
        assert_eq!(
            normalize_windows_path(r"\\server\share\proj"),
            "//server/share/proj",
        );
    }

    #[test]
    fn converts_plain_drive_path() {
        assert_eq!(normalize_windows_path(r"D:\a\b"), "D:/a/b");
    }

    /// Running the normalizer twice must not change the result — the
    /// boundary can be crossed more than once (e.g. canonicalize of an
    /// already-normalized path).
    #[test]
    fn is_idempotent() {
        let once = normalize_windows_path(r"\\?\D:\Unity\My Project");
        assert_eq!(once, "D:/Unity/My Project");
        assert_eq!(normalize_windows_path(&once), once);
    }

    #[test]
    fn leaves_forward_slash_paths_unchanged() {
        assert_eq!(normalize_windows_path("D:/a/b"), "D:/a/b");
        assert_eq!(normalize_windows_path("/home/user/proj"), "/home/user/proj");
    }

    /// Spaces, dots and unicode in path segments must survive untouched —
    /// only separators and the verbatim prefix are rewritten.
    #[test]
    fn preserves_segment_contents() {
        assert_eq!(
            normalize_windows_path(r"\\?\C:\Users\Ana Sofía\My Game.v2\Assets"),
            "C:/Users/Ana Sofía/My Game.v2/Assets",
        );
    }
}
