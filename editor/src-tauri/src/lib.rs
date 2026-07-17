mod git;
mod lsp;
mod terminal;
mod settings;
mod search;
mod file_scanner;
mod file_index;
mod unity;
mod asmdef;
mod unity_yaml;
mod unity_index;
mod unity_diff;
mod unity_tests;
mod unity_ipc;
mod dap;
mod auth;
mod graphify;
mod sync_util;
mod walk_policy;
#[cfg(target_os = "macos")]
mod menu;
#[cfg(target_os = "macos")]
mod dock;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
    /// Gitignored per `git check-ignore` (exact git semantics: nested
    /// .gitignore files, info/exclude, global excludesFile). The explorer
    /// renders these dimmed, VS Code style. Always false outside a git repo.
    #[serde(default)]
    pub ignored: bool,
}

/// Which of `names` (entries of directory `dir`) are gitignored, per
/// `git -C <dir> check-ignore -z --stdin`. Batch form: one subprocess per
/// directory listing. Any failure — not a git repo (exit 128), git missing,
/// broken pipe — degrades to "nothing ignored"; ignore status must never
/// break the file tree.
fn classify_ignored(dir: &str, names: &[String]) -> std::collections::HashSet<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    if names.is_empty() {
        return std::collections::HashSet::new();
    }

    let child = Command::new("git")
        .args(["-C", dir, "check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(_) => return std::collections::HashSet::new(),
    };

    // Feed stdin from a separate thread: check-ignore streams results as it
    // reads, so on a large listing with many ignored entries both pipes can
    // fill and a single-threaded write-then-read would deadlock.
    let writer = child.stdin.take().map(|mut stdin| {
        let mut buf = Vec::with_capacity(names.iter().map(|n| n.len() + 1).sum());
        for name in names {
            buf.extend_from_slice(name.as_bytes());
            buf.push(0);
        }
        std::thread::spawn(move || {
            let _ = stdin.write_all(&buf);
        })
    });

    let output = child.wait_with_output();
    if let Some(handle) = writer {
        let _ = handle.join();
    }

    // Exit 0 = some paths ignored (listed on stdout, NUL-separated verbatim);
    // 1 = none ignored; 128 = not a repo / git error. stdout is empty in the
    // latter two, so parsing unconditionally yields the correct empty set.
    match output {
        Ok(out) => out
            .stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
        Err(_) => std::collections::HashSet::new(),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
}

/// Stays `sync` (not converted for C8): a single non-recursive `fs::read_dir`
/// call plus one short-lived `git check-ignore` batch — no walk, bounded by
/// one directory's entry count — invoked on every lazy file-tree expand.
/// Cheap enough that main-thread dispatch is the right tradeoff (an `async`
/// command still pays IPC/task scheduling overhead), and every fallible
/// operation is funneled through `?`/`Result` or degrades (ignore status),
/// not a panic path.
#[tauri::command]
fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;

    let skip_dirs = ["node_modules", "target", ".git", "dist", "build"];

    let mut result: Vec<FileEntry> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip only the always-hidden entries (.git, .DS_Store); other
            // dotfiles (.env, .gitignore, ...) are visible in the tree. See
            // walk_policy::is_always_hidden.
            if walk_policy::is_always_hidden(&name) {
                return None;
            }

            let is_dir = entry.file_type().ok()?.is_dir();

            // Skip certain directories
            if is_dir && skip_dirs.contains(&name.as_str()) {
                return None;
            }

            let path = entry.path().to_string_lossy().to_string();

            Some(FileEntry {
                name,
                path,
                is_dir,
                children: if is_dir { Some(vec![]) } else { None },
                ignored: false,
            })
        })
        .collect();

    let names: Vec<String> = result.iter().map(|e| e.name.clone()).collect();
    let ignored = classify_ignored(&path, &names);
    for entry in &mut result {
        entry.ignored = ignored.contains(&entry.name);
    }

    // Sort: directories first, then alphabetical case-insensitive
    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, &contents).map_err(|e| e.to_string())
}

/// Cheap existence check for a single candidate file path — no content read,
/// no error payload. Used by the TS/JS relative-import link/definition
/// provider (`src/features/editor/services/import-link-provider.ts`) to probe
/// resolution candidates (`spec`, `spec.ts`, `spec/index.ts`, ...) one at a
/// time without paying for `read_file`'s UTF-8 decode + error string on the
/// (common) miss path.
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Existence check for a project folder — used by the multi-window "open
/// project" flow (`src/features/project/services/multi-window.ts`) to guard
/// against spawning a window for a path that's been moved/deleted since it
/// was recorded in recents. Deliberately separate from `path_exists`: that
/// command is `is_file()`-only (see its doc comment) and would always return
/// `false` for a project directory, which is exactly the path this guard
/// needs to accept.
#[tauri::command]
fn dir_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Canonicalize a project path before `openProjectInNewWindow`
/// (`src/features/project/services/multi-window.ts`) hashes it into a
/// per-window label. `unity_ipc::hash_workspace` already canonicalizes the
/// workspace path when computing the Unity IPC socket/pipe path; if the
/// window label were hashed from the RAW path instead, the same project
/// opened via two different spellings (a symlink, a trailing slash, `..`
/// segments) would get two different window labels — so both windows'
/// `unity_ipc` sockets collide on the SAME canonical path, and the second
/// window's cleanup can unlink the first window's still-live socket.
/// Calling this first and using its result everywhere downstream (label,
/// window dedup, `?path=` query param, recents) keeps all of that on one
/// canonical form.
///
/// Infallible: falls back to the input path unchanged when canonicalization
/// fails (e.g. the path doesn't exist, or a permissions error), so a bad
/// path still flows through to the existing `dir_exists` guard instead of
/// erroring out early here.
#[tauri::command]
fn canonicalize_path(path: String) -> String {
    std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path)
}

/// `async`: full recursive `WalkDir` walk over the workspace (TS/JS project
/// files, used by the Monaco TS worker to seed the in-memory FS). Dispatched
/// onto Tauri's blocking thread pool (see `tauri::command(async)` on a
/// non-`async fn`) instead of the main thread — see C8's crash-hardening
/// notes on `debug_panic_sync`/`debug_panic_async` in `run()` for why: a
/// panic here (e.g. a symlink cycle or permissions edge case `WalkDir`
/// doesn't fully guard against) would otherwise unwind across the native
/// webview's FFI callback and abort the whole process. `invoke()` on the
/// frontend is a `Promise` either way, so this is not a breaking change for
/// callers.
#[tauri::command(async)]
fn scan_workspace_files(path: String) -> Result<Vec<String>, String> {
    let skip_dirs: &[&str] = &[
        "node_modules", "target", ".git", "dist", "build", ".next", ".nuxt",
    ];
    let valid_extensions: &[&str] = &["ts", "tsx", "js", "jsx", "mts", "cts"];

    let files: Vec<String> = WalkDir::new(&path)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_dir() {
                // Skip hidden directories and specific directories
                if name.starts_with('.') {
                    return false;
                }
                if skip_dirs.contains(&name.as_ref()) {
                    return false;
                }
            }
            true
        })
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if entry.file_type().is_dir() {
                return None;
            }
            let path = entry.path();
            // Check for .d.ts first (compound extension)
            let path_str = path.to_string_lossy();
            if path_str.ends_with(".d.ts") {
                return Some(path_str.to_string());
            }
            // Check regular extensions
            let ext = path.extension()?.to_string_lossy();
            if valid_extensions.contains(&ext.as_ref()) {
                Some(path_str.to_string())
            } else {
                None
            }
        })
        .collect();

    Ok(files)
}

/// `async` for the same reason as `scan_workspace_files` above — a full
/// recursive `WalkDir` over the entire workspace (used for AI-context file
/// enumeration and the Unity scene-context panel), moved off the main thread
/// so it can't block the UI or, if it panics, take down every window.
#[tauri::command(async)]
fn scan_all_files(workspace_path: String) -> Result<Vec<String>, String> {
    let skip_dirs: &[&str] = &["node_modules", "target", ".git", "dist", "build", ".next", ".nuxt"];
    let files: Vec<String> = WalkDir::new(&workspace_path)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_dir() {
                if walk_policy::is_always_hidden(&name) { return false; }
                if skip_dirs.contains(&name.as_ref()) { return false; }
            }
            true
        })
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if entry.file_type().is_dir() { return None; }
            Some(entry.path().to_string_lossy().to_string())
        })
        .collect();
    Ok(files)
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(p, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err("Directory already exists".to_string());
    }
    fs::create_dir_all(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// `async`: reads an arbitrary-length list of files synchronously in a tight
/// loop (used to bulk-load TS lib/type-declaration files for the Monaco TS
/// worker — can be dozens to low hundreds of files per call on a large
/// workspace). Same reasoning as the two `WalkDir`-based commands above:
/// moved off the main thread so a slow disk or an unexpected panic
/// (`fs::read_to_string` on a file that changes underfoot, etc.) can't stall
/// or crash the whole app.
#[tauri::command(async)]
fn read_files_bulk(paths: Vec<String>) -> Result<Vec<FileContent>, String> {
    let results: Vec<FileContent> = paths
        .into_iter()
        .filter_map(|path| {
            let content = fs::read_to_string(&path).ok()?;
            Some(FileContent { path, content })
        })
        .collect();

    Ok(results)
}

/// Scans ALL .d.ts files in node_modules — this is how VS Code resolves
/// subpath imports like `@trpc/server/adapters/express`.
///
/// `async` (C8, bonus finding beyond the originally-scoped candidate list —
/// this walk wasn't named in the C8 task brief but is the same shape of risk
/// as `scan_workspace_files`/`scan_all_files`): `node_modules` in a large JS
/// project routinely has tens of thousands of entries, so this is at least
/// as heavy as the two `WalkDir` commands already converted above.
#[tauri::command(async)]
fn scan_node_modules_types(workspace_path: String) -> Result<Vec<String>, String> {
    let node_modules = Path::new(&workspace_path).join("node_modules");
    if !node_modules.is_dir() {
        return Ok(vec![]);
    }

    let skip_dirs = ["__tests__", "test", "tests", "examples", "example", "docs", "__mocks__", "__fixtures__"];

    let mut files = Vec::new();
    for entry in WalkDir::new(&node_modules)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                // Skip hidden dirs (but allow @scoped packages)
                if name.starts_with('.') {
                    return false;
                }
                // Skip test/example directories to reduce noise
                if skip_dirs.contains(&name.as_ref()) {
                    return false;
                }
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let path_str = entry.path().to_string_lossy();
            if path_str.ends_with(".d.ts") {
                files.push(path_str.to_string());
            }
        }
    }

    Ok(files)
}

#[tauri::command]
fn create_directory_recursive(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[tauri::command]
async fn execute_command(
    command: String,
    cwd: String,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    use std::process::Stdio;
    use tokio::process::Command;

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30000));

    let child = Command::new(if cfg!(target_os = "windows") { "cmd" } else { "sh" })
        .args(if cfg!(target_os = "windows") { vec!["/C", &command] } else { vec!["-c", &command] })
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("Command timed out after {}ms", timeout.as_millis()))?
        .map_err(|e| format!("Command failed: {}", e))?;

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Installs a process-wide panic hook: prints the panic (message + source
/// location) to stderr via Rust's default hook (unchanged formatting/output
/// tooling may already parse), then best-effort appends the same
/// information as one line to `panics.log` under the app data dir.
///
/// This does NOT change panic semantics anywhere — it's pure observability.
/// See `debug_panic_sync`/`debug_panic_async` below for what actually
/// happens (crash vs. contained) when a command panics; this hook fires
/// either way and is the only place a sync-command crash (which takes the
/// whole process down before any other code could log it) gets a chance to
/// leave a trace before the process dies.
///
/// Every step here is best-effort: a failure to create the directory, open
/// the file, or write to it is silently swallowed. A panic *inside the
/// panic hook itself* would trigger Rust's "panic while panicking" abort
/// immediately, which is strictly worse than just losing the log line, so
/// nothing here is allowed to fail loudly.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Run the default hook first — its stderr formatting (backtrace
        // hint, thread name, etc.) is more complete than anything hand-rolled
        // here, and this preserves that output for anyone watching a
        // terminal/dev console.
        default_hook(info);

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let thread_name = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let line = format!(
            "[{}.{:03}] thread '{}' panicked at {}: {}\n",
            ts.as_secs(),
            ts.subsec_millis(),
            thread_name,
            location,
            payload
        );

        let Some(mut path) = dirs::data_dir() else {
            return;
        };
        path.push("editor");
        if std::fs::create_dir_all(&path).is_err() {
            return;
        }
        path.push("panics.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = std::io::Write::write_all(&mut f, line.as_bytes());
        }
    }));
}

/// Dev-only, unregistered-in-release command used to empirically verify
/// crash-containment behavior for the C8 hardening pass (see
/// `debug_panic_async` below for the async counterpart and the source-reading
/// this is based on).
///
/// Per tauri 2.x's command dispatch (`tauri-macros` `wrapper::body_blocking`,
/// generated for any `#[tauri::command]` *without* the `async` modifier — see
/// `~/.cargo/registry/src/*/tauri-macros-2.5.5/src/command/wrapper.rs`), a
/// blocking command's body runs inline, synchronously, on whatever thread
/// delivered the IPC message (`WebviewWindow::on_message`, called directly
/// from the platform webview's IPC callback — for the default wry runtime
/// that's the native webview delegate on the main UI thread). That callback
/// is a Rust fn called back *from* the native (Objective-C/COM/GTK) webview
/// through an `extern "C"` boundary. Unwinding a panic across an `extern "C"`
/// boundary is UB, and since Rust 1.71 the runtime detects this and aborts
/// the process immediately — this project sets no `panic = "abort"` profile
/// anywhere (checked: no such key in `src-tauri/Cargo.toml`), so the abort
/// here is the FFI-boundary safety net kicking in, not a build setting.
///
/// EXPECTED (documented, not yet empirically verified — see manual-pass note
/// in the C8 report): invoking this command from any window kills the entire
/// process, i.e. every window, reproducing the reported "one window crashes,
/// all windows die" bug. This is exactly the failure mode C8's other changes
/// (poison recovery, sync→async conversion of heavy commands) mitigate
/// around, since fixing the FFI-abort itself would require process-per-window
/// isolation (see the future-work note on `run()` below) — out of scope for
/// this pragmatic pass.
#[cfg(debug_assertions)]
#[tauri::command]
fn debug_panic_sync() {
    panic!("debug_panic_sync: intentional panic for C8 crash-hardening verification");
}

/// Dev-only, unregistered-in-release command — async counterpart of
/// `debug_panic_sync`.
///
/// Per the same dispatch code (`wrapper::body_async`, used for any
/// `#[tauri::command(async)]` or `async fn` command), the command's future is
/// handed to `resolver.respond_async_serialized`, which wraps it in
/// `tauri::async_runtime::spawn` — a `tokio::spawn` under this project's
/// default (tokio) async runtime feature. A panic inside a spawned tokio task
/// is caught by tokio's own per-task unwind boundary (each task is polled
/// inside a `catch_unwind`); the task's `JoinHandle` would observe a
/// `JoinError::is_panic()` if anyone awaited it, but nothing here does — the
/// response future itself panicked, so the frontend's `invoke()` promise for
/// this call simply never resolves or rejects. Critically, the panic does
/// NOT propagate to the tokio worker thread or the process: every other
/// window, and every other in-flight command on the same worker thread pool,
/// keeps running.
///
/// EXPECTED (documented, not yet empirically verified — manual-pass item):
/// calling this command hangs only the calling frontend's promise for this
/// one invocation; the app (all windows) stays up. This is the behavior
/// step 4 (sync→async conversion) leans on: moving heavy fs-walk commands
/// onto this path trades "possible unhandled panic kills everyone" for
/// "possible unhandled panic strands one promise."
#[cfg(debug_assertions)]
#[tauri::command(async)]
async fn debug_panic_async() {
    panic!("debug_panic_async: intentional panic for C8 crash-hardening verification");
}

/// Show/focus the existing "welcome" (project-manager) window, or create it if
/// none exists. Shared by the macOS dock-icon `RunEvent::Reopen` handler and by
/// the dock right-click menu's "New Window" action (`dock::install_dock_menu`).
///
/// macOS-only: `RunEvent::Reopen` and the dock menu are both macOS-only
/// surfaces, so gating this here keeps it out of other platforms' builds
/// (no dead-code warnings) while sharing one implementation.
#[cfg(target_os = "macos")]
pub(crate) fn open_or_focus_welcome(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.webview_windows().get("welcome") {
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tauri::WebviewWindowBuilder::new(
                &app,
                "welcome",
                tauri::WebviewUrl::App("index.html?view=welcome".into()),
            )
            .title("Arcane")
            .inner_size(720.0, 480.0)
            .min_inner_size(600.0, 360.0)
            .resizable(true)
            .build();
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();

    // ── Future work (deferred, out of scope for C8's pragmatic pass) ──────
    // The structural fix for "one window's bug takes down every window" is
    // process-per-window isolation (spawn a child process per project
    // window instead of sharing one Rust process/Mutex-guarded state across
    // all of them). C8 deliberately does NOT do that — it's a much larger
    // change (IPC between a supervisor process and per-window worker
    // processes, window lifecycle/restart UX, etc.). What C8 does instead:
    // poison-recover the shared std::sync::Mutex state so one panic doesn't
    // permanently wedge every other window's access to that state
    // (`sync_util::lock_recover`), move the heaviest sync fs-walk commands
    // onto tokio's task-isolated async dispatch path so a panic there can't
    // reach the FFI-boundary abort path at all, and log panics (this hook)
    // so a crash leaves a paper trail. Revisit process-per-window isolation
    // if sync-command panics remain a recurring source of whole-app crashes
    // after this pass.
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(lsp::LspState::new())
        .manage(terminal::TerminalState::new())
        .manage(file_scanner::FileWatcherState::new())
        .manage(file_index::FileIndexState::new())
        .manage(unity_ipc::UnityIpcState::new())
        .manage(dap::DapState::new())
        .manage(search::ContentSearchState::new())
        .invoke_handler(tauri::generate_handler![
            read_directory,
            read_file,
            write_file,
            path_exists,
            dir_exists,
            canonicalize_path,
            scan_workspace_files,
            scan_all_files,
            create_file,
            create_directory,
            rename_path,
            delete_path,
            read_files_bulk,
            scan_node_modules_types,
            #[cfg(debug_assertions)]
            debug_panic_sync,
            #[cfg(debug_assertions)]
            debug_panic_async,
            settings::read_settings,
            settings::write_settings,
            search::start_content_search,
            search::cancel_content_search,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_stop_all,
            lsp::lsp_trace_path,
            lsp::check_dotnet_installed,
            git::git_status,
            git::git_list_branches,
            git::git_switch_branch,
            git::git_create_branch,
            git::git_rename_branch,
            git::git_delete_branch,
            git::git_diff,
            git::git_diff_file_head,
            git::git_stage_file,
            git::git_unstage_file,
            git::git_stage_all,
            git::git_commit,
            git::git_stash_push,
            git::git_stash_list,
            git::git_stash_apply,
            git::git_stash_pop,
            git::git_stash_drop,
            git::git_show_head,
            git::git_show_index,
            git::git_unstage_all,
            git::git_discard_file,
            git::git_discard_all,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_log,
            git::git_show_commit,
            git::git_show_file_at,
            git::git_worktree_list,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_prune,
            git::git_blame_file,
            git::git_setup_unityyamlmerge,
            git::git_run_unityyamlmerge,
            git::git_resolve_conflict_side,
            git::git_append_gitignore,
            terminal::terminal_reset_window,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_attach,
            terminal::terminal_ack,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_clipboard_image_to_temp,
            file_scanner::scan_all_files_v2,
            file_scanner::fuzzy_search_files,
            file_scanner::start_file_watcher,
            file_scanner::stop_file_watcher,
            file_index::build_file_index,
            unity::detect_unity_project,
            unity::scan_meta_files,
            unity::unity_setup_lsp,
            unity::resolve_unity_editor,
            unity::unity_fetch_registry_index,
            unity::unity_install_bridge,
            asmdef::asmdef_build_graph,
            asmdef::asmdef_graph_get,
            asmdef::asmdef_owning_assembly,
            asmdef::unity_classify_scripts,
            unity_yaml::unity_parse_asset,
            unity_diff::unity_scene_diff,
            unity_diff::unity_scene_diff_revs,
            unity_index::unity_index_build,
            unity_index::unity_index_guid_map,
            unity_index::unity_index_find_references,
            unity_index::unity_index_hygiene,
            unity_index::unity_index_apply_delta,
            unity_tests::unity_tests_discover,
            unity_tests::unity_tests_run_headless,
            auth::auth_read_token,
            auth::auth_write_token,
            auth::auth_delete_token,
            unity_ipc::unity_ipc_start,
            unity_ipc::unity_ipc_stop,
            unity_ipc::unity_ipc_send,
            unity_ipc::unity_ipc_request,
            unity_ipc::unity_write_bridge_discovery,
            dap::dap_start,
            dap::dap_send,
            dap::dap_stop,
            dap::check_mono_installed,
            graphify::graphify_check,
            graphify::graphify_build,
            graphify::graphify_query,
            graphify::graphify_explain,
            graphify::graphify_path,
            graphify::graphify_load_summary,
            graphify::graphify_enrich_payload,
            create_directory_recursive,
            execute_command,
        ])
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                let handle = _app.handle();
                if let Ok(m) = menu::build_menu(handle) {
                    let _ = _app.set_menu(m);
                    let app_for_event = handle.clone();
                    _app.on_menu_event(move |_, event| {
                        menu::handle_menu_event(&app_for_event, event.id().as_ref());
                    });
                }
                // Dock right-click → "New Window". macOS-only: there is no
                // Tauri v2 dock/jumplist API, so this splices `applicationDockMenu:`
                // onto tao's app-delegate class via objc2 (see src/dock.rs).
                //
                // Windows note: a Windows taskbar jumplist "New Window" entry is
                // NOT implemented — Tauri v2 exposes no jumplist API without a
                // custom plugin. Launching the .exe again already opens an
                // independent window (this app registers no single-instance
                // plugin), which is the intended multi-window behavior there.
                dock::install_dock_menu(handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                // Per-window terminal cleanup
                if let Some(state) = window.try_state::<terminal::TerminalState>() {
                    state.drop_window(&label);
                }
                // Per-window file watcher cleanup
                if let Some(state) = window.try_state::<file_scanner::FileWatcherState>() {
                    state.drop_window(&label);
                }
                // Per-window LSP cleanup
                if let Some(state) = window.try_state::<lsp::LspState>() {
                    let inner = state.0.clone();
                    let label_clone = label.clone();
                    tauri::async_runtime::spawn(async move {
                        let dummy = lsp::LspState(inner);
                        dummy.drop_window(&label_clone).await;
                    });
                }
                // Per-window DAP session cleanup
                if let Some(state) = window.try_state::<dap::DapState>() {
                    let inner = state.0.clone();
                    let label_clone = label.clone();
                    tauri::async_runtime::spawn(async move {
                        let dummy = dap::DapState(inner);
                        dummy.drop_window(&label_clone).await;
                    });
                }
                // Per-window file index cleanup
                if let Some(state) = window.try_state::<file_index::FileIndexState>() {
                    state.drop_window(&label);
                }
                // Per-window content search cursor cleanup
                if let Some(state) = window.try_state::<search::ContentSearchState>() {
                    state.drop_window(&label);
                }
                // Per-window Unity IPC bridge cleanup
                if let Some(state) = window.try_state::<unity_ipc::UnityIpcState>() {
                    let inner = state.0.clone();
                    let label_clone = label.clone();
                    tauri::async_runtime::spawn(async move {
                        let dummy = unity_ipc::UnityIpcState(inner);
                        dummy.drop_window(&label_clone).await;
                    });
                }

                // Last-window-closed behavior:
                //  - macOS: keep app running with no windows visible
                //  - Win/Linux: quit when no windows remain
                #[cfg(not(target_os = "macos"))]
                {
                    let app = window.app_handle().clone();
                    let remaining = tauri::Manager::webview_windows(&app).len();
                    if remaining == 0 {
                        app.exit(0);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // `RunEvent::Reopen` (dock-icon click with no visible windows) is a
            // macOS-only variant — it isn't part of the enum on Windows/Linux.
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Reopen { has_visible_windows, .. } = &event {
                    if !has_visible_windows {
                        open_or_focus_welcome(app_handle);
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (&app_handle, &event);
            }
        });
}

#[cfg(test)]
mod path_exists_tests {
    use super::path_exists;

    #[test]
    fn true_for_a_real_file_false_for_a_missing_one() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("foo.ts");
        std::fs::write(&file, "export {};").unwrap();

        assert!(path_exists(file.to_string_lossy().to_string()));
        assert!(!path_exists(tmp.path().join("missing.ts").to_string_lossy().to_string()));
    }

    #[test]
    fn false_for_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!path_exists(tmp.path().to_string_lossy().to_string()));
    }
}

#[cfg(test)]
mod read_directory_ignore_tests {
    use super::{read_directory, FileEntry};
    use std::process::Command;

    /// Setup git commands isolate host gitconfig, mirroring git.rs's test
    /// modules, so signing/hooks/aliases can't break these tests.
    fn run_git(path: &str, args: &[&str]) {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = Command::new("git")
            .args(&full)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn entry<'a>(entries: &'a [FileEntry], name: &str) -> &'a FileEntry {
        entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("entry {name} missing from listing"))
    }

    #[test]
    fn gitignored_entries_are_marked() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_str().unwrap().to_string();
        run_git(&root, &["init", "-q"]);
        std::fs::write(tmp.path().join(".gitignore"), "ignored-dir/\n*.log\n").unwrap();
        std::fs::write(tmp.path().join("kept.txt"), "k").unwrap();
        std::fs::write(tmp.path().join("a.log"), "l").unwrap();
        std::fs::create_dir(tmp.path().join("ignored-dir")).unwrap();

        let entries = read_directory(root).unwrap();
        assert!(entry(&entries, "a.log").ignored);
        assert!(entry(&entries, "ignored-dir").ignored);
        assert!(!entry(&entries, "kept.txt").ignored);
        assert!(!entry(&entries, ".gitignore").ignored);
    }

    #[test]
    fn non_repo_directory_marks_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.log"), "l").unwrap();
        std::fs::write(tmp.path().join("kept.txt"), "k").unwrap();

        let entries = read_directory(tmp.path().to_str().unwrap().to_string()).unwrap();
        assert!(entries.iter().all(|e| !e.ignored));
    }

    #[test]
    fn nested_gitignore_is_honored_for_subdirectory_listings() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_str().unwrap().to_string();
        run_git(&root, &["init", "-q"]);
        let sub = tmp.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join(".gitignore"), "local.txt\n").unwrap();
        std::fs::write(sub.join("local.txt"), "x").unwrap();
        std::fs::write(sub.join("other.txt"), "y").unwrap();

        let entries = read_directory(sub.to_str().unwrap().to_string()).unwrap();
        assert!(entry(&entries, "local.txt").ignored);
        assert!(!entry(&entries, "other.txt").ignored);
    }

    /// Invoke-payload contract pin: the frontend consumes these exact field
    /// names (src/types/index.ts FileEntry).
    #[test]
    fn file_entry_serde_contract() {
        let e = FileEntry {
            name: "a.ts".into(),
            path: "/ws/a.ts".into(),
            is_dir: false,
            children: None,
            ignored: true,
        };
        let v = serde_json::to_value(&e).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.get("name").unwrap(), "a.ts");
        assert_eq!(obj.get("path").unwrap(), "/ws/a.ts");
        assert_eq!(obj.get("is_dir").unwrap(), false);
        assert_eq!(obj.get("ignored").unwrap(), true);
        assert!(!obj.contains_key("children"), "None children are skipped");
    }
}

#[cfg(test)]
mod dir_exists_tests {
    use super::dir_exists;

    #[test]
    fn true_for_a_real_directory_false_for_a_missing_one() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(dir_exists(tmp.path().to_string_lossy().to_string()));
        assert!(!dir_exists(tmp.path().join("missing-project").to_string_lossy().to_string()));
    }

    #[test]
    fn false_for_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("foo.ts");
        std::fs::write(&file, "export {};").unwrap();
        assert!(!dir_exists(file.to_string_lossy().to_string()));
    }
}

#[cfg(test)]
mod canonicalize_path_tests {
    use super::canonicalize_path;

    // Unix-only: creating a symlink on Windows needs elevated privileges /
    // dev mode, which isn't guaranteed in CI. The fallback test below still
    // covers Windows.
    #[cfg(unix)]
    #[test]
    fn canonicalizes_a_symlink_to_its_real_target() {
        let tmp = tempfile::tempdir().unwrap();
        let real_dir = tmp.path().join("real-project");
        std::fs::create_dir(&real_dir).unwrap();
        let link = tmp.path().join("link-project");
        std::os::unix::fs::symlink(&real_dir, &link).unwrap();

        let expected = std::fs::canonicalize(&real_dir)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(canonicalize_path(link.to_string_lossy().into_owned()), expected);
    }

    #[test]
    fn falls_back_to_the_input_path_unchanged_when_the_path_does_not_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp
            .path()
            .join("does-not-exist")
            .to_string_lossy()
            .into_owned();
        assert_eq!(canonicalize_path(missing.clone()), missing);
    }
}
