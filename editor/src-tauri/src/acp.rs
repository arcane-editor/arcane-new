//! External coding agents over the Agent Client Protocol (ACP).
//!
//! ACP is JSON-RPC 2.0 spoken over a child process's stdio, as **newline-
//! delimited JSON** — one complete JSON object per line, with no
//! `Content-Length` header. That is the single most important difference from
//! `lsp.rs`/`dap.rs`, and it makes the read loop a plain `lines()` iterator.
//!
//! This module is a byte pipe plus a package manager. It knows nothing about
//! sessions, prompts or permissions: it spawns the agent, forwards each stdout
//! line to the frontend as an `acp-message` event, and writes lines handed to
//! `acp_send` to the agent's stdin. All protocol semantics live in TypeScript
//! (`src/features/acp` and `src/features/ai-panel/services/claude-backend.ts`),
//! which is also where the request-id map lives — exactly the split `lsp.rs`
//! uses.
//!
//! One agent instance per (window, agent id), so two windows can each run their
//! own Claude without sharing state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, OnceCell};

/// The adapter Arcane installs for the `claude` agent.
///
/// Pinned deliberately. `@latest` drifts under users mid-session, and the
/// protocol surface an agent advertises changes between releases; a pin means a
/// version bump is a reviewed change with a known payload.
///
/// Renamed from `@zed-industries/claude-code-acp`, which npm now marks
/// deprecated.
pub const CLAUDE_AGENT_PKG: &str = "@agentclientprotocol/claude-agent-acp";
pub const CLAUDE_AGENT_VERSION: &str = "0.70.0";

/// Written only after a successful install, so a crashed or half-finished one
/// reads back as "not installed" and simply reinstalls.
const MANIFEST_NAME: &str = ".arcane-agent.json";

// ── Per-window registry ─────────────────────────────────────────

pub struct AcpAgent {
    stdin: Option<tokio::process::ChildStdin>,
    child: Option<Child>,
}

/// Window label → agent id → the running agent.
///
/// The inner `Arc` is public so `lib.rs`'s `WindowEvent::Destroyed` handler can
/// clone it into a `'static` task — `drop_window` is async (the map is behind a
/// `tokio::sync::Mutex`) and the event handler is not.
pub struct AcpState(pub Arc<Mutex<HashMap<String, HashMap<String, AcpAgent>>>>);

impl AcpState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }

    pub async fn drop_window(&self, label: &str) {
        let mut map = self.0.lock().await;
        if let Some(mut agents) = map.remove(label) {
            for (_id, agent) in agents.iter_mut() {
                kill_and_clear(agent).await;
            }
        }
    }
}

impl Default for AcpState {
    fn default() -> Self {
        Self::new()
    }
}

async fn kill_and_clear(agent: &mut AcpAgent) {
    // Drop stdin first: a well-behaved agent exits on EOF, which is a cleaner
    // shutdown than SIGKILL and lets it flush any pending session state.
    agent.stdin.take();
    if let Some(mut child) = agent.child.take() {
        let _ = child.kill().await;
    }
}

// ── PATH discovery ──────────────────────────────────────────────
//
// GUI apps on macOS are launched by launchd and inherit its minimal PATH, not
// the user's shell PATH. Node installed through nvm/volta/fnm/asdf — which is
// how most developers have it — is therefore invisible to us even though it is
// on their PATH in every terminal they open. `lsp.rs` hits the same wall with
// `dotnet` and solves it by probing known locations; we do that, and then fall
// back to asking the user's login shell directly.

fn extra_path_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        // nvm keeps every installed version side by side; prefer the newest by
        // lexical order, which is right for the v-prefixed names it uses.
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
        dirs.push(home.join(".volta").join("bin"));
        dirs.push(home.join(".fnm").join("aliases").join("default").join("bin"));
        dirs.push(home.join(".asdf").join("shims"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".bun").join("bin"));
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

/// PATH as reported by the user's login shell.
///
/// Last resort, and cached for the process lifetime: spawning a login shell
/// runs the user's full profile, which can take hundreds of milliseconds and
/// must not happen on every probe. Never fails loudly — an empty result just
/// means we fall back to the probed directories.
static LOGIN_SHELL_PATH: OnceCell<Option<String>> = OnceCell::const_new();

async fn login_shell_path() -> Option<String> {
    LOGIN_SHELL_PATH
        .get_or_init(|| async {
            if cfg!(target_os = "windows") {
                return None;
            }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let child = crate::process_util::async_command(&shell)
                .args(["-ilc", "printf %s \"$PATH\""])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .output();

            // A misconfigured profile can hang forever (a prompt, a blocking
            // `read`). Cap it rather than wedging the agent panel.
            match tokio::time::timeout(std::time::Duration::from_secs(5), child).await {
                Ok(Ok(out)) if out.status.success() => {
                    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if path.is_empty() {
                        None
                    } else {
                        Some(path)
                    }
                }
                _ => None,
            }
        })
        .await
        .clone()
}

/// Every directory worth searching, most specific first.
async fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = extra_path_dirs();
    if let Ok(path_var) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path_var));
    }
    if let Some(shell_path) = login_shell_path().await {
        dirs.extend(std::env::split_paths(&shell_path));
    }
    dirs
}

/// PATH to hand the child process: our discoveries prepended to what we have.
async fn augmented_path() -> String {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = search_dirs().await;
    paths.extend(std::env::split_paths(&existing));
    // Preserve order while dropping duplicates, so the child's PATH stays short.
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    std::env::join_paths(paths)
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|_| existing.to_string_lossy().to_string())
}

/// Candidate filenames for `name` on this platform. Windows needs the
/// extensions because npm installs shims (`.cmd`), not bare executables.
fn executable_names(name: &str) -> Vec<String> {
    if cfg!(target_os = "windows") {
        vec![
            format!("{}.exe", name),
            format!("{}.cmd", name),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    }
}

async fn find_in_path(name: &str) -> Option<PathBuf> {
    let candidates = executable_names(name);
    for dir in search_dirs().await {
        for candidate in &candidates {
            let p = dir.join(candidate);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

// ── Install layout ──────────────────────────────────────────────

/// `~/.arcane/agents/<id>` (or `~/.arcane-dev/...` on a dev build).
///
/// A private npm prefix, deliberately not a global install: it needs no
/// elevated permissions, cannot collide with the user's own tooling, and is
/// removable by deleting one directory.
fn agent_dir(app: &AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    Ok(crate::auth::arcane_home_dir(app)?
        .join("agents")
        .join(agent_id))
}

fn adapter_entry(dir: &Path) -> PathBuf {
    dir.join("node_modules")
        .join("@agentclientprotocol")
        .join("claude-agent-acp")
        .join("dist")
        .join("index.js")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct InstallManifest {
    package: String,
    version: String,
    uses_external_cli: bool,
}

fn read_manifest(dir: &Path) -> Option<InstallManifest> {
    let text = std::fs::read_to_string(dir.join(MANIFEST_NAME)).ok()?;
    serde_json::from_str(&text).ok()
}

// ── Probe ───────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProbe {
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub npm_path: Option<String>,
    pub claude_path: Option<String>,
    pub installed_version: Option<String>,
    pub adapter_entry: Option<String>,
    pub uses_external_cli: bool,
    pub pinned_version: String,
}

async fn node_version(node: &Path) -> Option<String> {
    let out = crate::process_util::async_command(node)
        .arg("-v")
        .stdin(std::process::Stdio::null())
        .output();
    match tokio::time::timeout(std::time::Duration::from_secs(10), out).await {
        Ok(Ok(o)) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => None,
    }
}

/// What is on this machine right now. Never mutates anything; safe to call on
/// every panel mount.
#[tauri::command]
pub async fn acp_probe(app: AppHandle, agent_id: String) -> Result<AcpProbe, String> {
    let dir = agent_dir(&app, &agent_id)?;
    let entry = adapter_entry(&dir);

    // The manifest alone is not proof: `node_modules` can be deleted out from
    // under it. Both must be present to count as installed.
    let manifest = read_manifest(&dir).filter(|_| entry.is_file());

    let node = find_in_path("node").await;
    let node_version = match node.as_ref() {
        Some(p) => node_version(p).await,
        None => None,
    };

    Ok(AcpProbe {
        node_path: node.map(|p| p.to_string_lossy().to_string()),
        node_version,
        npm_path: find_in_path("npm").await.map(|p| p.to_string_lossy().to_string()),
        claude_path: find_in_path("claude").await.map(|p| p.to_string_lossy().to_string()),
        uses_external_cli: manifest.as_ref().map(|m| m.uses_external_cli).unwrap_or(false),
        installed_version: manifest.map(|m| m.version),
        adapter_entry: entry.is_file().then(|| entry.to_string_lossy().to_string()),
        pinned_version: CLAUDE_AGENT_VERSION.to_string(),
    })
}

// ── Install ─────────────────────────────────────────────────────

/// npm arguments for a managed install into `dir`.
///
/// Split out as a pure function so the `--omit=optional` decision — the one
/// that turns a ~321 MB download into a ~5 MB one — is testable without npm.
pub fn install_args(dir: &Path, spec: &str, reuse_existing_cli: bool) -> Vec<String> {
    let mut args = vec![
        "install".to_string(),
        "--prefix".to_string(),
        dir.to_string_lossy().to_string(),
        // Nothing here is a project: silence the noise npm emits about it.
        "--no-audit".to_string(),
        "--no-fund".to_string(),
        "--loglevel".to_string(),
        "info".to_string(),
    ];
    if reuse_existing_cli {
        // The adapter resolves its Claude binary from CLAUDE_CODE_EXECUTABLE
        // before it looks at its own platform-specific optional dependency, so
        // skipping optionals is safe exactly when we can supply that path.
        args.push("--omit=optional".to_string());
    }
    args.push(spec.to_string());
    args
}

/// Install or upgrade the adapter, streaming npm's output to the frontend.
#[tauri::command]
pub async fn acp_install(
    app: AppHandle,
    window: Window,
    agent_id: String,
    reuse_existing_cli: bool,
) -> Result<AcpProbe, String> {
    let dir = agent_dir(&app, &agent_id)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;

    let npm = find_in_path("npm").await.ok_or_else(|| {
        "npm was not found. Install Node.js 22 or newer from https://nodejs.org and try again."
            .to_string()
    })?;

    // A stale manifest must not survive a failed reinstall — otherwise a broken
    // tree keeps reporting itself as a good install.
    let _ = std::fs::remove_file(dir.join(MANIFEST_NAME));

    let spec = format!("{}@{}", CLAUDE_AGENT_PKG, CLAUDE_AGENT_VERSION);
    let args = install_args(&dir, &spec, reuse_existing_cli);
    let path_value = augmented_path().await;

    let mut child = crate::process_util::async_command(&npm)
        .args(&args)
        .current_dir(&dir)
        .env("PATH", &path_value)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to run npm ({}): {}", npm.display(), e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture npm stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture npm stderr")?;

    let label = window.label().to_string();
    spawn_progress_pump(app.clone(), label.clone(), agent_id.clone(), stdout, "stdout");
    // npm writes its progress to stderr, so this stream carries the interesting
    // lines. It is retained rather than discarded because it is also the only
    // explanation the user gets when an install fails.
    let stderr_tail = spawn_stderr_pump(app.clone(), label, agent_id.clone(), stderr);

    let status = child
        .wait()
        .await
        .map_err(|e| format!("npm did not complete: {}", e))?;

    if !status.success() {
        let tail = stderr_tail.lock().await.join("\n");
        return Err(format!(
            "npm install failed (exit {}).\n{}",
            status.code().unwrap_or(-1),
            tail
        ));
    }

    let entry = adapter_entry(&dir);
    if !entry.is_file() {
        return Err(format!(
            "npm reported success but {} is missing. Try installing again.",
            entry.display()
        ));
    }

    // Manifest LAST: its presence is what marks the install complete.
    let manifest = InstallManifest {
        package: CLAUDE_AGENT_PKG.to_string(),
        version: CLAUDE_AGENT_VERSION.to_string(),
        uses_external_cli: reuse_existing_cli,
    };
    std::fs::write(
        dir.join(MANIFEST_NAME),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Could not record the install: {}", e))?;

    acp_probe(app, agent_id).await
}

fn spawn_progress_pump(
    app: AppHandle,
    label: String,
    agent_id: String,
    stream: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    kind: &'static str,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit_to(
                label.as_str(),
                "acp-install-progress",
                serde_json::json!({ "agentId": agent_id, "line": line, "stream": kind }),
            );
        }
    });
}

/// Like `spawn_progress_pump`, but also keeps the last few lines so a failure
/// can be explained instead of just reported.
fn spawn_stderr_pump(
    app: AppHandle,
    label: String,
    agent_id: String,
    stream: impl tokio::io::AsyncRead + Unpin + Send + 'static,
) -> Arc<Mutex<Vec<String>>> {
    const TAIL_LINES: usize = 20;
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = tail.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            {
                let mut buf = sink.lock().await;
                buf.push(line.clone());
                if buf.len() > TAIL_LINES {
                    let excess = buf.len() - TAIL_LINES;
                    buf.drain(0..excess);
                }
            }
            let _ = app.emit_to(
                label.as_str(),
                "acp-install-progress",
                serde_json::json!({ "agentId": agent_id, "line": line, "stream": "stderr" }),
            );
        }
    });
    tail
}

// ── Running the agent ───────────────────────────────────────────

/// Spawn an agent for this window. Any previous instance under the same id is
/// torn down first, so this doubles as "restart".
#[tauri::command]
pub async fn acp_start(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, AcpState>,
    agent_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let path_value = augmented_path().await;

    let mut cmd: Command = crate::process_util::async_command(&command);
    cmd.args(&args)
        .current_dir(&cwd)
        .env("PATH", &path_value)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    for (key, value) in env.unwrap_or_default() {
        cmd.env(key, value);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to start the agent ({}): {}. Check that Node.js 22+ is installed.",
            command, e
        )
    })?;

    let stdin = child.stdin.take().ok_or("Failed to capture agent stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture agent stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture agent stderr")?;

    {
        let mut map = state.0.lock().await;
        let agents = map.entry(label.clone()).or_default();
        if let Some(mut prev) = agents.remove(&agent_id) {
            kill_and_clear(&mut prev).await;
        }
        agents.insert(
            agent_id.clone(),
            AcpAgent {
                stdin: Some(stdin),
                child: Some(child),
            },
        );
    }

    // ── stdout: newline-delimited JSON, one ACP message per line ──
    {
        let handle = app.clone();
        let registry = state.0.clone();
        let win = label.clone();
        let id = agent_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let exit_error = loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        trace_append(&id, "<-", &line);
                        let _ = handle.emit_to(
                            win.as_str(),
                            "acp-message",
                            serde_json::json!({ "agentId": id, "body": line }),
                        );
                    }
                    Ok(None) => break None,
                    Err(e) => break Some(e.to_string()),
                }
            };

            // The pipe is closed, so the protocol is over whether or not the
            // process has actually died yet. Reap it here rather than leaving an
            // unreachable child alive until the window closes.
            {
                let mut map = registry.lock().await;
                if let Some(agents) = map.get_mut(&win) {
                    if let Some(mut agent) = agents.remove(&id) {
                        kill_and_clear(&mut agent).await;
                    }
                    if agents.is_empty() {
                        map.remove(&win);
                    }
                }
            }

            trace_append(&id, "!!", exit_error.as_deref().unwrap_or("agent exited"));
            let _ = handle.emit_to(
                win.as_str(),
                "acp-exited",
                serde_json::json!({ "agentId": id, "error": exit_error }),
            );
        });
    }

    // ── stderr: diagnostics only. The adapter routes all of its own logging
    // here precisely so stdout stays a clean protocol channel. ──
    {
        let handle = app.clone();
        let win = label;
        let id = agent_id;
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                trace_append(&id, "!!", &line);
                let _ = handle.emit_to(
                    win.as_str(),
                    "acp-stderr",
                    serde_json::json!({ "agentId": id, "body": line }),
                );
            }
        });
    }

    Ok(())
}

/// Write one ACP message to the agent's stdin. The caller supplies the JSON;
/// this appends the newline that delimits it.
#[tauri::command]
pub async fn acp_send(
    window: Window,
    state: tauri::State<'_, AcpState>,
    agent_id: String,
    message: String,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.0.lock().await;
    let agent = map
        .get_mut(label)
        .and_then(|agents| agents.get_mut(&agent_id))
        .ok_or_else(|| format!("Agent '{}' is not running.", agent_id))?;
    let stdin = agent
        .stdin
        .as_mut()
        .ok_or_else(|| format!("Agent '{}' has no stdin.", agent_id))?;

    trace_append(&agent_id, "->", &message);

    let mut payload = message;
    if !payload.ends_with('\n') {
        payload.push('\n');
    }
    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to agent '{}': {}", agent_id, e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush agent '{}': {}", agent_id, e))?;
    Ok(())
}

/// Stop one agent in this window. Idempotent.
#[tauri::command]
pub async fn acp_stop(
    window: Window,
    state: tauri::State<'_, AcpState>,
    agent_id: String,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.0.lock().await;
    if let Some(agents) = map.get_mut(label) {
        if let Some(mut agent) = agents.remove(&agent_id) {
            kill_and_clear(&mut agent).await;
        }
        if agents.is_empty() {
            map.remove(label);
        }
    }
    Ok(())
}

/// Reap every agent belonging to this window's *previous* incarnation.
///
/// A webview reload (Cmd+R) resets the frontend but leaves the Rust process
/// tree untouched, so the old agent would keep running with nobody listening.
/// Called once at boot; a no-op on first launch.
#[tauri::command]
pub async fn acp_reset_window(
    window: Window,
    state: tauri::State<'_, AcpState>,
) -> Result<(), String> {
    state.drop_window(window.label()).await;
    Ok(())
}

// ── Trace log ───────────────────────────────────────────────────
//
// A protocol this chatty is close to undebuggable from screenshots. Mirrors
// `lsp.rs`'s trace file, with the same `->` / `<-` / `!!` prefixes.

static TRACE: std::sync::OnceLock<std::sync::Mutex<Option<std::fs::File>>> =
    std::sync::OnceLock::new();

fn trace_file() -> &'static std::sync::Mutex<Option<std::fs::File>> {
    TRACE.get_or_init(|| {
        let path = match dirs::cache_dir() {
            Some(dir) => {
                let dir = dir.join("editor-arcane");
                let _ = std::fs::create_dir_all(&dir);
                dir.join("acp-trace.log")
            }
            None => return std::sync::Mutex::new(None),
        };
        std::sync::Mutex::new(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok(),
        )
    })
}

fn trace_append(agent_id: &str, direction: &str, body: &str) {
    use std::io::Write;
    let mut guard = crate::sync_util::lock_recover(trace_file());
    if let Some(file) = guard.as_mut() {
        let _ = writeln!(file, "[{}] {} {}", agent_id, direction, body);
    }
}

/// Absolute path of the ACP trace log, so the UI can reveal it.
#[tauri::command]
pub fn acp_trace_path() -> Option<String> {
    dirs::cache_dir().map(|d| {
        d.join("editor-arcane")
            .join("acp-trace.log")
            .to_string_lossy()
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_args_omit_optionals_only_when_an_external_cli_can_be_supplied() {
        let dir = PathBuf::from("/tmp/agents/claude");
        let lean = install_args(&dir, "pkg@1.0.0", true);
        let full = install_args(&dir, "pkg@1.0.0", false);

        assert!(lean.iter().any(|a| a == "--omit=optional"));
        assert!(!full.iter().any(|a| a == "--omit=optional"));

        // The spec is always last so npm cannot mistake it for a flag value.
        assert_eq!(lean.last().unwrap(), "pkg@1.0.0");
        assert_eq!(full.last().unwrap(), "pkg@1.0.0");
        // --prefix keeps the install out of the user's global node_modules.
        assert!(full.iter().any(|a| a == "--prefix"));
    }

    #[test]
    fn adapter_entry_points_at_the_renamed_package() {
        let entry = adapter_entry(Path::new("/home/u/.arcane/agents/claude"));
        let as_str = entry.to_string_lossy().replace('\\', "/");
        // Guards the rename: @zed-industries/claude-code-acp is deprecated.
        assert!(as_str.ends_with(
            "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
        ));
    }

    #[test]
    fn executable_names_cover_npm_shims_on_windows() {
        let names = executable_names("npm");
        if cfg!(target_os = "windows") {
            // npm installs `npm.cmd`, not `npm.exe`; missing it is why a
            // Windows probe would otherwise report "npm not found".
            assert!(names.contains(&"npm.cmd".to_string()));
        } else {
            assert_eq!(names, vec!["npm".to_string()]);
        }
    }

    #[test]
    fn probe_serializes_the_camel_case_keys_the_frontend_reads() {
        let probe = AcpProbe {
            node_path: Some("/usr/bin/node".into()),
            node_version: Some("v24.0.0".into()),
            npm_path: None,
            claude_path: None,
            installed_version: None,
            adapter_entry: None,
            uses_external_cli: false,
            pinned_version: CLAUDE_AGENT_VERSION.to_string(),
        };
        let json = serde_json::to_value(&probe).unwrap();
        for key in [
            "nodePath",
            "nodeVersion",
            "npmPath",
            "claudePath",
            "installedVersion",
            "adapterEntry",
            "usesExternalCli",
            "pinnedVersion",
        ] {
            assert!(json.get(key).is_some(), "missing {}", key);
        }
    }

    /// Teardown must FAIL a caller rather than leave it waiting forever. The
    /// frontend's pending-request map is rejected by the `acp-exited` event, so
    /// the Rust half only has to guarantee the process is gone.
    #[tokio::test]
    async fn drop_window_removes_every_agent_for_that_window_only() {
        let state = AcpState::new();
        {
            let mut map = state.0.lock().await;
            map.entry("window-a".to_string()).or_default().insert(
                "claude".to_string(),
                AcpAgent { stdin: None, child: None },
            );
            map.entry("window-b".to_string()).or_default().insert(
                "claude".to_string(),
                AcpAgent { stdin: None, child: None },
            );
        }

        state.drop_window("window-a").await;

        let map = state.0.lock().await;
        assert!(!map.contains_key("window-a"));
        assert!(map.contains_key("window-b"), "other windows must be untouched");
    }

    /// End-to-end over the real NDJSON path, using `cat` as a perfect-echo
    /// agent. Skips (rather than fails) where `cat` is unavailable, matching
    /// `dap.rs::cat_roundtrip`.
    #[tokio::test]
    async fn ndjson_lines_survive_a_roundtrip_through_a_real_process() {
        let mut child = match crate::process_util::async_command("cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return, // cat unavailable — skip
        };

        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        // Multi-byte content and an embedded newline escape: both are things a
        // naive framing would corrupt.
        let msg = r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"text":"héllo\nworld"}}"#;
        stdin.write_all(format!("{}\n", msg).as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();
        drop(stdin); // EOF so cat exits

        let mut lines = BufReader::new(stdout).lines();
        let got = lines.next_line().await.unwrap().expect("one line back");
        assert_eq!(got, msg);

        let parsed: serde_json::Value = serde_json::from_str(&got).unwrap();
        assert_eq!(parsed["params"]["text"], "héllo\nworld");
        assert!(lines.next_line().await.unwrap().is_none());
    }
}
