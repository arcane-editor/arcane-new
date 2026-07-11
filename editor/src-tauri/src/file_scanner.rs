use crate::walk_policy;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use nucleo_matcher::pattern::{Atom, AtomKind, CaseMatching, Normalization};
use nucleo_matcher::{Matcher, Utf32Str};
use serde::Serialize;
use std::collections::{BinaryHeap, HashSet};
use std::cmp::Ordering;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct FuzzyFileResult {
    pub path: String,
    pub relative_path: String,
    pub file_name: String,
    pub score: u32,
    pub match_indices: Vec<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileIndexDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

// Inspired by VS Code's quick-open ranking strategy:
// - treat file-name (label) matches as primary when query has no path separator
// - treat path (description) matches as secondary
// - boost exact/prefix matches heavily
const PATH_IDENTITY_SCORE: u32 = 1 << 24;
const FILE_STEM_EXACT_SCORE: u32 = 1 << 23;
const FILE_NAME_EXACT_SCORE: u32 = 1 << 22;
const FILE_NAME_PREFIX_SCORE: u32 = 1 << 21;
const FILE_NAME_MATCH_SCORE: u32 = 1 << 20;

// Min-heap entry for top-N selection.
// We reverse score ordering so BinaryHeap::pop removes the *lowest* score.
struct ScoredEntry {
    score: u32,
    has_file_name_match: bool,
    has_prefix_match: bool,
    has_exact_name_match: bool,
    has_exact_stem_match: bool,
    file_name_len: usize,
    path_depth: usize,
    relative_path_len: usize,
    result: FuzzyFileResult,
}

impl PartialEq for ScoredEntry {
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score
            && self.has_file_name_match == other.has_file_name_match
            && self.has_prefix_match == other.has_prefix_match
            && self.has_exact_name_match == other.has_exact_name_match
            && self.has_exact_stem_match == other.has_exact_stem_match
            && self.file_name_len == other.file_name_len
            && self.path_depth == other.path_depth
            && self.relative_path_len == other.relative_path_len
            && self.result.path == other.result.path
    }
}
impl Eq for ScoredEntry {}

impl PartialOrd for ScoredEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ScoredEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse by score/flags for min-heap behavior; better entries are "smaller".
        other
            .score
            .cmp(&self.score)
            .then_with(|| other.has_exact_stem_match.cmp(&self.has_exact_stem_match))
            .then_with(|| other.has_exact_name_match.cmp(&self.has_exact_name_match))
            .then_with(|| other.has_prefix_match.cmp(&self.has_prefix_match))
            .then_with(|| other.has_file_name_match.cmp(&self.has_file_name_match))
            .then_with(|| self.file_name_len.cmp(&other.file_name_len))
            .then_with(|| self.path_depth.cmp(&other.path_depth))
            .then_with(|| self.relative_path_len.cmp(&other.relative_path_len))
            .then_with(|| self.result.path.cmp(&other.result.path))
    }
}

// ── Git-state path detection ────────────────────────────────────────────────

/// Returns true if `path_str` points at a git ref-like file (HEAD or a branch
/// pointer). Used to trigger an instant branch-name refresh on `git checkout`
/// from outside the app — e.g., in the integrated terminal.
fn is_git_state_path(path_str: &str) -> bool {
    let normalized = path_str.replace('\\', "/");
    normalized.ends_with("/.git/HEAD")
        || normalized.contains("/.git/refs/heads/")
        || normalized.contains("/.git/refs/remotes/")
        || normalized.contains("/.git/refs/tags/")
        || normalized.ends_with("/.git/packed-refs")
}

/// If `<ws_path>/.git` is a `gitdir:` pointer file (i.e. `ws_path` is a linked
/// git worktree, not the main repo), return the real git dir it points at —
/// typically `<main-repo>/.git/worktrees/<name>`. That directory holds the
/// worktree's own HEAD/refs and lives outside the watched workspace root, so
/// callers use this to watch it in addition to the workspace root. Returns
/// `None` for a normal repo (`.git` is a directory) or no `.git` at all.
///
/// The returned path is canonicalized: relative `gitdir:` pointers are
/// resolved lexically first (join keeps `..` components as-is), but `notify`
/// on macOS delivers watch-event paths fully resolved (no `..`, symlinks
/// resolved — e.g. `/var` → `/private/var`). Without canonicalizing here, the
/// prefix match against watch-event paths in `is_git_state_path_in_dir` would
/// never fire for relative-pointer worktrees. Falls back to the
/// un-canonicalized path if canonicalize fails (e.g. an odd setup where the
/// target doesn't exist yet) so callers still get a best-effort value instead
/// of losing the git dir entirely.
fn resolve_linked_git_dir(ws_path: &str) -> Option<std::path::PathBuf> {
    let dot_git = std::path::Path::new(ws_path).join(".git");
    if !dot_git.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(&dot_git).ok()?;
    let gitdir = content.strip_prefix("gitdir:")?.trim();
    let p = std::path::PathBuf::from(gitdir);
    let resolved = if p.is_absolute() {
        p
    } else {
        std::path::Path::new(ws_path).join(p)
    };
    Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

/// Returns true if `path_str` is a git-state file under `git_dir` — the
/// resolved linked-worktree git dir from `resolve_linked_git_dir`. Mirrors
/// `is_git_state_path`'s ref/HEAD/packed-refs matching, but scoped to an
/// arbitrary directory (the worktree gitdir isn't named `.git` and doesn't
/// live under the workspace root, so the `/.git/...` suffix checks above
/// don't apply here).
///
/// The prefix match requires a path-component boundary (a trailing `/` after
/// `git_dir`, or exact equality) — a raw `starts_with` would false-positive on
/// a sibling worktree dir that shares a name prefix, e.g. `git_dir` =
/// `.../worktrees/feature` matching `.../worktrees/feature-backup/...`.
fn is_git_state_path_in_dir(path_str: &str, git_dir: &str) -> bool {
    let normalized = path_str.replace('\\', "/");
    let normalized_dir = git_dir.replace('\\', "/");
    let normalized_dir = normalized_dir.trim_end_matches('/');
    let prefix = format!("{}/", normalized_dir);
    if normalized != normalized_dir && !normalized.starts_with(&prefix) {
        return false;
    }
    normalized.ends_with("/HEAD")
        || normalized.contains("/refs/")
        || normalized.ends_with("/packed-refs")
}

fn query_contains_path_separator(query: &str) -> bool {
    query.contains('/') || query.contains('\\')
}

// ── File Watcher State ──────────────────────────────────────────────────────

pub struct FileWatcherState {
    pub watcher: Option<RecommendedWatcher>,
    _shutdown_tx: Option<mpsc::Sender<()>>,
}

impl FileWatcherState {
    pub fn new() -> Self {
        Self {
            watcher: None,
            _shutdown_tx: None,
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Scan all files respecting .gitignore, with optional extra exclude patterns.
///
/// Uses the shared `walk_policy` module (dotfiles visible except
/// `.git`/`.DS_Store`, `.gitignore` respected) and appends root-level
/// `.env`/`.env.*` files the walker didn't already yield (they're
/// whitelisted even when gitignored — see `walk_policy::root_env_files`).
#[tauri::command]
pub fn scan_all_files_v2(
    workspace_path: String,
    extra_excludes: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut builder = walk_policy::policy_walker(&workspace_path);
    walk_policy::apply_extra_excludes(&mut builder, &workspace_path, &extra_excludes);

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
    let extra_env_files: Vec<String> = walk_policy::root_env_files(Path::new(&workspace_path))
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|s| !seen.contains(s.as_str()))
        .collect();
    drop(seen);
    files.extend(extra_env_files);

    Ok(files)
}

/// Fuzzy search files in workspace. Returns top N matches.
/// This runs entirely in Rust — no JS main thread blocking.
#[tauri::command]
pub fn fuzzy_search_files(
    workspace_path: String,
    query: String,
    max_results: usize,
    extra_excludes: Vec<String>,
    file_extensions: Option<Vec<String>>,
) -> Result<Vec<FuzzyFileResult>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }

    let max_results = if max_results == 0 { 100 } else { max_results };

    // Build the file list using the shared policy walker (dotfiles visible
    // except .git/.DS_Store, .gitignore respected) plus caller-supplied
    // exclude globs.
    let mut builder = walk_policy::policy_walker(&workspace_path);
    walk_policy::apply_extra_excludes(&mut builder, &workspace_path, &extra_excludes);

    // Set up nucleo matcher
    let mut matcher = Matcher::new(nucleo_matcher::Config::DEFAULT.match_paths());
    let path_atom = Atom::new(
        &query,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Fuzzy,
        false,
    );
    let file_name_atom = Atom::new(
        &query,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Fuzzy,
        false,
    );

    let query_lower = query.to_lowercase();
    let query_path_normalized = query_lower.replace('\\', "/");
    let query_char_count = query.chars().count();
    let prefer_file_name = !query_contains_path_separator(&query);

    let workspace_prefix = if workspace_path.ends_with('/') {
        workspace_path.clone()
    } else {
        format!("{}/", workspace_path)
    };

    // Use a min-heap to keep top N results
    let mut heap: BinaryHeap<ScoredEntry> = BinaryHeap::with_capacity(max_results + 1);

    // Root .env / .env.* files are whitelisted even when gitignored (the
    // policy walker can't re-include a gitignore-pruned path). Track them
    // here and drop any the walker itself already yields below, so a
    // non-gitignored .env is scored exactly once, not twice.
    let mut pending_env_files: HashSet<String> =
        walk_policy::root_env_files(Path::new(&workspace_path))
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();

    // Scores and (maybe) pushes a single absolute path into `heap`. Shared
    // by both the walker loop and the root-env-file whitelist pass below so
    // gitignored `.env` files are ranked identically to normal matches.
    let score_and_push = |abs_path: String, matcher: &mut Matcher, heap: &mut BinaryHeap<ScoredEntry>| {
        // Extension filter (cheap; happens before fuzzy match)
        if let Some(ref exts) = file_extensions {
            if !exts.is_empty() {
                let ext_ok = Path::new(&abs_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
                    .unwrap_or(false);
                if !ext_ok {
                    return;
                }
            }
        }

        let relative_path = if abs_path.starts_with(&workspace_prefix) {
            abs_path[workspace_prefix.len()..].to_string()
        } else {
            abs_path.clone()
        };

        // Convert to Utf32Str for path matching first. If even path doesn't
        // match, file-name cannot rescue this entry because file-name is part
        // of relative_path.
        let mut path_buf = Vec::new();
        let path_haystack = Utf32Str::new(&relative_path, &mut path_buf);
        let Some(path_score) = path_atom.score(path_haystack, matcher) else {
            return;
        };

        let file_name = Path::new(&abs_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let mut file_name_buf = Vec::new();
        let file_name_haystack = Utf32Str::new(&file_name, &mut file_name_buf);
        let file_name_score = file_name_atom.score(file_name_haystack, matcher);

        let file_name_lower = file_name.to_lowercase();
        let file_stem_lower = Path::new(&file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        let has_file_name_match = file_name_score.is_some();
        let has_prefix_match = file_name_lower.starts_with(&query_lower);
        let has_exact_name_match = file_name_lower == query_lower;
        let has_exact_stem_match = file_stem_lower == query_lower;
        let relative_path_lower = relative_path.replace('\\', "/").to_lowercase();
        let has_path_identity_match = relative_path_lower == query_path_normalized;

        // Base on path score, then apply a VS Code-like "label first"
        // ranking policy when the user is not typing a path query.
        let mut score = path_score as u32;
        if let Some(file_score) = file_name_score {
            if prefer_file_name {
                score = score.saturating_add(FILE_NAME_MATCH_SCORE);
                score = score.saturating_add((file_score as u32).saturating_mul(8));
            } else {
                score = score.saturating_add((file_score as u32).saturating_mul(2));
            }
        }

        if has_prefix_match {
            let file_name_len = file_name.chars().count().max(1);
            let prefix_coverage_boost =
                ((query_char_count.min(file_name_len) * 100) / file_name_len) as u32;
            if prefer_file_name {
                score = score.saturating_add(FILE_NAME_PREFIX_SCORE + prefix_coverage_boost);
            } else {
                score = score.saturating_add((FILE_NAME_PREFIX_SCORE / 256) + prefix_coverage_boost);
            }
        }

        if has_exact_name_match {
            score = score.saturating_add(FILE_NAME_EXACT_SCORE);
        }
        if has_exact_stem_match {
            score = score.saturating_add(FILE_STEM_EXACT_SCORE);
        }
        if has_path_identity_match {
            score = score.saturating_add(PATH_IDENTITY_SCORE);
        }

        // Match indices are for relative_path highlighting in the UI.
        let mut indices = Vec::new();
        path_atom.indices(path_haystack, matcher, &mut indices);
        indices.sort();
        indices.dedup();

        let result = FuzzyFileResult {
            path: abs_path,
            relative_path,
            file_name,
            score,
            match_indices: indices,
        };

        let path_depth = result
            .relative_path
            .bytes()
            .filter(|b| *b == b'/' || *b == b'\\')
            .count();

        heap.push(ScoredEntry {
            score,
            has_file_name_match,
            has_prefix_match,
            has_exact_name_match,
            has_exact_stem_match,
            file_name_len: result.file_name.chars().count(),
            path_depth,
            relative_path_len: result.relative_path.chars().count(),
            result,
        });

        // If we exceed max, drop the lowest-ranked entry.
        if heap.len() > max_results {
            heap.pop();
        }
    };

    for entry in builder.build() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().map_or(false, |ft| ft.is_file()) {
            continue;
        }

        let abs_path = entry.path().to_string_lossy().to_string();
        // Already yielded by the walker (not gitignored) — no need to add
        // it again from the whitelist pass below.
        pending_env_files.remove(&abs_path);
        score_and_push(abs_path, &mut matcher, &mut heap);
    }

    // Whitelist pass: any root .env / .env.* file the walker didn't yield
    // (because it's gitignored) still gets scored and ranked like any other
    // match — see walk_policy module docs for why this is root-only.
    for env_path in pending_env_files {
        score_and_push(env_path, &mut matcher, &mut heap);
    }

    // Extract + order by score descending for UI consumption.
    let mut entries: Vec<ScoredEntry> = heap.into_vec();
    entries.sort_unstable_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.has_exact_stem_match.cmp(&a.has_exact_stem_match))
            .then_with(|| b.has_exact_name_match.cmp(&a.has_exact_name_match))
            .then_with(|| b.has_prefix_match.cmp(&a.has_prefix_match))
            .then_with(|| b.has_file_name_match.cmp(&a.has_file_name_match))
            .then_with(|| a.file_name_len.cmp(&b.file_name_len))
            .then_with(|| a.path_depth.cmp(&b.path_depth))
            .then_with(|| a.relative_path_len.cmp(&b.relative_path_len))
            .then_with(|| a.result.relative_path.cmp(&b.result.relative_path))
    });

    let results = entries.into_iter().map(|e| e.result).collect();

    Ok(results)
}

/// Start watching a workspace directory for file changes.
/// Emits `file-index-changed` Tauri events with delta payloads.
#[tauri::command]
pub async fn start_file_watcher(
    app: AppHandle,
    workspace_path: String,
) -> Result<(), String> {
    let state = app.state::<Mutex<FileWatcherState>>();
    let mut state = state.lock().map_err(|e| e.to_string())?;

    // Stop existing watcher if any
    state.watcher = None;
    state._shutdown_tx = None;

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let app_handle = app.clone();
    let ws_path = workspace_path.clone();

    // Linked git worktrees keep `<ws>/.git` as a `gitdir:` pointer file; the
    // real HEAD/refs live in the main repo's `.git/worktrees/<name>/`, outside
    // the workspace root we watch below. Resolve it up front so the event
    // loop can recognize git-state changes there too.
    let linked_git_dir = resolve_linked_git_dir(&ws_path);
    let linked_git_dir_str = linked_git_dir
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());

    // Debounce channel: collect events, emit after 500ms quiet period
    let (event_tx, mut event_rx) = mpsc::channel::<Event>(256);

    let watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = event_tx.blocking_send(event);
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    // Spawn debounce task
    let app_for_debounce = app_handle.clone();
    tokio::spawn(async move {
        let mut pending_added: Vec<String> = Vec::new();
        let mut pending_removed: Vec<String> = Vec::new();
        // Leading-edge dedup so one `git checkout` (which rewrites HEAD, index,
        // refs/heads/<branch>, logs/HEAD all in ~10ms) fires git-state-changed
        // once, not 5+ times.
        let mut last_git_emit: Option<std::time::Instant> = None;

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => break,
                event = event_rx.recv() => {
                    match event {
                        Some(event) => {
                            let mut git_state_touched = false;
                            for path in &event.paths {
                                let path_str = path.to_string_lossy().to_string();
                                if is_git_state_path(&path_str)
                                    || linked_git_dir_str.as_deref().is_some_and(|d| {
                                        is_git_state_path_in_dir(&path_str, d)
                                    })
                                {
                                    git_state_touched = true;
                                }
                                match event.kind {
                                    notify::EventKind::Create(_) => {
                                        if path.is_file() {
                                            pending_added.push(path_str);
                                        }
                                    }
                                    notify::EventKind::Remove(_) => {
                                        pending_removed.push(path_str);
                                    }
                                    notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                                        // Rename: treat as remove old + add new
                                        if path.exists() && path.is_file() {
                                            pending_added.push(path_str);
                                        } else {
                                            pending_removed.push(path_str);
                                        }
                                    }
                                    _ => {}
                                }
                            }

                            // Fire git-state-changed immediately on the first
                            // event in a burst, then suppress for 100ms so the
                            // remaining events in the same checkout don't spam
                            // refreshStatus invocations.
                            if git_state_touched {
                                let now = std::time::Instant::now();
                                let should_emit = last_git_emit
                                    .map(|t| now.duration_since(t).as_millis() >= 100)
                                    .unwrap_or(true);
                                if should_emit {
                                    let _ = app_for_debounce.emit("git-state-changed", ());
                                    last_git_emit = Some(now);
                                }
                            }

                            // Debounce: wait 500ms for more events
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                            // Drain any remaining events in the channel. Git-state
                            // paths seen here DO count toward `git_state_touched`:
                            // a `git checkout` can still be rewriting HEAD/refs when
                            // the leading-edge emit above fires, so that emit can
                            // race a not-yet-updated HEAD. Folding drained git-state
                            // events into the same `git_state_touched` flag lets the
                            // trailing re-emit below correct for that once the whole
                            // burst has settled.
                            while let Ok(event) = event_rx.try_recv() {
                                for path in &event.paths {
                                    let path_str = path.to_string_lossy().to_string();
                                    if is_git_state_path(&path_str)
                                        || linked_git_dir_str.as_deref().is_some_and(|d| {
                                            is_git_state_path_in_dir(&path_str, d)
                                        })
                                    {
                                        git_state_touched = true;
                                    }
                                    match event.kind {
                                        notify::EventKind::Create(_) => {
                                            if path.is_file() {
                                                pending_added.push(path_str);
                                            }
                                        }
                                        notify::EventKind::Remove(_) => {
                                            pending_removed.push(path_str);
                                        }
                                        notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                                            if path.exists() && path.is_file() {
                                                pending_added.push(path_str);
                                            } else {
                                                pending_removed.push(path_str);
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }

                            // Trailing re-emit: if the burst (leading batch or
                            // drain) touched git state, fire once more now that
                            // the burst has fully settled — this is the read
                            // that's guaranteed to see the post-checkout HEAD,
                            // correcting for the race above. Reset `last_git_emit`
                            // so this emit isn't itself swallowed by the 100ms
                            // dedup window (at this point >=500ms have elapsed
                            // since any leading-edge emit) and so an unrelated
                            // burst that starts right after gets its own fresh
                            // dedup window. This runs once per burst — it's
                            // outside the drain `while` loop — so it can't fire
                            // once per drained event.
                            if git_state_touched {
                                let _ = app_for_debounce.emit("git-state-changed", ());
                                last_git_emit = Some(std::time::Instant::now());
                            }

                            if !pending_added.is_empty() || !pending_removed.is_empty() {
                                let delta = FileIndexDelta {
                                    added: std::mem::take(&mut pending_added),
                                    removed: std::mem::take(&mut pending_removed),
                                };
                                let _ = app_for_debounce.emit("file-index-changed", &delta);
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    // Start watching
    let mut watcher = watcher;
    watcher
        .watch(Path::new(&ws_path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch: {}", e))?;

    // Also watch the linked worktree's real git dir (tiny — a handful of
    // files) so branch switches inside a worktree emit `git-state-changed`
    // too. Non-fatal on failure: the main repo's `.git` can sit outside
    // sandbox scope in unusual setups, and losing just this fast path still
    // leaves normal-repo git-state detection working.
    if let Some(ref git_dir) = linked_git_dir {
        if let Err(e) = watcher.watch(git_dir, RecursiveMode::Recursive) {
            eprintln!(
                "[file_scanner] Failed to watch linked git dir {:?}: {}",
                git_dir, e
            );
        }
    }

    state.watcher = Some(watcher);
    state._shutdown_tx = Some(shutdown_tx);

    Ok(())
}

/// Stop the file watcher.
#[tauri::command]
pub async fn stop_file_watcher(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<FileWatcherState>>();
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.watcher = None;
    state._shutdown_tx = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use nucleo_matcher::pattern::{Atom, AtomKind, CaseMatching, Normalization};
    use nucleo_matcher::{Matcher, Utf32Str};

    /// Returns true if `query` fuzzy-matches `haystack` under the given casing.
    /// Mirrors the gate in `fuzzy_search_files`: an entry whose path fails to
    /// match is dropped before any ranking applies.
    fn matches(case: CaseMatching, query: &str, haystack: &str) -> bool {
        let mut m = Matcher::new(nucleo_matcher::Config::DEFAULT.match_paths());
        let atom = Atom::new(query, case, Normalization::Smart, AtomKind::Fuzzy, false);
        let mut buf = Vec::new();
        atom.score(Utf32Str::new(haystack, &mut buf), &mut m).is_some()
    }

    // Documents the bug: nucleo's Smart case is per-pattern — any uppercase in
    // the query forces case-sensitive matching, so the lowercase `a` in
    // "IITapplication" can't match the `A` in "IITApplication.cs" and the file
    // is dropped from results entirely.
    #[test]
    fn smart_case_drops_pascalcase_name_match() {
        assert!(!matches(CaseMatching::Smart, "IITapplication", "Assets/IITApplication.cs"));
    }

    // Proves the fix: Ignore casing finds the PascalCase file regardless of how
    // the user cased the query, so the existing exact-stem bonus can rank it first.
    #[test]
    fn ignore_case_keeps_pascalcase_name_match() {
        assert!(matches(CaseMatching::Ignore, "IITapplication", "Assets/IITApplication.cs"));
    }

    // ── resolve_linked_git_dir ───────────────────────────────────────────

    use super::{is_git_state_path_in_dir, resolve_linked_git_dir};

    #[test]
    fn resolve_linked_git_dir_none_for_real_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        assert_eq!(resolve_linked_git_dir(tmp.path().to_str().unwrap()), None);
    }

    #[test]
    fn resolve_linked_git_dir_none_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(resolve_linked_git_dir(tmp.path().to_str().unwrap()), None);
    }

    #[test]
    fn resolve_linked_git_dir_resolves_absolute_pointer() {
        let tmp = tempfile::tempdir().unwrap();
        let real_git_dir = tmp.path().join("main-repo/.git/worktrees/feature");
        std::fs::create_dir_all(&real_git_dir).unwrap();
        let ws = tmp.path().join("worktree-ws");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(
            ws.join(".git"),
            format!("gitdir: {}\n", real_git_dir.display()),
        )
        .unwrap();

        // Compare against the canonicalized form: on macOS tempfile dirs live
        // under /var, which canonicalizes to /private/var, so a raw
        // `real_git_dir` would not equal what `notify` delivers at watch time.
        let expected = std::fs::canonicalize(&real_git_dir).unwrap();
        assert_eq!(
            resolve_linked_git_dir(ws.to_str().unwrap()),
            Some(expected)
        );
    }

    #[test]
    fn resolve_linked_git_dir_resolves_relative_pointer() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("worktree-ws");
        std::fs::create_dir_all(&ws).unwrap();
        // The target must actually exist for canonicalize() to succeed —
        // otherwise resolve_linked_git_dir falls back to the un-normalized
        // (lexically-joined, `..`-containing) path, which is the bug this
        // test pins the fix for.
        let real_git_dir = tmp.path().join("main/.git/worktrees/feature");
        std::fs::create_dir_all(&real_git_dir).unwrap();
        std::fs::write(ws.join(".git"), "gitdir: ../main/.git/worktrees/feature\n").unwrap();

        let expected = std::fs::canonicalize(&real_git_dir).unwrap();
        assert_eq!(
            resolve_linked_git_dir(ws.to_str().unwrap()),
            Some(expected)
        );
    }

    // ── is_git_state_path_in_dir ─────────────────────────────────────────

    const WORKTREE_GITDIR: &str = "/main-repo/.git/worktrees/feature";

    #[test]
    fn is_git_state_path_in_dir_matches_head() {
        assert!(is_git_state_path_in_dir(
            "/main-repo/.git/worktrees/feature/HEAD",
            WORKTREE_GITDIR
        ));
    }

    #[test]
    fn is_git_state_path_in_dir_matches_refs() {
        assert!(is_git_state_path_in_dir(
            "/main-repo/.git/worktrees/feature/refs/heads/main",
            WORKTREE_GITDIR
        ));
    }

    #[test]
    fn is_git_state_path_in_dir_matches_packed_refs() {
        assert!(is_git_state_path_in_dir(
            "/main-repo/.git/worktrees/feature/packed-refs",
            WORKTREE_GITDIR
        ));
    }

    #[test]
    fn is_git_state_path_in_dir_rejects_paths_outside_dir() {
        assert!(!is_git_state_path_in_dir(
            "/main-repo/.git/worktrees/other/HEAD",
            WORKTREE_GITDIR
        ));
    }

    #[test]
    fn is_git_state_path_in_dir_rejects_unrelated_file_inside_dir() {
        assert!(!is_git_state_path_in_dir(
            "/main-repo/.git/worktrees/feature/index",
            WORKTREE_GITDIR
        ));
    }

    // A sibling worktree dir name that shares `git_dir` as a string prefix
    // (but not as a path-component prefix) must not false-positive.
    #[test]
    fn is_git_state_path_in_dir_rejects_sibling_dir_name_prefix() {
        assert!(!is_git_state_path_in_dir(
            "/main-repo/.git/worktrees/feature-backup/refs/heads/x",
            WORKTREE_GITDIR
        ));
    }

    // ── scan_all_files_v2 / fuzzy_search_files — walk_policy wiring ───────
    //
    // These pin the interim wiring described in walk_policy's module docs:
    // .git is never surfaced, non-gitignored dotfiles are visible, and a
    // gitignored root .env is whitelisted exactly once (no duplicate when
    // the walker itself would already yield it).

    use super::{fuzzy_search_files, scan_all_files_v2};

    fn init_git_repo_with_gitignore(root: &std::path::Path, gitignore_body: &str) {
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), gitignore_body).unwrap();
    }

    #[test]
    fn scan_all_files_v2_never_yields_git_internals() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), "");
        std::fs::write(tmp.path().join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(tmp.path().join("visible.txt"), "hi\n").unwrap();

        let files = scan_all_files_v2(tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();

        assert!(files.iter().any(|f| f.ends_with("visible.txt")), "files = {:?}", files);
        // Substring check must be path-component-aware: ".gitignore" itself
        // is a legitimate result and literally contains the substring
        // ".git", so a bare `contains(".git")` would false-positive on it.
        assert!(
            !files.iter().any(|f| f.contains("/.git/")),
            "files should never contain .git internals: {:?}",
            files
        );
    }

    #[test]
    fn scan_all_files_v2_whitelists_gitignored_root_env_without_duplicating() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), ".env\nsecret.txt\n");
        std::fs::write(tmp.path().join(".env"), "A=1\n").unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "shh\n").unwrap();
        std::fs::write(tmp.path().join("visible.txt"), "hi\n").unwrap();

        let files = scan_all_files_v2(tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();

        let env_matches: Vec<&String> = files.iter().filter(|f| f.ends_with(".env")).collect();
        assert_eq!(env_matches.len(), 1, "expected .env exactly once, got {:?}", files);
        assert!(!files.iter().any(|f| f.ends_with("secret.txt")), "files = {:?}", files);
        assert!(files.iter().any(|f| f.ends_with("visible.txt")), "files = {:?}", files);
    }

    #[test]
    fn scan_all_files_v2_does_not_duplicate_non_gitignored_env_file() {
        let tmp = tempfile::tempdir().unwrap();
        // No .gitignore rule for .env — the walker itself yields it, so the
        // root_env_files append pass must not add a second copy.
        init_git_repo_with_gitignore(tmp.path(), "");
        std::fs::write(tmp.path().join(".env"), "A=1\n").unwrap();

        let files = scan_all_files_v2(tmp.path().to_str().unwrap().to_string(), vec![]).unwrap();

        let env_matches: Vec<&String> = files.iter().filter(|f| f.ends_with(".env")).collect();
        assert_eq!(env_matches.len(), 1, "expected .env exactly once, got {:?}", files);
    }

    #[test]
    fn fuzzy_search_files_finds_gitignored_root_env_file() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), ".env\n");
        std::fs::write(tmp.path().join(".env"), "A=1\n").unwrap();
        std::fs::write(tmp.path().join("other.txt"), "hi\n").unwrap();

        let results = fuzzy_search_files(
            tmp.path().to_str().unwrap().to_string(),
            ".env".to_string(),
            10,
            vec![],
            None,
        )
        .unwrap();

        assert_eq!(
            results.iter().filter(|r| r.file_name == ".env").count(),
            1,
            "expected exactly one .env match, got {:?}",
            results.iter().map(|r| &r.file_name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn fuzzy_search_files_never_yields_git_internals() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo_with_gitignore(tmp.path(), "");
        std::fs::write(tmp.path().join(".git").join("config"), "[core]\n").unwrap();

        let results = fuzzy_search_files(
            tmp.path().to_str().unwrap().to_string(),
            "config".to_string(),
            10,
            vec![],
            None,
        )
        .unwrap();

        assert!(
            !results.iter().any(|r| r.path.contains("/.git/")),
            "results should never contain .git internals: {:?}",
            results
        );
    }
}
