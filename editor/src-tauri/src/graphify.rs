//! Tauri command wrappers around the bundled `arcane-graph` PyInstaller
//! sidecar. The sidecar does AST-only structural extraction and graph
//! traversal; this module shells out to it and streams progress events
//! back to the frontend.
//!
//! Graph artifacts live at `~/.arcane/graphs/<sha1(workspace)>/graph.json`
//! — outside the user's project tree so we never pollute their working
//! directory or .gitignore.

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
fn graph_dir_for(workspace_path: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let mut hasher = Sha1::new();
    hasher.update(workspace_path.as_bytes());
    let hash = hex::encode_short(&hasher.finalize());
    Ok(home.join(".arcane").join("graphs").join(hash))
}

fn graph_json_path(workspace_path: &str) -> Result<PathBuf, String> {
    Ok(graph_dir_for(workspace_path)?.join("graph.json"))
}

fn summary_json_path(workspace_path: &str) -> Result<PathBuf, String> {
    Ok(graph_dir_for(workspace_path)?.join("graph.summary.json"))
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
    let sidecar = match app.shell().sidecar("arcane-graph") {
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
    // we keep at src-tauri/binaries/arcane-graph-<triple> so cargo check can
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
    let out_path = graph_json_path(&workspace_path)?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cache dir: {}", e))?;
    }
    let out_str = out_path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("arcane-graph")
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
        summary_path: summary_json_path(&workspace_path)?
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
    let graph_path = graph_json_path(&workspace_path)?;
    if !graph_path.exists() {
        return Err("no graph available — build it first".to_string());
    }
    let graph_str = graph_path.to_string_lossy().to_string();
    let budget_str = budget.unwrap_or(2000).to_string();

    let sidecar = app
        .shell()
        .sidecar("arcane-graph")
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
    let graph_path = graph_json_path(&workspace_path)?;
    if !graph_path.exists() {
        return Err("no graph available — build it first".to_string());
    }
    let graph_str = graph_path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("arcane-graph")
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
    let graph_path = graph_json_path(&workspace_path)?;
    if !graph_path.exists() {
        return Err("no graph available — build it first".to_string());
    }
    let graph_str = graph_path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("arcane-graph")
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
    _app: AppHandle,
    workspace_path: String,
) -> Result<GraphifyLoadSummaryResult, String> {
    let graph_path = graph_json_path(&workspace_path)?;
    let summary_path = summary_json_path(&workspace_path)?;
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

/// Build a trimmed projection of the locally-built graph for server-side AI
/// enrichment. We group nodes by community and sample a handful of member
/// labels/files per community (and pull god nodes from the summary), so the
/// payload — and the model's context — stays small even for huge graphs.
///
/// Returns the exact shape the arcane-server `/v1/graph/enrich` endpoint
/// expects (`GraphEnrichRequest`).
#[tauri::command]
pub async fn graphify_enrich_payload(
    _app: AppHandle,
    workspace_path: String,
) -> Result<serde_json::Value, String> {
    use std::collections::{BTreeMap, BTreeSet};

    const MAX_COMMUNITIES: usize = 30;
    const MAX_LABELS_PER_COMMUNITY: usize = 12;
    const MAX_FILES_PER_COMMUNITY: usize = 8;

    let graph_path = graph_json_path(&workspace_path)?;
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
    let summary_path = summary_json_path(&workspace_path)?;
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
