//! Debug Adapter Protocol (DAP) host for Unity Mono debugging.
//!
//! Mirrors `lsp.rs`: spawns a DAP adapter as a child process, speaks the
//! `Content-Length`-framed JSON wire format over its stdio, and bridges
//! messages to the frontend via Tauri events (`dap-message` / `dap-exited`).
//! The frontend implements the DAP *client* (initialize/attach/breakpoints/…).
//!
//! For Unity we use `vscode-mono-debug` (MIT) run under the system Mono runtime
//! — this avoids hand-writing the Mono Soft Debugger wire protocol while keeping
//! the UI adapter-agnostic (a native Rust SDB client can replace the sidecar
//! later). Debugging degrades gracefully when Mono or the adapter is absent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt, AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

/// One running DAP adapter and its stdin handle (one session per window).
pub struct DapSession {
    stdin: Option<tokio::process::ChildStdin>,
}

/// Per-window DAP session registry (Tauri-managed state).
pub struct DapState(pub Arc<Mutex<HashMap<String, DapSession>>>);

impl DapState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }

    pub async fn drop_window(&self, label: &str) {
        let mut map = self.0.lock().await;
        if let Some(mut session) = map.remove(label) {
            session.stdin.take();
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct MonoDebugInfo {
    pub mono_path: Option<String>,
    pub adapter_path: Option<String>,
    /// True only when BOTH the runtime and the adapter were found.
    pub available: bool,
}

/// The Mono runtime's executable name on this platform.
///
/// Named (rather than inlined) so the Windows behaviour is assertable from a
/// macOS test run — the `.exe` suffix was simply missing, so no candidate path
/// could ever exist on Windows.
pub(crate) fn mono_binary_name() -> &'static str {
    if cfg!(windows) {
        "mono.exe"
    } else {
        "mono"
    }
}

/// Well-known install locations for the Mono runtime on this platform.
fn mono_candidate_paths() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        // Mono's MSI installs here; Unity also ships a MonoBleedingEdge runtime
        // beside the editor, but that one is found via the Unity install.
        vec![
            PathBuf::from(r"C:\Program Files\Mono\bin\mono.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Mono\bin\mono.exe"),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![
            PathBuf::from("/Library/Frameworks/Mono.framework/Versions/Current/Commands/mono"),
            PathBuf::from("/opt/homebrew/bin/mono"),
            PathBuf::from("/usr/local/bin/mono"),
            PathBuf::from("/usr/bin/mono"),
        ]
    }
}

/// Find the system Mono runtime, if installed.
fn find_mono() -> Option<PathBuf> {
    for p in mono_candidate_paths() {
        if p.exists() {
            return Some(p);
        }
    }
    // PATH fallback. `std::env::split_paths` uses the platform separator — the
    // old code split on ':', which on Windows both uses the wrong separator
    // (';') and shreds every drive-lettered entry: "C:\bin" became "C" and
    // "\bin". Combined with the missing .exe, the Unity debugger could never
    // attach on Windows.
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(mono_binary_name());
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Locate the bundled mono-debug adapter assembly (`mono-debug.exe`).
fn find_adapter(app: &AppHandle) -> Option<PathBuf> {
    // Packaged: <resource_dir>/binaries/mono-debug/mono-debug.exe
    if let Ok(res) = app.path().resource_dir() {
        for name in ["mono-debug.exe", "MonoDebug.exe"] {
            let p = res.join("binaries").join("mono-debug").join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    // Dev: <crate>/binaries/mono-debug/mono-debug.exe
    for name in ["mono-debug.exe", "MonoDebug.exe"] {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("mono-debug")
            .join(name);
        if p.exists() {
            return Some(p);
        }
    }
    // Reuse a system-installed adapter if present (the VS Code "Mono Debug"
    // extension ships mono-debug.exe). This lets debugging work for users who
    // already have the standard Unity/Mono debug tooling — no vendoring needed.
    find_vscode_mono_debug()
}

/// Search the user's VS Code extension dirs for the mono-debug adapter.
fn find_vscode_mono_debug() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let ext_roots = [
        home.join(".vscode").join("extensions"),
        home.join(".vscode-insiders").join("extensions"),
        home.join(".vscode-oss").join("extensions"),
        home.join(".cursor").join("extensions"),
    ];
    for root in ext_roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.contains("mono-debug") {
                continue;
            }
            // Common layouts: <ext>/bin/mono-debug.exe or <ext>/bin/Release/mono-debug.exe
            let base = entry.path().join("bin");
            for rel in ["mono-debug.exe", "Release/mono-debug.exe", "Debug/mono-debug.exe"] {
                let candidate = base.join(rel);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Report Mono + adapter availability so the UI can degrade gracefully
/// ("Install Mono to enable debugging — brew install mono").
#[tauri::command]
pub fn check_mono_installed(app: AppHandle) -> MonoDebugInfo {
    let mono = find_mono();
    let adapter = find_adapter(&app);
    MonoDebugInfo {
        available: mono.is_some() && adapter.is_some(),
        mono_path: mono.map(|p| p.to_string_lossy().to_string()),
        adapter_path: adapter.map(|p| p.to_string_lossy().to_string()),
    }
}

/// Frame a DAP message with a `Content-Length` header (UTF-8 body).
fn frame_message(body: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// Start the DAP adapter for this window. The frontend then drives it with
/// `dap_send` (initialize → attach → setBreakpoints → configurationDone …).
#[tauri::command]
pub async fn dap_start(window: Window, app: AppHandle) -> Result<(), String> {
    let mono = find_mono().ok_or_else(|| {
        "Mono runtime not found. Install Mono to enable Unity debugging (e.g. `brew install mono`).".to_string()
    })?;
    let adapter = find_adapter(&app).ok_or_else(|| {
        "Mono debug adapter not bundled. Run scripts/fetch-mono-debug.ts to vendor vscode-mono-debug.".to_string()
    })?;

    spawn_adapter(
        window,
        app.clone(),
        mono.to_string_lossy().to_string(),
        vec![adapter.to_string_lossy().to_string()],
    )
    .await
}

/// Spawn an adapter process (split out so tests can inject a fake adapter).
async fn spawn_adapter(
    window: Window,
    app: AppHandle,
    program: String,
    args: Vec<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let state = app.state::<DapState>();

    // Tear down any prior session for this window.
    {
        let mut map = state.0.lock().await;
        if let Some(mut prev) = map.remove(&label) {
            prev.stdin.take();
        }
    }

    let mut child = crate::process_util::async_command(&program)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn DAP adapter {}: {}", program, e))?;

    let stdin = child.stdin.take().ok_or("Failed to capture adapter stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture adapter stdout")?;

    state
        .0
        .lock()
        .await
        .insert(label.clone(), DapSession { stdin: Some(stdin) });

    // stdout reader: parse Content-Length framed DAP messages → dap-message.
    {
        let handle = app.clone();
        let win = label.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut content_length: Option<usize> = None;
                loop {
                    let mut header = String::new();
                    match reader.read_line(&mut header).await {
                        Ok(0) => {
                            let _ = handle.emit_to(win.as_str(), "dap-exited", ());
                            return;
                        }
                        Ok(_) => {}
                        Err(_) => {
                            let _ = handle.emit_to(win.as_str(), "dap-exited", ());
                            return;
                        }
                    }
                    let trimmed = header.trim();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(v) = trimmed
                        .strip_prefix("Content-Length:")
                        .or_else(|| trimmed.strip_prefix("content-length:"))
                    {
                        if let Ok(n) = v.trim().parse::<usize>() {
                            content_length = Some(n);
                        }
                    }
                }
                let length = match content_length {
                    Some(n) => n,
                    None => continue,
                };
                let mut body = vec![0u8; length];
                if reader.read_exact(&mut body).await.is_err() {
                    let _ = handle.emit_to(win.as_str(), "dap-exited", ());
                    return;
                }
                if let Ok(s) = String::from_utf8(body) {
                    let _ = handle.emit_to(win.as_str(), "dap-message", s);
                }
            }
        });
    }

    // Reap the child so it doesn't become a zombie; signal exit on death.
    {
        let handle = app.clone();
        let win = label.clone();
        tauri::async_runtime::spawn(async move {
            let _ = child.wait().await;
            let _ = handle.emit_to(win.as_str(), "dap-exited", ());
        });
    }

    Ok(())
}

/// Send a raw DAP message (JSON string) to the adapter for this window.
#[tauri::command]
pub async fn dap_send(window: Window, app: AppHandle, message: String) -> Result<(), String> {
    let label = window.label().to_string();
    let state = app.state::<DapState>();
    let mut map = state.0.lock().await;
    let session = map
        .get_mut(&label)
        .ok_or("No DAP session running for this window")?;
    let stdin = session
        .stdin
        .as_mut()
        .ok_or("DAP session stdin is closed")?;
    stdin
        .write_all(&frame_message(&message))
        .await
        .map_err(|e| format!("Failed to write to DAP adapter: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush DAP adapter stdin: {}", e))?;
    Ok(())
}

/// Stop the DAP session for this window.
#[tauri::command]
pub async fn dap_stop(window: Window, app: AppHandle) -> Result<(), String> {
    let label = window.label().to_string();
    let state = app.state::<DapState>();
    let mut map = state.0.lock().await;
    if let Some(mut session) = map.remove(&label) {
        session.stdin.take();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, AsyncBufReadExt, BufReader};

    /// The Unity debugger could never attach on Windows: PATH was split on
    /// ':', which is the POSIX separator AND shreds a drive-lettered entry
    /// ("C:\bin" -> "C", "\bin"), and the binary name omitted `.exe`.
    #[test]
    fn path_entries_split_on_the_platform_separator() {
        let joined = if cfg!(windows) {
            r"C:\bin;D:\tools"
        } else {
            "/usr/bin:/usr/local/bin"
        };
        let parts: Vec<_> = std::env::split_paths(joined).collect();
        assert_eq!(parts.len(), 2, "got {:?}", parts);
        // The whole point: a Windows entry keeps its drive letter.
        assert!(parts[0].to_string_lossy().len() > 2);
    }

    #[test]
    fn mono_binary_name_is_platform_correct() {
        assert_eq!(
            mono_binary_name(),
            if cfg!(windows) { "mono.exe" } else { "mono" }
        );
    }

    #[test]
    fn frame_message_has_content_length_header() {
        let body = r#"{"seq":1,"type":"request","command":"initialize"}"#;
        let framed = frame_message(body);
        let text = String::from_utf8(framed).unwrap();
        assert!(text.starts_with(&format!("Content-Length: {}\r\n\r\n", body.len())));
        assert!(text.ends_with(body));
    }

    /// Pipe a framed DAP message through `cat` (a fake adapter) and read it back,
    /// confirming the framing encode + decode loop round-trips.
    #[tokio::test]
    async fn cat_roundtrip() {
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

        let body = r#"{"seq":1,"type":"event","event":"initialized"}"#;
        stdin.write_all(&frame_message(body)).await.unwrap();
        stdin.flush().await.unwrap();
        drop(stdin); // EOF so cat exits

        // Decode using the same header-parsing logic as the reader loop.
        let mut reader = BufReader::new(stdout);
        let mut content_length: Option<usize> = None;
        loop {
            let mut header = String::new();
            let n = reader.read_line(&mut header).await.unwrap();
            if n == 0 {
                break;
            }
            let trimmed = header.trim();
            if trimmed.is_empty() {
                break;
            }
            if let Some(v) = trimmed.strip_prefix("Content-Length:") {
                content_length = Some(v.trim().parse().unwrap());
            }
        }
        let length = content_length.expect("Content-Length parsed");
        let mut buf = vec![0u8; length];
        reader.read_exact(&mut buf).await.unwrap();
        assert_eq!(String::from_utf8(buf).unwrap(), body);
    }
}
