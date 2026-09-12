//! Tauri glue: per-window debug sessions and the commands the frontend calls.
//!
//! The command names and event names are unchanged from the sidecar this
//! replaces (`dap_start` / `dap_send` / `dap_stop`, `dap-message` /
//! `dap-exited`), because the frontend already speaks DAP correctly. What
//! changed is what sits behind them: a native client instead of a
//! `vscode-mono-debug` child process that needed a system Mono runtime and a
//! binary that was never vendored.
//!
//! One router task owns each window's session. Dropping the session drops its
//! request channel, which ends the task, which disposes the connection cleanly
//! — so closing a project window detaches properly rather than abandoning a
//! socket, which is the thing that kills a Unity editor.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value as Json;
use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::{mpsc, Mutex};

use super::router::{Msg, Router};
use super::{android, discovery, players, trace};

/// One window's debug session.
pub struct DebugSession {
    requests: mpsc::UnboundedSender<Msg>,
}

/// Per-window session registry (Tauri-managed state).
pub struct DebugState(pub Arc<Mutex<HashMap<String, DebugSession>>>);

impl DebugState {
    pub fn new() -> Self {
        DebugState(Arc::new(Mutex::new(HashMap::new())))
    }

    pub async fn drop_window(&self, label: &str) {
        // Dropping the sender ends the router task, which disposes cleanly.
        self.0.lock().await.remove(label);
    }
}

impl Default for DebugState {
    fn default() -> Self {
        Self::new()
    }
}

/// The Unity editor holding this project open, if there is one.
///
/// Instant: it reads one file and checks a process id. Attaching goes through
/// here, because the overwhelmingly common case is "attach to my editor" and
/// making that wait on a network scan would be a second and a half of nothing
/// happening, every time.
#[tauri::command]
pub fn debug_targets(workspace_path: String) -> Vec<discovery::Target> {
    discovery::targets_for_workspace(&PathBuf::from(workspace_path))
}

/// Everything attachable, including players — the slow scan.
///
/// Listens for a player announcement interval and asks `adb` about attached
/// Android devices, so it takes a noticeable moment. Driven by the debug panel
/// rather than by attach, and it never fails: a machine with no route to the
/// multicast group, or no Android SDK, simply contributes nothing.
#[tauri::command]
pub async fn debug_scan_targets(workspace_path: String) -> Vec<discovery::Target> {
    let workspace = PathBuf::from(workspace_path);
    let mut targets = discovery::targets_for_workspace(&workspace);
    targets.extend(players::discover().await);
    targets.extend(android::discover(&workspace).await);
    targets
}

/// Where the wire trace is written.
#[tauri::command]
pub fn debug_trace_path() -> Result<String, String> {
    trace::path()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "no cache directory available".to_string())
}

/// Start a debug session for this window.
#[tauri::command]
pub async fn dap_start(
    window: Window,
    app: AppHandle,
    workspace_path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    trace::open_session(&format!("label={} workspace={}", label, workspace_path));

    // Tear down any prior session for this window first, so two routers never
    // hold connections to the same runtime.
    {
        let state = app.state::<DebugState>();
        state.0.lock().await.remove(&label);
    }

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Json>();
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<Msg>();

    // Outbound: every DAP message becomes a `dap-message` event carrying the
    // raw JSON string, which is what `dap-client.ts` expects.
    {
        let app = app.clone();
        let label = label.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(message) = out_rx.recv().await {
                let text = message.to_string();
                trace::append("<-", &text);
                let _ = app.emit_to(label.as_str(), "dap-message", text);
            }
        });
    }

    // The router task.
    {
        let app = app.clone();
        let label = label.clone();
        let self_tx = msg_tx.clone();
        let workspace = PathBuf::from(workspace_path);
        tauri::async_runtime::spawn(async move {
            let mut router = Router::new(out_tx, self_tx, workspace);
            while let Some(msg) = msg_rx.recv().await {
                router.on(msg).await;
            }
            // The channel closed: the window went away or the session was
            // stopped. Detach cleanly before the socket drops.
            router.shutdown().await;
            trace::append("--", "session ended");
            let _ = app.emit_to(label.as_str(), "dap-exited", ());
        });
    }

    let state = app.state::<DebugState>();
    state
        .0
        .lock()
        .await
        .insert(label, DebugSession { requests: msg_tx });
    Ok(())
}

/// Forward a DAP request from the frontend.
#[tauri::command]
pub async fn dap_send(window: Window, app: AppHandle, message: String) -> Result<(), String> {
    trace::append("->", &message);
    let parsed: Json =
        serde_json::from_str(&message).map_err(|e| format!("malformed DAP message: {}", e))?;

    let label = window.label().to_string();
    let state = app.state::<DebugState>();
    let map = state.0.lock().await;
    let session = map
        .get(&label)
        .ok_or("No debug session running for this window")?;
    session
        .requests
        .send(Msg::Request(parsed))
        .map_err(|_| "debug session has ended".to_string())
}

/// Stop this window's debug session.
#[tauri::command]
pub async fn dap_stop(window: Window, app: AppHandle) -> Result<(), String> {
    let label = window.label().to_string();
    let state = app.state::<DebugState>();
    state.0.lock().await.remove(&label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project Unity has never opened has no editor to attach to. Player
    /// discovery may still contribute, so this asserts only that no *editor*
    /// target appears — a machine on a LAN with a running player is a valid
    /// environment for this test to run in.
    #[test]
    fn a_project_with_no_running_editor_offers_no_editor_target() {
        let dir = tempfile::tempdir().unwrap();
        let targets = discovery::targets_for_workspace(dir.path());
        assert!(targets.is_empty());
    }

    #[test]
    fn the_trace_path_is_reportable() {
        assert!(debug_trace_path().is_ok());
    }
}
