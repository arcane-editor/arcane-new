use crate::sync_util::lock_recover;
use crate::unity_journal::{JournalReader, JournalWriter};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::{mpsc, oneshot, Mutex};

// ── Constants ───────────────────────────────────────────────────────────────

/// Bridge wire-protocol major version. The C# package announces its own in
/// `connection_init`; a major mismatch surfaces an "Update bridge" prompt.
/// 2 = the journal transport (1 was Unix sockets / named pipes).
const PROTOCOL_VERSION: u32 = 2;
/// Default timeout for an RPC request to the Unity bridge (spec §11 — every
/// bridge call must have a timeout so a hung Unity never freezes the IDE).
const DEFAULT_RPC_TIMEOUT_MS: u64 = 10_000;

// Journal poll pacing. Must match arcane-extension/Editor/BridgeClient.cs.
const POLL_ACTIVE_MS: u64 = 25;
const POLL_IDLE_MS: u64 = 250;
const IDLE_AFTER_MS: u64 = 3000;
const HEARTBEAT_MS: u64 = 2000;
const PEER_DEAD_MS: u64 = 8000;
/// How long to wait for the Unity package to show up before concluding it is
/// missing or outdated (only when Unity itself is demonstrably running).
const STALE_PACKAGE_AFTER_MS: u64 = 15_000;

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UnityMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    /// Correlation id for `rpc_request`/`rpc_response`. Absent on fire-and-forget
    /// messages (logs, playstate, …) — `serde(default)` keeps it backward compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub timestamp: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConnectionChangedPayload {
    pub connected: bool,
    pub info: Option<serde_json::Value>,
}

// ── State ───────────────────────────────────────────────────────────────────

/// One window's Unity IPC bridge: its running server's shutdown signal, the
/// connected client's write channel, and in-flight RPCs. Each field stays a
/// `tokio::sync::Mutex` (async lock holders don't poison the way `std::sync`
/// ones do, and callers already `.await` across these), untouched by the
/// per-window keying below — only the *registry* of these got a lock.
pub struct UnityIpcInner {
    pub shutdown_tx: Mutex<Option<mpsc::Sender<()>>>,
    pub client_tx: Mutex<Option<mpsc::Sender<String>>>,
    /// In-flight RPC requests awaiting an `rpc_response`, keyed by request id.
    pub pending: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    /// Monotonic counter for unique request ids (no Math.random / clock needed).
    pub req_counter: AtomicU64,
}

impl UnityIpcInner {
    fn new() -> Self {
        Self {
            shutdown_tx: Mutex::new(None),
            client_tx: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            req_counter: AtomicU64::new(0),
        }
    }
}

/// Registry of running Unity IPC bridges, keyed by window label — mirrors
/// the per-window pattern in `lsp.rs`/`dap.rs`/`file_scanner::FileWatcherState`.
/// Each project window gets its own server/connection/pending-RPC state, so
/// one window's `unity_ipc_stop` (fired on workspace switch) can never kill
/// another window's bridge, and Unity editor events are only ever routed to
/// the window whose project produced them (see the `emit_to` call sites in
/// `run_journal_session`/`route_message`). The journal files are per-project by
/// construction (`<project>/Library/ArcaneIDE/`) and the frontend guarantees at
/// most one window per project, so two sessions can never end up writing the
/// same journal — which would violate the one-writer-per-file invariant the
/// whole transport depends on.
///
/// The registry lock itself is a plain `std::sync::Mutex` guarding only map
/// membership (insert / remove / lookup, all synchronous, no `.await` while
/// held) — plain-data state, so `lock_recover` (poison-tolerant) is the
/// right fit per its own doc comment. It's wrapped in an outer `Arc` (unlike
/// `file_scanner`/`file_index`/`search`'s bare `Mutex<...>`) so `lib.rs`'s
/// `WindowEvent::Destroyed` handler can clone its way to an owned, `'static`
/// handle to run the (async) shutdown in a spawned task — the same trick
/// `lsp::LspState`/`dap::DapState` use for their `Arc<Mutex<..>>>` state.
pub struct UnityIpcState(pub Arc<StdMutex<HashMap<String, Arc<UnityIpcInner>>>>);

impl UnityIpcState {
    pub fn new() -> Self {
        Self(Arc::new(StdMutex::new(HashMap::new())))
    }

    /// Returns this window's IPC state, creating a fresh (idle — no server
    /// running yet) `UnityIpcInner` the first time this window is seen.
    pub fn get_or_create(&self, label: &str) -> Arc<UnityIpcInner> {
        let mut map = lock_recover(&self.0);
        map.entry(label.to_string())
            .or_insert_with(|| Arc::new(UnityIpcInner::new()))
            .clone()
    }

    /// Stop this window's bridge (if running) and drop its slot entirely.
    /// Called from `WindowEvent::Destroyed` cleanup in `lib.rs` — idempotent,
    /// a no-op if the window never started a bridge. Shares the exact
    /// shutdown path `unity_ipc_stop` uses so a destroyed window's Unity
    /// connection tears down identically to an explicit stop: the server
    /// task is signaled to exit, the client channel is dropped, and any
    /// pending RPCs are failed rather than left to hang until their timeout.
    pub async fn drop_window(&self, label: &str) {
        let inner = {
            let mut map = lock_recover(&self.0);
            map.remove(label)
        };
        if let Some(inner) = inner {
            shutdown_inner(&inner).await;
        }
    }
}

impl Default for UnityIpcState {
    fn default() -> Self {
        Self::new()
    }
}

/// Shut down `inner`'s running server (if any): signal its accept-loop task
/// to stop, drop the client channel, and clear any RPCs still awaiting a
/// response (dropping their `oneshot::Sender`s resolves the awaiting
/// receivers to `Err` instead of hanging until timeout). Idempotent — safe
/// to call on an inner that never started a server or was already stopped.
/// Shared by the `unity_ipc_stop` command and `UnityIpcState::drop_window`
/// so both paths tear down identically.
async fn shutdown_inner(inner: &UnityIpcInner) {
    if let Some(tx) = inner.shutdown_tx.lock().await.take() {
        let _ = tx.send(()).await;
    }
    *inner.client_tx.lock().await = None;
    inner.pending.lock().await.clear();
}

// ── Journal Paths ───────────────────────────────────────────────────────────
//
// The journal files sit at a FIXED location relative to the project, so unlike
// the socket transport there is no path to compute and therefore no way for the
// two sides to disagree about it. That retired `hash_workspace`, whose sha1 of
// the canonicalized path silently diverged from the C# side's — Rust's
// `std::fs::canonicalize` resolves symlinks and .NET's `Path.GetFullPath` does
// not, so any project under a symlinked directory never connected.

fn bridge_dir(workspace_path: &str) -> PathBuf {
    Path::new(workspace_path).join("Library").join("ArcaneIDE")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 32 hex chars of session identity. No uuid crate needed: this only has to be
/// unique across IDE launches on one machine, not globally.
fn new_session_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{:012x}{:08x}{:08x}{:04x}",
        now.as_millis() as u64,
        now.subsec_nanos(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed) as u16
    )
}

/// True when Unity has this project open. Unity writes
/// `Library/EditorInstance.json` (containing `process_id`) whenever the editor
/// holds a project — the same signal Rider and the VS Code extension use.
///
/// Combined with "no `to-ide.jsonl` has appeared", this distinguishes *the user
/// hasn't opened Unity* from *the com.arcane.editor package is missing or
/// predates the journal transport*, turning an indefinite "waiting for Unity"
/// into a prompt the user can act on.
fn unity_editor_is_running(workspace_path: &str) -> bool {
    let path = Path::new(workspace_path)
        .join("Library")
        .join("EditorInstance.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let pid = match serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("process_id").and_then(|p| p.as_u64()))
    {
        Some(p) => p,
        None => return false,
    };
    process_is_alive(pid as u32)
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    // Signal 0 performs error checking without delivering a signal.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use std::process::Command;
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

/// Write the discovery file the Unity package reads to find this IDE session.
/// Lives under `Library/ArcaneIDE/bridge.json` (Library/ is VCS-ignored). Only
/// written for actual Unity projects (presence of `ProjectSettings/`).
///
/// Deliberately NOT a Tauri command: `ide_session_id` must belong to a session
/// that is actually running its journal loop. Publishing an id nobody owns would
/// make Unity handshake against a session that never reads its journal.
///
/// Written via tmp + rename so Unity can never observe a half-written file —
/// plain `std::fs::write` is not atomic, and Unity polls this once a second.
fn write_bridge_discovery(
    workspace_path: &str,
    ide_session_id: &str,
) -> Result<Option<String>, String> {
    let root = Path::new(workspace_path);
    if !root.join("ProjectSettings").is_dir() {
        return Ok(None); // not a Unity project — no discovery file
    }
    let dir = bridge_dir(workspace_path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    let content = serde_json::json!({
        "transport": "journal",
        "protocolVersion": PROTOCOL_VERSION,
        "ideSessionId": ide_session_id,
        "ideVersion": env!("CARGO_PKG_VERSION"),
        "idePid": std::process::id(),
        "minPackageVersion": "0.1.0",
        "_note": "Arcane IDE bridge. If Unity is not connecting, update the com.arcane.editor package.",
    });
    let serialized = serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?;

    let file = dir.join("bridge.json");
    let tmp = dir.join("bridge.json.tmp");
    std::fs::write(&tmp, serialized).map_err(|e| format!("Failed to write bridge.json: {}", e))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("Failed to publish bridge.json: {}", e))?;
    Ok(Some(file.to_string_lossy().to_string()))
}

/// Remove the discovery file. Its absence is how Unity learns the IDE closed,
/// so this is what saves the package from polling a dead session forever.
fn remove_bridge_discovery(workspace_path: &str) {
    let _ = std::fs::remove_file(bridge_dir(workspace_path).join("bridge.json"));
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn unity_ipc_start(
    app: AppHandle,
    window: Window,
    workspace_path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let inner = app.state::<UnityIpcState>().get_or_create(&label);

    // Stop this window's existing server if running (restart-in-place, e.g.
    // reopening the same project).
    if let Some(tx) = inner.shutdown_tx.lock().await.take() {
        let _ = tx.send(()).await;
    }
    *inner.client_tx.lock().await = None;

    // A fresh identity per start. Unity re-handshakes whenever this changes,
    // which is what makes an IDE restart recover without user action.
    let ide_session_id = new_session_id();
    let dir = bridge_dir(&workspace_path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    // We own to-unity.jsonl (and its epoch); Unity owns to-ide.jsonl. Open up
    // front so failures surface to the caller rather than dying silently inside
    // the spawned task.
    let mut writer = JournalWriter::open(&dir.join("to-unity.jsonl"), &dir.join("to-unity.ack"))
        .map_err(|e| format!("Failed to open to-unity.jsonl: {}", e))?;
    // Our own start resets the journal we write. Safe because we send nothing
    // until a connection_init echoes this ide_session_id back at us.
    writer
        .truncate()
        .map_err(|e| format!("Failed to reset to-unity.jsonl: {}", e))?;

    if let Err(e) = write_bridge_discovery(&workspace_path, &ide_session_id) {
        eprintln!("[UnityIPC] Failed to write bridge discovery: {}", e);
    }

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    *inner.shutdown_tx.lock().await = Some(shutdown_tx);

    let app_handle = app.clone();
    let ipc_state = inner.clone();
    let label_for_task = label.clone();
    let ws = workspace_path.clone();

    tokio::spawn(async move {
        tokio::select! {
            _ = shutdown_rx.recv() => {}
            _ = run_journal_session(
                ws.clone(),
                ide_session_id,
                dir,
                writer,
                app_handle,
                ipc_state,
                label_for_task,
            ) => {}
        }
        // Whichever way we got here, the session is over: retract the discovery
        // file so Unity stops polling a session that no longer exists.
        remove_bridge_discovery(&ws);
    });

    Ok(())
}

/// One journal session: poll `to-ide.jsonl`, gate on the handshake, pump the
/// outbound channel into `to-unity.jsonl`. Replaces the old socket/pipe
/// `handle_client` and its two platform-specific accept loops.
#[allow(clippy::too_many_arguments)]
async fn run_journal_session(
    workspace_path: String,
    ide_session_id: String,
    dir: PathBuf,
    mut writer: JournalWriter,
    app: AppHandle,
    state: Arc<UnityIpcInner>,
    label: String,
) {
    let (client_tx, mut client_rx) = mpsc::channel::<String>(64);
    *state.client_tx.lock().await = Some(client_tx);

    let mut reader: Option<JournalReader> = None;
    let mut connected = false;
    let mut unity_session_id: Option<String> = None;
    let mut last_heartbeat = now_ms();
    let mut last_traffic = now_ms();
    let mut last_peer_bytes = now_ms();
    let mut stale_checked = false;
    let started = now_ms();

    loop {
        let now = now_ms();

        // Lazily open Unity's journal — a reader never creates the peer's file.
        if reader.is_none() {
            reader = JournalReader::open(&dir.join("to-ide.jsonl"), &dir.join("to-ide.ack")).ok();
            if let Some(r) = reader.as_mut() {
                // Skip a previous session's backlog rather than replaying it
                // through route_message. Nothing is lost: a stale connection_init
                // would be rejected by the handshake gate anyway, and once Unity
                // notices our new bridge.json it truncates and re-handshakes,
                // which the epoch check turns into a reset back to 0.
                r.seek_to_end();
            }
        }

        let mut saw_bytes = false;
        if let Some(r) = reader.as_mut() {
            let lines = r.poll();
            if !lines.is_empty() {
                saw_bytes = true;
                last_peer_bytes = now;
            }
            for line in lines {
                let msg: UnityMessage = match serde_json::from_str(&line) {
                    Ok(m) => m,
                    // One malformed line never kills the session.
                    Err(_) => continue,
                };

                if msg.msg_type == "connection_init" {
                    // The handshake gate: we write NOTHING until a
                    // connection_init echoes our CURRENT session id back. That is
                    // what closes the startup race in both orderings — a stale
                    // echo from a previous IDE session is simply ignored.
                    let echoed = msg
                        .payload
                        .get("ideSessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if echoed != ide_session_id {
                        continue;
                    }
                    let incoming = msg
                        .payload
                        .get("unitySessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if unity_session_id.as_deref() != Some(incoming) {
                        // A new Unity session: reset the journal we write BEFORE
                        // emitting anything into it.
                        let _ = writer.truncate();
                        unity_session_id = Some(incoming.to_string());
                    }
                    connected = true;
                    // The handshake landed, so the package is present and current
                    // — never warn about a stale package for this session.
                    stale_checked = true;
                } else if msg.msg_type == "disconnect" {
                    // Unity quit cleanly; don't make the user wait out PEER_DEAD_MS.
                    connected = false;
                    unity_session_id = None;
                    state.pending.lock().await.clear();
                    let _ = app.emit_to(
                        label.as_str(),
                        "unity-connection-changed",
                        ConnectionChangedPayload {
                            connected: false,
                            info: None,
                        },
                    );
                    continue;
                }

                // route_message emits unity-connection-changed for connection_init.
                route_message(&app, &state, &label, msg).await;
            }
            r.publish_ack_if_needed(now);
        }

        // Outbound — only after the handshake.
        let mut wrote = false;
        if connected {
            while let Ok(msg) = client_rx.try_recv() {
                match writer.append(&msg) {
                    Ok(true) => wrote = true,
                    Ok(false) => {
                        eprintln!("[UnityIPC] outbound message exceeds the 16 MB cap — dropped")
                    }
                    Err(e) => eprintln!("[UnityIPC] journal write failed: {}", e),
                }
            }
            if now.saturating_sub(last_heartbeat) >= HEARTBEAT_MS {
                last_heartbeat = now;
                let hb = serde_json::json!({
                    "type": "heartbeat",
                    "payload": {},
                    "timestamp": now as f64 / 1000.0,
                });
                if let Ok(true) = writer.append(&hb.to_string()) {
                    wrote = true;
                }
            }
            if wrote {
                let _ = writer.flush();
            }
            writer.maybe_rotate();
        }

        // Liveness: with no socket to close, a journal that stops growing IS the
        // disconnect signal.
        if connected && now.saturating_sub(last_peer_bytes) > PEER_DEAD_MS {
            connected = false;
            unity_session_id = None;
            state.pending.lock().await.clear();
            let _ = app.emit_to(
                label.as_str(),
                "unity-connection-changed",
                ConnectionChangedPayload {
                    connected: false,
                    info: None,
                },
            );
        }

        // Distinguish "Unity isn't open" from "the package is missing or too old".
        if !stale_checked && now.saturating_sub(started) > STALE_PACKAGE_AFTER_MS {
            stale_checked = true;
            if unity_editor_is_running(&workspace_path) {
                let _ = app.emit_to(label.as_str(), "unity-package-stale", ());
            }
        }

        // Heartbeats deliberately do NOT reset the backoff — otherwise the 2s
        // heartbeat would pin polling at 25ms forever and idle CPU would never
        // drop.
        if saw_bytes {
            last_traffic = now;
        }
        let interval = if now.saturating_sub(last_traffic) >= IDLE_AFTER_MS {
            POLL_IDLE_MS
        } else {
            POLL_ACTIVE_MS
        };
        tokio::time::sleep(Duration::from_millis(interval)).await;
    }
}

async fn route_message(app: &AppHandle, state: &Arc<UnityIpcInner>, label: &str, msg: UnityMessage) {
    match msg.msg_type.as_str() {
        "connection_init" | "project_info" => {
            // Validate the bridge's protocol version; warn on a major mismatch
            // but still connect (the frontend offers "Update bridge").
            if let Some(pv) = msg.payload.get("protocolVersion").and_then(|v| v.as_u64()) {
                if pv as u32 != PROTOCOL_VERSION {
                    let _ = app.emit_to(
                        label,
                        "unity-bridge-version-mismatch",
                        serde_json::json!({
                            "ideProtocol": PROTOCOL_VERSION,
                            "bridgeProtocol": pv,
                        }),
                    );
                }
            }
            let _ = app.emit_to(
                label,
                "unity-connection-changed",
                ConnectionChangedPayload {
                    connected: true,
                    info: Some(msg.payload),
                },
            );
        }
        "heartbeat" => {
            // Auto-respond with heartbeat_ack
            let ack = serde_json::json!({
                "type": "heartbeat_ack",
                "timestamp": msg.timestamp
            });
            if let Some(tx) = state.client_tx.lock().await.as_ref() {
                let _ = tx.send(ack.to_string()).await;
            }
        }
        "rpc_response" => {
            // Complete the matching in-flight request. payload is
            // `{result: ...}` or `{error: {code, message}}`.
            if let Some(id) = msg.id {
                let mut pending = state.pending.lock().await;
                if let Some(tx) = pending.remove(&id) {
                    let _ = tx.send(msg.payload);
                }
            }
        }
        "log" => {
            let _ = app.emit_to(label, "unity-log", &msg.payload);
        }
        "log_batch" => {
            let _ = app.emit_to(label, "unity-log-batch", &msg.payload);
        }
        "playstate_changed" => {
            let _ = app.emit_to(label, "unity-playstate-changed", &msg.payload);
        }
        "playmode_stats" => {
            let _ = app.emit_to(label, "unity-playmode-stats", &msg.payload);
        }
        "compilation_started" => {
            let _ = app.emit_to(label, "unity-compilation", serde_json::json!({ "started": true }));
        }
        "compilation_finished" => {
            let mut payload = msg.payload;
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("started".to_string(), serde_json::Value::Bool(false));
            }
            let _ = app.emit_to(label, "unity-compilation", &payload);
        }
        "open_file" => {
            let _ = app.emit_to(label, "unity-open-file", &msg.payload);
        }
        "build_progress" => {
            let _ = app.emit_to(label, "unity-build-progress", &msg.payload);
        }
        "build_result" => {
            let _ = app.emit_to(label, "unity-build-result", &msg.payload);
        }
        "test_event" => {
            let _ = app.emit_to(label, "unity-test-event", &msg.payload);
        }
        "selection_changed" => {
            let _ = app.emit_to(label, "unity-selection-changed", &msg.payload);
        }
        "hierarchy_changed" => {
            let _ = app.emit_to(label, "unity-hierarchy-changed", &msg.payload);
        }
        "focus_window" => {
            // Could focus the IDE window
        }
        _ => {
            // Unknown message type — ignore
        }
    }
}

/// Stop this window's Unity IPC server, if any. Only affects this window's
/// bridge — with two project windows open, switching workspaces in one no
/// longer tears down the other's connection to its Unity editor.
#[tauri::command]
pub async fn unity_ipc_stop(app: AppHandle, window: Window) -> Result<(), String> {
    let label = window.label().to_string();
    let inner = app.state::<UnityIpcState>().get_or_create(&label);
    shutdown_inner(&inner).await;
    Ok(())
}

#[tauri::command]
pub async fn unity_ipc_send(app: AppHandle, window: Window, message_json: String) -> Result<(), String> {
    let label = window.label().to_string();
    let inner = app.state::<UnityIpcState>().get_or_create(&label);
    if let Some(tx) = inner.client_tx.lock().await.as_ref() {
        tx.send(message_json)
            .await
            .map_err(|e| format!("Failed to send: {}", e))?;
    } else {
        return Err("No Unity client connected".to_string());
    }
    Ok(())
}

/// Send an RPC request to the connected Unity bridge and await its response.
/// Returns the `result` value on success, or an Err on bridge error / timeout /
/// disconnect. `timeout_ms` defaults to 10s.
#[tauri::command]
pub async fn unity_ipc_request(
    app: AppHandle,
    window: Window,
    method: String,
    params: serde_json::Value,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    let label = window.label().to_string();
    let inner = app.state::<UnityIpcState>().get_or_create(&label);

    let id = format!("rpc-{}", inner.req_counter.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = oneshot::channel::<serde_json::Value>();
    inner.pending.lock().await.insert(id.clone(), tx);

    let request = serde_json::json!({
        "type": "rpc_request",
        "id": id,
        "payload": { "method": method, "params": params },
    });

    // Send (clean up the pending entry if no client is connected).
    {
        let guard = inner.client_tx.lock().await;
        match guard.as_ref() {
            Some(client_tx) => {
                if let Err(e) = client_tx.send(request.to_string()).await {
                    inner.pending.lock().await.remove(&id);
                    return Err(format!("Failed to send RPC '{}': {}", method, e));
                }
            }
            None => {
                inner.pending.lock().await.remove(&id);
                return Err("No Unity client connected".to_string());
            }
        }
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_RPC_TIMEOUT_MS));
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(payload)) => {
            if let Some(err) = payload.get("error") {
                let message = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown Unity RPC error");
                Err(format!("Unity RPC '{}' error: {}", method, message))
            } else {
                Ok(payload.get("result").cloned().unwrap_or(payload))
            }
        }
        // Sender dropped (disconnect drains pending) → resolve as disconnect.
        Ok(Err(_)) => Err(format!(
            "Unity disconnected before responding to '{}'",
            method
        )),
        Err(_) => {
            inner.pending.lock().await.remove(&id);
            Err(format!("Unity RPC '{}' timed out", method))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_id_is_optional_and_backward_compatible() {
        // Old messages with no id still deserialize.
        let no_id: UnityMessage =
            serde_json::from_str(r#"{"type":"log","payload":{}}"#).unwrap();
        assert!(no_id.id.is_none());
        // rpc_response carries an id.
        let with_id: UnityMessage = serde_json::from_str(
            r#"{"type":"rpc_response","id":"rpc-7","payload":{"result":1}}"#,
        )
        .unwrap();
        assert_eq!(with_id.id.as_deref(), Some("rpc-7"));
    }

    #[test]
    fn journal_paths_are_fixed_relative_to_the_project() {
        // No hashing, no canonicalization, nothing to disagree about — which is
        // what retired the sha1 path fallback and its symlink mismatch.
        let dir = bridge_dir("/x/proj");
        assert_eq!(dir, PathBuf::from("/x/proj/Library/ArcaneIDE"));
    }

    #[test]
    fn session_ids_are_unique_per_call() {
        let a = new_session_id();
        let b = new_session_id();
        assert_ne!(a, b, "a repeated id would break re-handshake detection");
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn detects_a_running_unity_editor_from_editor_instance_json() {
        let d = std::env::temp_dir().join(format!("arcane-ei-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("Library")).unwrap();
        let ws = d.to_str().unwrap();

        // No EditorInstance.json at all.
        assert!(!unity_editor_is_running(ws));

        // Our own pid is definitionally alive.
        std::fs::write(
            d.join("Library").join("EditorInstance.json"),
            format!(
                "{{\"process_id\":{},\"version\":\"2021.3.0f1\"}}",
                std::process::id()
            ),
        )
        .unwrap();
        assert!(unity_editor_is_running(ws));

        // Malformed content must not panic or claim a live editor.
        std::fs::write(d.join("Library").join("EditorInstance.json"), "{ not json").unwrap();
        assert!(!unity_editor_is_running(ws));

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn bridge_discovery_round_trips_and_is_skipped_for_non_unity_projects() {
        let d = std::env::temp_dir().join(format!("arcane-disc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let ws = d.to_str().unwrap();

        // No ProjectSettings/ → not a Unity project → nothing written.
        assert_eq!(write_bridge_discovery(ws, "sess-1").unwrap(), None);
        assert!(!bridge_dir(ws).join("bridge.json").exists());

        std::fs::create_dir_all(d.join("ProjectSettings")).unwrap();
        let written = write_bridge_discovery(ws, "sess-1").unwrap().unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
        assert_eq!(parsed["transport"], "journal");
        assert_eq!(parsed["protocolVersion"], 2);
        assert_eq!(parsed["ideSessionId"], "sess-1");
        // The tmp file must not survive the atomic rename.
        assert!(!bridge_dir(ws).join("bridge.json.tmp").exists());

        remove_bridge_discovery(ws);
        assert!(
            !bridge_dir(ws).join("bridge.json").exists(),
            "its absence is how Unity learns the IDE closed"
        );

        let _ = std::fs::remove_dir_all(&d);
    }

    // ── UnityIpcState: per-window keying ────────────────────────────────
    //
    // `UnityIpcInner` needs no live pipe/socket to construct (its fields are
    // just tokio primitives — channels, a map, a counter — none of which
    // touch the filesystem or a real Unity connection), so these exercise
    // the registry directly rather than mocking a bridge connection.

    #[test]
    fn get_or_create_returns_distinct_inners_per_window_and_is_stable_within_one() {
        let state = UnityIpcState::new();
        let a1 = state.get_or_create("window-a");
        let a2 = state.get_or_create("window-a");
        let b = state.get_or_create("window-b");

        assert!(
            Arc::ptr_eq(&a1, &a2),
            "the same label must return the same inner across calls"
        );
        assert!(
            !Arc::ptr_eq(&a1, &b),
            "different labels must get distinct inners"
        );
    }

    #[tokio::test]
    async fn drop_window_removes_only_that_labels_entry() {
        let state = UnityIpcState::new();
        let a = state.get_or_create("window-a");
        let b = state.get_or_create("window-b");

        state.drop_window("window-a").await;

        // "window-a" is gone — the next get_or_create allocates a fresh inner.
        let a_after = state.get_or_create("window-a");
        assert!(!Arc::ptr_eq(&a, &a_after));
        // "window-b" is untouched.
        let b_after = state.get_or_create("window-b");
        assert!(Arc::ptr_eq(&b, &b_after));
    }

    #[tokio::test]
    async fn drop_window_is_idempotent_when_absent() {
        let state = UnityIpcState::new();
        // Never created — must not panic (mirrors WindowEvent::Destroyed
        // firing for a window that never started a Unity bridge).
        state.drop_window("never-started").await;
    }

    #[tokio::test]
    async fn drop_window_fails_pending_rpcs_instead_of_leaving_them_to_hang() {
        let state = UnityIpcState::new();
        let inner = state.get_or_create("window-a");
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        inner
            .pending
            .lock()
            .await
            .insert("rpc-0".to_string(), tx);

        state.drop_window("window-a").await;

        // Dropping the pending map's sender resolves the awaiting receiver
        // to Err instead of leaving the caller to hang until its timeout.
        assert!(rx.await.is_err());
    }
}
