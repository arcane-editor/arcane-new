//! Persistent, per-workspace quick-open file index.
//!
//! Before this module existed, `fuzzy_search_files` re-walked the entire
//! workspace (policy walk + nucleo scoring) on *every keystroke* — fine for
//! small projects, a visible stall for large ones (Unity projects routinely
//! have 50k+ tracked files). `FileIndexState` holds a single cached file
//! list per workspace, built once via `build_file_index` and kept warm by
//! the file watcher's debounce task calling `apply_delta` on every
//! filesystem change. `fuzzy_search_files` (in `file_scanner`) then only
//! needs to run nucleo scoring over the cached list — no re-walk — unless
//! the cache is missing, stale, or for a different workspace/exclude set.
//!
//! ## Lock discipline
//!
//! `FileIndexState` wraps a `std::sync::Mutex`. Everything in this module
//! that touches it is synchronous (no `.await` inside a held lock is even
//! possible here — there are no `await` points in this module at all), so
//! the only concern is *wall-clock* hold time blocking other threads:
//! - `apply_delta` only mutates an in-memory `Vec<String>` — no I/O — so it
//!   holds the lock for the whole operation. That's still on the order of
//!   microseconds even for a large delta.
//! - `build_index` (behind `build_file_index`) walks the filesystem — that
//!   walk happens *before* the lock is taken; the lock is only held to swap
//!   in the freshly built `FileIndex`.
//! - `fuzzy_search_files_impl` (in `file_scanner`) clones the cached
//!   `Vec<String>` out from under the lock and scores the clone with the
//!   lock released, rather than scoring 100k+ paths while holding it — that
//!   would block `apply_delta` calls arriving from the watcher's debounce
//!   task for the scoring duration. See that function's doc comment for
//!   detail.
//!
//! ## Race with `build_file_index`
//!
//! `build_file_index` unconditionally replaces whatever index is currently
//! stored (workspace switch semantics — the old workspace's index is no
//! longer relevant). If a watcher delta from the *old* workspace's watcher
//! is still in flight and calls `apply_delta` concurrently with a
//! `build_file_index` call for the *new* workspace, whichever finishes last
//! wins. Both outcomes are acceptable: either the new index stands
//! untouched (correct), or a stale delta is applied to it and is caught by
//! the next `fuzzy_search_files` call anyway since watcher teardown/startup
//! (`stop_file_watcher`/`start_file_watcher`) is sequenced before/after
//! `setWorkspace` on the frontend, making this window vanishingly small in
//! practice. Not worth a generation counter for a self-correcting cache.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use crate::file_scanner::FileIndexDelta;
use crate::walk_policy;

/// A workspace's cached file list plus the parameters it was built with, so
/// callers can tell whether a cached list is still valid for the current
/// call (same workspace, same exclude patterns) before trusting it.
pub struct FileIndex {
    pub workspace_path: String,
    pub extra_excludes: Vec<String>,
    pub files: Vec<String>,
    /// Set by `apply_delta` when a `.gitignore`/`.ignore` file was added,
    /// removed, or (as far as the watcher can tell) modified — gitignore
    /// *content* controls which paths the walker would even consider, and
    /// there's no cheap way to re-evaluate that from a delta alone. A stale
    /// index is still returned as-is by `apply_delta`'s caller (the watcher
    /// task doesn't rebuild); the next `fuzzy_search_files` call sees the
    /// flag and does a full rebuild before scoring.
    pub stale: bool,
}

/// Managed via `.manage(FileIndexState::new())` in `lib.rs`. `None` until
/// the first `build_file_index` call for a workspace.
pub struct FileIndexState(pub Mutex<Option<FileIndex>>);

impl FileIndexState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for FileIndexState {
    fn default() -> Self {
        Self::new()
    }
}

/// Walks `workspace_path` per the shared `walk_policy` (dotfiles visible
/// except `.git`/`.DS_Store`, `.gitignore` respected) plus caller-supplied
/// exclude globs, then appends any root-level `.env`/`.env.*` files the
/// walker didn't already yield (whitelisted even when gitignored — see
/// `walk_policy::root_env_files`).
///
/// This is the exact walk semantics `scan_all_files_v2` and
/// `fuzzy_search_files` used inline before the persistent index existed;
/// both now go through this single implementation — `scan_all_files_v2`
/// directly, `fuzzy_search_files` via `build_index`/`fuzzy_search_files_impl`
/// on a cache miss.
pub fn walk_files(workspace_path: &str, extra_excludes: &[String]) -> Vec<String> {
    let mut builder = walk_policy::policy_walker(workspace_path);
    walk_policy::apply_extra_excludes(&mut builder, workspace_path, extra_excludes);

    let mut files: Vec<String> = builder
        .build()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if entry.file_type()?.is_file() {
                Some(entry.path().to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();

    let seen: HashSet<&str> = files.iter().map(|s| s.as_str()).collect();
    let extra_env_files: Vec<String> = walk_policy::root_env_files(Path::new(workspace_path))
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|s| !seen.contains(s.as_str()))
        .collect();
    drop(seen);
    files.extend(extra_env_files);

    files
}

/// Plain (non-`State`) implementation behind the `build_file_index` command
/// — split out so tests can drive it against a bare `FileIndexState`
/// without standing up a Tauri app. Walks the workspace, then
/// unconditionally replaces whatever index is currently stored (see the
/// module doc comment's "Race with `build_file_index`" section).
pub fn build_index(
    state: &FileIndexState,
    workspace_path: String,
    extra_excludes: Vec<String>,
) -> Result<usize, String> {
    let files = walk_files(&workspace_path, &extra_excludes);
    let count = files.len();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(FileIndex {
        workspace_path,
        extra_excludes,
        files,
        stale: false,
    });
    Ok(count)
}

/// Build (or rebuild) the persistent file index for `workspace_path`.
/// Called from the frontend once per workspace open, and again whenever
/// exclude patterns change (both fire-and-forget — `fuzzy_search_files`
/// rebuilds inline as a fallback if this hasn't landed yet). `async` so a
/// cold build (full directory walk) runs on Tauri's blocking thread pool
/// instead of the main runtime.
#[tauri::command(async)]
pub fn build_file_index(
    state: tauri::State<'_, FileIndexState>,
    workspace_path: String,
    extra_excludes: Vec<String>,
) -> Result<usize, String> {
    build_index(&state, workspace_path, extra_excludes)
}

/// Returns true if any path component of `path` is an `ALWAYS_HIDDEN` name
/// (`.git`, `.DS_Store`) — i.e. the path lives inside a directory that's
/// hidden everywhere, not just at gitignore-time. A newly created file deep
/// inside `.git/` (e.g. during a commit) must never enter the index via
/// `apply_delta`, matching what a fresh `walk_files` would have excluded.
fn path_has_always_hidden_segment(path: &str) -> bool {
    Path::new(path).components().any(|c| {
        if let std::path::Component::Normal(name) = c {
            walk_policy::is_always_hidden(&name.to_string_lossy())
        } else {
            false
        }
    })
}

/// Returns true if `path`'s file name is `.gitignore` or `.ignore` — the two
/// files whose *content* changes what the walker would include, which
/// `apply_delta` can't cheaply re-evaluate for existing cached entries.
fn is_gitignore_file(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .map(|n| n == ".gitignore" || n == ".ignore")
        .unwrap_or(false)
}

/// Applies a watcher-observed delta to the live index in place, so most
/// filesystem changes update the cache in microseconds instead of
/// triggering a full re-walk. Called from `file_scanner::start_file_watcher`'s
/// debounce task, once per settled burst of filesystem events, before that
/// task emits `file-index-changed`.
///
/// No-op if no index has been built yet (workspace just opened, watcher
/// started before `build_file_index` resolved) — nothing to update, and the
/// first `fuzzy_search_files` call will do a full walk regardless.
///
/// - Added paths: skipped if they sit inside an always-hidden directory
///   (`.git`, `.DS_Store` — see `path_has_always_hidden_segment`), and
///   deduped against both the existing index and the rest of the same
///   batch. Root `.env`/`.env.*` files are never special-cased here — they
///   aren't `ALWAYS_HIDDEN` names, so they pass through like any other add,
///   consistent with `walk_files` always including them.
/// - Removed paths: dropped from the index via a retain filter.
/// - Any added/removed path named `.gitignore` or `.ignore` flips `stale`
///   (see `FileIndex::stale` doc comment) — added/removed paths are still
///   applied in the same call so the index reflects the raw filesystem
///   event even while marked stale; the next `fuzzy_search_files` call
///   discards this best-effort state anyway once it does a full rebuild.
pub fn apply_delta(state: &FileIndexState, delta: &FileIndexDelta) {
    // A poisoned mutex (some other thread panicked while holding it) would
    // otherwise permanently break the index for the rest of the session —
    // this is a background watcher task with no way to surface an error to
    // the user, so recovering the guard and continuing best-effort beats
    // silently going dark on every future filesystem change.
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(index) = guard.as_mut() else {
        return;
    };

    if delta
        .added
        .iter()
        .chain(delta.removed.iter())
        .any(|p| is_gitignore_file(p))
    {
        index.stale = true;
    }

    if !delta.removed.is_empty() {
        let removed: HashSet<&str> = delta.removed.iter().map(|s| s.as_str()).collect();
        index.files.retain(|f| !removed.contains(f.as_str()));
    }

    if !delta.added.is_empty() {
        let to_add: Vec<String> = {
            let existing: HashSet<&str> = index.files.iter().map(|s| s.as_str()).collect();
            let mut seen_new: HashSet<&str> = HashSet::new();
            delta
                .added
                .iter()
                .filter(|p| !path_has_always_hidden_segment(p))
                .filter(|p| !existing.contains(p.as_str()))
                .filter(|p| seen_new.insert(p.as_str()))
                .cloned()
                .collect()
        };
        index.files.extend(to_add);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_git_repo_with_gitignore(root: &Path, gitignore_body: &str) {
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), gitignore_body).unwrap();
    }

    // ── build_index ─────────────────────────────────────────────────────

    #[test]
    fn build_index_counts_and_stores_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "a").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "b").unwrap();

        let state = FileIndexState::new();
        let count = build_index(&state, tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();
        assert_eq!(count, 2);

        let guard = state.0.lock().unwrap();
        let idx = guard.as_ref().unwrap();
        assert_eq!(idx.files.len(), 2);
        assert!(!idx.stale);
        assert_eq!(idx.workspace_path, tmp.path().to_str().unwrap());
    }

    #[test]
    fn build_index_excludes_gitignored_files_and_git_internals() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), "secret.txt\n");
        std::fs::write(tmp.path().join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "shh").unwrap();
        std::fs::write(tmp.path().join("visible.txt"), "hi").unwrap();

        let state = FileIndexState::new();
        build_index(&state, tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();

        let guard = state.0.lock().unwrap();
        let files = &guard.as_ref().unwrap().files;
        assert!(files.iter().any(|f| f.ends_with("visible.txt")), "files = {:?}", files);
        assert!(!files.iter().any(|f| f.ends_with("secret.txt")), "files = {:?}", files);
        assert!(!files.iter().any(|f| f.contains("/.git/")), "files = {:?}", files);
    }

    #[test]
    fn build_index_whitelists_gitignored_root_env_file() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), ".env\n");
        std::fs::write(tmp.path().join(".env"), "A=1\n").unwrap();

        let state = FileIndexState::new();
        build_index(&state, tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();

        let guard = state.0.lock().unwrap();
        let files = &guard.as_ref().unwrap().files;
        let env_matches = files.iter().filter(|f| f.ends_with(".env")).count();
        assert_eq!(env_matches, 1, "files = {:?}", files);
    }

    #[test]
    fn build_index_replaces_prior_index_unconditionally() {
        let tmp1 = tempfile::tempdir().unwrap();
        std::fs::write(tmp1.path().join("one.txt"), "1").unwrap();
        let tmp2 = tempfile::tempdir().unwrap();
        std::fs::write(tmp2.path().join("two.txt"), "2").unwrap();
        std::fs::write(tmp2.path().join("three.txt"), "3").unwrap();

        let state = FileIndexState::new();
        build_index(&state, tmp1.path().to_str().unwrap().to_string(), vec![]).unwrap();
        build_index(&state, tmp2.path().to_str().unwrap().to_string(), vec![]).unwrap();

        let guard = state.0.lock().unwrap();
        let idx = guard.as_ref().unwrap();
        assert_eq!(idx.workspace_path, tmp2.path().to_str().unwrap());
        assert_eq!(idx.files.len(), 2);
    }

    // ── apply_delta: added ──────────────────────────────────────────────

    #[test]
    fn apply_delta_adds_new_paths() {
        let state = FileIndexState::new();
        build_index(&state, "/ws".to_string(), vec![]).unwrap();
        // build_index on a nonexistent "/ws" yields zero files; seed
        // manually isn't needed since apply_delta doesn't require the path
        // to exist on disk (it's a pure in-memory list update).

        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec!["/ws/new.txt".to_string()],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        assert_eq!(guard.as_ref().unwrap().files, vec!["/ws/new.txt".to_string()]);
    }

    #[test]
    fn apply_delta_dedups_added_paths_against_existing_and_within_batch() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            *guard = Some(FileIndex {
                workspace_path: "/ws".to_string(),
                extra_excludes: vec![],
                files: vec!["/ws/existing.txt".to_string()],
                stale: false,
            });
        }

        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec![
                    "/ws/existing.txt".to_string(),
                    "/ws/new.txt".to_string(),
                    "/ws/new.txt".to_string(),
                ],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        let files = &guard.as_ref().unwrap().files;
        assert_eq!(files.iter().filter(|f| f.as_str() == "/ws/existing.txt").count(), 1);
        assert_eq!(files.iter().filter(|f| f.as_str() == "/ws/new.txt").count(), 1);
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn apply_delta_skips_paths_under_always_hidden_segment() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            *guard = Some(FileIndex {
                workspace_path: "/ws".to_string(),
                extra_excludes: vec![],
                files: vec![],
                stale: false,
            });
        }

        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec![
                    "/ws/.git/COMMIT_EDITMSG".to_string(),
                    "/ws/.DS_Store".to_string(),
                    "/ws/nested/.git/index".to_string(),
                    "/ws/keep.txt".to_string(),
                ],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        let files = &guard.as_ref().unwrap().files;
        assert_eq!(files, &vec!["/ws/keep.txt".to_string()], "files = {:?}", files);
    }

    #[test]
    fn apply_delta_allows_env_files() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            *guard = Some(FileIndex {
                workspace_path: "/ws".to_string(),
                extra_excludes: vec![],
                files: vec![],
                stale: false,
            });
        }

        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec!["/ws/.env".to_string(), "/ws/.env.local".to_string()],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        let files = &guard.as_ref().unwrap().files;
        assert!(files.contains(&"/ws/.env".to_string()), "files = {:?}", files);
        assert!(files.contains(&"/ws/.env.local".to_string()), "files = {:?}", files);
    }

    // ── apply_delta: removed ────────────────────────────────────────────

    #[test]
    fn apply_delta_removes_paths() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            *guard = Some(FileIndex {
                workspace_path: "/ws".to_string(),
                extra_excludes: vec![],
                files: vec!["/ws/a.txt".to_string(), "/ws/b.txt".to_string()],
                stale: false,
            });
        }

        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec![],
                removed: vec!["/ws/a.txt".to_string()],
            },
        );

        let guard = state.0.lock().unwrap();
        assert_eq!(guard.as_ref().unwrap().files, vec!["/ws/b.txt".to_string()]);
    }

    #[test]
    fn apply_delta_is_noop_when_no_index_built() {
        let state = FileIndexState::new();
        // Should not panic even though guard is None.
        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec!["/ws/a.txt".to_string()],
                removed: vec![],
            },
        );
        let guard = state.0.lock().unwrap();
        assert!(guard.is_none());
    }

    // ── apply_delta: .gitignore / .ignore → stale ──────────────────────

    #[test]
    fn apply_delta_marks_stale_on_gitignore_change() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            *guard = Some(FileIndex {
                workspace_path: "/ws".to_string(),
                extra_excludes: vec![],
                files: vec![],
                stale: false,
            });
        }

        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec!["/ws/.gitignore".to_string()],
                removed: vec![],
            },
        );

        assert!(state.0.lock().unwrap().as_ref().unwrap().stale);
    }

    #[test]
    fn apply_delta_marks_stale_on_ignore_file_removed() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            *guard = Some(FileIndex {
                workspace_path: "/ws".to_string(),
                extra_excludes: vec![],
                files: vec!["/ws/.ignore".to_string()],
                stale: false,
            });
        }

        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec![],
                removed: vec!["/ws/.ignore".to_string()],
            },
        );

        assert!(state.0.lock().unwrap().as_ref().unwrap().stale);
    }

    #[test]
    fn apply_delta_does_not_mark_stale_for_unrelated_files() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            *guard = Some(FileIndex {
                workspace_path: "/ws".to_string(),
                extra_excludes: vec![],
                files: vec![],
                stale: false,
            });
        }

        apply_delta(
            &state,
            &FileIndexDelta {
                added: vec!["/ws/normal.txt".to_string()],
                removed: vec![],
            },
        );

        assert!(!state.0.lock().unwrap().as_ref().unwrap().stale);
    }

    // ── path_has_always_hidden_segment / is_gitignore_file ─────────────

    #[test]
    fn path_has_always_hidden_segment_matches_nested_git_dir() {
        assert!(path_has_always_hidden_segment("/ws/nested/.git/index"));
        assert!(path_has_always_hidden_segment("/ws/.DS_Store"));
        assert!(!path_has_always_hidden_segment("/ws/keep.txt"));
    }

    #[test]
    fn is_gitignore_file_matches_gitignore_and_ignore_only() {
        assert!(is_gitignore_file("/ws/.gitignore"));
        assert!(is_gitignore_file("/ws/nested/.ignore"));
        assert!(!is_gitignore_file("/ws/.gitignore.bak"));
        assert!(!is_gitignore_file("/ws/other.txt"));
    }
}
