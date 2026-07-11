use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Window};

struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    writer: std::fs::File,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    _reader_thread: Option<thread::JoinHandle<()>>,
}

struct WindowSlot {
    instances: HashMap<u32, PtyInstance>,
    next_id: u32,
}

impl WindowSlot {
    fn new() -> Self {
        Self {
            instances: HashMap::new(),
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

/// Reap every PTY belonging to this window's *previous* incarnation.
/// `TerminalState` is keyed by window label and otherwise only
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
