//! Tauri command wrappers around the bundled `unityide-graph` PyInstaller
//! sidecar. The sidecar does AST-only structural extraction and graph
//! traversal; this module shells out to it and streams progress events
//! back to the frontend.
//!
//! Graph artifacts live under the per-app config dir (see `auth::config_home_dir`)
//! at `<unityide-home>/graphs/<sha1(workspace)>/graph.json` — i.e.
//! `~/.unityide/graphs/<sha1>/` for prod builds and `~/.unityide-dev/graphs/<sha1>/`
//! for dev builds — outside the user's project tree so we never pollute their
//! working directory or .gitignore.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphifyCheck {
    pub available: bool,
    pub version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphifyBuildResult {
    pub nodes: u32,
    pub edges: u32,
    pub communities: u32,
    pub graph_path: String,
    pub summary_path: String,
}

/// Resolve the on-disk graph location for a given workspace path. We hash
/// the absolute workspace path so two different folders never collide and
/// the same folder is stable across IDE restarts.
fn graph_dir_for(app: &AppHandle, workspace_path: &str) -> Result<PathBuf, String> {
    let mut hasher = Sha1::new();
    hasher.update(workspace_path.as_bytes());
    let hash = hex::encode_short(&hasher.finalize());
    Ok(crate::auth::config_home_dir(app)?.join("graphs").join(hash))
}

fn graph_json_path(app: &AppHandle, workspace_path: &str) -> Result<PathBuf, String> {
    Ok(graph_dir_for(app, workspace_path)?.join("graph.json"))
}

fn summary_json_path(app: &AppHandle, workspace_path: &str) -> Result<PathBuf, String> {
    Ok(graph_dir_for(app, workspace_path)?.join("graph.summary.json"))
}

mod hex {
    pub fn encode_short(bytes: &[u8]) -> String {
        // Take first 10 bytes -> 20 hex chars. Plenty of uniqueness for
        // per-workspace directories and keeps the path short.
        let mut s = String::with_capacity(20);
        for b in bytes.iter().take(10) {
            s.push_str(&format!("{:02x}", b));
        }
        s
    }
}

#[tauri::command]
pub async fn graphify_check(app: AppHandle) -> Result<GraphifyCheck, String> {
    let sidecar = match app.shell().sidecar("unityide-graph") {
        Ok(s) => s,
        Err(_) => return Ok(GraphifyCheck { available: false, version: None }),
    };
    let (mut rx, _child) = match sidecar.args(["version"]).spawn() {
        Ok(pair) => pair,
        Err(_) => return Ok(GraphifyCheck { available: false, version: None }),
    };

    let mut version_line: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line).trim().to_string();
                if !text.is_empty() && version_line.is_none() {
                    version_line = Some(text);
                }
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }

    // A version string containing "stub" is the placeholder shell script
    // we keep at src-tauri/binaries/unityide-graph-<triple> so cargo check can
    // pass without the real PyInstaller binary. Treat it as unavailable so
    // the frontend renders the calm `graph: unavailable` state rather than
    // erroring as soon as a build is attempted.
    let real = version_line
        .as_deref()
        .map(|v| !v.to_ascii_lowercase().contains("stub"))
        .unwrap_or(false);

    Ok(GraphifyCheck {
        available: real,
        version: version_line,
    })
}

/// Run the AST-only build. Streams progress over the `graphify-build-progress`
/// event so the frontend can show indexing status. Returns the final summary
/// the sidecar emits on its last stdout line.
///
/// `root` (optional) narrows scanning to a workspace subdirectory; `include_ext`
/// (optional) filters extracted code files by extension. The frontend uses
/// these for Unity projects (root=Assets, include_ext=[.cs]).
///
/// `window` is auto-injected by Tauri (no frontend invoke change needed —
/// same precedent as `terminal.rs`'s `terminal_spawn`); progress events are
/// emitted only to the calling window via `emit_to` so a graph build kicked
/// off in one window's project doesn't spam another window's UI.
#[tauri::command]
pub async fn graphify_build(
    app: AppHandle,
    window: tauri::Window,
    workspace_path: String,
    root: Option<String>,
    include_ext: Option<Vec<String>>,
) -> Result<GraphifyBuildResult, String> {
    let out_path = graph_json_path(&app, &workspace_path)?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cache dir: {}", e))?;
    }
    let out_str = out_path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("unityide-graph")
        .map_err(|e| format!("sidecar not bundled: {}", e))?;

    let mut args: Vec<String> = vec![
        "build".to_string(),
        workspace_path.clone(),
        "--out".to_string(),
        out_str.clone(),
    ];
    if let Some(r) = root {
        args.push("--root".to_string());
        args.push(r);
    }
    if let Some(exts) = include_ext {
        for e in exts {
            args.push("--include-ext".to_string());
            args.push(e);
        }
    }
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();

    let (mut rx, _child) = sidecar
        .args(args_ref)
        .spawn()
        .map_err(|e| format!("spawn sidecar: {}", e))?;

    let mut last_stdout_line: Option<String> = None;
    let mut exit_code: i32 = -1;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line).to_string();
                let trimmed = text.trim().to_string();
                if !trimmed.is_empty() {
                    last_stdout_line = Some(trimmed.clone());
                    let _ = app.emit_to(window.label(), "graphify-build-progress", &trimmed);
                }
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line).to_string();
                let trimmed = text.trim().to_string();
                if !trimmed.is_empty() {
                    let _ = app.emit_to(window.label(), "graphify-build-progress", &trimmed);
                }
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code.unwrap_or(-1);
                break;
            }
            _ => {}
        }
    }

    if exit_code != 0 {
        return Err(format!(
            "sidecar exited with code {} (last line: {:?})",
            exit_code, last_stdout_line
        ));
    }

    let summary_line = last_stdout_line
        .ok_or_else(|| "sidecar produced no output".to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&summary_line)
        .map_err(|e| format!("could not parse sidecar summary line: {} ({})", e, summary_line))?;

    let nodes = parsed.get("nodes").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let edges = parsed.get("edges").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let communities = parsed.get("communities").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    Ok(GraphifyBuildResult {
        nodes,
        edges,
        communities,
        graph_path: out_str,
        summary_path: summary_json_path(&app, &workspace_path)?
            .to_string_lossy()
            .to_string(),
    })
}

/// Free-text traversal over the graph. Returns the sidecar's stdout verbatim
/// — typically a human-readable subgraph dump that fits the model's context.
#[tauri::command]
pub async fn graphify_query(
    app: AppHandle,
    workspace_path: String,
    question: String,
    budget: Option<u32>,
    dfs: Option<bool>,
) -> Result<String, String> {
    let graph_path = graph_json_path(&app, &workspace_path)?;
    if !graph_path.exists() {
        return Err("no graph available — build it first".to_string());
    }
    let graph_str = graph_path.to_string_lossy().to_string();
    let budget_str = budget.unwrap_or(2000).to_string();

    let sidecar = app
        .shell()
        .sidecar("unityide-graph")
        .map_err(|e| format!("sidecar not bundled: {}", e))?;

    let mut args: Vec<String> = vec![
        "query".to_string(),
        graph_str,
        question,
        "--budget".to_string(),
        budget_str,
    ];
    if dfs.unwrap_or(false) {
        args.push("--dfs".to_string());
    }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let (mut rx, _child) = sidecar
        .args(args_ref)
        .spawn()
        .map_err(|e| format!("spawn sidecar: {}", e))?;

    let mut buffer = String::new();
    let mut exit_code: i32 = -1;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                buffer.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Stderr(_) => {}
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code.unwrap_or(-1);
                break;
            }
            _ => {}
        }
    }

    if exit_code != 0 {
        return Err(format!("sidecar query failed with code {}", exit_code));
    }
    Ok(buffer)
}

#[tauri::command]
pub async fn graphify_explain(
    app: AppHandle,
    workspace_path: String,
    node: String,
) -> Result<String, String> {
    let graph_path = graph_json_path(&app, &workspace_path)?;
    if !graph_path.exists() {
        return Err("no graph available — build it first".to_string());
    }
    let graph_str = graph_path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("unityide-graph")
        .map_err(|e| format!("sidecar not bundled: {}", e))?;

    let (mut rx, _child) = sidecar
        .args(["explain", &graph_str, &node])
        .spawn()
        .map_err(|e| format!("spawn sidecar: {}", e))?;

    let mut buffer = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                buffer.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    Ok(buffer)
}

#[tauri::command]
pub async fn graphify_path(
    app: AppHandle,
    workspace_path: String,
    a: String,
    b: String,
) -> Result<String, String> {
    let graph_path = graph_json_path(&app, &workspace_path)?;
    if !graph_path.exists() {
        return Err("no graph available — build it first".to_string());
    }
    let graph_str = graph_path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("unityide-graph")
        .map_err(|e| format!("sidecar not bundled: {}", e))?;

    let (mut rx, _child) = sidecar
        .args(["path", &graph_str, &a, &b])
        .spawn()
        .map_err(|e| format!("spawn sidecar: {}", e))?;

    let mut buffer = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                buffer.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    Ok(buffer)
}

/// Returns metadata about a previously-built graph: node/edge counts, god
/// nodes, last-built timestamp. Returns `available: false` if no graph
/// exists yet for the given workspace.
#[derive(Debug, Serialize, Deserialize)]
pub struct GraphifyLoadSummaryResult {
    pub available: bool,
    pub graph_path: Option<String>,
    pub summary: Option<serde_json::Value>,
    pub last_built_at_ms: Option<u128>,
}

#[tauri::command]
pub async fn graphify_load_summary(
    app: AppHandle,
    workspace_path: String,
) -> Result<GraphifyLoadSummaryResult, String> {
    let graph_path = graph_json_path(&app, &workspace_path)?;
    let summary_path = summary_json_path(&app, &workspace_path)?;
    if !graph_path.exists() {
        return Ok(GraphifyLoadSummaryResult {
            available: false,
            graph_path: None,
            summary: None,
            last_built_at_ms: None,
        });
    }
    let summary = if summary_path.exists() {
        let text = std::fs::read_to_string(&summary_path).map_err(|e| e.to_string())?;
        Some(serde_json::from_str(&text).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let last_built_at_ms = std::fs::metadata(&graph_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis());

    Ok(GraphifyLoadSummaryResult {
        available: true,
        graph_path: Some(graph_path.to_string_lossy().to_string()),
        summary,
        last_built_at_ms,
    })
}

/// `project_symbols` backing: list the symbols (graph nodes) recorded for a
/// file or a type, straight from graph.json — no sidecar invocation, so it
/// works with any previously-built graph. The AST graph's nodes ARE the
/// symbol table: one node per extracted class/function with `label`,
/// `source_file`, and `source_location`.
///
/// Filters: `file` matches by path suffix (so relative paths like
/// `Assets/Scripts/Player.cs` work against absolute stored paths);
/// `type_name` finds the best label match, then lists every symbol in that
/// symbol's file (a type's file is its member table). At least one filter is
/// required.
#[tauri::command]
pub async fn graphify_symbols(
    app: AppHandle,
    workspace_path: String,
    file: Option<String>,
    type_name: Option<String>,
) -> Result<String, String> {
    let graph_path = graph_json_path(&app, &workspace_path)?;
    if !graph_path.exists() {
        return Err("no graph available — build it first".to_string());
    }
    let graph_text = std::fs::read_to_string(&graph_path).map_err(|e| e.to_string())?;
    let graph: serde_json::Value = serde_json::from_str(&graph_text).map_err(|e| e.to_string())?;
    let empty: Vec<serde_json::Value> = Vec::new();
    let nodes = graph.get("nodes").and_then(|v| v.as_array()).unwrap_or(&empty);
    Ok(format_symbols(nodes, file.as_deref(), type_name.as_deref()))
}

const MAX_SYMBOL_FILES: usize = 4;
const MAX_SYMBOLS_PER_FILE: usize = 64;
const MAX_SYMBOLS_OUTPUT: usize = 2048;

/// Pure formatting core of `graphify_symbols` (unit-tested below).
fn format_symbols(
    nodes: &[serde_json::Value],
    file: Option<&str>,
    type_name: Option<&str>,
) -> String {
    use std::collections::BTreeMap;

    let node_str = |n: &serde_json::Value, key: &str| -> String {
        n.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
    };

    // Resolve the target files.
    let mut target_files: Vec<String> = Vec::new();
    if let Some(f) = file {
        let needle = f.trim_start_matches("./");
        let mut matches: Vec<String> = nodes
            .iter()
            .map(|n| node_str(n, "source_file"))
            .filter(|sf| !sf.is_empty() && sf.ends_with(needle))
            .collect();
        matches.sort();
        matches.dedup();
        target_files.extend(matches.into_iter().take(MAX_SYMBOL_FILES));
    }
    if target_files.is_empty() {
        if let Some(t) = type_name {
            let term = t.to_lowercase();
            let mut best: Option<(usize, String)> = None;
            for n in nodes {
                let label = node_str(n, "label").to_lowercase();
                if label.contains(&term) {
                    // Prefer the shortest containing label (closest match).
                    let sf = node_str(n, "source_file");
                    if sf.is_empty() {
                        continue;
                    }
                    if best.as_ref().map(|(len, _)| label.len() < *len).unwrap_or(true) {
                        best = Some((label.len(), sf));
                    }
                }
            }
            if let Some((_, sf)) = best {
                target_files.push(sf);
            }
        }
    }

    if target_files.is_empty() {
        return match (file, type_name) {
            (None, None) => "project_symbols needs a `file` or `type` argument.".to_string(),
            _ => "No symbols found — check the path/type name, or rebuild the graph if the file is new.".to_string(),
        };
    }

    // Group matching nodes by file, ordered by source_location then label.
    let mut by_file: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for n in nodes {
        let sf = node_str(n, "source_file");
        if target_files.contains(&sf) {
            by_file
                .entry(sf)
                .or_default()
                .push((node_str(n, "source_location"), node_str(n, "label")));
        }
    }

    let mut lines: Vec<String> = Vec::new();
    for (sf, mut symbols) in by_file {
        symbols.sort();
        lines.push(format!("FILE {}", sf));
        let total = symbols.len();
        for (loc, label) in symbols.into_iter().take(MAX_SYMBOLS_PER_FILE) {
            if loc.is_empty() {
                lines.push(format!("  {}", label));
            } else {
                lines.push(format!("  {} [{}]", label, loc));
            }
        }
        if total > MAX_SYMBOLS_PER_FILE {
            lines.push(format!("  … {} more symbols", total - MAX_SYMBOLS_PER_FILE));
        }
    }

    let mut out = lines.join("\n");
    if out.len() > MAX_SYMBOLS_OUTPUT {
        out.truncate(MAX_SYMBOLS_OUTPUT);
        out.push_str("\n… (truncated)");
    }
    out
}

#[cfg(test)]
mod symbol_tests {
    use super::format_symbols;
    use serde_json::json;

    fn nodes() -> Vec<serde_json::Value> {
        vec![
            json!({"label": "PlayerController", "source_file": "/ws/Assets/Scripts/PlayerController.cs", "source_location": "L10"}),
            json!({"label": "PlayerController.Move", "source_file": "/ws/Assets/Scripts/PlayerController.cs", "source_location": "L25"}),
            json!({"label": "GameManager", "source_file": "/ws/Assets/Scripts/GameManager.cs", "source_location": "L5"}),
        ]
    }

    #[test]
    fn file_filter_matches_by_suffix() {
        let out = format_symbols(&nodes(), Some("Assets/Scripts/PlayerController.cs"), None);
        assert!(out.contains("FILE /ws/Assets/Scripts/PlayerController.cs"));
        assert!(out.contains("PlayerController.Move [L25]"));
        assert!(!out.contains("GameManager"));
    }

    #[test]
    fn type_filter_lists_the_owning_file() {
        let out = format_symbols(&nodes(), None, Some("gamemanager"));
        assert!(out.contains("FILE /ws/Assets/Scripts/GameManager.cs"));
        assert!(out.contains("GameManager [L5]"));
    }

    #[test]
    fn no_match_and_no_args_are_reported() {
        let out = format_symbols(&nodes(), Some("Nope.cs"), None);
        assert!(out.contains("No symbols found"));
        let out2 = format_symbols(&nodes(), None, None);
        assert!(out2.contains("needs a `file` or `type`"));
    }
}

/// Build a trimmed projection of the locally-built graph for server-side AI
/// enrichment. We group nodes by community and sample a handful of member
/// labels/files per community (and pull god nodes from the summary), so the
/// payload — and the model's context — stays small even for huge graphs.
///
/// Returns the exact shape the arcane-server `/v1/graph/enrich` endpoint
/// expects (`GraphEnrichRequest`).
#[tauri::command]
pub async fn graphify_enrich_payload(
    app: AppHandle,
    workspace_path: String,
) -> Result<serde_json::Value, String> {
    use std::collections::{BTreeMap, BTreeSet};

    const MAX_COMMUNITIES: usize = 30;
    const MAX_LABELS_PER_COMMUNITY: usize = 12;
    const MAX_FILES_PER_COMMUNITY: usize = 8;

    let graph_path = graph_json_path(&app, &workspace_path)?;
    if !graph_path.exists() {
        return Err("no graph available — build it first".to_string());
    }
    let graph_text = std::fs::read_to_string(&graph_path).map_err(|e| e.to_string())?;
    let graph: serde_json::Value = serde_json::from_str(&graph_text).map_err(|e| e.to_string())?;

    let empty: Vec<serde_json::Value> = Vec::new();
    let nodes = graph.get("nodes").and_then(|v| v.as_array()).unwrap_or(&empty);
    let links = graph.get("links").and_then(|v| v.as_array()).unwrap_or(&empty);

    // community id -> (sample labels, sample files, total size)
    let mut by_comm: BTreeMap<i64, (Vec<String>, Vec<String>, u32)> = BTreeMap::new();
    let mut languages: BTreeSet<String> = BTreeSet::new();

    for n in nodes {
        let comm = n.get("community").and_then(|v| v.as_i64()).unwrap_or(-1);
        let label = n.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let file = n
            .get("source_file")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let entry = by_comm.entry(comm).or_insert_with(|| (Vec::new(), Vec::new(), 0));
        entry.2 += 1;
        if !label.is_empty() && entry.0.len() < MAX_LABELS_PER_COMMUNITY {
            entry.0.push(label);
        }
        if let Some(f) = file {
            if let Some(ext) = f.rsplit('.').next() {
                if f.contains('.') && ext.len() <= 5 && !ext.is_empty() {
                    languages.insert(ext.to_string());
                }
            }
            if entry.1.len() < MAX_FILES_PER_COMMUNITY && !entry.1.contains(&f) {
                entry.1.push(f);
            }
        }
    }

    let total_communities = by_comm.len();

    // Largest communities first; cap the count we send.
    let mut comm_vec: Vec<(i64, (Vec<String>, Vec<String>, u32))> = by_comm.into_iter().collect();
    comm_vec.sort_by(|a, b| b.1 .2.cmp(&a.1 .2));
    let communities: Vec<serde_json::Value> = comm_vec
        .into_iter()
        .take(MAX_COMMUNITIES)
        .map(|(id, (labels, files, size))| {
            serde_json::json!({
                "id": id,
                "size": size,
                "sampleLabels": labels,
                "sampleFiles": files,
            })
        })
        .collect();

    // God nodes already have the {label, source_file} shape in the summary.
    let summary_path = summary_json_path(&app, &workspace_path)?;
    let god_nodes = if summary_path.exists() {
        let text = std::fs::read_to_string(&summary_path).map_err(|e| e.to_string())?;
        let summary: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        summary
            .get("god_nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(serde_json::json!({
        "stats": {
            "nodes": nodes.len(),
            "edges": links.len(),
            "communities": total_communities,
        },
        "godNodes": god_nodes,
        "communities": communities,
        "languages": languages.into_iter().collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod sidecar_wiring_tests {
    use std::collections::BTreeSet;

    /// Every sidecar name this module spawns, scraped from its own source.
    /// Scraped rather than listed so the test cannot go stale behind a new
    /// `sidecar(...)` call site that nobody remembered to register here.
    fn spawned_names(src: &str) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        for (i, _) in src.match_indices(".sidecar(\"") {
            let rest = &src[i + ".sidecar(\"".len()..];
            if let Some(end) = rest.find('"') {
                out.insert(rest[..end].to_string());
            }
        }
        out
    }

    /// Renaming the graph sidecar means touching three files that no compiler
    /// checks against each other: the spawn call here, `bundle.externalBin` in
    /// tauri.conf.json, and the `shell:allow-spawn` allowlist in
    /// capabilities/default.json.
    ///
    /// Miss the capability file and there is no build error and no test
    /// failure — the binary is bundled, the code compiles, and the spawn is
    /// denied at runtime in the packaged app only. This test is the thing that
    /// turns that into a `cargo test` failure instead.
    #[test]
    fn spawned_sidecars_are_bundled_and_permitted() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let spawned = spawned_names(include_str!("graphify.rs"));
        assert!(
            !spawned.is_empty(),
            "scraped no sidecar() calls — the scraper has drifted from the code"
        );

        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap())
                .unwrap();
        let bundled: BTreeSet<String> = conf["bundle"]["externalBin"]
            .as_array()
            .expect("tauri.conf.json bundle.externalBin must be an array")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        let caps: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("capabilities/default.json")).unwrap(),
        )
        .unwrap();
        let permitted: BTreeSet<String> = caps["permissions"]
            .as_array()
            .expect("capabilities/default.json must have a permissions array")
            .iter()
            .filter(|p| p["identifier"] == "shell:allow-spawn")
            .filter_map(|p| p["allow"].as_array())
            .flatten()
            .filter_map(|a| a["name"].as_str().map(str::to_string))
            .collect();

        for name in &spawned {
            let path = format!("binaries/{name}");
            assert!(
                bundled.contains(&path),
                "graphify.rs spawns {name:?} but tauri.conf.json bundle.externalBin \
                 does not list {path:?} — the binary would not ship. Bundled: {bundled:?}"
            );
            assert!(
                permitted.contains(&path),
                "graphify.rs spawns {name:?} but capabilities/default.json does not \
                 allow {path:?} under shell:allow-spawn — this builds and tests clean, \
                 then denies the spawn at runtime in the packaged app. Permitted: {permitted:?}"
            );
        }
    }
}
