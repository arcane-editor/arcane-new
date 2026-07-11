use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Window};

struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    writer: std::fs::File,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    _reader_thread: Option<thread::JoinHandle<()>>,
}

/// A one-shot terminal created on the agent's behalf via the ACP `terminal/*`
/// methods. Unlike `PtyInstance` (an interactive xterm), this runs a specific
/// command, buffers its output, and captures the exit code.
struct AcpTerminal {
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    master: Box<dyn MasterPty + Send>,
    output: Arc<Mutex<Vec<u8>>>,
    truncated: Arc<AtomicBool>,
    /// Exit code once the process has been reaped (None while still running).
    exit: Arc<Mutex<Option<i32>>>,
    _reader_thread: Option<thread::JoinHandle<()>>,
}

struct WindowSlot {
    instances: HashMap<u32, PtyInstance>,
    acp: HashMap<u32, AcpTerminal>,
    next_id: u32,
}

impl WindowSlot {
    fn new() -> Self {
        Self {
            instances: HashMap::new(),
            acp: HashMap::new(),
            next_id: 1,
        }
    }
}

pub struct TerminalState {
    windows: Arc<Mutex<HashMap<String, WindowSlot>>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            windows: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn drop_window(&self, label: &str) {
        if let Ok(mut map) = self.windows.lock() {
            if let Some(mut slot) = map.remove(label) {
                let ids: Vec<u32> = slot.instances.keys().copied().collect();
                for id in ids {
                    if let Some(mut inst) = slot.instances.remove(&id) {
                        let _ = inst.child.kill();
                    }
                }
                let acp_ids: Vec<u32> = slot.acp.keys().copied().collect();
                for id in acp_ids {
                    if let Some(term) = slot.acp.remove(&id) {
                        if let Ok(mut ch) = term.child.lock() {
                            let _ = ch.kill();
                        }
                    }
                }
            }
        }
    }
}

#[derive(Clone, Serialize)]
struct TerminalOutputPayload {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExitPayload {
    id: u32,
    exit_code: Option<u32>,
}

fn detect_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

#[cfg(unix)]
fn clone_master_as_writer(master: &dyn MasterPty) -> Result<std::fs::File, String> {
    use std::os::unix::io::FromRawFd;

    let raw_fd = master
        .as_raw_fd()
        .ok_or_else(|| "Failed to get raw fd from master PTY".to_string())?;

    let dup_fd = unsafe { libc::dup(raw_fd) };
    if dup_fd < 0 {
        return Err("Failed to duplicate master PTY fd".to_string());
    }

    Ok(unsafe { std::fs::File::from_raw_fd(dup_fd) })
}

#[cfg(windows)]
fn clone_master_as_writer(_master: &dyn MasterPty) -> Result<std::fs::File, String> {
    Err("Windows PTY writer not implemented".to_string())
}

/// Reap every PTY (interactive + ACP) belonging to this window's *previous*
/// incarnation. `TerminalState` is keyed by window label and otherwise only
/// ever cleaned up on window destroy, so a webview reload (e.g. Cmd+R, which
/// resets the frontend's terminal store but leaves the Rust process tree
/// alone) would otherwise orphan every shell that was running before the
/// reload. Call this once at boot, before spawning any new terminal for the
/// window — it's a no-op on first launch since there's no prior slot yet.
#[tauri::command]
pub fn terminal_reset_window(window: Window, state: tauri::State<'_, TerminalState>) {
    state.drop_window(window.label());
}

#[tauri::command]
pub fn terminal_spawn(
    app_handle: AppHandle,
    window: Window,
    state: tauri::State<'_, TerminalState>,
    cwd: String,
    shell: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    let id = {
        let mut map = state.windows.lock().map_err(|e| e.to_string())?;
        let slot = map.entry(label.clone()).or_insert_with(WindowSlot::new);
        let current = slot.next_id;
        slot.next_id += 1;
        current
    };

    let pty_system = native_pty_system();
    let pty_size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(pty_size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell_path = shell.unwrap_or_else(detect_shell);
    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.cwd(&cwd);

    // portable-pty's CommandBuilder starts with an empty env. Without TERM,
    // PATH, HOME, etc. the spawned shell falls back to a "dumb" mode where
    // readline/zle line-editing (incl. backspace) is broken. Inherit parent
    // env, then force a real terminfo entry on top.
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    #[cfg(unix)]
    {
        cmd.arg("-l");
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = clone_master_as_writer(pair.master.as_ref())?;
    let master = pair.master;

    let handle = app_handle.clone();
    let target_label = label.clone();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = handle.emit_to(
                        target_label.as_str(),
                        "terminal-exit",
                        TerminalExitPayload { id, exit_code: None },
                    );
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if handle
                        .emit_to(
                            target_label.as_str(),
                            "terminal-output",
                            TerminalOutputPayload { id, data },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    let _ = handle.emit_to(
                        target_label.as_str(),
                        "terminal-exit",
                        TerminalExitPayload { id, exit_code: None },
                    );
                    break;
                }
            }
        }
    });

    let instance = PtyInstance {
        master,
        writer,
        child,
        _reader_thread: Some(reader_thread),
    };

    let mut map = state.windows.lock().map_err(|e| e.to_string())?;
    let slot = map.entry(label).or_insert_with(WindowSlot::new);
    slot.instances.insert(id, instance);

    Ok(id)
}

#[tauri::command]
pub fn terminal_write(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.windows.lock().map_err(|e| e.to_string())?;
    let slot = map
        .get_mut(label)
        .ok_or_else(|| format!("No terminal window slot for {}", label))?;
    let instance = slot
        .instances
        .get_mut(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;

    instance
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to terminal {}: {}", id, e))?;

    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let label = window.label();
    let map = state.windows.lock().map_err(|e| e.to_string())?;
    let slot = map
        .get(label)
        .ok_or_else(|| format!("No terminal window slot for {}", label))?;
    let instance = slot
        .instances
        .get(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;

    instance
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to resize terminal {}: {}", id, e))?;

    Ok(())
}

#[tauri::command]
pub fn terminal_kill(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.windows.lock().map_err(|e| e.to_string())?;
    if let Some(slot) = map.get_mut(label) {
        if let Some(mut instance) = slot.instances.remove(&id) {
            let _ = instance.child.kill();
            drop(instance.master);
        }
    }
    Ok(())
}

// ── ACP terminals (terminal/* from the Claude bridge) ────────────────────────
//
// These run a specific command (no login shell), buffer output into a capped
// in-memory ring, and capture the exit code — the shape ACP's terminal/output
// and terminal/wait_for_exit expect. Distinct from the interactive PTY above.

const ACP_DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024; // 1 MiB

#[derive(Deserialize)]
pub struct AcpEnvVar {
    name: String,
    value: String,
}

#[derive(Serialize)]
pub struct AcpTerminalOutputResult {
    output: String,
    truncated: bool,
    exited: bool,
    exit_code: Option<i32>,
    signal: Option<String>,
}

#[derive(Serialize)]
pub struct AcpTerminalWaitResult {
    exit_code: Option<i32>,
    signal: Option<String>,
}

#[tauri::command]
pub fn acp_terminal_create(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Vec<AcpEnvVar>,
    output_byte_limit: Option<usize>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    let id = {
        let mut map = state.windows.lock().map_err(|e| e.to_string())?;
        let slot = map.entry(label.clone()).or_insert_with(WindowSlot::new);
        let current = slot.next_id;
        slot.next_id += 1;
        current
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(&command);
    for arg in &args {
        cmd.arg(arg);
    }
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
    }
    // Inherit parent env + force a real terminfo entry, then apply ACP overrides.
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for ev in &env {
        cmd.env(&ev.name, &ev.value);
    }
    // NOTE: no `-l` — this is a direct command, not an interactive login shell.

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let limit = output_byte_limit.unwrap_or(ACP_DEFAULT_OUTPUT_LIMIT).max(1024);
    let output = Arc::new(Mutex::new(Vec::<u8>::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let exit = Arc::new(Mutex::new(None::<i32>));
    let child = Arc::new(Mutex::new(child));

    let output_c = output.clone();
    let truncated_c = truncated.clone();
    let exit_c = exit.clone();
    let child_c = child.clone();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut out) = output_c.lock() {
                        if out.len() >= limit {
                            truncated_c.store(true, Ordering::Relaxed);
                        } else {
                            let space = limit - out.len();
                            if n <= space {
                                out.extend_from_slice(&buf[..n]);
                            } else {
                                out.extend_from_slice(&buf[..space]);
                                truncated_c.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
        }
        // Reader hit EOF — reap the exit status (poll so kill() can interleave).
        loop {
            {
                if let Ok(mut ch) = child_c.lock() {
                    match ch.try_wait() {
                        Ok(Some(status)) => {
                            if let Ok(mut e) = exit_c.lock() {
                                *e = Some(status.exit_code() as i32);
                            }
                            break;
                        }
                        Ok(None) => {}
                        Err(_) => {
                            if let Ok(mut e) = exit_c.lock() {
                                *e = Some(-1);
                            }
                            break;
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    });

    let term = AcpTerminal {
        child,
        master: pair.master,
        output,
        truncated,
        exit,
        _reader_thread: Some(reader_thread),
    };

    let mut map = state.windows.lock().map_err(|e| e.to_string())?;
    let slot = map.entry(label).or_insert_with(WindowSlot::new);
    slot.acp.insert(id, term);
    Ok(id)
}

#[tauri::command]
pub fn acp_terminal_output(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<AcpTerminalOutputResult, String> {
    let label = window.label();
    let map = state.windows.lock().map_err(|e| e.to_string())?;
    let slot = map
        .get(label)
        .ok_or_else(|| format!("No terminal window slot for {}", label))?;
    let term = slot
        .acp
        .get(&id)
        .ok_or_else(|| format!("ACP terminal {} not found", id))?;

    let bytes = term.output.lock().map_err(|e| e.to_string())?.clone();
    let output = String::from_utf8_lossy(&bytes).to_string();
    let truncated = term.truncated.load(Ordering::Relaxed);
    let exit_code = *term.exit.lock().map_err(|e| e.to_string())?;
    Ok(AcpTerminalOutputResult {
        output,
        truncated,
        exited: exit_code.is_some(),
        exit_code,
        signal: None,
    })
}

#[tauri::command]
pub async fn acp_terminal_wait(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<AcpTerminalWaitResult, String> {
    let label = window.label().to_string();
    loop {
        {
            let map = state.windows.lock().map_err(|e| e.to_string())?;
            let slot = map
                .get(&label)
                .ok_or_else(|| format!("No terminal window slot for {}", label))?;
            let term = slot
                .acp
                .get(&id)
                .ok_or_else(|| format!("ACP terminal {} not found", id))?;
            let exit_code = *term.exit.lock().map_err(|e| e.to_string())?;
            if let Some(code) = exit_code {
                return Ok(AcpTerminalWaitResult { exit_code: Some(code), signal: None });
            }
        }
        // Guard released before awaiting — never hold a std Mutex across .await.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tauri::command]
pub fn acp_terminal_kill(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<(), String> {
    let label = window.label();
    let map = state.windows.lock().map_err(|e| e.to_string())?;
    if let Some(slot) = map.get(label) {
        if let Some(term) = slot.acp.get(&id) {
            if let Ok(mut ch) = term.child.lock() {
                let _ = ch.kill();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn acp_terminal_release(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.windows.lock().map_err(|e| e.to_string())?;
    if let Some(slot) = map.get_mut(label) {
        if let Some(term) = slot.acp.remove(&id) {
            if let Ok(mut ch) = term.child.lock() {
                let _ = ch.kill();
            }
            drop(term.master);
        }
    }
    Ok(())
}
