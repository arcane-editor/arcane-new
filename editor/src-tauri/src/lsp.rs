use crate::sync_util::lock_recover;
use std::collections::HashMap;
use std::fs::{File, OpenOptions, create_dir_all};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Window};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

// ── LSP traffic trace file ──────────────────────────────────────
//
// One shared trace file mirrors every JSON-RPC message, server-side log
// line, and session boundary across all language servers. Truncated only
// when starting a fresh session (no servers active); otherwise appended,
// so adding a Python server while C# is running doesn't wipe the C# log.

static TRACE: OnceLock<StdMutex<Option<File>>> = OnceLock::new();

fn trace_file_path() -> Option<PathBuf> {
    Some(dirs::cache_dir()?.join("editor-unityide").join("lsp-trace.log"))
}

/// Open the trace file. `truncate=true` starts a fresh session;
/// `truncate=false` appends.
fn trace_open_session(header: &str, truncate: bool) {
    let path = match trace_file_path() {
        Some(p) => p,
        None => return,
    };
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(&path)
        .ok();

    let slot = TRACE.get_or_init(|| StdMutex::new(None));
    let mut guard = lock_recover(slot);
    *guard = file;
    if let Some(f) = guard.as_mut() {
        let _ = writeln!(f, "{}", header);
        let _ = f.flush();
    }
}

fn ts_unix() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}.{:03}", d.as_secs(), d.subsec_millis())
}

/// Append a single tagged line. `prefix` is one of `->`, `<-`, `!!`.
pub(crate) fn trace_append(language: &str, prefix: &str, body: &str) {
    let slot = match TRACE.get() {
        Some(s) => s,
        None => return,
    };
    let mut guard = lock_recover(slot);
    if let Some(f) = guard.as_mut() {
        let _ = writeln!(f, "[{} {}] {} {}", ts_unix(), language, prefix, body);
        let _ = f.flush();
    }
}

// ── Per-language registry ───────────────────────────────────────

/// One running LSP child process and its stdin handle.
pub struct LspServer {
    stdin: Option<tokio::process::ChildStdin>,
    child: Option<Child>,
}

/// Thread-safe registry keyed by window label, then by language. Tauri-managed application state.
pub struct LspState(pub Arc<Mutex<HashMap<String, HashMap<String, LspServer>>>>);

impl LspState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }

    pub async fn drop_window(&self, label: &str) {
        let mut map = self.0.lock().await;
        if let Some(mut langs) = map.remove(label) {
            for (_lang, server) in langs.iter_mut() {
                kill_and_clear(server).await;
            }
        }
    }
}

// ── Per-language binary + args resolution ───────────────────────

/// Build-time target triple, exported by build.rs (`cargo:rustc-env=BUILD_TARGET`).
/// Used to locate sidecars under `src-tauri/binaries/<name>-<TARGET>` during dev.
const BUILD_TARGET: &str = env!("BUILD_TARGET");

/// Locate a bundled sidecar binary by name. Looks first next to the running
/// executable (production layout — Tauri places externalBins there during
/// bundling), then falls back to `src-tauri/binaries/<name>-<TARGET>` for
/// dev mode where the bundler hasn't run.
fn resolve_bundled_sidecar(name: &str) -> Option<PathBuf> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(format!("{}{}", name, suffix));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // Dev fallback: `target/{debug,release}/<exe>` lives a few levels below the
    // crate root. Walk up looking for the `src-tauri/binaries/<name>-<target>`
    // path. Works for `cargo run` and `bun run tauri dev` invocations.
    if let Ok(exe) = std::env::current_exe() {
        let dev_name = format!("{}-{}{}", name, BUILD_TARGET, suffix);
        let mut dir = exe.parent();
        while let Some(d) = dir {
            let cand = d.join("binaries").join(&dev_name);
            if cand.is_file() {
                return Some(cand);
            }
            // Also try sibling `src-tauri/binaries` (one level up from `target/`).
            let cand2 = d.join("src-tauri").join("binaries").join(&dev_name);
            if cand2.is_file() {
                return Some(cand2);
            }
            dir = d.parent();
        }
    }

    None
}

/// Resolve the path to the LSP server binary for a given language.
///
/// Resolution order per language:
/// - **csharp**: not handled here — see [`resolve_server_command`], because a
///   managed csharp-ls is an assembly run by `dotnet` rather than an
///   executable, so program and args have to be decided together.
/// - **typescript**: bundled sidecar (Tauri externalBin) → fall back to PATH
///   if the user sets `EDITOR_USE_SYSTEM_LSP=1` or the sidecar is missing.
/// - **python**: PATH only. Pyright bundling is a known follow-up — pkg has
///   subtle issues with pyright's webpack chunk loading inside its snapshot
///   that exit the process silently on `--stdio`. The PATH-based behavior
///   matches what the editor did before bundling was introduced.
fn resolve_server_binary(language: &str) -> String {
    match language {
        "csharp" => crate::csharp_ls::exe_name("csharp-ls"),
        "python" => {
            if cfg!(target_os = "windows") {
                "pyright-langserver.cmd".to_string()
            } else {
                "pyright-langserver".to_string()
            }
        }
        "typescript" => {
            let prefer_system = std::env::var("EDITOR_USE_SYSTEM_LSP")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            if !prefer_system {
                if let Some(p) = resolve_bundled_sidecar("typescript-language-server") {
                    return p.to_string_lossy().to_string();
                }
            }
            if cfg!(target_os = "windows") {
                "typescript-language-server.cmd".to_string()
            } else {
                "typescript-language-server".to_string()
            }
        }
        // Unknown language — pass through; spawn will fail with a clear error.
        other => other.to_string(),
    }
}

/// Locate the directory containing the `dotnet` executable.
///
/// GUI apps on macOS don't inherit the shell's PATH, so csharp-ls (which
/// uses MSBuildLocator) can't find dotnet via PATH alone. Probe the
/// standard install locations + existing env hints, and return the parent
/// directory so callers can both prepend it to PATH and use it as
/// DOTNET_ROOT.
pub(crate) fn find_dotnet_dir() -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "dotnet.exe"
    } else {
        "dotnet"
    };

    // 1. Honor pre-set environment variables if they actually point at dotnet.
    for var in ["DOTNET_ROOT", "DOTNET_HOST_PATH"] {
        if let Ok(val) = std::env::var(var) {
            let p = PathBuf::from(&val);
            if p.is_file() && p.file_name().map(|n| n == exe_name).unwrap_or(false) {
                if let Some(parent) = p.parent() {
                    return Some(parent.to_path_buf());
                }
            }
            let candidate = p.join(exe_name);
            if candidate.is_file() {
                return Some(p);
            }
        }
    }

    // 2. Probe the standard install locations per platform.
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".dotnet"));
        candidates.push(home.join(".local").join("share").join("dotnet"));
    }

    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/usr/local/share/dotnet"));
        candidates.push(PathBuf::from("/opt/homebrew/share/dotnet"));
        candidates.push(PathBuf::from("/opt/homebrew/bin"));
        candidates.push(PathBuf::from("/usr/local/bin"));
    } else if cfg!(target_os = "linux") {
        candidates.push(PathBuf::from("/usr/share/dotnet"));
        candidates.push(PathBuf::from("/usr/lib/dotnet"));
        candidates.push(PathBuf::from("/usr/local/share/dotnet"));
        candidates.push(PathBuf::from("/snap/dotnet-sdk/current"));
    } else if cfg!(target_os = "windows") {
        candidates.push(PathBuf::from("C:\\Program Files\\dotnet"));
        candidates.push(PathBuf::from("C:\\Program Files (x86)\\dotnet"));
    }

    for dir in &candidates {
        let exe = dir.join(exe_name);
        if exe.is_file() {
            // Resolve symlinks (e.g. /opt/homebrew/bin/dotnet -> /usr/local/share/dotnet/dotnet)
            // so DOTNET_ROOT points at the real install dir, not a bin/ shim.
            let resolved = std::fs::canonicalize(&exe).unwrap_or(exe);
            if let Some(parent) = resolved.parent() {
                return Some(parent.to_path_buf());
            }
        }
    }

    // 3. Fall back to scanning PATH directly. This catches non-standard
    //    layouts when the app *was* launched from a terminal.
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let exe = dir.join(exe_name);
            if exe.is_file() {
                let resolved = std::fs::canonicalize(&exe).unwrap_or(exe);
                if let Some(parent) = resolved.parent() {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }

    None
}

/// Whether a `dotnet` executable exists on this machine.
///
/// Superseded for the C# gate by `csharp_ls::csharp_ls_status`, which also
/// reports whether there is an SDK and whether the runtime is new enough —
/// "dotnet exists" is not sufficient to run the pinned language server. Kept
/// as the cheap yes/no probe for callers that only need presence.
#[tauri::command]
pub fn check_dotnet_installed() -> bool {
    find_dotnet_dir().is_some()
}

/// Build a PATH value with `extra` prepended to the current PATH.
pub(crate) fn path_with_prepended(extra: &Path) -> String {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut paths: Vec<PathBuf> = vec![extra.to_path_buf()];
    paths.extend(std::env::split_paths(&existing));
    std::env::join_paths(paths)
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|_| extra.to_string_lossy().to_string())
}

/// argv for a given language. `solution_path` is only consumed by csharp.
fn resolve_server_args(language: &str, solution_path: Option<&str>) -> Vec<String> {
    match language {
        "csharp" => {
            let mut args = vec!["--loglevel".to_string(), "debug".to_string()];
            if let Some(sln) = solution_path {
                args.push("--solution".to_string());
                args.push(sln.to_string());
            }
            args
        }
        "python" => vec!["--stdio".to_string()],
        "typescript" => vec!["--stdio".to_string()],
        _ => Vec::new(),
    }
}

/// Program and argv for a language's server.
///
/// Exists because C# has two shapes. A csharp-ls the user installed themselves
/// is an executable shim; the copy this editor provisions is a bare tool
/// assembly (the package declares `Runner="dotnet"` and ships no native host),
/// so it runs as `dotnet <assembly> <server args>`. Choosing the program and
/// the argv in one place is what keeps those two from drifting apart.
fn resolve_server_command(
    language: &str,
    solution_path: Option<&str>,
    dotnet_dir: Option<&Path>,
) -> (String, Vec<String>) {
    let mut args = resolve_server_args(language, solution_path);

    if language == "csharp" {
        match crate::csharp_ls::resolve_existing() {
            Some((crate::csharp_ls::ServerLaunch::Executable(exe), _)) => {
                return (exe.to_string_lossy().to_string(), args);
            }
            Some((crate::csharp_ls::ServerLaunch::DotnetDll(dll), _)) => {
                // Absolute `dotnet` where we have it: a GUI app on macOS does
                // not inherit the shell PATH, so the bare name may not resolve.
                let dotnet = dotnet_dir
                    .map(|dir| dir.join(crate::csharp_ls::exe_name("dotnet")))
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| crate::csharp_ls::exe_name("dotnet"));
                args.insert(0, dll.to_string_lossy().to_string());
                return (dotnet, args);
            }
            None => {}
        }
    }

    (resolve_server_binary(language), args)
}

/// Kill a single language server's child process and clear its handles.
async fn kill_and_clear(server: &mut LspServer) {
    server.stdin.take();
    if let Some(mut child) = server.child.take() {
        let _ = child.kill().await;
    }
}

// ── Tauri commands ──────────────────────────────────────────────

/// Start (or restart) the LSP server for `language`. If a server for that
/// language is already running, it is torn down first.
///
/// `solution_path` is csharp-specific (passed as `--solution` to csharp-ls)
/// and ignored for other languages.
#[tauri::command]
pub async fn lsp_start(
    app_handle: AppHandle,
    window: Window,
    state: tauri::State<'_, LspState>,
    language: String,
    workspace_path: String,
    solution_path: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let mut map = state.0.lock().await;

    // Tear down any existing entry for this language in this window's slot.
    if let Some(servers) = map.get_mut(&label) {
        if let Some(mut existing) = servers.remove(&language) {
            kill_and_clear(&mut existing).await;
        }
    }

    // Truncate the trace only when no servers are active across any window.
    let truncate_trace = map.values().all(|s| s.is_empty());

    // csharp-ls (via MSBuildLocator) needs to find `dotnet`. GUI Tauri apps
    // on macOS don't inherit the shell PATH, so probe known install
    // locations and inject DOTNET_ROOT + an augmented PATH for the child.
    // Resolved before the command because a managed csharp-ls *is* run by
    // `dotnet`, so the program itself depends on this.
    let dotnet_dir = if language == "csharp" {
        find_dotnet_dir()
    } else {
        None
    };
    if language == "csharp" && dotnet_dir.is_none() {
        let msg = "Could not locate the .NET SDK. Install the .NET SDK \
                   (https://dotnet.microsoft.com/download) or set the \
                   DOTNET_ROOT environment variable to its install directory."
            .to_string();
        return Err(msg);
    }

    let (bin, args) =
        resolve_server_command(&language, solution_path.as_deref(), dotnet_dir.as_deref());

    let header = format!(
        "=== LSP session ts={} lang={} label={} bin={} cwd={} sln={} dotnet={} ===",
        ts_unix(),
        language,
        label,
        bin,
        workspace_path,
        solution_path.clone().unwrap_or_else(|| "<none>".to_string()),
        dotnet_dir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "<n/a>".to_string()),
    );
    trace_open_session(&header, truncate_trace);

    let mut command = crate::process_util::async_command(&bin);
    command
        .args(&args)
        .current_dir(&workspace_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    if let Some(ref dir) = dotnet_dir {
        let dotnet_exe = dir.join(if cfg!(target_os = "windows") {
            "dotnet.exe"
        } else {
            "dotnet"
        });
        command
            .env("DOTNET_ROOT", dir)
            .env("DOTNET_HOST_PATH", &dotnet_exe)
            .env("PATH", path_with_prepended(dir));
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn {} for language '{}': {}", bin, language, e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    map.entry(label.clone()).or_insert_with(HashMap::new).insert(
        language.clone(),
        LspServer {
            stdin: Some(stdin),
            child: Some(child),
        },
    );

    // ---- background task: stream stderr lines ----
    {
        let stderr_handle = app_handle.clone();
        let stderr_lang = language.clone();
        let stderr_label = label.clone();
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[LSP {}/{} stderr] {}", stderr_label, stderr_lang, line);
                trace_append(&stderr_lang, "!!", &line);
                let _ = stderr_handle.emit_to(
                    stderr_label.as_str(),
                    "lsp-stderr",
                    serde_json::json!({
                        "language": stderr_lang,
                        "body": line,
                    }),
                );
            }
        });
    }

    // ---- background task: parse LSP framed messages from stdout ----
    {
        let handle = app_handle.clone();
        let stdout_lang = language.clone();
        let stdout_label = label.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);

            loop {
                // --- 1. Read headers until the blank line (\r\n\r\n) ---
                let mut content_length: Option<usize> = None;
                loop {
                    let mut header_line = String::new();
                    match reader.read_line(&mut header_line).await {
                        Ok(0) => {
                            let _ = handle.emit_to(
                                stdout_label.as_str(),
                                "lsp-exited",
                                serde_json::json!({ "language": stdout_lang }),
                            );
                            return;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("[LSP {} stdout] read error: {}", stdout_lang, e);
                            let _ = handle.emit_to(
                                stdout_label.as_str(),
                                "lsp-exited",
                                serde_json::json!({ "language": stdout_lang }),
                            );
                            return;
                        }
                    }

                    let trimmed = header_line.trim();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(value) = trimmed.strip_prefix("Content-Length:") {
                        if let Ok(len) = value.trim().parse::<usize>() {
                            content_length = Some(len);
                        }
                    } else if let Some(value) = trimmed.strip_prefix("content-length:") {
                        if let Ok(len) = value.trim().parse::<usize>() {
                            content_length = Some(len);
                        }
                    }
                }

                // --- 2. Read the body ---
                let length = match content_length {
                    Some(n) => n,
                    None => {
                        eprintln!(
                            "[LSP {} stdout] missing Content-Length header, skipping message",
                            stdout_lang
                        );
                        continue;
                    }
                };

                let mut body = vec![0u8; length];
                if let Err(e) = reader.read_exact(&mut body).await {
                    eprintln!(
                        "[LSP {} stdout] failed to read body ({} bytes): {}",
                        stdout_lang, length, e
                    );
                    let _ = handle.emit_to(
                        stdout_label.as_str(),
                        "lsp-exited",
                        serde_json::json!({ "language": stdout_lang }),
                    );
                    return;
                }

                let body_str = match String::from_utf8(body) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!(
                            "[LSP {} stdout] body is not valid UTF-8: {}",
                            stdout_lang, e
                        );
                        continue;
                    }
                };

                // --- 3. Emit the tagged JSON payload as a Tauri event ---
                trace_append(&stdout_lang, "<-", &body_str);
                if let Err(e) = handle.emit_to(
                    stdout_label.as_str(),
                    "lsp-message",
                    serde_json::json!({
                        "language": stdout_lang,
                        "body": body_str,
                    }),
                ) {
                    eprintln!(
                        "[LSP {} stdout] failed to emit event: {}",
                        stdout_lang, e
                    );
                }
            }
        });
    }

    Ok(())
}

/// Send a JSON-RPC message to the running language server.
/// The caller supplies the raw JSON body; this function adds LSP framing.
#[tauri::command]
pub async fn lsp_send(
    window: Window,
    state: tauri::State<'_, LspState>,
    language: String,
    message: String,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.0.lock().await;
    let servers = map
        .get_mut(label)
        .ok_or_else(|| format!("No LSP slot for window '{}'", label))?;

    let server = servers
        .get_mut(&language)
        .ok_or_else(|| format!("LSP server for '{}' is not running", language))?;

    let stdin = server
        .stdin
        .as_mut()
        .ok_or_else(|| format!("LSP server for '{}' has no stdin", language))?;

    trace_append(&language, "->", &message);

    let frame = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);

    stdin
        .write_all(frame.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to LSP stdin ({}): {}", language, e))?;

    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush LSP stdin ({}): {}", language, e))?;

    Ok(())
}

/// Return the absolute path of the shared LSP trace file.
#[tauri::command]
pub fn lsp_trace_path() -> Result<String, String> {
    trace_file_path()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine cache directory".to_string())
}

/// Stop a single language server in this window. Idempotent.
#[tauri::command]
pub async fn lsp_stop(
    window: Window,
    state: tauri::State<'_, LspState>,
    language: String,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.0.lock().await;
    if let Some(servers) = map.get_mut(label) {
        if let Some(mut server) = servers.remove(&language) {
            kill_and_clear(&mut server).await;
        }
    }
    Ok(())
}

/// Stop every running language server in this window. Used on workspace switch.
#[tauri::command]
pub async fn lsp_stop_all(
    window: Window,
    state: tauri::State<'_, LspState>,
) -> Result<(), String> {
    let label = window.label();
    let mut map = state.0.lock().await;
    if let Some(servers) = map.get_mut(label) {
        for (_lang, server) in servers.iter_mut() {
            kill_and_clear(server).await;
        }
        servers.clear();
    }
    Ok(())
}
