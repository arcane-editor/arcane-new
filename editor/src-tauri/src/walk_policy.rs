//! Shared file-walking policy for the explorer tree, quick-open, and (later)
//! the persistent file index.
//!
//! Policy (binding decision D3 from the search-overhaul plan):
//! - `ALWAYS_HIDDEN` entries (`.git`, `.DS_Store`) are hidden everywhere, no
//!   exceptions.
//! - All other dotfiles are visible (unlike the `ignore` crate's default
//!   `hidden(true)` behavior, which treats every dotfile as hidden).
//! - `.gitignore` / global gitignore / `.git/info/exclude` are respected in
//!   quick-open and content-search walks — but NOT in the explorer tree
//!   (`read_directory` lists a raw directory listing plus `ALWAYS_HIDDEN`).
//! - `.env` and `.env.*` are whitelisted at the workspace root even when
//!   gitignored, because the `ignore` crate has no supported way to
//!   re-include a file once a `.gitignore` rule has pruned it from a walk.
//!   `root_env_files` reads the root directory directly (bypassing the
//!   walker/gitignore entirely) and callers append its results to the
//!   walker's output. This only covers root-level env files; a nested
//!   gitignored `.env` (e.g. `packages/api/.env`) is a documented
//!   limitation of this policy.

use std::fs;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

/// Entries that are hidden everywhere, regardless of gitignore state or the
/// "show dotfiles" policy below. `.git` because walking it is never useful
/// (and can be huge); `.DS_Store` because it's macOS noise, not project
/// content.
pub const ALWAYS_HIDDEN: &[&str] = &[".git", ".DS_Store"];

/// Returns true if `name` (a bare file/dir name, not a path) must never be
/// shown, in the tree, quick-open, or anywhere else.
pub fn is_always_hidden(name: &str) -> bool {
    ALWAYS_HIDDEN.contains(&name)
}

/// Returns true if `name` is a root-level env file: `.env` itself, or any
/// `.env.<suffix>` variant (`.env.local`, `.env.production`, ...).
///
/// Deliberately does NOT match arbitrary `.env*` (e.g. a hypothetical
/// `.envrc` is a direnv file, not an env file) — only the literal `.env` or
/// dot-separated suffixes of it.
pub fn is_env_file(name: &str) -> bool {
    name == ".env" || name.starts_with(".env.")
}

/// Builds a `WalkBuilder` configured per the D3 policy: dotfiles visible,
/// gitignore respected, `ALWAYS_HIDDEN` entries pruned (directories among
/// them are not descended into).
///
/// Does not walk the tree — call `.build()` on the returned builder, or feed
/// it into `apply_extra_excludes` first to layer on caller-supplied exclude
/// globs.
pub fn policy_walker(root: &str) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !is_always_hidden(&name)
        });
    builder
}

/// Reads the immediate children of `root` (no recursion) and returns the
/// paths of any root-level env files (`.env`, `.env.local`, ...).
///
/// This bypasses gitignore entirely by design — it's the supplement that
/// makes `.env` visible even when a project's `.gitignore` excludes it (the
/// overwhelmingly common case), since the `ignore` crate offers no way to
/// re-include a gitignore-pruned path mid-walk. Only covers the workspace
/// root; nested gitignored env files are not surfaced by this function.
pub fn root_env_files(root: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return result;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_env_file(&name) {
            continue;
        }
        let is_file = entry.file_type().map(|ft| ft.is_file()).unwrap_or(false);
        if is_file {
            result.push(entry.path());
        }
    }
    result.sort();
    result
}

/// Builds the `ignore::overrides::Override` matcher used by
/// `apply_extra_excludes`. Extracted so `file_index::apply_delta` can apply
/// the exact same extra-excludes semantics to newly-added paths (checking a
/// single path against the built matcher) without duplicating the glob
/// normalization logic used when wiring it into a walk.
///
/// Plain globs are treated as ignore rules (prefixed with `!` so
/// `OverrideBuilder`'s whitelist semantics invert into excludes) — a
/// caller-supplied glob that already starts with `!` is passed through
/// unchanged. Returns `None` if `extra_excludes` is empty, every entry is
/// blank, or the built matcher fails to compile — callers should treat
/// `None` as "no extra excludes apply", matching `apply_extra_excludes`'s
/// own silent best-effort handling of a failed build.
pub fn build_extra_excludes_override(
    root: &str,
    extra_excludes: &[String],
) -> Option<ignore::overrides::Override> {
    if extra_excludes.is_empty() {
        return None;
    }
    let mut overrides = ignore::overrides::OverrideBuilder::new(root);
    for p in extra_excludes {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            continue;
        }
        let glob = if trimmed.starts_with('!') {
            trimmed.to_string()
        } else {
            format!("!{}", trimmed)
        };
        let _ = overrides.add(&glob);
    }
    overrides.build().ok()
}

/// Layers caller-supplied exclude globs (e.g. Unity-specific patterns from
/// the frontend) onto `builder`.
///
/// Extracted from the duplicated `OverrideBuilder` blocks that used to live
/// in `file_scanner::scan_all_files_v2` and `file_scanner::fuzzy_search_files`.
pub fn apply_extra_excludes(b: &mut WalkBuilder, root: &str, extra_excludes: &[String]) {
    if let Some(built) = build_extra_excludes_override(root, extra_excludes) {
        b.overrides(built);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;

    // ── is_always_hidden ────────────────────────────────────────────────

    #[test]
    fn always_hidden_matches_git_and_ds_store() {
        assert!(is_always_hidden(".git"));
        assert!(is_always_hidden(".DS_Store"));
    }

    #[test]
    fn always_hidden_does_not_match_other_dotfiles() {
        assert!(!is_always_hidden(".env"));
        assert!(!is_always_hidden(".gitignore"));
        assert!(!is_always_hidden(".editorconfig"));
        assert!(!is_always_hidden(".vscode"));
    }

    // ── is_env_file ─────────────────────────────────────────────────────

    #[test]
    fn env_file_matches_dotenv_and_variants() {
        assert!(is_env_file(".env"));
        assert!(is_env_file(".env.local"));
        assert!(is_env_file(".env.production"));
        assert!(is_env_file(".env.development.local"));
    }

    #[test]
    fn env_file_does_not_match_unrelated_dotfiles() {
        assert!(!is_env_file(".envrc"));
        assert!(!is_env_file(".gitignore"));
        assert!(!is_env_file("env"));
        assert!(!is_env_file(".ENV"));
    }

    // ── policy_walker ───────────────────────────────────────────────────

    fn walked_names(root: &Path) -> HashSet<String> {
        policy_walker(root.to_str().unwrap())
            .build()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn walker_respects_gitignore_for_regular_files() {
        let tmp = tempfile::tempdir().unwrap();
        // `.gitignore` is only honored by the `ignore` crate when the walk
        // root looks like a git repo (`require_git` defaults to true, same
        // as the pre-existing WalkBuilder usage this module replaces) — a
        // bare `.git` directory is sufficient, it doesn't need to be a real
        // repo.
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".gitignore"), ".env\nsecret.txt\n").unwrap();
        fs::write(tmp.path().join(".env"), "SECRET=1\n").unwrap();
        fs::write(tmp.path().join("secret.txt"), "shh\n").unwrap();
        fs::write(tmp.path().join("visible.txt"), "hi\n").unwrap();

        let names = walked_names(tmp.path());

        // The walker itself does not re-include gitignored files — that's
        // root_env_files' job, layered on by callers.
        assert!(names.contains(".gitignore"), "names = {:?}", names);
        assert!(names.contains("visible.txt"), "names = {:?}", names);
        assert!(!names.contains("secret.txt"), "names = {:?}", names);
        assert!(!names.contains(".env"), "names = {:?}", names);
    }

    #[test]
    fn walker_shows_non_whitelisted_dotfiles() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(".editorconfig"), "root = true\n").unwrap();

        let names = walked_names(tmp.path());
        assert!(names.contains(".editorconfig"), "names = {:?}", names);
    }

    #[test]
    fn walker_never_yields_git_or_ds_store() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(tmp.path().join(".DS_Store"), "binary junk").unwrap();

        let names = walked_names(tmp.path());
        assert!(!names.contains(".git"), "names = {:?}", names);
        assert!(!names.contains("HEAD"), "names = {:?}", names);
        assert!(!names.contains(".DS_Store"), "names = {:?}", names);
    }

    // ── root_env_files ──────────────────────────────────────────────────

    #[test]
    fn root_env_files_returns_dotenv_and_variants_only_at_root() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(".env"), "A=1\n").unwrap();
        fs::write(tmp.path().join(".env.local"), "B=2\n").unwrap();
        fs::write(tmp.path().join(".envrc"), "use flake\n").unwrap();
        fs::write(tmp.path().join("regular.txt"), "hi\n").unwrap();
        let nested = tmp.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join(".env"), "C=3\n").unwrap();

        let found = root_env_files(tmp.path());
        let names: HashSet<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();

        assert_eq!(names, HashSet::from([".env".to_string(), ".env.local".to_string()]));
    }

    #[test]
    fn root_env_files_ignores_env_directories() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join(".env")).unwrap();

        let found = root_env_files(tmp.path());
        assert!(found.is_empty(), "found = {:?}", found);
    }

    #[test]
    fn root_env_files_empty_for_missing_root() {
        let missing = Path::new("/nonexistent/definitely/not/here");
        assert!(root_env_files(missing).is_empty());
    }

    // ── apply_extra_excludes ────────────────────────────────────────────

    #[test]
    fn apply_extra_excludes_prunes_matching_entries() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("Library")).unwrap();
        fs::write(tmp.path().join("Library").join("junk.bin"), "x").unwrap();
        fs::write(tmp.path().join("keep.txt"), "x").unwrap();

        let mut builder = policy_walker(tmp.path().to_str().unwrap());
        apply_extra_excludes(&mut builder, tmp.path().to_str().unwrap(), &["Library/**".to_string()]);

        let names: HashSet<String> = builder
            .build()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert!(!names.contains("junk.bin"), "names = {:?}", names);
        assert!(names.contains("keep.txt"), "names = {:?}", names);
    }

    #[test]
    fn apply_extra_excludes_noop_on_empty_slice() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("keep.txt"), "x").unwrap();

        let mut builder = policy_walker(tmp.path().to_str().unwrap());
        apply_extra_excludes(&mut builder, tmp.path().to_str().unwrap(), &[]);

        let names: HashSet<String> = builder
            .build()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.contains("keep.txt"), "names = {:?}", names);
    }
}
