//! Tauri glue: per-window debug sessions and the commands the frontend calls.
//!
//! The command names and event names are unchanged from the sidecar this
//! replaces (`dap_start` / `dap_send` / `dap_stop`, `dap-message` /
//! `dap-exited`), because the frontend already speaks DAP correctly. What
//! changed is what sits behind them: a native client instead of a
//! `vscode-mono-debug` child process that needed a system Mono runtime and a
//! binary that was never vendored.
//!
//! One router task owns each window's session. Stopping a session signals its
//! router explicitly and waits until the connection has been disposed cleanly
//! — so closing a project window detaches properly rather than abandoning a
//! socket, which is the thing that kills a Unity editor.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value as Json;
use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::router::{Msg, Router};
use super::{android, discovery, players, trace};

/// One window's debug session.
pub struct DebugSession {
    requests: mpsc::UnboundedSender<Msg>,
    shutdown: mpsc::UnboundedSender<oneshot::Sender<Result<(), String>>>,
    ended: oneshot::Receiver<()>,
}

/// Per-window session registry (Tauri-managed state).
pub struct DebugState(pub Arc<Mutex<HashMap<String, DebugSession>>>);

impl DebugState {
    pub fn new() -> Self {
        DebugState(Arc::new(Mutex::new(HashMap::new())))
    }

    pub async fn drop_window(&self, label: &str) {
        if let Err(e) = self.stop_session(label).await {
            trace::append("--", &e);
        }
    }

    async fn stop_session(&self, label: &str) -> Result<(), String> {
        // Failed disposal retains ownership of the session for a retry.
        let mut sessions = self.0.lock().await;
        if let Some(session) = sessions.get_mut(label) {
            let (reply, result) = oneshot::channel();
            if session.shutdown.send(reply).is_ok() {
                result
                    .await
                    .map_err(|_| "Debugger shutdown acknowledgement was lost".to_string())??;
            }
            (&mut session.ended)
                .await
                .map_err(|_| "Debugger shutdown task ended unexpectedly".to_string())?;
            sessions.remove(label);
        }
        Ok(())
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
        state.stop_session(&label).await?;
    }
    let state = app.state::<DebugState>();
    let mut sessions = state.0.lock().await;
    if sessions.contains_key(&label) {
        return Err("Another debug session started concurrently; retry attachment".into());
    }

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Json>();
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<Msg>();
    let (shutdown_tx, mut shutdown_rx) =
        mpsc::unbounded_channel::<oneshot::Sender<Result<(), String>>>();
    let (ended_tx, ended_rx) = oneshot::channel();

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
            loop {
                tokio::select! {
                    biased;
                    reply = shutdown_rx.recv() => {
                        let result = router.shutdown().await;
                        let completed = result.is_ok();
                        if let Some(reply) = reply { let _ = reply.send(result); }
                        else { break; }
                        if completed { break; }
                    },
                    msg = msg_rx.recv() => match msg {
                        // Drain attachment/protocol transitions before closing
                        // their socket. Honor shutdown before the next request.
                        Some(msg) => router.on(msg).await,
                        None => break,
                    },
                }
            }
            // Explicit shutdown or transport closure ends the session.
            // Detach cleanly before the socket drops.
            if let Err(error) = router.shutdown().await {
                trace::append("--", &error);
            }
            trace::append("--", "session ended");
            let _ = app.emit_to(label.as_str(), "dap-exited", ());
            let _ = ended_tx.send(());
        });
    }

    sessions.insert(
        label,
        DebugSession {
            requests: msg_tx,
            shutdown: shutdown_tx,
            ended: ended_rx,
        },
    );
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
    state.stop_session(&label).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn explicit_shutdown_completes_despite_retained_request_senders() {
        let state = DebugState::new();
        let (requests, _rx) = mpsc::unbounded_channel();
        let retained_sender = requests.clone();
        let (shutdown, mut shutdown_rx) =
            mpsc::unbounded_channel::<oneshot::Sender<Result<(), String>>>();
        let (ended_tx, ended) = oneshot::channel();
        state.0.lock().await.insert(
            "test".into(),
            DebugSession {
                requests,
                shutdown,
                ended,
            },
        );
        let task = tokio::spawn(async move {
            shutdown_rx.recv().await.unwrap().send(Ok(())).unwrap();
            ended_tx.send(()).unwrap();
        });
        state.stop_session("test").await.unwrap();
        task.await.unwrap();
        assert!(state.0.lock().await.is_empty());
        drop(retained_sender);
    }

    #[tokio::test]
    async fn refused_disposal_keeps_the_session_owned_for_retry() {
        let state = DebugState::new();
        let (requests, _rx) = mpsc::unbounded_channel();
        let (shutdown, mut shutdown_rx) =
            mpsc::unbounded_channel::<oneshot::Sender<Result<(), String>>>();
        let (ended_tx, ended) = oneshot::channel();
        state.0.lock().await.insert(
            "test".into(),
            DebugSession {
                requests,
                shutdown,
                ended,
            },
        );
        let task = tokio::spawn(async move {
            shutdown_rx
                .recv()
                .await
                .unwrap()
                .send(Err("agent did not acknowledge detach".into()))
                .unwrap();
            shutdown_rx.recv().await.unwrap().send(Ok(())).unwrap();
            ended_tx.send(()).unwrap();
        });
        assert!(state.stop_session("test").await.is_err());
        assert!(state.0.lock().await.contains_key("test"));
        state.stop_session("test").await.unwrap();
        task.await.unwrap();
        assert!(state.0.lock().await.is_empty());
    }

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
