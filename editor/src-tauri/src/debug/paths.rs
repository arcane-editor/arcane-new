//! One source path, three spellings.
//!
//! The same file reaches this subsystem written three different ways:
//!
//! | Source | Spelling |
//! |---|---|
//! | `METHOD_GET_DEBUG_INFO` | what the compiler recorded — absolute, native separators: `C:\Users\me\Game\Assets\Player.cs` |
//! | DAP `source.path` from the editor | whatever the frontend sent, usually forward slashes |
//! | `MOD_SOURCE_FILE_ONLY` | matched by **base name** only — `Player.cs` |
//!
//! All three were observed against a live Mono 6.13.0 agent. Getting this wrong
//! does not produce an error; it produces a breakpoint that never binds, which
//! is indistinguishable from "the debugger is broken". `CLAUDE.md` records the
//! same class of bug costing months of dead C# IntelliSense because Monaco and
//! the language server spelled a Windows drive letter differently.
//!
//! Comparison is case-insensitive on Windows and case-sensitive elsewhere. The
//! case rule is a parameter of the internal functions rather than a `cfg!`
//! sprinkled through them, so Windows behaviour stays assertable from a macOS
//! or Linux test run — the same reason `unity.rs` splits
//! `hub_roots_from_config_dir` out.

/// The file name, with either separator style.
pub fn file_name(path: &str) -> &str {
    match path.rfind(|c| c == '/' || c == '\\') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// A canonical key for maps: forward slashes, and lowercased where the platform
/// is case-insensitive.
pub fn normalize(path: &str) -> String {
    normalize_with(path, cfg!(windows))
}

fn normalize_with(path: &str, case_insensitive: bool) -> String {
    let forward = path.replace('\\', "/");
    if case_insensitive {
        forward.to_lowercase()
    } else {
        forward
    }
}

/// True when two paths name the same file after normalisation.
pub fn same_file(a: &str, b: &str) -> bool {
    normalize(a) == normalize(b)
}

/// True when a path reported by the runtime refers to the file the editor means.
///
/// Exact match first. Failing that, a trailing-component match: assemblies are
/// routinely compiled somewhere other than where they are now being edited — a
/// Unity project copied between machines, a package built in CI, a network
/// share mounted at a different root — and every real debugger falls back this
/// way. At least two components must line up, so a project full of
/// `Editor/Utils.cs` files does not collapse onto whichever one loaded first.
pub fn same_source_file(runtime_path: &str, editor_path: &str) -> bool {
    same_source_file_with(runtime_path, editor_path, cfg!(windows))
}

fn same_source_file_with(runtime_path: &str, editor_path: &str, case_insensitive: bool) -> bool {
    /// Trailing components that must agree for a non-exact match.
    const MIN_SHARED: usize = 2;

    let a = normalize_with(runtime_path, case_insensitive);
    let b = normalize_with(editor_path, case_insensitive);
    if a == b {
        return true;
    }

    let split = |p: &str| -> Vec<String> {
        p.split('/')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    };
    let (left, right) = (split(&a), split(&b));
    if left.is_empty() || right.is_empty() {
        return false;
    }

    let shared = left
        .iter()
        .rev()
        .zip(right.iter().rev())
        .take_while(|(x, y)| x == y)
        .count();

    // A path that is only a file name has no parent to corroborate it, so it
    // can only match exactly — which the equality check above already handled.
    shared > 0 && shared >= MIN_SHARED.min(left.len()).min(right.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_handles_both_separator_styles() {
        assert_eq!(file_name(r"C:\Users\me\Game\Assets\Player.cs"), "Player.cs");
        assert_eq!(file_name("/Users/me/Game/Assets/Player.cs"), "Player.cs");
        assert_eq!(file_name("Player.cs"), "Player.cs");
    }

    /// The base name is what `MOD_SOURCE_FILE_ONLY` matches on: passing the
    /// full path there returned no types, passing `Fixture.cs` returned exactly
    /// the two declared in that file.
    #[test]
    fn file_name_of_a_mixed_separator_path_is_the_last_component() {
        assert_eq!(file_name(r"C:\Users\me/Game\Assets/Player.cs"), "Player.cs");
    }

    #[test]
    fn file_name_of_a_trailing_separator_is_empty_rather_than_a_panic() {
        assert_eq!(file_name(r"C:\Users\me\"), "");
    }

    #[test]
    fn separator_style_does_not_change_identity() {
        assert!(same_file(
            r"C:\Users\me\Game\Assets\Player.cs",
            "C:/Users/me/Game/Assets/Player.cs"
        ));
    }

    #[test]
    fn windows_comparison_ignores_case() {
        assert_eq!(
            normalize_with(r"C:\Users\Me\Player.cs", true),
            normalize_with("c:/users/me/player.cs", true)
        );
    }

    /// Asserted explicitly so the Windows rule cannot quietly become the rule
    /// everywhere: two files differing only in case are two files on Linux.
    #[test]
    fn case_sensitive_platforms_keep_case() {
        assert_ne!(
            normalize_with("/home/me/Player.cs", false),
            normalize_with("/home/me/player.cs", false)
        );
    }

    #[test]
    fn different_files_are_not_the_same_file() {
        assert!(!same_file("/a/Player.cs", "/a/Enemy.cs"));
    }

    #[test]
    fn an_exact_runtime_path_matches_the_editor_path() {
        assert!(same_source_file_with(
            r"C:\Game\Assets\Player.cs",
            "C:/Game/Assets/Player.cs",
            true
        ));
    }

    /// The assembly was compiled on a build machine; the user is editing the
    /// same project checked out somewhere else entirely.
    #[test]
    fn a_project_compiled_elsewhere_still_matches_on_trailing_components() {
        assert!(same_source_file_with(
            r"D:\build\agent\work\Game\Assets\Scripts\Player.cs",
            "/Users/me/Game/Assets/Scripts/Player.cs",
            false
        ));
    }

    /// The reason the fallback needs two components and not one: Unity projects
    /// are full of same-named files, and binding a breakpoint to the wrong one
    /// stops execution somewhere the user never asked about.
    #[test]
    fn a_bare_file_name_match_is_not_enough() {
        assert!(!same_source_file_with(
            "/build/Game/Assets/Enemy/Utils.cs",
            "/home/me/Game/Assets/Player/Utils.cs",
            false
        ));
    }

    #[test]
    fn two_matching_components_are_enough() {
        assert!(same_source_file_with(
            "/build/Game/Assets/Player/Utils.cs",
            "/home/me/OtherRoot/Assets/Player/Utils.cs",
            false
        ));
    }

    #[test]
    fn a_single_component_path_matches_only_itself() {
        assert!(same_source_file_with("Player.cs", "Player.cs", false));
        assert!(!same_source_file_with("Player.cs", "Enemy.cs", false));
    }

    #[test]
    fn unrelated_files_never_match() {
        assert!(!same_source_file_with(
            "/build/Game/Assets/Scripts/Player.cs",
            "/home/me/Game/Assets/Scripts/Enemy.cs",
            false
        ));
    }
}
