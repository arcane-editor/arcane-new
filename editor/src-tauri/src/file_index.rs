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
//! - `apply_delta` mostly mutates an in-memory `Vec<String>`, but when the
//!   delta has any `added` paths it ALSO reads `.gitignore`/
//!   `.git/info/exclude` off disk (`build_delta_gitignore`, needed to filter
//!   added paths the same way a fresh walk would) — real I/O, done *while
//!   the lock is held*. This is a correction of an earlier version of this
//!   paragraph that claimed "no I/O"; that stopped being true once the
//!   delta-filter fix (Finding 1) landed. In practice the hold time is still
//!   bounded — both files are small, local, and normally warm in the OS
//!   page cache, and the lock has effectively one writer at a time (the
//!   watcher's debounce task processes one settled burst before the next) —
//!   but it is no longer accurate to call this "no I/O".
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
//! practice.
//!
//! That "last writer wins, both outcomes correct" reasoning does *not* cover
//! every interleaving, though — being honest about the one gap the review
//! for this module traced: if a walk (`build_index`, or the cache-miss path
//! of `fuzzy_search_files_impl`) has already read a file's directory entry,
//! that file is then deleted on disk, and the watcher's `apply_delta`
//! removal for it lands against whatever index is *currently* stored — all
//! before the walk's own result is stored — then the walk's result (which
//! still contains the now-deleted path, because it was read before the
//! delete happened) overwrites the index the removal delta just corrected.
//! The removal event isn't replayed against the new index (it already fired
//! once), so the deleted path lingers — and quick-open can offer/open a
//! path that no longer exists — until the *next* rebuild, not the next
//! delta. This is low-probability (it needs a walk, a delete, and a delta
//! for the same path to race within one walk's wall-clock window) and
//! bounded (self-heals at the next `build_file_index`/cache-miss rebuild),
//! so it's not worth a generation counter — but it is a real gap, not a
//! self-correcting one.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::overrides::Override;

use crate::file_scanner::FileIndexDelta;
use crate::sync_util::lock_recover;
use crate::walk_policy;

/// A workspace's cached file list plus the parameters it was built with, so
/// callers can tell whether a cached list is still valid for the current
/// call (same workspace, same exclude patterns) before trusting it.
pub struct FileIndex {
    pub workspace_path: String,
    pub extra_excludes: Vec<String>,
    /// `Arc`-wrapped so a cache hit in `fuzzy_search_files_impl` can clone a
    /// handle to the list in O(1) (a refcount bump) instead of deep-cloning
    /// every path string on every keystroke — see that function's doc
    /// comment. `apply_delta` mutates through `Arc::make_mut`, which only
    /// deep-clones if some other clone of this `Arc` is alive at that moment
    /// (i.e. a search that took the O(1) clone is still scoring with the
    /// lock released) — copy-on-write, not copy-always.
    pub files: Arc<Vec<String>>,
    /// Set by `apply_delta` when a `.gitignore`/`.ignore` file was added,
    /// removed, or (as far as the watcher can tell) modified — gitignore
    /// *content* controls which paths the walker would even consider, and
    /// there's no cheap way to re-evaluate that from a delta alone. A stale
    /// index is still returned as-is by `apply_delta`'s caller (the watcher
    /// task doesn't rebuild); the next `fuzzy_search_files` call sees the
    /// flag and does a full rebuild before scoring.
    pub stale: bool,
}

/// Managed via `.manage(FileIndexState::new())` in `lib.rs`. Keyed by window
/// label — mirrors `lsp.rs`/`file_scanner::FileWatcherState` — so two windows
/// open on different workspaces never clobber each other's cached index. No
/// entry exists for a label until the first `build_file_index` call for that
/// window.
pub struct FileIndexState(pub Mutex<HashMap<String, FileIndex>>);

impl FileIndexState {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    /// Drop this window's cached index, if any. Called from
    /// `WindowEvent::Destroyed` cleanup in `lib.rs` — idempotent, a no-op if
    /// the window never built an index.
    pub fn drop_window(&self, label: &str) {
        let mut guard = lock_recover(&self.0);
        guard.remove(label);
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
                // Normalized: these are quick-open results the frontend
                // splits on `/`. See `path_util`.
                Some(crate::path_util::to_ui_path(entry.path()))
            } else {
                None
            }
        })
        .collect();

    let seen: HashSet<&str> = files.iter().map(|s| s.as_str()).collect();
    let extra_env_files: Vec<String> = walk_policy::root_env_files(Path::new(workspace_path))
        .into_iter()
        // Same normalization as the walk above — `seen` holds normalized
        // paths, so the dedup below only works if these match.
        .map(crate::path_util::to_ui_path)
        .filter(|s| !seen.contains(s.as_str()))
        .collect();
    drop(seen);
    files.extend(extra_env_files);

    files
}

/// Plain (non-`State`) implementation behind the `build_file_index` command
/// — split out so tests can drive it against a bare `FileIndexState`
/// without standing up a Tauri app. Walks the workspace, then
/// unconditionally replaces whatever index is currently stored for `label`
/// (see the module doc comment's "Race with `build_file_index`" section) —
/// every other window's entry is untouched.
pub fn build_index(
    state: &FileIndexState,
    label: &str,
    workspace_path: String,
    extra_excludes: Vec<String>,
) -> Result<usize, String> {
    let files = walk_files(&workspace_path, &extra_excludes);
    let count = files.len();
    let mut guard = lock_recover(&state.0);
    guard.insert(
        label.to_string(),
        FileIndex {
            workspace_path,
            extra_excludes,
            files: Arc::new(files),
            stale: false,
        },
    );
    Ok(count)
}

/// Build (or rebuild) the persistent file index for `workspace_path`.
/// Called from the frontend once per workspace open, and again whenever
/// exclude patterns change (both fire-and-forget — `fuzzy_search_files`
/// rebuilds inline as a fallback if this hasn't landed yet). `async` so a
/// cold build (full directory walk) runs on Tauri's blocking thread pool
/// instead of the main runtime.
///
/// `window` is auto-injected by Tauri (no frontend invoke change needed —
/// same precedent as `terminal.rs`'s `terminal_spawn`); the index is keyed
/// by `window.label()` so only the *calling* window's own entry is replaced.
#[tauri::command(async)]
pub fn build_file_index(
    state: tauri::State<'_, FileIndexState>,
    window: tauri::Window,
    workspace_path: String,
    extra_excludes: Vec<String>,
) -> Result<usize, String> {
    build_index(&state, window.label(), workspace_path, extra_excludes)
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
/// `pub(crate)`: also used by `file_scanner`'s watcher event loop to flip a
/// content edit (any event kind, not just add/remove) into a stale index.
pub(crate) fn is_gitignore_file(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .map(|n| n == ".gitignore" || n == ".ignore")
        .unwrap_or(false)
}

/// Builds a root-scoped `Gitignore` matcher for `workspace_path`, covering
/// the same two root-level ignore sources `walk_policy::policy_walker`
/// enables via `git_ignore(true)`/`git_exclude(true)`: the workspace's own
/// `.gitignore` and `.git/info/exclude`.
///
/// Deliberately does NOT attempt nested-`.gitignore` fidelity. The `ignore`
/// crate's `GitignoreBuilder` matches every glob it's given relative to a
/// single root (the path passed to `GitignoreBuilder::new`) — folding a
/// nested `.gitignore`'s patterns into this same builder would evaluate them
/// relative to the *workspace* root instead of their own directory, which is
/// silently wrong for directory-relative patterns (e.g. `/build` in
/// `packages/api/.gitignore` should only match `packages/api/build`, not any
/// `build` anywhere in the workspace). Faithfully replaying nested
/// `.gitignore` files requires the same per-directory matcher stack
/// `ignore::WalkBuilder` (and therefore `policy_walker`) builds while it
/// walks — not reconstructible from a bare list of added paths without
/// walking, which would defeat the point of a delta-based update. The
/// user's global gitignore (`core.excludesFile`) is similarly not consulted
/// here.
///
/// This is a **documented divergence** from a full `walk_files` rebuild: a
/// newly-created file excluded only by a *nested* `.gitignore` or the global
/// gitignore is admitted into the index by `apply_delta` even though a
/// rebuild would exclude it, until the next full rebuild. In practice this
/// is the uncommon case — Unity projects overwhelmingly gitignore build
/// output (`Library/`, `Temp/`, `Obj/`, `Logs/`, `Build/`, ...) from a single
/// root `.gitignore`, which this function does cover, matching Finding 1's
/// primary concern (thousands of compiler-output files entering the index
/// during a Unity recompile).
///
/// Returns `Err` only if the underlying glob set fails to compile (e.g. an
/// excessively large/malformed `.gitignore`) — `apply_delta` treats that as
/// "can't confidently classify this batch" and marks the index stale rather
/// than risking an excluded path being admitted.
fn build_delta_gitignore(workspace_path: &str) -> Result<Gitignore, ignore::Error> {
    let root = Path::new(workspace_path);
    let mut builder = GitignoreBuilder::new(root);
    let gitignore_path = root.join(".gitignore");
    if gitignore_path.is_file() {
        // `.add` returns partial per-line errors (e.g. one malformed glob
        // among otherwise-valid ones) and keeps every successfully-parsed
        // glob — treated as best-effort here, mirroring `Gitignore::new`'s
        // own documented stance that I/O/parse errors are not fatal.
        let _ = builder.add(&gitignore_path);
    }
    let exclude_path = root.join(".git").join("info").join("exclude");
    if exclude_path.is_file() {
        let _ = builder.add(&exclude_path);
    }
    builder.build()
}

/// Returns true if `path` is a *root*-level env file (`.env`, `.env.local`,
/// ...) living directly inside `workspace_root`. Mirrors
/// `walk_policy::root_env_files`, which only whitelists root-level env
/// files — a nested gitignored `.env` (e.g. `packages/api/.env`) is a
/// documented limitation of that function, carried through here so
/// `apply_delta` can't admit a path a fresh `walk_files` would exclude.
fn is_root_env_file(path: &str, workspace_root: &Path) -> bool {
    let p = Path::new(path);
    let is_env = p
        .file_name()
        .map(|n| walk_policy::is_env_file(&n.to_string_lossy()))
        .unwrap_or(false);
    is_env && p.parent() == Some(workspace_root)
}

/// Returns true if `path` would be excluded by the workspace's root-level
/// gitignore sources (`gitignore`, from `build_delta_gitignore`) or by
/// `extra_excludes` (`extra_excludes_override`, from
/// `walk_policy::build_extra_excludes_override`) — the same two exclusion
/// sources `walk_files` applies via `policy_walker`/`apply_extra_excludes`,
/// checked here against a single added path instead of during a directory
/// walk.
fn is_path_excluded(
    path: &str,
    workspace_root: &Path,
    gitignore: &Gitignore,
    extra_excludes_override: Option<&Override>,
) -> bool {
    let Ok(rel) = Path::new(path).strip_prefix(workspace_root) else {
        // Not under the workspace root — shouldn't happen for a path that
        // already passed `path_has_always_hidden_segment` (the watcher only
        // ever watches the workspace root and, for linked worktrees, a path
        // segmented by `.git/...` that's already filtered out above). Can't
        // classify it against a workspace-rooted matcher without risking a
        // panic on `matched_path_or_any_parents`' "path is expected to be
        // under the root" assertion, so treat it as not-excluded — no worse
        // than this path's handling before this fix.
        return false;
    };
    if gitignore.matched_path_or_any_parents(rel, false).is_ignore() {
        return true;
    }
    if let Some(overrides) = extra_excludes_override {
        if overrides.matched(rel, false).is_ignore() {
            return true;
        }
    }
    false
}

/// Marks `label`'s current index (if any) stale, forcing the next
/// `fuzzy_search_files` call for that window to do a full, policy-correct
/// rebuild instead of trusting the cached list. No-op if that window has no
/// index built yet — nothing to mark. Every other window's entry is
/// untouched.
///
/// Used by `file_scanner`'s watcher event loop for filesystem changes
/// `apply_delta`'s added/removed-path delta model can't represent at all —
/// e.g. a directory rename, which only delivers directory-path events (no
/// per-file events for the moved subtree), or a `.gitignore`/`.ignore`
/// content edit (`Modify(Data)`, not add/remove) that changes what the
/// walker would include.
pub fn mark_stale(state: &FileIndexState, label: &str) {
    let mut guard = lock_recover(&state.0);
    if let Some(index) = guard.get_mut(label) {
        index.stale = true;
    }
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
///   (`.git`, `.DS_Store` — see `path_has_always_hidden_segment`), skipped if
///   they're excluded by the workspace's root `.gitignore`/`.git/info/exclude`
///   or by `extra_excludes` (see `is_path_excluded` — this is what keeps
///   gitignored/excluded paths, e.g. Unity `Library/`/`Temp/` compiler
///   output, out of the index; see that function and
///   `build_delta_gitignore` for the nested-gitignore/global-gitignore
///   fidelity this deliberately does not attempt), unless the path is a
///   root-level env file (`is_root_env_file` — whitelisted even when
///   gitignored, consistent with `walk_files` always including them), and
///   deduped against both the existing index and the rest of the same
///   batch. If the gitignore matcher itself can't be built (see
///   `build_delta_gitignore`'s error case), no paths are admitted from this
///   batch and the index is marked `stale` instead, so the next
///   `fuzzy_search_files` call does a full, policy-correct rebuild rather
///   than risking an excluded path being admitted.
/// - Removed paths: dropped from the index via a retain filter.
/// - Any added/removed path named `.gitignore` or `.ignore` flips `stale`
///   (see `FileIndex::stale` doc comment) — added/removed paths are still
///   applied in the same call so the index reflects the raw filesystem
///   event even while marked stale; the next `fuzzy_search_files` call
///   discards this best-effort state anyway once it does a full rebuild.
pub fn apply_delta(state: &FileIndexState, label: &str, delta: &FileIndexDelta) {
    // A poisoned mutex (some other thread panicked while holding it) would
    // otherwise permanently break the index for the rest of the session —
    // this is a background watcher task with no way to surface an error to
    // the user, so recovering the guard and continuing best-effort beats
    // silently going dark on every future filesystem change. See
    // `sync_util::lock_recover` for why that's safe for this plain-data
    // state.
    let mut guard = lock_recover(&state.0);
    let Some(index) = guard.get_mut(label) else {
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
        Arc::make_mut(&mut index.files).retain(|f| !removed.contains(f.as_str()));
    }

    if !delta.added.is_empty() {
        let workspace_root = Path::new(&index.workspace_path);
        match build_delta_gitignore(&index.workspace_path) {
            Ok(gitignore) => {
                let extra_excludes_override = walk_policy::build_extra_excludes_override(
                    &index.workspace_path,
                    &index.extra_excludes,
                );
                let to_add: Vec<String> = {
                    let existing: HashSet<&str> = index.files.iter().map(|s| s.as_str()).collect();
                    let mut seen_new: HashSet<&str> = HashSet::new();
                    delta
                        .added
                        .iter()
                        .filter(|p| !path_has_always_hidden_segment(p))
                        .filter(|p| {
                            is_root_env_file(p, workspace_root)
                                || !is_path_excluded(
                                    p,
                                    workspace_root,
                                    &gitignore,
                                    extra_excludes_override.as_ref(),
                                )
                        })
                        .filter(|p| !existing.contains(p.as_str()))
                        .filter(|p| seen_new.insert(p.as_str()))
                        .cloned()
                        .collect()
                };
                if !to_add.is_empty() {
                    Arc::make_mut(&mut index.files).extend(to_add);
                }
            }
            Err(_) => {
                // Matcher couldn't be built confidently for this batch —
                // admit nothing new and force a full rebuild on the next
                // search instead of risking gitignored/excluded paths
                // silently entering the cache (see this function's doc
                // comment and `build_delta_gitignore`'s doc comment).
                index.stale = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed window label used by every single-window test in this module —
    /// only the new "two labels coexist independently" test uses a second
    /// label alongside this one.
    const LABEL: &str = "test-window";

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
        let count =
            build_index(&state, LABEL, tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();
        assert_eq!(count, 2);

        let guard = state.0.lock().unwrap();
        let idx = guard.get(LABEL).unwrap();
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
        build_index(&state, LABEL, tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();

        let guard = state.0.lock().unwrap();
        let files = &guard.get(LABEL).unwrap().files;
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
        build_index(&state, LABEL, tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();

        let guard = state.0.lock().unwrap();
        let files = &guard.get(LABEL).unwrap().files;
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
        build_index(&state, LABEL, tmp1.path().to_str().unwrap().to_string(), vec![]).unwrap();
        build_index(&state, LABEL, tmp2.path().to_str().unwrap().to_string(), vec![]).unwrap();

        let guard = state.0.lock().unwrap();
        let idx = guard.get(LABEL).unwrap();
        assert_eq!(idx.workspace_path, tmp2.path().to_str().unwrap());
        assert_eq!(idx.files.len(), 2);
    }

    // ── FileIndexState: per-label independence (multi-window) ───────────

    #[test]
    fn two_labels_hold_independent_indexes() {
        let tmp_a = tempfile::tempdir().unwrap();
        std::fs::write(tmp_a.path().join("a-only.txt"), "a").unwrap();
        let tmp_b = tempfile::tempdir().unwrap();
        std::fs::write(tmp_b.path().join("b-only.txt"), "b").unwrap();

        let state = FileIndexState::new();
        build_index(&state, "window-a", tmp_a.path().to_str().unwrap().to_string(), vec![])
            .unwrap();
        build_index(&state, "window-b", tmp_b.path().to_str().unwrap().to_string(), vec![])
            .unwrap();

        let guard = state.0.lock().unwrap();
        let idx_a = guard.get("window-a").unwrap();
        let idx_b = guard.get("window-b").unwrap();
        assert_eq!(idx_a.workspace_path, tmp_a.path().to_str().unwrap());
        assert!(idx_a.files.iter().any(|f| f.ends_with("a-only.txt")), "files = {:?}", idx_a.files);
        assert_eq!(idx_b.workspace_path, tmp_b.path().to_str().unwrap());
        assert!(idx_b.files.iter().any(|f| f.ends_with("b-only.txt")), "files = {:?}", idx_b.files);
    }

    // ── mark_stale ──────────────────────────────────────────────────────

    #[test]
    fn mark_stale_sets_stale_on_existing_index() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: "/ws".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec!["/ws/a.txt".to_string()]),
                    stale: false,
                },
            );
        }

        mark_stale(&state, LABEL);

        let guard = state.0.lock().unwrap();
        let idx = guard.get(LABEL).unwrap();
        assert!(idx.stale);
        // Only the flag flips — the cached file list itself is untouched.
        assert_eq!(*idx.files, vec!["/ws/a.txt".to_string()]);
    }

    #[test]
    fn mark_stale_is_noop_when_no_index_built() {
        let state = FileIndexState::new();
        // Should not panic even though there's no entry for this label.
        mark_stale(&state, LABEL);
        assert!(state.0.lock().unwrap().get(LABEL).is_none());
    }

    // ── apply_delta: added ──────────────────────────────────────────────

    #[test]
    fn apply_delta_adds_new_paths() {
        let state = FileIndexState::new();
        build_index(&state, LABEL, "/ws".to_string(), vec![]).unwrap();
        // build_index on a nonexistent "/ws" yields zero files; seed
        // manually isn't needed since apply_delta doesn't require the path
        // to exist on disk (it's a pure in-memory list update).

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec!["/ws/new.txt".to_string()],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        assert_eq!(*guard.get(LABEL).unwrap().files, vec!["/ws/new.txt".to_string()]);
    }

    #[test]
    fn apply_delta_dedups_added_paths_against_existing_and_within_batch() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: "/ws".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec!["/ws/existing.txt".to_string()]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
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
        let files = &guard.get(LABEL).unwrap().files;
        assert_eq!(files.iter().filter(|f| f.as_str() == "/ws/existing.txt").count(), 1);
        assert_eq!(files.iter().filter(|f| f.as_str() == "/ws/new.txt").count(), 1);
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn apply_delta_skips_paths_under_always_hidden_segment() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: "/ws".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
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
        let files = &guard.get(LABEL).unwrap().files;
        assert_eq!(&**files, &vec!["/ws/keep.txt".to_string()], "files = {:?}", files);
    }

    #[test]
    fn apply_delta_allows_env_files() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: "/ws".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec!["/ws/.env".to_string(), "/ws/.env.local".to_string()],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        let files = &guard.get(LABEL).unwrap().files;
        assert!(files.contains(&"/ws/.env".to_string()), "files = {:?}", files);
        assert!(files.contains(&"/ws/.env.local".to_string()), "files = {:?}", files);
    }

    // ── apply_delta: added paths vs. gitignore / extra_excludes (Finding 1)
    //
    // These use a real tempdir (unlike the fake "/ws" paths above) because
    // `build_delta_gitignore` reads an actual `.gitignore` file off disk.

    #[test]
    fn apply_delta_excludes_gitignored_added_path() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), "Library/\n");
        let ws = tmp.path().to_str().unwrap().to_string();

        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: ws.clone(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec![format!("{}/Library/ScriptAssemblies/Foo.dll", ws)],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        let idx = guard.get(LABEL).unwrap();
        assert!(idx.files.is_empty(), "gitignored path should not be admitted: {:?}", idx.files);
        // Only .gitignore/.ignore content changes flip `stale` — an ordinary
        // gitignored path being filtered out must not also mark the index
        // stale (that would force a full rebuild for every Unity recompile).
        assert!(!idx.stale);
    }

    #[test]
    fn apply_delta_excludes_path_matching_extra_excludes() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_str().unwrap().to_string();

        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: ws.clone(),
                    extra_excludes: vec!["Builds/**".to_string()],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec![format!("{}/Builds/Windows/game.exe", ws)],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        let files = &guard.get(LABEL).unwrap().files;
        assert!(
            files.is_empty(),
            "extra_excludes-matched path should not be admitted: {:?}",
            files
        );
    }

    #[test]
    fn apply_delta_admits_env_file_even_when_gitignored() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), ".env\n");
        let ws = tmp.path().to_str().unwrap().to_string();

        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: ws.clone(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec![format!("{}/.env", ws)],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        let files = &guard.get(LABEL).unwrap().files;
        assert!(files.iter().any(|f| f.ends_with(".env")), "files = {:?}", files);
    }

    #[test]
    fn apply_delta_admits_normal_source_file_alongside_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), "Library/\n");
        let ws = tmp.path().to_str().unwrap().to_string();

        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: ws.clone(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec![format!("{}/Assets/Scripts/Player.cs", ws)],
                removed: vec![],
            },
        );

        let guard = state.0.lock().unwrap();
        let files = &guard.get(LABEL).unwrap().files;
        assert!(files.iter().any(|f| f.ends_with("Player.cs")), "files = {:?}", files);
    }

    // ── apply_delta: removed ────────────────────────────────────────────

    #[test]
    fn apply_delta_removes_paths() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: "/ws".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec!["/ws/a.txt".to_string(), "/ws/b.txt".to_string()]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec![],
                removed: vec!["/ws/a.txt".to_string()],
            },
        );

        let guard = state.0.lock().unwrap();
        assert_eq!(*guard.get(LABEL).unwrap().files, vec!["/ws/b.txt".to_string()]);
    }

    #[test]
    fn apply_delta_is_noop_when_no_index_built() {
        let state = FileIndexState::new();
        // Should not panic even though there's no entry for this label.
        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec!["/ws/a.txt".to_string()],
                removed: vec![],
            },
        );
        let guard = state.0.lock().unwrap();
        assert!(guard.get(LABEL).is_none());
    }

    // ── apply_delta: .gitignore / .ignore → stale ──────────────────────

    #[test]
    fn apply_delta_marks_stale_on_gitignore_change() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: "/ws".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec!["/ws/.gitignore".to_string()],
                removed: vec![],
            },
        );

        assert!(state.0.lock().unwrap().get(LABEL).unwrap().stale);
    }

    #[test]
    fn apply_delta_marks_stale_on_ignore_file_removed() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: "/ws".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec!["/ws/.ignore".to_string()]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec![],
                removed: vec!["/ws/.ignore".to_string()],
            },
        );

        assert!(state.0.lock().unwrap().get(LABEL).unwrap().stale);
    }

    #[test]
    fn apply_delta_does_not_mark_stale_for_unrelated_files() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                LABEL.to_string(),
                FileIndex {
                    workspace_path: "/ws".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        apply_delta(
            &state,
            LABEL,
            &FileIndexDelta {
                added: vec!["/ws/normal.txt".to_string()],
                removed: vec![],
            },
        );

        assert!(!state.0.lock().unwrap().get(LABEL).unwrap().stale);
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

    // ── FileIndexState::drop_window ─────────────────────────────────────

    #[test]
    fn drop_window_removes_only_that_label() {
        let state = FileIndexState::new();
        {
            let mut guard = state.0.lock().unwrap();
            guard.insert(
                "window-a".to_string(),
                FileIndex {
                    workspace_path: "/ws-a".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
            guard.insert(
                "window-b".to_string(),
                FileIndex {
                    workspace_path: "/ws-b".to_string(),
                    extra_excludes: vec![],
                    files: Arc::new(vec![]),
                    stale: false,
                },
            );
        }

        state.drop_window("window-a");

        let guard = state.0.lock().unwrap();
        assert!(guard.get("window-a").is_none());
        assert!(guard.get("window-b").is_some(), "window-b's entry must survive");
    }

    #[test]
    fn drop_window_is_idempotent_when_absent() {
        let state = FileIndexState::new();
        // Must not panic when the window never built an index.
        state.drop_window("never-built");
        assert!(state.0.lock().unwrap().is_empty());
    }
}
