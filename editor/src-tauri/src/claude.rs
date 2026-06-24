// Claude Code via Agent Client Protocol (ACP)
//
// Spawns the `@agentclientprotocol/claude-agent-acp` bridge as a subprocess.
// The bridge translates between ACP (JSON-RPC 2.0 over newline-delimited JSON
// on stdio) and Anthropic's Claude Agent SDK, which in turn drives the user's
// locally-installed `claude` CLI.
//
// One bridge instance per window. Wire format on the bridge's stdio is one
// JSON object per line — NOT LSP-style Content-Length framing.
//
// We are a thin pass-through: Rust spawns the process, forwards JSON lines as
// `claude-message` events to the frontend, and writes lines sent via
// `claude_send` to the bridge's stdin. All ACP semantics (request id
// correlation, fs/* and terminal/* handlers, permission flow) live on the
// frontend.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Pinned bridge package for the npx fallback. Bump deliberately; pinning avoids
/// `@latest` version drift and the documented first-run ENOENT flakiness.
const BRIDGE_PKG: &str = "@agentclientprotocol/claude-agent-acp@0.44.0";

// ── Per-window registry ─────────────────────────────────────────

pub struct ClaudeBridge {
    stdin: Option<tokio::process::ChildStdin>,
    child: Option<Child>,
}

pub struct ClaudeState(pub Arc<Mutex<HashMap<String, ClaudeBridge>>>);

impl ClaudeState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }

    pub async fn drop_window(&self, label: &str) {
        let mut map = self.0.lock().await;
        if let Some(mut bridge) = map.remove(label) {
            kill_and_clear(&mut bridge).await;
        }
    }
}

async fn kill_and_clear(bridge: &mut ClaudeBridge) {
    bridge.stdin.take();
    if let Some(mut child) = bridge.child.take() {
        let _ = child.kill().await;
    }
}

// ── PATH probing ────────────────────────────────────────────────
//
// GUI apps on macOS don't inherit the shell's PATH. Same issue as csharp-ls
// in lsp.rs. We probe known npm/node locations and prepend the discovered
// directories to PATH when spawning the bridge so `npx` and `claude` are
// findable.

fn extra_path_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        // nvm — picks every installed version's bin dir (newest first by lex order).
        let nvm_dir = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            versions.sort();
            versions.reverse();
            dirs.extend(versions);
        }
        // volta, fnm, asdf, plain ~/.local/bin
        dirs.push(home.join(".volta").join("bin"));
        dirs.push(home.join(".fnm").join("aliases").join("default").join("bin"));
        dirs.push(home.join(".asdf").join("shims"));
        dirs.push(home.join(".local").join("bin"));
        // npm global install prefix (default location when no nvm)
        dirs.push(home.join(".npm-global").join("bin"));
    }

    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
    } else if cfg!(target_os = "linux") {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
    } else if cfg!(target_os = "windows") {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local_app_data).join("Programs").join("nodejs"));
        }
        dirs.push(PathBuf::from("C:\\Program Files\\nodejs"));
        dirs.push(PathBuf::from("C:\\Program Files (x86)\\nodejs"));
    }

    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

fn augmented_path() -> String {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut paths: Vec<PathBuf> = extra_path_dirs();
    paths.extend(std::env::split_paths(&existing));
    std::env::join_paths(paths)
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|_| existing.to_string_lossy().to_string())
}

/// Find a binary by name across the augmented PATH. Returns the first match.
fn find_in_path(name: &str) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") && !name.ends_with(".exe") {
        format!("{}.exe", name)
    } else {
        name.to_string()
    };

    let mut dirs = extra_path_dirs();
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            dirs.push(dir);
        }
    }

    for dir in dirs {
        let p = dir.join(&exe_name);
        if p.is_file() {
            return Some(p);
        }
        // Also try the bare name without .exe on Windows (e.g. shims/scripts)
        if cfg!(target_os = "windows") {
            let bare = dir.join(name);
            if bare.is_file() {
                return Some(bare);
            }
            let cmd = dir.join(format!("{}.cmd", name));
            if cmd.is_file() {
                return Some(cmd);
            }
        }
    }
    None
}

// ── Install detection ───────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ClaudeInstallInfo {
    /// Path to the `claude` CLI if found.
    pub claude_path: Option<String>,
    /// Path to `node` if found (needed for npx fallback).
    pub node_path: Option<String>,
    /// Path to `claude-agent-acp` if globally installed.
    pub bridge_path: Option<String>,
}

/// Probe the system for the binaries needed to run the Claude Agent.
/// Best-effort and synchronous; suitable to call on agent panel mount.
#[tauri::command]
pub fn claude_check_install() -> ClaudeInstallInfo {
    ClaudeInstallInfo {
        claude_path: find_in_path("claude").map(|p| p.to_string_lossy().to_string()),
        node_path: find_in_path("node").map(|p| p.to_string_lossy().to_string()),
        bridge_path: find_in_path("claude-agent-acp")
            .map(|p| p.to_string_lossy().to_string()),
    }
}

// ── Spawning the bridge ─────────────────────────────────────────

/// Start the Claude ACP bridge for this window. If one is already running, it
/// is torn down first.
///
/// `workspace_path` is set as the bridge's working directory; the bridge
/// forwards it to Claude as the project root.
///
/// `executable_override` optionally pins the `claude` binary the bridge
/// invokes (sets `CLAUDE_CODE_EXECUTABLE`). If omitted, the bridge resolves
/// `claude` from PATH itself.
#[tauri::command]
pub async fn claude_start(
    app_handle: AppHandle,
    window: Window,
    state: tauri::State<'_, ClaudeState>,
    workspace_path: String,
    executable_override: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let mut map = state.0.lock().await;

    // Tear down any prior instance for this window.
    if let Some(mut prev) = map.remove(&label) {
        kill_and_clear(&mut prev).await;
    }

    let path_value = augmented_path();

    // Resolution order, most-preferred first:
    //   1. ARCANE_CLAUDE_BRIDGE env override (a vendored/pinned bridge path)
    //   2. a globally-installed `claude-agent-acp` on PATH
    //   3. `npx -y <pinned bridge>` (auto-installs into npx's cache)
    // The npx fallback pins an exact version to avoid `@latest` drift and the
    // documented first-run ENOENT flakiness from unpinned installs.
    let (program, args): (String, Vec<String>) = if let Some(bridge_override) =
        std::env::var("ARCANE_CLAUDE_BRIDGE").ok().filter(|s| !s.is_empty())
    {
        (bridge_override, Vec::new())
    } else if let Some(bin) = find_in_path("claude-agent-acp") {
        (bin.to_string_lossy().to_string(), Vec::new())
    } else if let Some(npx) = find_in_path("npx") {
        (
            npx.to_string_lossy().to_string(),
            vec!["-y".to_string(), BRIDGE_PKG.to_string()],
        )
    } else {
        return Err(
            "Could not find `claude-agent-acp` or `npx` on PATH. Install Node.js \
             (https://nodejs.org) or run `npm i -g @agentclientprotocol/claude-agent-acp` \
             then try again."
                .to_string(),
        );
    };

    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&workspace_path)
        .env("PATH", &path_value)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(claude_bin) = executable_override.as_ref().filter(|s| !s.is_empty()) {
        command.env("CLAUDE_CODE_EXECUTABLE", claude_bin);
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        // npx's first-run install can race and surface as NotFound; retry once.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => command.spawn().map_err(|e2| {
            format!(
                "Failed to spawn Claude ACP bridge ({}): {}. \
                 Make sure the `claude` CLI is installed (see https://code.claude.com/docs).",
                program, e2
            )
        })?,
        Err(e) => {
            return Err(format!(
                "Failed to spawn Claude ACP bridge ({}): {}. \
                 Make sure the `claude` CLI is installed (see https://code.claude.com/docs).",
                program, e
            ));
        }
    };

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture bridge stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture bridge stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture bridge stderr".to_string())?;

    map.insert(
        label.clone(),
        ClaudeBridge {
            stdin: Some(stdin),
            child: Some(child),
        },
    );

    // ── stdout: newline-delimited JSON, one ACP message per line ──
    {
        let handle = app_handle.clone();
        let label_clone = label.clone();
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        let _ = handle.emit_to(
                            label_clone.as_str(),
                            "claude-message",
                            serde_json::json!({ "body": line }),
                        );
                    }
                    Ok(None) => {
                        let _ = handle.emit_to(
                            label_clone.as_str(),
                            "claude-exited",
                            serde_json::json!({}),
                        );
                        break;
                    }
                    Err(e) => {
                        eprintln!("[Claude stdout] read error: {}", e);
                        let _ = handle.emit_to(
                            label_clone.as_str(),
                            "claude-exited",
                            serde_json::json!({ "error": e.to_string() }),
                        );
                        break;
                    }
                }
            }
        });
    }

    // ── stderr: forward each line as `claude-stderr` for diagnostics ──
    {
        let handle = app_handle.clone();
        let label_clone = label.clone();
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[Claude stderr] {}", line);
                let _ = handle.emit_to(
                    label_clone.as_str(),
                    "claude-stderr",
                    serde_json::json!({ "body": line }),
                );
            }
        });
    }

    Ok(())
}

/// Write one ACP message (no framing) to the bridge's stdin.
/// Caller supplies the raw JSON string; this function appends a newline.
#[tauri::command]
pub async fn claude_send(
    window: Window,
    state: tauri::State<'_, ClaudeState>,
    message: String,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.0.lock().await;
    let bridge = map
        .get_mut(label)
        .ok_or_else(|| format!("Claude bridge not running for window '{}'", label))?;
    let stdin = bridge
        .stdin
        .as_mut()
        .ok_or_else(|| "Claude bridge stdin is not available".to_string())?;

    let mut payload = message;
    if !payload.ends_with('\n') {
        payload.push('\n');
    }

    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to Claude bridge stdin: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush Claude bridge stdin: {}", e))?;
    Ok(())
}

/// Stop the bridge for this window. Idempotent.
#[tauri::command]
pub async fn claude_stop(
    window: Window,
    state: tauri::State<'_, ClaudeState>,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.0.lock().await;
    if let Some(mut bridge) = map.remove(label) {
        kill_and_clear(&mut bridge).await;
    }
    Ok(())
}

