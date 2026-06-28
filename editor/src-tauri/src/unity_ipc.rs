use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

// ── Constants ───────────────────────────────────────────────────────────────

const IPC_PIPE_PREFIX: &str = "unity-ide-";
const MAX_FRAME_SIZE: u32 = 16 * 1024 * 1024; // 16 MB
const HEADER_SIZE: usize = 4;
/// Bridge wire-protocol major version. The C# package announces its own in
/// `connection_init`; a major mismatch surfaces an "Update bridge" prompt.
const PROTOCOL_VERSION: u32 = 1;
/// Default timeout for an RPC request to the Unity bridge (spec §11 — every
/// bridge call must have a timeout so a hung Unity never freezes the IDE).
const DEFAULT_RPC_TIMEOUT_MS: u64 = 10_000;

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

pub struct UnityIpcInner {
    pub shutdown_tx: Mutex<Option<mpsc::Sender<()>>>,
    pub client_tx: Mutex<Option<mpsc::Sender<String>>>,
    /// In-flight RPC requests awaiting an `rpc_response`, keyed by request id.
    pub pending: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    /// Monotonic counter for unique request ids (no Math.random / clock needed).
    pub req_counter: AtomicU64,
}

pub struct UnityIpcState(pub Arc<UnityIpcInner>);

impl UnityIpcState {
    pub fn new() -> Self {
        Self(Arc::new(UnityIpcInner {
            shutdown_tx: Mutex::new(None),
            client_tx: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            req_counter: AtomicU64::new(0),
        }))
    }
}

// ── Pipe Path ───────────────────────────────────────────────────────────────

fn hash_workspace(workspace_path: &str) -> String {
    let normalized = std::fs::canonicalize(workspace_path)
        .unwrap_or_else(|_| Path::new(workspace_path).to_path_buf());
    let normalized_str = normalized.to_string_lossy().to_string();

    let mut hasher = Sha1::new();
    hasher.update(normalized_str.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Unix: a domain socket under /tmp keyed by the workspace path hash.
#[cfg(unix)]
fn compute_pipe_path(workspace_path: &str) -> String {
    format!("/tmp/{}{}.sock", IPC_PIPE_PREFIX, hash_workspace(workspace_path))
}

/// Windows: a named pipe (`\\.\pipe\…`) keyed by the same workspace hash.
#[cfg(windows)]
fn compute_pipe_path(workspace_path: &str) -> String {
    format!(r"\\.\pipe\{}{}", IPC_PIPE_PREFIX, hash_workspace(workspace_path))
}

/// Clean up stale socket file if nothing is listening on it.
#[cfg(unix)]
async fn cleanup_stale_socket(socket_path: &str) -> Result<(), String> {
    if !Path::new(socket_path).exists() {
        return Ok(());
    }

    // Try connecting to see if something is actively listening
    match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        tokio::net::UnixStream::connect(socket_path),
    )
    .await
    {
        Ok(Ok(_stream)) => {
            // Something is listening — another IDE instance
            return Err(format!(
                "Another IDE instance is already listening on {}",
                socket_path
            ));
        }
        _ => {
            // Not listening or timed out — stale socket, remove it
            let _ = std::fs::remove_file(socket_path);
        }
    }

    Ok(())
}

/// Write the bridge discovery file the Unity C# package reads to find this
/// IDE's socket. Lives under `Library/ArcaneIDE/bridge.json` (Library/ is
/// VCS-ignored). Only written for actual Unity projects (presence of
/// `ProjectSettings/`). Best-effort: returns the file path on success.
pub fn write_bridge_discovery(workspace_path: &str) -> Result<Option<String>, String> {
    let root = Path::new(workspace_path);
    if !root.join("ProjectSettings").is_dir() {
        return Ok(None); // not a Unity project — no discovery file
    }
    let dir = root.join("Library").join("ArcaneIDE");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    let file = dir.join("bridge.json");
    let transport = if cfg!(windows) { "pipe" } else { "unix" };
    let content = serde_json::json!({
        "transport": transport,
        "socketPath": compute_pipe_path(workspace_path),
        "protocolVersion": PROTOCOL_VERSION,
        "ideVersion": env!("CARGO_PKG_VERSION"),
        "idePid": std::process::id(),
    });
    let serialized = serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?;
    std::fs::write(&file, serialized).map_err(|e| format!("Failed to write bridge.json: {}", e))?;
    Ok(Some(file.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn unity_write_bridge_discovery(workspace_path: String) -> Result<Option<String>, String> {
    write_bridge_discovery(&workspace_path)
}

// ── Frame Encoding/Decoding ─────────────────────────────────────────────────

fn encode_frame(message: &str) -> Vec<u8> {
    let payload = message.as_bytes();
    let len = payload.len() as u32;
    let mut frame = Vec::with_capacity(HEADER_SIZE + payload.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn unity_ipc_start(
    app: AppHandle,
    workspace_path: String,
) -> Result<(), String> {
    let inner = app.state::<UnityIpcState>().0.clone();

    // Stop existing server if running
    if let Some(tx) = inner.shutdown_tx.lock().await.take() {
        let _ = tx.send(()).await;
    }
    *inner.client_tx.lock().await = None;

    let socket_path = compute_pipe_path(&workspace_path);

    #[cfg(unix)]
    cleanup_stale_socket(&socket_path).await?;

    // Bind/create the transport up front so failures surface to the caller
    // rather than dying silently inside the spawned accept loop.
    #[cfg(unix)]
    let listener = tokio::net::UnixListener::bind(&socket_path)
        .map_err(|e| format!("Failed to bind socket {}: {}", socket_path, e))?;

    #[cfg(windows)]
    let server = {
        use tokio::net::windows::named_pipe::ServerOptions;
        ServerOptions::new()
            .first_pipe_instance(true)
            .create(&socket_path)
            .map_err(|e| format!("Failed to create pipe {}: {}", socket_path, e))?
    };

    // Publish the discovery file so the Unity package can connect without
    // recomputing the socket path itself. Best-effort — not fatal if it fails.
    if let Err(e) = write_bridge_discovery(&workspace_path) {
        eprintln!("[UnityIPC] Failed to write bridge discovery: {}", e);
    }

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    *inner.shutdown_tx.lock().await = Some(shutdown_tx);

    let app_handle = app.clone();
    let ipc_state = inner.clone();

    // Unix: accept connections on the listening socket; remove the socket file
    // on shutdown.
    #[cfg(unix)]
    {
        let sock_path = socket_path.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_rx.recv() => {
                        let _ = std::fs::remove_file(&sock_path);
                        break;
                    }
                    accept_result = listener.accept() => {
                        match accept_result {
                            Ok((stream, _)) => {
                                handle_client(stream, app_handle.clone(), ipc_state.clone()).await;
                            }
                            Err(e) => {
                                eprintln!("[UnityIPC] Accept error: {}", e);
                            }
                        }
                    }
                }
            }
        });
    }

    // Windows: a named-pipe server instance serves a single client, so we hand
    // off each connected instance and immediately create the next one to keep
    // listening. Pipes leave no filesystem entry to clean up.
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let pipe_name = socket_path.clone();
        let mut server = server;
        tokio::spawn(async move {
            loop {
                // Wait for a client to connect (or for shutdown). Resolve the
                // select! to a value first so the `connect()` borrow on `server`
                // ends before we move it below.
                let connected = tokio::select! {
                    _ = shutdown_rx.recv() => break,
                    res = server.connect() => res,
                };
                if let Err(e) = connected {
                    eprintln!("[UnityIPC] Pipe connect error: {}", e);
                    continue;
                }

                // Hand the connected instance to the client handler and create
                // the next server instance so the pipe keeps accepting.
                let connected_pipe = server;
                match ServerOptions::new().create(&pipe_name) {
                    Ok(next) => {
                        server = next;
                        handle_client(connected_pipe, app_handle.clone(), ipc_state.clone()).await;
                    }
                    Err(e) => {
                        eprintln!("[UnityIPC] Failed to create next pipe instance: {}", e);
                        handle_client(connected_pipe, app_handle.clone(), ipc_state.clone()).await;
                        break;
                    }
                }
            }
        });
    }

    Ok(())
}

async fn handle_client<S>(stream: S, app: AppHandle, state: Arc<UnityIpcInner>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    // `tokio::io::split` works for any duplex byte stream, so the length-prefixed
    // framing below is identical for Unix sockets and Windows named pipes.
    let (mut reader, writer) = tokio::io::split(stream);
    let writer = Arc::new(Mutex::new(writer));

    // Channel for sending messages to the client
    let (client_tx, mut client_rx) = mpsc::channel::<String>(64);
    *state.client_tx.lock().await = Some(client_tx);

    // Spawn writer task
    let writer_clone = writer.clone();
    tokio::spawn(async move {
        while let Some(msg) = client_rx.recv().await {
            let frame = encode_frame(&msg);
            let mut w = writer_clone.lock().await;
            if w.write_all(&frame).await.is_err() {
                break;
            }
        }
    });

    // Emit connection event
    let _ = app.emit(
        "unity-connection-changed",
        ConnectionChangedPayload {
            connected: true,
            info: None,
        },
    );

    // Read loop with length-prefixed framing
    let mut buffer = Vec::new();
    let mut read_buf = [0u8; 8192];

    loop {
        match reader.read(&mut read_buf).await {
            Ok(0) => break, // Connection closed
            Ok(n) => {
                buffer.extend_from_slice(&read_buf[..n]);

                // Extract complete frames
                while buffer.len() >= HEADER_SIZE {
                    let payload_len =
                        u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);

                    if payload_len > MAX_FRAME_SIZE {
                        eprintln!(
                            "[UnityIPC] Frame too large: {} bytes",
                            payload_len
                        );
                        // Disconnect on protocol error
                        buffer.clear();
                        break;
                    }

                    let total = HEADER_SIZE + payload_len as usize;
                    if buffer.len() < total {
                        break; // Incomplete frame
                    }

                    let payload =
                        String::from_utf8_lossy(&buffer[HEADER_SIZE..total]).to_string();
                    buffer.drain(..total);

                    // Parse and route message
                    if let Ok(msg) = serde_json::from_str::<UnityMessage>(&payload) {
                        route_message(&app, &state, msg).await;
                    }
                }
            }
            Err(e) => {
                eprintln!("[UnityIPC] Read error: {}", e);
                break;
            }
        }
    }

    // Connection closed — clear the client channel and fail any pending RPCs so
    // callers don't hang until their timeout (dropping the oneshot sender makes
    // the awaiting receiver resolve to Err).
    *state.client_tx.lock().await = None;
    {
        let mut pending = state.pending.lock().await;
        pending.clear();
    }
    let _ = app.emit(
        "unity-connection-changed",
        ConnectionChangedPayload {
            connected: false,
            info: None,
        },
    );
}

async fn route_message(app: &AppHandle, state: &Arc<UnityIpcInner>, msg: UnityMessage) {
    match msg.msg_type.as_str() {
        "connection_init" | "project_info" => {
            // Validate the bridge's protocol version; warn on a major mismatch
            // but still connect (the frontend offers "Update bridge").
            if let Some(pv) = msg.payload.get("protocolVersion").and_then(|v| v.as_u64()) {
                if pv as u32 != PROTOCOL_VERSION {
                    let _ = app.emit(
                        "unity-bridge-version-mismatch",
                        serde_json::json!({
                            "ideProtocol": PROTOCOL_VERSION,
                            "bridgeProtocol": pv,
                        }),
                    );
                }
            }
            let _ = app.emit(
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
            let _ = app.emit("unity-log", &msg.payload);
        }
        "log_batch" => {
            let _ = app.emit("unity-log-batch", &msg.payload);
        }
        "playstate_changed" => {
            let _ = app.emit("unity-playstate-changed", &msg.payload);
        }
        "playmode_stats" => {
            let _ = app.emit("unity-playmode-stats", &msg.payload);
        }
        "compilation_started" => {
            let _ = app.emit("unity-compilation", serde_json::json!({ "started": true }));
        }
        "compilation_finished" => {
            let mut payload = msg.payload;
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("started".to_string(), serde_json::Value::Bool(false));
            }
            let _ = app.emit("unity-compilation", &payload);
        }
        "open_file" => {
            let _ = app.emit("unity-open-file", &msg.payload);
        }
        "build_progress" => {
            let _ = app.emit("unity-build-progress", &msg.payload);
        }
        "build_result" => {
            let _ = app.emit("unity-build-result", &msg.payload);
        }
        "test_event" => {
            let _ = app.emit("unity-test-event", &msg.payload);
        }
        "selection_changed" => {
            let _ = app.emit("unity-selection-changed", &msg.payload);
        }
        "hierarchy_changed" => {
            let _ = app.emit("unity-hierarchy-changed", &msg.payload);
        }
        "focus_window" => {
            // Could focus the IDE window
        }
        _ => {
            // Unknown message type — ignore
        }
    }
}

#[tauri::command]
pub async fn unity_ipc_stop(app: AppHandle) -> Result<(), String> {
    let inner = app.state::<UnityIpcState>().0.clone();
    if let Some(tx) = inner.shutdown_tx.lock().await.take() {
        let _ = tx.send(()).await;
    }
    *inner.client_tx.lock().await = None;
    inner.pending.lock().await.clear();
    Ok(())
}

#[tauri::command]
pub async fn unity_ipc_send(app: AppHandle, message_json: String) -> Result<(), String> {
    let inner = app.state::<UnityIpcState>().0.clone();
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
    method: String,
    params: serde_json::Value,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    let inner = app.state::<UnityIpcState>().0.clone();

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

    /// Decode a length-prefixed frame the way the read loop does.
    fn decode_frame(frame: &[u8]) -> Option<String> {
        if frame.len() < HEADER_SIZE {
            return None;
        }
        let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        if frame.len() < HEADER_SIZE + len {
            return None;
        }
        Some(String::from_utf8_lossy(&frame[HEADER_SIZE..HEADER_SIZE + len]).to_string())
    }

    #[test]
    fn frame_roundtrip() {
        let original = r#"{"type":"rpc_request","id":"rpc-0","payload":{"method":"getEditorState"}}"#;
        let frame = encode_frame(original);
        // 4-byte big-endian length header.
        let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
        assert_eq!(len as usize, original.len());
        assert_eq!(decode_frame(&frame).as_deref(), Some(original));
    }

    #[test]
    fn frame_roundtrip_unicode() {
        let original = r#"{"type":"log","payload":{"message":"héllo → 世界"}}"#;
        let frame = encode_frame(original);
        assert_eq!(decode_frame(&frame).as_deref(), Some(original));
    }

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

    #[cfg(unix)]
    #[test]
    fn pipe_path_is_deterministic() {
        let a = compute_pipe_path("/tmp/some/workspace");
        let b = compute_pipe_path("/tmp/some/workspace");
        assert_eq!(a, b);
        assert!(a.starts_with("/tmp/unity-ide-"));
        assert!(a.ends_with(".sock"));
    }
}
