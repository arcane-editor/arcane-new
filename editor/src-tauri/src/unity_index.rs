//! Persistent GUID + reverse-reference index for Unity projects.
//!
//! Unity assets reference one another by GUID (stored in `.meta` sidecars).
//! Answering "what references this script / texture / prefab?" requires a
//! whole-project scan: read every `.meta` to learn `guid ↔ asset path`, then
//! scan every YAML asset for `guid:` references and tally them per file.
//!
//! Building this is expensive, so the result is:
//!   • cached in-process (keyed by workspace path), and
//!   • persisted to `<workspace>/Library/ArcaneIDE/index/guid-index.json`,
//!     reloaded on the next build when fresh (matching projectPath +
//!     unityVersion + schemaVersion).
//!
//! Incremental updates (`apply_delta`) keep the maps consistent as files change
//! without a full rescan. Coarse progress is emitted via the
//! `unity-index-progress` Tauri event.

use crate::sync_util::lock_recover;
use crate::unity_yaml;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Window};
use walkdir::WalkDir;

/// Persisted schema version. Bump when the on-disk shape changes.
const SCHEMA_VERSION: u32 = 1;

/// Directories never worth scanning. We DO descend into `Assets/` and
/// `Packages/`; everything else Unity-generated or VCS noise is skipped.
const SKIP_DIRS: &[&str] = &[
    "Library",
    "Temp",
    "obj",
    "Logs",
    ".git",
    "node_modules",
    "UserSettings",
];

/// Asset extensions whose contents we scan for `guid:` references.
const REF_EXTENSIONS: &[&str] = &[
    "unity",
    "prefab",
    "asset",
    "mat",
    "controller",
    "anim",
];

// ── Serializable types ──────────────────────────────────────────────────────

/// One reverse-reference hit: an asset that references a guid, with the number
/// of distinct references to *other* guids found in that file is NOT what this
/// stores — `count` is how many times the *target* guid appears.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefHit {
    pub path: String,
    pub count: usize,
}

/// Meta-hygiene findings.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HygieneReport {
    /// Asset files under `Assets/` lacking a sibling `.meta`.
    pub assets_without_meta: Vec<String>,
    /// `.meta` files whose referenced asset no longer exists.
    pub orphan_metas: Vec<String>,
}

/// Small counts summary returned by the build command (cheap to send).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub guid_count: usize,
    /// Number of guids that are referenced by at least one asset.
    pub referenced_guid_count: usize,
    /// Total reverse-reference hits across all guids.
    pub total_ref_hits: usize,
    pub assets_without_meta: usize,
    pub orphan_metas: usize,
    /// True when this build was served from the persisted cache.
    pub from_cache: bool,
}

/// In-memory + persisted index state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexState {
    pub workspace: String,
    pub unity_version: String,
    pub guid_to_path: HashMap<String, String>,
    pub path_to_guid: HashMap<String, String>,
    pub reverse: HashMap<String, Vec<RefHit>>,
    pub assets_without_meta: Vec<String>,
    pub orphan_metas: Vec<String>,
}

/// On-disk wrapper with a version header for freshness checks.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedIndex {
    schema_version: u32,
    project_path: String,
    unity_version: String,
    state: IndexState,
}

impl IndexState {
    fn summary(&self, from_cache: bool) -> IndexSummary {
        let referenced_guid_count = self.reverse.len();
        let total_ref_hits = self
            .reverse
            .values()
            .map(|hits| hits.iter().map(|h| h.count).sum::<usize>())
            .sum();
        IndexSummary {
            guid_count: self.guid_to_path.len(),
            referenced_guid_count,
            total_ref_hits,
            assets_without_meta: self.assets_without_meta.len(),
            orphan_metas: self.orphan_metas.len(),
            from_cache,
        }
    }

    fn hygiene(&self) -> HygieneReport {
        HygieneReport {
            assets_without_meta: self.assets_without_meta.clone(),
            orphan_metas: self.orphan_metas.clone(),
        }
    }
}

// ── In-process cache ────────────────────────────────────────────────────────

fn index_cache() -> &'static Mutex<Option<IndexState>> {
    static CACHE: OnceLock<Mutex<Option<IndexState>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Compiled `guid:` regex shared across the module.
fn guid_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"guid:\s*([0-9a-f]{32})").expect("guid regex"))
}

// ── Path helpers ────────────────────────────────────────────────────────────

fn index_dir(workspace: &Path) -> PathBuf {
    workspace.join("Library").join("ArcaneIDE").join("index")
}

fn index_file(workspace: &Path) -> PathBuf {
    index_dir(workspace).join("guid-index.json")
}

/// True if `name` is a directory we must not descend into.
fn is_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

/// True if a path's extension marks it as a YAML asset we scan for refs.
fn is_ref_asset(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| REF_EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// The asset path a `.meta` describes (the meta path minus the `.meta` suffix).
fn asset_for_meta(meta_path: &Path) -> Option<PathBuf> {
    let s = meta_path.to_string_lossy();
    s.strip_suffix(".meta").map(PathBuf::from)
}

// ── Build ───────────────────────────────────────────────────────────────────

/// Walk `Assets/` and `Packages/`, collecting every file path once. Returns the
/// flat list (used for both meta and ref passes so we only traverse twice at
/// most, and emit sane progress totals).
fn collect_files(workspace: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root_name in ["Assets", "Packages"] {
        let root = workspace.join(root_name);
        if !root.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&root)
            .into_iter()
            .filter_entry(|e| {
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy();
                    if is_skip_dir(name.as_ref()) {
                        return false;
                    }
                }
                true
            })
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                out.push(entry.path().to_path_buf());
            }
        }
    }
    out
}

fn emit_progress(window: Option<&Window>, phase: &str, done: usize, total: usize) {
    if let Some(w) = window {
        let _ = w.emit(
            "unity-index-progress",
            serde_json::json!({ "phase": phase, "done": done, "total": total }),
        );
    }
}

/// Read one `.meta`'s guid and record it in both maps.
fn record_meta(meta_path: &Path, state: &mut IndexState) {
    let asset = match asset_for_meta(meta_path) {
        Some(a) => a,
        None => return,
    };
    let content = match std::fs::read_to_string(meta_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    if let Some(caps) = guid_regex().captures(&content) {
        if let Some(g) = caps.get(1) {
            let guid = g.as_str().to_string();
            let asset_str = asset.to_string_lossy().to_string();
            state.guid_to_path.insert(guid.clone(), asset_str.clone());
            state.path_to_guid.insert(asset_str, guid);
        }
    }
}

/// Scan one YAML asset for guid references and fold its hits into `reverse`.
///
/// The set of distinct guids comes from `unity_yaml::extract_guid_refs`; the
/// per-guid `count` is how many times that guid textually appears in the file.
fn record_refs(asset_path: &Path, state: &mut IndexState) {
    let content = match std::fs::read_to_string(asset_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let path_str = asset_path.to_string_lossy().to_string();

    // Distinct guids referenced by this file (lenient parser, no panic).
    let distinct = unity_yaml::extract_guid_refs(&content);
    if distinct.is_empty() {
        return;
    }

    // Tally raw occurrences so `count` reflects reference density per file.
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for caps in guid_regex().captures_iter(&content) {
        if let Some(m) = caps.get(1) {
            *counts.entry(m.as_str()).or_insert(0) += 1;
        }
    }

    for guid in distinct {
        let count = counts.get(guid.as_str()).copied().unwrap_or(1);
        state
            .reverse
            .entry(guid)
            .or_default()
            .push(RefHit { path: path_str.clone(), count });
    }
}

/// Compute meta-hygiene over the full file list.
///
/// `assets_without_meta`: a non-`.meta`, non-directory file under `Assets/`
/// that has no sibling `<file>.meta`. (Folders also get metas in Unity, but a
/// folder without a meta is not flagged here — we only consider files.)
///
/// `orphan_metas`: a `.meta` whose described asset path does not exist (the
/// asset OR folder it shadowed is gone).
fn compute_hygiene(workspace: &Path, files: &[PathBuf], state: &mut IndexState) {
    let assets_root = workspace.join("Assets");
    let existing: std::collections::HashSet<&Path> = files.iter().map(|p| p.as_path()).collect();

    let mut without_meta = Vec::new();
    let mut orphans = Vec::new();

    for path in files {
        let is_meta = path.extension().map(|e| e == "meta").unwrap_or(false);
        if is_meta {
            // Orphan if the described asset path exists as neither a tracked
            // file nor a directory on disk.
            if let Some(asset) = asset_for_meta(path) {
                let exists = existing.contains(asset.as_path()) || asset.is_dir();
                if !exists {
                    orphans.push(path.to_string_lossy().to_string());
                }
            }
        } else {
            // Only flag missing-meta for files under Assets/.
            if path.starts_with(&assets_root) {
                let meta = PathBuf::from(format!("{}.meta", path.to_string_lossy()));
                if !meta.exists() {
                    without_meta.push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    without_meta.sort();
    orphans.sort();
    state.assets_without_meta = without_meta;
    state.orphan_metas = orphans;
}

/// Full build: scan everything, persist, and return the populated state.
fn build_state(workspace: &Path, unity_version: &str, window: Option<&Window>) -> IndexState {
    let mut state = IndexState {
        workspace: workspace.to_string_lossy().to_string(),
        unity_version: unity_version.to_string(),
        guid_to_path: HashMap::new(),
        path_to_guid: HashMap::new(),
        reverse: HashMap::new(),
        assets_without_meta: Vec::new(),
        orphan_metas: Vec::new(),
    };

    emit_progress(window, "scanning", 0, 0);
    let files = collect_files(workspace);
    let total = files.len();

    // Pass 1: metas → guid maps.
    emit_progress(window, "metas", 0, total);
    let mut processed = 0usize;
    for path in &files {
        if path.extension().map(|e| e == "meta").unwrap_or(false) {
            record_meta(path, &mut state);
        }
        processed += 1;
        // Coarse: ~4 progress beats over the meta pass.
        if total > 0 && processed % (total / 4).max(1) == 0 {
            emit_progress(window, "metas", processed, total);
        }
    }

    // Pass 2: YAML assets → reverse references.
    emit_progress(window, "references", 0, total);
    let mut processed = 0usize;
    for path in &files {
        if is_ref_asset(path) {
            record_refs(path, &mut state);
        }
        processed += 1;
        if total > 0 && processed % (total / 4).max(1) == 0 {
            emit_progress(window, "references", processed, total);
        }
    }

    // Stable ordering for deterministic output / diffs.
    for hits in state.reverse.values_mut() {
        hits.sort_by(|a, b| a.path.cmp(&b.path));
    }

    // Pass 3: hygiene.
    emit_progress(window, "hygiene", 0, total);
    compute_hygiene(workspace, &files, &mut state);

    emit_progress(window, "persisting", total, total);
    persist(workspace, unity_version, &state);

    emit_progress(window, "done", total, total);
    state
}

// ── Persistence ─────────────────────────────────────────────────────────────

fn persist(workspace: &Path, unity_version: &str, state: &IndexState) {
    let dir = index_dir(workspace);
    if std::fs::create_dir_all(&dir).is_err() {
        return; // best-effort; in-memory cache still serves this session
    }
    let wrapper = PersistedIndex {
        schema_version: SCHEMA_VERSION,
        project_path: workspace.to_string_lossy().to_string(),
        unity_version: unity_version.to_string(),
        state: state.clone(),
    };
    if let Ok(json) = serde_json::to_string(&wrapper) {
        let _ = std::fs::write(index_file(workspace), json);
    }
}

/// Load a persisted index iff it is fresh: matching schemaVersion, projectPath
/// and unityVersion. Returns `None` on any mismatch or read/parse failure.
fn load_fresh(workspace: &Path, unity_version: &str) -> Option<IndexState> {
    let content = std::fs::read_to_string(index_file(workspace)).ok()?;
    let wrapper: PersistedIndex = serde_json::from_str(&content).ok()?;
    let ws = workspace.to_string_lossy();
    if wrapper.schema_version == SCHEMA_VERSION
        && wrapper.project_path == ws
        && wrapper.unity_version == unity_version
    {
        Some(wrapper.state)
    } else {
        None
    }
}

// ── Cache orchestration ─────────────────────────────────────────────────────

/// Ensure an index is available for `workspace`, building if necessary.
/// `from_cache` reflects whether we avoided a fresh disk scan (in-process or
/// persisted hit). When `force` is set, always rebuild.
fn ensure_index(
    workspace: &Path,
    unity_version: &str,
    force: bool,
    window: Option<&Window>,
) -> (IndexState, bool) {
    let ws_str = workspace.to_string_lossy().to_string();

    if !force {
        // In-process cache hit?
        {
            let cache = lock_recover(index_cache());
            if let Some(state) = cache.as_ref() {
                if state.workspace == ws_str && state.unity_version == unity_version {
                    return (state.clone(), true);
                }
            }
        }
        // Persisted fresh file?
        if let Some(state) = load_fresh(workspace, unity_version) {
            let mut cache = lock_recover(index_cache());
            *cache = Some(state.clone());
            drop(cache);
            return (state, true);
        }
    }

    let state = build_state(workspace, unity_version, window);
    let mut cache = lock_recover(index_cache());
    *cache = Some(state.clone());
    drop(cache);
    (state, false)
}

/// Fetch the cached state for a workspace, building (non-forced) if absent.
/// Used by the read-only query commands. Returns `Err` only if a build can't
/// determine the unity version — which it never can here, so we build with the
/// cached version or empty string.
///
/// `pub(crate)` so `unity_diff.rs` can resolve guid → asset path without a
/// second, competing index implementation.
pub(crate) fn get_or_build(workspace_path: &str) -> IndexState {
    let workspace = Path::new(workspace_path);
    let ws_str = workspace.to_string_lossy().to_string();

    // Reuse the in-process cache regardless of unity version (queries don't
    // need version-keying; the build command handles freshness).
    {
        let cache = lock_recover(index_cache());
        if let Some(state) = cache.as_ref() {
            if state.workspace == ws_str {
                return state.clone();
            }
        }
    }

    // No cache — try a persisted file (any version), else a fresh build with an
    // empty version. Reading the persisted file regardless of version is fine
    // for queries; an explicit rebuild via unity_index_build refreshes it.
    if let Ok(content) = std::fs::read_to_string(index_file(workspace)) {
        if let Ok(wrapper) = serde_json::from_str::<PersistedIndex>(&content) {
            if wrapper.schema_version == SCHEMA_VERSION && wrapper.project_path == ws_str {
                let mut cache = lock_recover(index_cache());
                *cache = Some(wrapper.state.clone());
                drop(cache);
                return wrapper.state;
            }
        }
    }

    let (state, _) = ensure_index(workspace, "", false, None);
    state
}

// ── Incremental delta ─────────────────────────────────────────────────────--

/// Remove every reverse-reference hit and guid-map entry that points at `path`.
fn drop_path(state: &mut IndexState, path: &str) {
    // Reverse: strip hits whose source file is `path`.
    for hits in state.reverse.values_mut() {
        hits.retain(|h| h.path != path);
    }
    state.reverse.retain(|_, hits| !hits.is_empty());

    // If `path` is a `.meta`, drop the guid it provided.
    if let Some(asset) = path.strip_suffix(".meta") {
        if let Some(guid) = state.path_to_guid.remove(asset) {
            state.guid_to_path.remove(&guid);
        }
    }
    // If `path` is itself a tracked asset, drop its guid mapping too.
    if let Some(guid) = state.path_to_guid.remove(path) {
        state.guid_to_path.remove(&guid);
    }
}

/// Re-ingest a single changed file (meta and/or ref asset) into `state`.
fn reingest_path(state: &mut IndexState, path: &str) {
    let p = Path::new(path);
    // Always clear stale entries for this path first so counts don't double.
    drop_path(state, path);

    if p.extension().map(|e| e == "meta").unwrap_or(false) {
        record_meta(p, state);
    }
    if is_ref_asset(p) {
        record_refs(p, state);
    }
    // Keep reverse lists sorted for determinism.
    for hits in state.reverse.values_mut() {
        hits.sort_by(|a, b| a.path.cmp(&b.path));
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn unity_index_build(
    window: Window,
    workspace_path: String,
    unity_version: String,
    force: bool,
) -> Result<IndexSummary, String> {
    let workspace = Path::new(&workspace_path);
    if !workspace.is_dir() {
        return Err(format!("Workspace not found: {}", workspace_path));
    }
    let (state, from_cache) = ensure_index(workspace, &unity_version, force, Some(&window));
    Ok(state.summary(from_cache))
}

#[tauri::command]
pub fn unity_index_guid_map(
    workspace_path: String,
) -> Result<HashMap<String, String>, String> {
    Ok(get_or_build(&workspace_path).guid_to_path)
}

#[tauri::command]
pub fn unity_index_find_references(
    workspace_path: String,
    guid: String,
) -> Result<Vec<RefHit>, String> {
    let state = get_or_build(&workspace_path);
    Ok(state.reverse.get(&guid).cloned().unwrap_or_default())
}

#[tauri::command]
pub fn unity_index_hygiene(workspace_path: String) -> Result<HygieneReport, String> {
    Ok(get_or_build(&workspace_path).hygiene())
}

#[tauri::command]
pub fn unity_index_apply_delta(
    workspace_path: String,
    changed: Vec<String>,
    removed: Vec<String>,
) -> Result<(), String> {
    let workspace = Path::new(&workspace_path);
    let ws_str = workspace.to_string_lossy().to_string();

    // Operate on the cached state; if absent, build it first so the delta has
    // something consistent to mutate.
    let mut state = get_or_build(&workspace_path);
    if state.workspace != ws_str {
        // Defensive: get_or_build always sets workspace, but guard anyway.
        state.workspace = ws_str.clone();
    }

    for path in &removed {
        drop_path(&mut state, path);
    }
    for path in &changed {
        reingest_path(&mut state, path);
    }

    state.reverse.retain(|_, hits| !hits.is_empty());

    // Persist + cache the updated state (preserve its unity_version).
    let version = state.unity_version.clone();
    persist(workspace, &version, &state);
    let mut cache = lock_recover(index_cache());
    *cache = Some(state);
    drop(cache);
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────--

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn temp_dir(suffix: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!(
            "unity_index_test_{}_{}",
            std::process::id(),
            suffix
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    /// Reset the in-process cache so tests don't leak state into one another.
    fn clear_cache() {
        *lock_recover(index_cache()) = None;
    }

    const SCRIPT_GUID: &str = "0123456789abcdef0123456789abcdef";

    fn make_project(ws: &Path) {
        // A C# script + its .meta declaring SCRIPT_GUID.
        write(&ws.join("Assets/Scripts/Player.cs"), "public class Player {}");
        write(
            &ws.join("Assets/Scripts/Player.cs.meta"),
            &format!("fileFormatVersion: 2\nguid: {}\n", SCRIPT_GUID),
        );
        // A scene referencing the script guid via a MonoBehaviour m_Script.
        write(
            &ws.join("Assets/Scenes/Main.unity"),
            &format!(
                "--- !u!1 &1\nGameObject:\n  m_Name: Hero\n--- !u!114 &2\nMonoBehaviour:\n  m_Script: {{fileID: 11500000, guid: {}, type: 3}}\n",
                SCRIPT_GUID
            ),
        );
        // The scene's own meta (so it's not flagged missing-meta).
        write(
            &ws.join("Assets/Scenes/Main.unity.meta"),
            "fileFormatVersion: 2\nguid: ffffffffffffffffffffffffffffffff\n",
        );
    }

    #[test]
    fn build_finds_references_and_guid_map() {
        clear_cache();
        let ws = temp_dir("refs");
        make_project(&ws);

        let (state, from_cache) = ensure_index(&ws, "2022.3.10f1", true, None);
        assert!(!from_cache, "forced build is never from cache");

        // guid_map contains the script.
        let mapped = state.guid_to_path.get(SCRIPT_GUID).cloned();
        assert!(mapped.is_some(), "script guid present in map");
        assert!(mapped.unwrap().ends_with("Player.cs"));

        // find_references(scriptGuid) returns the scene.
        let hits = state.reverse.get(SCRIPT_GUID).cloned().unwrap_or_default();
        assert_eq!(hits.len(), 1, "exactly one referencing file");
        assert!(hits[0].path.ends_with("Main.unity"));
        assert_eq!(hits[0].count, 1);

        clear_cache();
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn hygiene_flags_missing_meta() {
        clear_cache();
        let ws = temp_dir("hygiene");
        make_project(&ws);
        // Add an asset with NO meta.
        write(&ws.join("Assets/Art/orphan.png"), "PNGDATA");

        let (state, _) = ensure_index(&ws, "2022.3.10f1", true, None);
        let report = state.hygiene();
        assert!(
            report.assets_without_meta.iter().any(|p| p.ends_with("orphan.png")),
            "orphan.png should be flagged as missing-meta"
        );

        clear_cache();
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn hygiene_flags_orphan_meta() {
        clear_cache();
        let ws = temp_dir("orphan_meta");
        make_project(&ws);
        // A .meta whose asset does not exist.
        write(
            &ws.join("Assets/Gone.cs.meta"),
            "fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        );

        let (state, _) = ensure_index(&ws, "x", true, None);
        let report = state.hygiene();
        assert!(
            report.orphan_metas.iter().any(|p| p.ends_with("Gone.cs.meta")),
            "Gone.cs.meta should be flagged as orphan"
        );

        clear_cache();
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn persistence_loads_when_fresh() {
        clear_cache();
        let ws = temp_dir("persist");
        make_project(&ws);

        // First build persists.
        let (_s1, c1) = ensure_index(&ws, "2021.3.0f1", true, None);
        assert!(!c1);
        assert!(index_file(&ws).exists(), "index file written");

        // Clear in-process cache; a fresh load should hit the persisted file.
        clear_cache();
        let (_s2, c2) = ensure_index(&ws, "2021.3.0f1", false, None);
        assert!(c2, "fresh persisted index reused");

        // A different unity version is NOT fresh → rebuild.
        clear_cache();
        let (_s3, c3) = ensure_index(&ws, "2099.1.0f1", false, None);
        assert!(!c3, "version mismatch forces rebuild");

        clear_cache();
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn apply_delta_keeps_maps_consistent() {
        clear_cache();
        let ws = temp_dir("delta");
        make_project(&ws);
        let _ = ensure_index(&ws, "v", true, None);

        let scene = ws.join("Assets/Scenes/Main.unity");
        let scene_str = scene.to_string_lossy().to_string();

        // Remove the scene → reference should disappear.
        unity_index_apply_delta(
            ws.to_string_lossy().to_string(),
            vec![],
            vec![scene_str.clone()],
        )
        .unwrap();
        let hits = unity_index_find_references(
            ws.to_string_lossy().to_string(),
            SCRIPT_GUID.to_string(),
        )
        .unwrap();
        assert!(hits.is_empty(), "ref dropped after scene removal");

        // Recreate the scene on disk and re-ingest via changed → ref returns.
        write(
            &scene,
            &format!(
                "--- !u!114 &2\nMonoBehaviour:\n  m_Script: {{fileID: 11500000, guid: {}, type: 3}}\n",
                SCRIPT_GUID
            ),
        );
        unity_index_apply_delta(
            ws.to_string_lossy().to_string(),
            vec![scene_str.clone()],
            vec![],
        )
        .unwrap();
        let hits = unity_index_find_references(
            ws.to_string_lossy().to_string(),
            SCRIPT_GUID.to_string(),
        )
        .unwrap();
        assert_eq!(hits.len(), 1, "ref restored after re-ingest");
        assert!(hits[0].path.ends_with("Main.unity"));

        // Re-ingesting again must NOT double the count (idempotent).
        unity_index_apply_delta(
            ws.to_string_lossy().to_string(),
            vec![scene_str.clone()],
            vec![],
        )
        .unwrap();
        let hits = unity_index_find_references(
            ws.to_string_lossy().to_string(),
            SCRIPT_GUID.to_string(),
        )
        .unwrap();
        assert_eq!(hits.len(), 1, "re-ingest is idempotent (no dup hits)");

        clear_cache();
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn delta_updates_guid_map_on_meta_change() {
        clear_cache();
        let ws = temp_dir("delta_meta");
        make_project(&ws);
        let _ = ensure_index(&ws, "v", true, None);

        // Remove the script's meta → guid mapping should vanish.
        let meta = ws.join("Assets/Scripts/Player.cs.meta");
        unity_index_apply_delta(
            ws.to_string_lossy().to_string(),
            vec![],
            vec![meta.to_string_lossy().to_string()],
        )
        .unwrap();
        let map = unity_index_guid_map(ws.to_string_lossy().to_string()).unwrap();
        assert!(
            !map.contains_key(SCRIPT_GUID),
            "guid removed from map after meta deletion"
        );

        clear_cache();
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn empty_or_non_unity_workspace_yields_empty() {
        clear_cache();
        let ws = temp_dir("empty");
        // No Assets/ or Packages/.
        let (state, _) = ensure_index(&ws, "v", true, None);
        assert!(state.guid_to_path.is_empty());
        assert!(state.reverse.is_empty());
        assert!(state.hygiene().assets_without_meta.is_empty());

        clear_cache();
        fs::remove_dir_all(&ws).ok();
    }
}
