use serde::{Deserialize, Serialize};
use std::fs;
use walkdir::WalkDir;

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};
use ignore::WalkState;
use tauri::{AppHandle, Emitter, State};

use crate::walk_policy;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line_number: usize,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub results: Vec<FileSearchResult>,
    pub total_matches: usize,
    pub file_count: usize,
    pub truncated: bool,
}

#[tauri::command]
pub fn search_in_files(
    workspace_path: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include_pattern: Option<String>,
    exclude_pattern: Option<String>,
    file_extensions: Option<Vec<String>>,
) -> Result<SearchResults, String> {
    let skip_dirs: &[&str] = &["node_modules", "target", ".git", "dist", "build", ".next", ".nuxt"];
    let max_matches = 10_000usize;

    let matcher: Box<dyn Fn(&str) -> Vec<(usize, usize)> + Send> = if is_regex {
        let pattern = if case_sensitive {
            regex::Regex::new(&query)
        } else {
            regex::RegexBuilder::new(&query).case_insensitive(true).build()
        }.map_err(|e| e.to_string())?;
        Box::new(move |line: &str| {
            pattern.find_iter(line).map(|m| (m.start(), m.end())).collect()
        })
    } else {
        let q = if case_sensitive { query.clone() } else { query.to_lowercase() };
        let cs = case_sensitive;
        Box::new(move |line: &str| {
            let haystack = if cs { line.to_string() } else { line.to_lowercase() };
            let mut positions = Vec::new();
            let mut start = 0;
            while let Some(pos) = haystack[start..].find(&q) {
                let abs = start + pos;
                if whole_word {
                    let before_ok = abs == 0 || !haystack.as_bytes()[abs - 1].is_ascii_alphanumeric();
                    let after_ok = abs + q.len() >= haystack.len() || !haystack.as_bytes()[abs + q.len()].is_ascii_alphanumeric();
                    if before_ok && after_ok {
                        positions.push((abs, abs + q.len()));
                    }
                } else {
                    positions.push((abs, abs + q.len()));
                }
                start = abs + 1;
            }
            positions
        })
    };

    let include_glob = include_pattern.as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| glob::Pattern::new(p))
        .transpose().map_err(|e| e.to_string())?;
    let exclude_glob = exclude_pattern.as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| glob::Pattern::new(p))
        .transpose().map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    let mut total_matches = 0usize;
    let mut truncated = false;

    for entry in WalkDir::new(&workspace_path)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                if name.starts_with('.') { return false; }
                if skip_dirs.contains(&name.as_ref()) { return false; }
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if total_matches >= max_matches { truncated = true; break; }
        if entry.file_type().is_dir() { continue; }

        let path_str = entry.path().to_string_lossy().to_string();
        let rel = path_str.strip_prefix(&workspace_path).unwrap_or(&path_str).trim_start_matches('/');

        if let Some(ref pat) = include_glob {
            if !pat.matches(rel) { continue; }
        }
        if let Some(ref pat) = exclude_glob {
            if pat.matches(rel) { continue; }
        }

        // Extension filter (cheap; happens before file read)
        if let Some(ref exts) = file_extensions {
            if !exts.is_empty() {
                let ext_matches = entry.path().extension()
                    .and_then(|e| e.to_str())
                    .map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
                    .unwrap_or(false);
                if !ext_matches { continue; }
            }
        }

        let content = match fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut file_matches = Vec::new();
        for (line_num, line) in content.lines().enumerate() {
            let positions = matcher(line);
            for (ms, me) in positions {
                file_matches.push(SearchMatch {
                    line_number: line_num + 1,
                    line_content: line.to_string(),
                    match_start: ms,
                    match_end: me,
                });
                total_matches += 1;
                if total_matches >= max_matches { truncated = true; break; }
            }
            if truncated { break; }
        }

        if !file_matches.is_empty() {
            results.push(FileSearchResult { path: path_str, matches: file_matches });
        }
        if truncated { break; }
    }

    let file_count = results.len();
    Ok(SearchResults { results, total_matches, file_count, truncated })
}

// ════════════════════════════════════════════════════════════════════════════
// Streaming, cancellable content search (Task B2)
//
// A parallel replacement for `search_in_files` built on ripgrep internals
// (`grep-searcher`/`grep-regex`/`grep-matcher` + `globset`). It never blocks
// the caller: `start_content_search` validates up front (the ONLY synchronous
// error path — invalid regex or glob) then spawns worker threads and returns
// immediately. Results stream to the frontend via `search-results-batch`
// window events, terminated by exactly one `search-complete`.
//
// Cancellation is frontend-driven (decision D2): the frontend supplies a
// monotonic `search_id`; the backend keeps the most recent one in an
// `AtomicU64`. A worker whose id no longer equals `latest` quits. A newer
// `start_content_search` supersedes older runs automatically;
// `cancel_content_search` stops a run without starting a new one.
//
// Event payloads are camelCase (see `SearchResultsBatch` / `SearchComplete`).
// Match offsets (`matchStart`/`matchEnd`) are UTF-16 code-unit offsets *within
// `lineContent`* so the frontend's `String.prototype.slice` highlighting is
// correct on non-ASCII lines. `lineStart` is the UTF-16 offset in the original
// (untrimmed) line at which `lineContent` begins — 0 unless the line was
// preview-trimmed — so the true editor column is `lineStart + matchStart`.
// ════════════════════════════════════════════════════════════════════════════

const EVENT_BATCH: &str = "search-results-batch";
const EVENT_COMPLETE: &str = "search-complete";

/// Emit batches after this many buffered files or after `BATCH_INTERVAL`,
/// whichever comes first.
const BATCH_MAX_FILES: usize = 50;
const BATCH_INTERVAL: Duration = Duration::from_millis(40);

/// Lines longer than this (in chars) are preview-trimmed to a window around the
/// match so the UI isn't handed a multi-KB minified line.
const PREVIEW_MAX_CHARS: usize = 500;
/// Chars of leading context to keep before the match when trimming.
const PREVIEW_CONTEXT_BEFORE: usize = 40;

fn default_max_total_matches() -> usize {
    10_000
}
fn default_max_matches_per_file() -> usize {
    200
}

/// Frontend-managed cancellation cursor. `latest` holds the id of the most
/// recent search; any worker whose id differs quits. Managed in `lib.rs` via
/// `.manage(ContentSearchState::new())`.
pub struct ContentSearchState {
    pub latest: Arc<AtomicU64>,
}

impl ContentSearchState {
    pub fn new() -> Self {
        Self {
            latest: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl Default for ContentSearchState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchOptions {
    pub workspace_path: String,
    pub query: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub include_patterns: Vec<String>,
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    #[serde(default)]
    pub file_extensions: Option<Vec<String>>,
    #[serde(default = "default_max_total_matches")]
    pub max_total_matches: usize,
    #[serde(default = "default_max_matches_per_file")]
    pub max_matches_per_file: usize,
}

/// A single match within a line. Field names serialize to camelCase so the
/// existing `SearchPanel` consumer (`lineNumber`/`lineContent`/`matchStart`/
/// `matchEnd`) keeps working unchanged; `lineStart` is additive.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatch {
    pub line_number: usize,
    /// Display text for the line — preview-trimmed for very long lines.
    pub line_content: String,
    /// UTF-16 offset of the match start within `line_content`.
    pub match_start: usize,
    /// UTF-16 offset of the match end within `line_content`.
    pub match_end: usize,
    /// UTF-16 offset in the original line where `line_content` begins
    /// (0 when the line was not trimmed).
    pub line_start: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentFileResult {
    /// Absolute path (the frontend strips the workspace prefix for display and
    /// uses the absolute form to open the file).
    pub path: String,
    pub matches: Vec<ContentSearchMatch>,
    /// Per-file cap (`max_matches_per_file`) was hit — more matches exist.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResultsBatch {
    search_id: u64,
    results: Vec<ContentFileResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchComplete {
    search_id: u64,
    total_matches: usize,
    file_count: usize,
    /// Total-match cap (`max_total_matches`) was hit somewhere in the run.
    truncated: bool,
    /// This run was superseded/cancelled (its id is no longer `latest`); any
    /// buffered results were dropped and no batch events were emitted for them.
    cancelled: bool,
    elapsed_ms: u64,
}

/// Internal event the engine hands to its emit sink. The Tauri command maps
/// these to window events; tests collect them directly.
#[derive(Debug)]
enum ContentEvent {
    Batch(SearchResultsBatch),
    Complete(SearchComplete),
}

/// A validated, ready-to-run search. Building it is the only place synchronous
/// errors originate (bad regex / bad glob).
struct Engine {
    workspace_path: String,
    matcher: RegexMatcher,
    include_set: Option<GlobSet>,
    exclude_set: Option<GlobSet>,
    file_extensions: Option<Vec<String>>,
    max_total_matches: usize,
    max_matches_per_file: usize,
    threads: usize,
}

impl Engine {
    fn build(options: &ContentSearchOptions) -> Result<Engine, String> {
        // Literal queries are escaped so regex metacharacters are matched
        // verbatim; `is_regex` passes the query through untouched.
        let pattern = if options.is_regex {
            options.query.clone()
        } else {
            regex::escape(&options.query)
        };
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(!options.case_sensitive)
            .word(options.whole_word)
            .build(&pattern)
            .map_err(|e| format!("invalid pattern: {}", e))?;

        let include_set = build_globset(&options.include_patterns)?;
        let exclude_set = build_globset(&options.exclude_patterns)?;

        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(1, 12);

        Ok(Engine {
            workspace_path: options.workspace_path.clone(),
            matcher,
            include_set,
            exclude_set,
            file_extensions: options.file_extensions.clone(),
            max_total_matches: options.max_total_matches.max(1),
            max_matches_per_file: options.max_matches_per_file.max(1),
            threads,
        })
    }
}

/// Builds a `GlobSet` from user patterns, or `None` if there are no non-empty
/// patterns. Bare names (no `/`) are expanded so they match at any depth and
/// (for directories) match everything inside — `"x"` → `["x", "**/x",
/// "**/x/**"]`. Patterns containing a `/` are anchored and used verbatim.
/// Matched against workspace-relative, forward-slash paths.
pub fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for p in patterns {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            continue;
        }
        any = true;
        for variant in normalize_glob(trimmed) {
            let glob = Glob::new(&variant).map_err(|e| format!("invalid glob '{}': {}", p, e))?;
            builder.add(glob);
        }
    }
    if !any {
        return Ok(None);
    }
    let set = builder.build().map_err(|e| e.to_string())?;
    Ok(Some(set))
}

fn normalize_glob(pattern: &str) -> Vec<String> {
    if pattern.contains('/') {
        vec![pattern.to_string()]
    } else {
        vec![
            pattern.to_string(),
            format!("**/{}", pattern),
            format!("**/{}/**", pattern),
        ]
    }
}

/// Number of UTF-16 code units in `s[..byte_idx]`. `byte_idx` must be a char
/// boundary (regex match offsets always are). JS slices strings in UTF-16, so
/// this converts Rust byte offsets into the units the frontend expects.
pub fn byte_to_utf16(s: &str, byte_idx: usize) -> usize {
    s[..byte_idx].chars().map(|c| c.len_utf16()).sum()
}

/// Given a newline-stripped line and a match's byte range within it, returns
/// `(display_line, match_start_utf16, match_end_utf16, line_start_utf16)`.
///
/// Short lines pass through untrimmed (`line_start` = 0). Long lines are
/// trimmed to a ~`PREVIEW_MAX_CHARS` window around the match; the returned
/// offsets are relative to `display_line`, and `line_start_utf16` is the UTF-16
/// offset in the original line where the window begins.
fn build_match_preview(line: &str, ms_byte: usize, me_byte: usize) -> (String, usize, usize, usize) {
    let total_chars = line.chars().count();
    if total_chars <= PREVIEW_MAX_CHARS {
        return (
            line.to_string(),
            byte_to_utf16(line, ms_byte),
            byte_to_utf16(line, me_byte),
            0,
        );
    }

    // Char-boundary table: boundaries[i] is the byte offset of char i, with a
    // trailing sentinel at line.len() so a char index maps to a byte range.
    let mut boundaries: Vec<usize> = line.char_indices().map(|(b, _)| b).collect();
    boundaries.push(line.len());
    let idx_of = |b: usize| boundaries.binary_search(&b).unwrap_or_else(|i| i);

    let ms_ci = idx_of(ms_byte);
    let me_ci = idx_of(me_byte);
    let start_ci = ms_ci.saturating_sub(PREVIEW_CONTEXT_BEFORE);
    let mut end_ci = start_ci + PREVIEW_MAX_CHARS;
    if end_ci < me_ci {
        end_ci = me_ci; // never cut off the match itself
    }
    if end_ci > total_chars {
        end_ci = total_chars;
    }

    let start_b = boundaries[start_ci];
    let end_b = boundaries[end_ci];
    let display = line[start_b..end_b].to_string();
    let clamped_me = me_byte.min(end_b);

    let ms16 = byte_to_utf16(&display, ms_byte - start_b);
    let me16 = byte_to_utf16(&display, clamped_me - start_b);
    let line_start16 = byte_to_utf16(line, start_b);
    (display, ms16, me16, line_start16)
}

/// Builds a per-thread searcher: NUL-byte binary detection (skips binaries)
/// and line numbers on (for the UTF8 sink).
fn build_searcher() -> Searcher {
    SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build()
}

/// Searches a single file's `content` with `matcher`, returning up to
/// `max_matches_per_file` matches (with `truncated` set if capped). Pure and
/// AppHandle-free for direct unit testing. `searcher` is reused across files by
/// each worker; `path` is copied verbatim into the result.
pub fn search_file(
    searcher: &mut Searcher,
    matcher: &RegexMatcher,
    path: &str,
    content: &[u8],
    max_matches_per_file: usize,
) -> ContentFileResult {
    let mut matches: Vec<ContentSearchMatch> = Vec::new();
    let mut truncated = false;

    let sink = UTF8(|line_number, line| {
        // The UTF8 sink hands us the line including its terminator.
        let mut content_str = line;
        if let Some(s) = content_str.strip_suffix('\n') {
            content_str = s;
        }
        if let Some(s) = content_str.strip_suffix('\r') {
            content_str = s;
        }

        let mut stop = false;
        let _ = matcher.find_iter(content_str.as_bytes(), |m| {
            if matches.len() >= max_matches_per_file {
                truncated = true;
                stop = true;
                return false; // stop scanning this line
            }
            let (display, ms16, me16, line_start16) =
                build_match_preview(content_str, m.start(), m.end());
            matches.push(ContentSearchMatch {
                line_number: line_number as usize,
                line_content: display,
                match_start: ms16,
                match_end: me16,
                line_start: line_start16,
            });
            true
        });

        if stop {
            Ok(false) // stop searching the file
        } else {
            Ok(true)
        }
    });

    // Errors (e.g. invalid UTF-8 past the first valid region) simply end the
    // file's search; matches found so far are kept.
    let _ = searcher.search_slice(matcher, content, sink);

    ContentFileResult {
        path: path.to_string(),
        matches,
        truncated,
    }
}

fn with_trailing_slash(p: &str) -> String {
    if p.ends_with('/') {
        p.to_string()
    } else {
        format!("{}/", p)
    }
}

fn relativize(abs: &str, ws_prefix: &str) -> String {
    abs.strip_prefix(ws_prefix)
        .unwrap_or(abs)
        .replace('\\', "/")
}

fn passes_filters(engine: &Engine, rel: &str, path: &Path) -> bool {
    if let Some(ref inc) = engine.include_set {
        if !inc.is_match(rel) {
            return false;
        }
    }
    if let Some(ref exc) = engine.exclude_set {
        if exc.is_match(rel) {
            return false;
        }
    }
    if let Some(ref exts) = engine.file_extensions {
        if !exts.is_empty() {
            let ok = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
                .unwrap_or(false);
            if !ok {
                return false;
            }
        }
    }
    true
}

/// Reads + searches `abs_path`, sends any result, and updates the shared total
/// counter. Returns `Quit` when the total cap is reached or the channel is
/// closed, else `Continue`.
fn process_and_send(
    engine: &Engine,
    searcher: &mut Searcher,
    abs_path: String,
    total_matches: &AtomicUsize,
    total_truncated: &AtomicBool,
    tx: &Sender<ContentFileResult>,
) -> WalkState {
    let content = match fs::read(&abs_path) {
        Ok(c) => c,
        Err(_) => return WalkState::Continue,
    };
    let result = search_file(
        searcher,
        &engine.matcher,
        &abs_path,
        &content,
        engine.max_matches_per_file,
    );
    if result.matches.is_empty() {
        return WalkState::Continue;
    }
    let n = result.matches.len();
    // Multiple workers can each add a file's matches before any observes the
    // cap, so the reported total may slightly overshoot `max_total_matches`.
    // That's an accepted trade-off for lock-free counting; `truncated` is still
    // set and the run still stops promptly.
    let prev = total_matches.fetch_add(n, Ordering::Relaxed);
    let reached_cap = prev + n >= engine.max_total_matches;
    if reached_cap {
        total_truncated.store(true, Ordering::Relaxed);
    }
    if tx.send(result).is_err() {
        return WalkState::Quit;
    }
    if reached_cap {
        WalkState::Quit
    } else {
        WalkState::Continue
    }
}

#[allow(clippy::too_many_arguments)]
fn visit_entry(
    engine: &Engine,
    ws_prefix: &str,
    search_id: u64,
    latest: &AtomicU64,
    total_matches: &AtomicUsize,
    total_truncated: &AtomicBool,
    pending_env: &Mutex<HashSet<String>>,
    tx: &Sender<ContentFileResult>,
    searcher: &mut Searcher,
    result: Result<ignore::DirEntry, ignore::Error>,
) -> WalkState {
    // Stale (superseded/cancelled) → stop this worker.
    if latest.load(Ordering::SeqCst) != search_id {
        return WalkState::Quit;
    }
    // Total cap already reached by another worker → stop.
    if total_matches.load(Ordering::Relaxed) >= engine.max_total_matches {
        total_truncated.store(true, Ordering::Relaxed);
        return WalkState::Quit;
    }

    let entry = match result {
        Ok(e) => e,
        Err(_) => return WalkState::Continue,
    };
    if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
        return WalkState::Continue;
    }

    let abs_path = entry.path().to_string_lossy().to_string();
    let name = entry.file_name().to_string_lossy();

    // The walker yields root `.env`/`.env.*` only when NOT gitignored; mark any
    // it does yield so the post-walk env supplement doesn't search it twice.
    if walk_policy::is_env_file(&name) {
        if let Ok(mut set) = pending_env.lock() {
            set.remove(&abs_path);
        }
    }

    let rel = relativize(&abs_path, ws_prefix);
    if !passes_filters(engine, &rel, entry.path()) {
        return WalkState::Continue;
    }

    process_and_send(engine, searcher, abs_path, total_matches, total_truncated, tx)
}

/// Runs the parallel walk, blocking until the whole thread pool drains. Worker
/// tx clones are dropped as the pool winds down, so the emitter eventually sees
/// a disconnect even when every worker quits early.
fn run_walk(
    engine: &Engine,
    search_id: u64,
    latest: &Arc<AtomicU64>,
    total_matches: &Arc<AtomicUsize>,
    total_truncated: &Arc<AtomicBool>,
    pending_env: &Arc<Mutex<HashSet<String>>>,
    tx: Sender<ContentFileResult>,
) {
    let ws_prefix = with_trailing_slash(&engine.workspace_path);
    let walker = walk_policy::policy_walker(&engine.workspace_path)
        .threads(engine.threads)
        .build_parallel();

    // Owned clones moved into the `mkf` closure (must be `Send`; a plain
    // `&Sender` is not `Send`, so ownership is required).
    let latest = Arc::clone(latest);
    let total_matches = Arc::clone(total_matches);
    let total_truncated = Arc::clone(total_truncated);
    let pending_env = Arc::clone(pending_env);

    walker.run(move || {
        let tx = tx.clone();
        let latest = Arc::clone(&latest);
        let total_matches = Arc::clone(&total_matches);
        let total_truncated = Arc::clone(&total_truncated);
        let pending_env = Arc::clone(&pending_env);
        let ws_prefix = ws_prefix.clone();
        let mut searcher = build_searcher();
        Box::new(move |result| {
            visit_entry(
                engine,
                &ws_prefix,
                search_id,
                &latest,
                &total_matches,
                &total_truncated,
                &pending_env,
                &tx,
                &mut searcher,
                result,
            )
        })
    });
}

/// Searches any root `.env`/`.env.*` files the walker skipped because they were
/// gitignored (see `walk_policy`). Runs after the walk on a single thread.
fn run_env_supplement(
    engine: &Engine,
    search_id: u64,
    latest: &AtomicU64,
    total_matches: &AtomicUsize,
    total_truncated: &AtomicBool,
    pending_env: &Mutex<HashSet<String>>,
    tx: &Sender<ContentFileResult>,
) {
    if latest.load(Ordering::SeqCst) != search_id {
        return;
    }
    let mut paths: Vec<String> = match pending_env.lock() {
        Ok(set) => set.iter().cloned().collect(),
        Err(_) => return,
    };
    paths.sort();
    if paths.is_empty() {
        return;
    }

    let ws_prefix = with_trailing_slash(&engine.workspace_path);
    let mut searcher = build_searcher();
    for abs_path in paths {
        if latest.load(Ordering::SeqCst) != search_id {
            return;
        }
        if total_matches.load(Ordering::Relaxed) >= engine.max_total_matches {
            total_truncated.store(true, Ordering::Relaxed);
            return;
        }
        let rel = relativize(&abs_path, &ws_prefix);
        if !passes_filters(engine, &rel, Path::new(&abs_path)) {
            continue;
        }
        let _ = process_and_send(engine, &mut searcher, abs_path, total_matches, total_truncated, tx);
    }
}

/// Emitter loop: batches file results (up to `BATCH_MAX_FILES` or
/// `BATCH_INTERVAL`) and emits `search-results-batch`, then emits exactly one
/// `search-complete` on channel disconnect. Batch emits are skipped once the
/// run is stale, but the completion event always fires.
fn emitter_loop<E: Fn(ContentEvent)>(
    rx: Receiver<ContentFileResult>,
    emit: E,
    search_id: u64,
    latest: Arc<AtomicU64>,
    total_matches: Arc<AtomicUsize>,
    total_truncated: Arc<AtomicBool>,
    start: Instant,
) {
    let mut file_count = 0usize;
    let mut batch: Vec<ContentFileResult> = Vec::with_capacity(BATCH_MAX_FILES);

    loop {
        match rx.recv_timeout(BATCH_INTERVAL) {
            Ok(result) => {
                file_count += 1;
                batch.push(result);
                if batch.len() >= BATCH_MAX_FILES {
                    flush_batch(&emit, search_id, &latest, &mut batch);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !batch.is_empty() {
                    flush_batch(&emit, search_id, &latest, &mut batch);
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if !batch.is_empty() {
                    flush_batch(&emit, search_id, &latest, &mut batch);
                }
                break;
            }
        }
    }

    let cancelled = latest.load(Ordering::SeqCst) != search_id;
    emit(ContentEvent::Complete(SearchComplete {
        search_id,
        total_matches: total_matches.load(Ordering::Relaxed),
        file_count,
        truncated: total_truncated.load(Ordering::Relaxed),
        cancelled,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }));
}

fn flush_batch<E: Fn(ContentEvent)>(
    emit: &E,
    search_id: u64,
    latest: &AtomicU64,
    batch: &mut Vec<ContentFileResult>,
) {
    // Always drain the buffer; only emit when this run is still current.
    let results = std::mem::take(batch);
    if latest.load(Ordering::SeqCst) == search_id {
        emit(ContentEvent::Batch(SearchResultsBatch { search_id, results }));
    }
}

/// Drives a validated `Engine` to completion, streaming events through `emit`.
/// Blocks until the emitter has fired `search-complete`, so the Tauri command
/// wraps this in its own thread while tests call it directly.
fn run_engine<E>(engine: Engine, search_id: u64, latest: Arc<AtomicU64>, emit: E)
where
    E: Fn(ContentEvent) + Send + 'static,
{
    let start = Instant::now();
    let (tx, rx) = mpsc::channel::<ContentFileResult>();
    let total_matches = Arc::new(AtomicUsize::new(0));
    let total_truncated = Arc::new(AtomicBool::new(false));
    let pending_env = Arc::new(Mutex::new(root_env_set(&engine.workspace_path)));

    let emitter = {
        let latest = Arc::clone(&latest);
        let total_matches = Arc::clone(&total_matches);
        let total_truncated = Arc::clone(&total_truncated);
        thread::spawn(move || {
            emitter_loop(rx, emit, search_id, latest, total_matches, total_truncated, start);
        })
    };

    run_walk(
        &engine,
        search_id,
        &latest,
        &total_matches,
        &total_truncated,
        &pending_env,
        tx.clone(),
    );
    run_env_supplement(
        &engine,
        search_id,
        &latest,
        &total_matches,
        &total_truncated,
        &pending_env,
        &tx,
    );

    // Drop the last sender so the emitter observes a disconnect and completes.
    drop(tx);
    let _ = emitter.join();
}

fn root_env_set(workspace_path: &str) -> HashSet<String> {
    walk_policy::root_env_files(Path::new(workspace_path))
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

fn emit_event(app: &AppHandle, event: ContentEvent) {
    match event {
        ContentEvent::Batch(b) => {
            let _ = app.emit(EVENT_BATCH, &b);
        }
        ContentEvent::Complete(c) => {
            let _ = app.emit(EVENT_COMPLETE, &c);
        }
    }
}

/// Starts a streaming content search. Validates the pattern and globs
/// synchronously (the only `Err` path), records `search_id` as the latest run,
/// then spawns the engine and returns immediately. Results arrive as
/// `search-results-batch` events, terminated by one `search-complete`.
///
/// `#[tauri::command(async)]` keeps even the (small) validation off the UI
/// thread.
#[tauri::command(async)]
pub fn start_content_search(
    app: AppHandle,
    state: State<'_, ContentSearchState>,
    search_id: u64,
    options: ContentSearchOptions,
) -> Result<(), String> {
    let engine = Engine::build(&options)?;
    // This search becomes the current one; any older run's workers now see a
    // mismatched id and quit.
    state.latest.store(search_id, Ordering::SeqCst);
    let latest = Arc::clone(&state.latest);
    let app = app.clone();
    thread::spawn(move || {
        run_engine(engine, search_id, latest, move |event| emit_event(&app, event));
    });
    Ok(())
}

/// Cancels any in-flight search older than `search_id` by advancing `latest`.
/// To cancel a run with id `k` without starting a new one, pass a `search_id`
/// strictly greater than `k` (e.g. the frontend's next counter tick); workers
/// whose id no longer equals `latest` quit, and the run still emits
/// `search-complete` with `cancelled: true`.
#[tauri::command]
pub fn cancel_content_search(state: State<'_, ContentSearchState>, search_id: u64) {
    state.latest.fetch_max(search_id, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    // ── helpers ─────────────────────────────────────────────────────────

    fn base_options(workspace: &str, query: &str) -> ContentSearchOptions {
        ContentSearchOptions {
            workspace_path: workspace.to_string(),
            query: query.to_string(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include_patterns: vec![],
            exclude_patterns: vec![],
            file_extensions: None,
            max_total_matches: default_max_total_matches(),
            max_matches_per_file: default_max_matches_per_file(),
        }
    }

    fn init_git_repo(root: &Path, gitignore: &str) {
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), gitignore).unwrap();
    }

    struct RunOutput {
        files: Vec<ContentFileResult>,
        complete: SearchComplete,
    }

    impl RunOutput {
        fn total_match_count(&self) -> usize {
            self.files.iter().map(|f| f.matches.len()).sum()
        }
        fn file_with(&self, name: &str) -> Option<&ContentFileResult> {
            self.files.iter().find(|f| f.path.ends_with(name))
        }
    }

    /// Runs an engine to completion (via the same seam the command uses) and
    /// collects every emitted event. `latest` lets tests exercise the
    /// stale-id path without an AppHandle.
    fn run_collect(engine: Engine, search_id: u64, latest: Arc<AtomicU64>) -> RunOutput {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        run_engine(engine, search_id, latest, move |event| {
            sink.lock().unwrap().push(event);
        });

        let mut files = Vec::new();
        let mut complete = None;
        for event in Arc::try_unwrap(events).unwrap().into_inner().unwrap() {
            match event {
                ContentEvent::Batch(b) => {
                    assert_eq!(b.search_id, search_id, "batch carried wrong searchId");
                    files.extend(b.results);
                }
                ContentEvent::Complete(c) => {
                    assert!(complete.is_none(), "more than one search-complete emitted");
                    complete = Some(c);
                }
            }
        }
        RunOutput {
            files,
            complete: complete.expect("no search-complete emitted"),
        }
    }

    /// Runs with a fresh `latest` pre-seeded to `search_id` (the current run).
    fn run(options: &ContentSearchOptions, search_id: u64) -> RunOutput {
        let engine = Engine::build(options).expect("engine should build");
        let latest = Arc::new(AtomicU64::new(search_id));
        run_collect(engine, search_id, latest)
    }

    fn search_one(matcher: &RegexMatcher, content: &str, cap: usize) -> ContentFileResult {
        let mut searcher = build_searcher();
        search_file(&mut searcher, matcher, "/tmp/x", content.as_bytes(), cap)
    }

    fn literal_matcher(query: &str, case_sensitive: bool, whole_word: bool) -> RegexMatcher {
        RegexMatcherBuilder::new()
            .case_insensitive(!case_sensitive)
            .word(whole_word)
            .build(&regex::escape(query))
            .unwrap()
    }

    // ── build_globset ───────────────────────────────────────────────────

    #[test]
    fn build_globset_none_when_empty() {
        assert!(build_globset(&[]).unwrap().is_none());
        assert!(build_globset(&["".to_string(), "   ".to_string()]).unwrap().is_none());
    }

    #[test]
    fn build_globset_bare_name_matches_any_depth() {
        let set = build_globset(&["foo.cs".to_string()]).unwrap().unwrap();
        assert!(set.is_match("foo.cs"));
        assert!(set.is_match("Assets/Scripts/foo.cs"));
        assert!(!set.is_match("Assets/foo.txt"));
    }

    #[test]
    fn build_globset_bare_dir_matches_contents() {
        let set = build_globset(&["node_modules".to_string()]).unwrap().unwrap();
        assert!(set.is_match("node_modules"));
        assert!(set.is_match("node_modules/lib/index.js"));
        assert!(set.is_match("packages/app/node_modules/x.js"));
    }

    #[test]
    fn build_globset_slashed_pattern_is_verbatim() {
        let set = build_globset(&["src/**/*.rs".to_string()]).unwrap().unwrap();
        assert!(set.is_match("src/a/b.rs"));
        assert!(!set.is_match("other/a/b.rs"));
    }

    #[test]
    fn build_globset_invalid_glob_errors() {
        assert!(build_globset(&["a[".to_string()]).is_err());
    }

    // ── byte_to_utf16 ───────────────────────────────────────────────────

    #[test]
    fn byte_to_utf16_counts_code_units() {
        assert_eq!(byte_to_utf16("abc", 3), 3);
        // é is 2 bytes but 1 UTF-16 unit.
        assert_eq!(byte_to_utf16("café", "café".len()), 4);
        // 🎉 is 4 bytes but 2 UTF-16 units (surrogate pair).
        assert_eq!(byte_to_utf16("🎉", "🎉".len()), 2);
    }

    // ── search_file: literal / regex / case / whole-word ────────────────

    #[test]
    fn search_file_literal_finds_all_occurrences() {
        let m = literal_matcher("foo", false, false);
        let r = search_one(&m, "foo bar\nbaz\nfoo foo\n", 200);
        assert_eq!(r.matches.len(), 3);
        assert_eq!(r.matches[0].line_number, 1);
        assert_eq!(r.matches[1].line_number, 3);
        assert_eq!(r.matches[2].line_number, 3);
        assert!(!r.truncated);
    }

    #[test]
    fn search_file_literal_escapes_regex_metachars() {
        // A literal query with a '.' must not behave like the regex dot.
        let m = literal_matcher("a.b", false, false);
        let r = search_one(&m, "a.b axb\n", 200);
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].match_start, 0);
        assert_eq!(r.matches[0].match_end, 3);
    }

    #[test]
    fn search_file_regex_matches() {
        let m = RegexMatcherBuilder::new()
            .case_insensitive(true)
            .build(r"a.b")
            .unwrap();
        let r = search_one(&m, "axb a.b\n", 200);
        assert_eq!(r.matches.len(), 2);
    }

    #[test]
    fn search_file_case_sensitive_vs_insensitive() {
        let insensitive = literal_matcher("foo", false, false);
        assert_eq!(search_one(&insensitive, "FOO Foo foo\n", 200).matches.len(), 3);

        let sensitive = literal_matcher("foo", true, false);
        assert_eq!(search_one(&sensitive, "FOO Foo foo\n", 200).matches.len(), 1);
    }

    #[test]
    fn search_file_whole_word_excludes_substrings() {
        let m = literal_matcher("cat", false, true);
        let r = search_one(&m, "cat category cat.\n", 200);
        // Standalone "cat" at 0..3 and 13..16 — not the "cat" inside "category".
        assert_eq!(r.matches.len(), 2);
        assert_eq!(r.matches[0].match_start, 0);
        assert_eq!(r.matches[0].match_end, 3);
        assert_eq!(r.matches[1].match_start, 13);
        assert_eq!(r.matches[1].match_end, 16);
    }

    // ── search_file: UTF-16 offsets ─────────────────────────────────────

    #[test]
    fn search_file_utf16_offsets_on_accented_line() {
        let m = literal_matcher("match", false, false);
        let r = search_one(&m, "café match\n", 200);
        assert_eq!(r.matches.len(), 1);
        // "café " = 5 UTF-16 units (é is 1 unit despite 2 bytes).
        assert_eq!(r.matches[0].match_start, 5);
        assert_eq!(r.matches[0].match_end, 10);
        assert_eq!(r.matches[0].line_start, 0);
    }

    #[test]
    fn search_file_utf16_offsets_on_emoji_line() {
        let m = literal_matcher("match", false, false);
        let r = search_one(&m, "🎉 match\n", 200);
        assert_eq!(r.matches.len(), 1);
        // 🎉 = 2 units + space = 3.
        assert_eq!(r.matches[0].match_start, 3);
        assert_eq!(r.matches[0].match_end, 8);
    }

    // ── search_file: per-file cap ───────────────────────────────────────

    #[test]
    fn search_file_per_file_cap_truncates() {
        let m = literal_matcher("x", false, false);
        let content = "x\nx\nx\nx\nx\n"; // 5 matches
        let r = search_one(&m, content, 3);
        assert_eq!(r.matches.len(), 3);
        assert!(r.truncated);
    }

    #[test]
    fn search_file_exact_cap_not_truncated() {
        let m = literal_matcher("x", false, false);
        let r = search_one(&m, "x\nx\nx\n", 3);
        assert_eq!(r.matches.len(), 3);
        assert!(!r.truncated);
    }

    // ── search_file: binary detection ───────────────────────────────────

    #[test]
    fn search_file_skips_binary_content() {
        let m = literal_matcher("secret", false, false);
        // A NUL byte before the match makes the searcher treat the file as
        // binary and stop — no matches reported.
        let mut content = Vec::from(&b"\x00binary blob "[..]);
        content.extend_from_slice(b"secret here\n");
        let mut searcher = build_searcher();
        let r = search_file(&mut searcher, &m, "/tmp/bin", &content, 200);
        assert!(r.matches.is_empty(), "binary file should yield no matches");
    }

    // ── search_file: preview trim ───────────────────────────────────────

    #[test]
    fn search_file_trims_long_line_around_match() {
        let m = literal_matcher("needle", false, false);
        // 900 'a', then "needle", then 94 'a' → 1000 chars total.
        let mut line = "a".repeat(900);
        line.push_str("needle");
        line.push_str(&"a".repeat(94));
        line.push('\n');
        let r = search_one(&m, &line, 200);
        assert_eq!(r.matches.len(), 1);
        let mtch = &r.matches[0];
        // Window starts 40 chars before the match: 900 - 40 = 860.
        assert_eq!(mtch.line_start, 860);
        assert_eq!(mtch.match_start, 40);
        assert_eq!(mtch.match_end, 46);
        // Display is the trimmed window, not the whole 1000-char line.
        assert!(mtch.line_content.chars().count() <= PREVIEW_MAX_CHARS);
        assert!(mtch.line_content.contains("needle"));
        // Highlight slice stays correct against the trimmed content.
        let units: Vec<u16> = mtch.line_content.encode_utf16().collect();
        let matched: String = String::from_utf16(&units[mtch.match_start..mtch.match_end]).unwrap();
        assert_eq!(matched, "needle");
    }

    #[test]
    fn search_file_short_line_not_trimmed() {
        let m = literal_matcher("hit", false, false);
        let r = search_one(&m, "a hit here\n", 200);
        assert_eq!(r.matches[0].line_content, "a hit here");
        assert_eq!(r.matches[0].line_start, 0);
    }

    // ── Engine::build validation ────────────────────────────────────────

    #[test]
    fn engine_build_rejects_invalid_regex() {
        let mut opts = base_options("/tmp", "(");
        opts.is_regex = true;
        assert!(Engine::build(&opts).is_err());
    }

    #[test]
    fn engine_build_rejects_invalid_glob() {
        let mut opts = base_options("/tmp", "foo");
        opts.include_patterns = vec!["a[".to_string()];
        assert!(Engine::build(&opts).is_err());
    }

    #[test]
    fn engine_build_accepts_literal_regex_metachars() {
        // Not regex mode → "(" is escaped, so it builds fine.
        let opts = base_options("/tmp", "(");
        assert!(Engine::build(&opts).is_ok());
    }

    // ── engine end-to-end: basic streaming ──────────────────────────────

    #[test]
    fn engine_finds_matches_across_files() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), "hello world\nhello again\n").unwrap();
        fs::write(tmp.path().join("b.txt"), "nothing here\n").unwrap();
        fs::write(tmp.path().join("c.txt"), "say hello\n").unwrap();

        let out = run(&base_options(tmp.path().to_str().unwrap(), "hello"), 1);

        assert_eq!(out.complete.total_matches, 3);
        assert_eq!(out.complete.file_count, 2);
        assert!(!out.complete.cancelled);
        assert!(!out.complete.truncated);
        assert_eq!(out.total_match_count(), 3);
    }

    // ── engine: gitignore + root .env whitelist ─────────────────────────

    #[test]
    fn engine_respects_gitignore_but_searches_root_env() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo(tmp.path(), ".env\nsecret.txt\n");
        fs::write(tmp.path().join(".env"), "API_TOKEN=needle\n").unwrap();
        fs::write(tmp.path().join("secret.txt"), "needle\n").unwrap();
        fs::write(tmp.path().join("visible.txt"), "needle\n").unwrap();

        let out = run(&base_options(tmp.path().to_str().unwrap(), "needle"), 1);

        // .env is whitelisted (searched despite gitignore); secret.txt is not.
        assert!(out.file_with(".env").is_some(), "root .env should be searched");
        assert!(out.file_with("visible.txt").is_some());
        assert!(out.file_with("secret.txt").is_none(), "gitignored file must be skipped");
        // .env searched exactly once (no duplicate from the supplement).
        assert_eq!(out.files.iter().filter(|f| f.path.ends_with(".env")).count(), 1);
    }

    #[test]
    fn engine_does_not_duplicate_non_gitignored_env() {
        let tmp = tempfile::tempdir().unwrap();
        init_git_repo(tmp.path(), ""); // .env NOT ignored → walker yields it
        fs::write(tmp.path().join(".env"), "needle\n").unwrap();

        let out = run(&base_options(tmp.path().to_str().unwrap(), "needle"), 1);
        assert_eq!(out.files.iter().filter(|f| f.path.ends_with(".env")).count(), 1);
    }

    // ── engine: include / exclude globs ─────────────────────────────────

    #[test]
    fn engine_include_glob_filters_files() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("keep.cs"), "needle\n").unwrap();
        fs::write(tmp.path().join("skip.txt"), "needle\n").unwrap();

        let mut opts = base_options(tmp.path().to_str().unwrap(), "needle");
        opts.include_patterns = vec!["*.cs".to_string()];
        let out = run(&opts, 1);

        assert!(out.file_with("keep.cs").is_some());
        assert!(out.file_with("skip.txt").is_none());
    }

    #[test]
    fn engine_multi_glob_exclude() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("app.ts"), "needle\n").unwrap();
        fs::write(tmp.path().join("app.log"), "needle\n").unwrap();
        fs::create_dir(tmp.path().join("dist")).unwrap();
        fs::write(tmp.path().join("dist").join("bundle.ts"), "needle\n").unwrap();

        let mut opts = base_options(tmp.path().to_str().unwrap(), "needle");
        opts.exclude_patterns = vec!["*.log".to_string(), "dist".to_string()];
        let out = run(&opts, 1);

        assert!(out.file_with("app.ts").is_some());
        assert!(out.file_with("app.log").is_none());
        assert!(out.file_with("bundle.ts").is_none(), "dist/ contents excluded");
    }

    #[test]
    fn engine_file_extensions_filter() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.cs"), "needle\n").unwrap();
        fs::write(tmp.path().join("b.js"), "needle\n").unwrap();

        let mut opts = base_options(tmp.path().to_str().unwrap(), "needle");
        opts.file_extensions = Some(vec!["cs".to_string()]);
        let out = run(&opts, 1);

        assert!(out.file_with("a.cs").is_some());
        assert!(out.file_with("b.js").is_none());
    }

    // ── engine: caps ────────────────────────────────────────────────────

    #[test]
    fn engine_total_cap_truncates() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..5 {
            fs::write(tmp.path().join(format!("f{i}.txt")), "needle\n").unwrap();
        }
        let mut opts = base_options(tmp.path().to_str().unwrap(), "needle");
        opts.max_total_matches = 2;
        // Force single-threaded so the total-cap stop is deterministic.
        let mut engine = Engine::build(&opts).unwrap();
        engine.threads = 1;
        let latest = Arc::new(AtomicU64::new(1));
        let out = run_collect(engine, 1, latest);

        assert!(out.complete.truncated, "total cap should set truncated");
        assert!(out.complete.total_matches >= 2, "cap reached");
        assert!(out.complete.total_matches < 5, "should stop early");
    }

    #[test]
    fn engine_per_file_cap_sets_file_truncated() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("many.txt"), "x\nx\nx\nx\nx\n").unwrap();
        let mut opts = base_options(tmp.path().to_str().unwrap(), "x");
        opts.max_matches_per_file = 2;
        let out = run(&opts, 1);

        let f = out.file_with("many.txt").unwrap();
        assert_eq!(f.matches.len(), 2);
        assert!(f.truncated);
    }

    // ── engine: cancellation / stale id ─────────────────────────────────

    #[test]
    fn engine_stale_id_emits_no_batches_and_cancelled_complete() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..10 {
            fs::write(tmp.path().join(format!("f{i}.txt")), "needle needle\n").unwrap();
        }
        let engine = Engine::build(&base_options(tmp.path().to_str().unwrap(), "needle")).unwrap();
        // `latest` already advanced past our id → every worker is stale.
        let latest = Arc::new(AtomicU64::new(999));
        let out = run_collect(engine, 1, latest);

        assert!(out.files.is_empty(), "no batch results when cancelled");
        assert!(out.complete.cancelled, "complete must report cancelled");
        assert_eq!(out.complete.total_matches, 0);
    }

    #[test]
    fn engine_emits_exactly_one_complete_on_empty_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        // No files → walk yields nothing, but complete still fires once.
        let out = run(&base_options(tmp.path().to_str().unwrap(), "needle"), 1);
        assert_eq!(out.complete.total_matches, 0);
        assert_eq!(out.complete.file_count, 0);
        assert!(!out.complete.cancelled);
        assert!(out.files.is_empty());
    }

    // ── cancel_content_search semantics ─────────────────────────────────

    #[test]
    fn cancel_advances_latest_monotonically() {
        let state = ContentSearchState::new();
        state.latest.store(5, Ordering::SeqCst);
        // fetch_max: a lower id does not regress latest.
        state.latest.fetch_max(3, Ordering::SeqCst);
        assert_eq!(state.latest.load(Ordering::SeqCst), 5);
        // A higher id advances it (cancelling run 5).
        state.latest.fetch_max(9, Ordering::SeqCst);
        assert_eq!(state.latest.load(Ordering::SeqCst), 9);
    }
}
