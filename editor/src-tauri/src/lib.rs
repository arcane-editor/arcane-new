mod git;
mod lsp;
mod terminal;
mod settings;
mod search;
mod file_scanner;
mod unity;
mod asmdef;
mod unity_yaml;
mod unity_index;
mod unity_diff;
mod unity_tests;
mod unity_ipc;
mod dap;
mod auth;
mod claude;
mod graphify;
#[cfg(target_os = "macos")]
mod menu;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
}

#[tauri::command]
fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;

    let skip_dirs = ["node_modules", "target", ".git", "dist", "build"];

    let mut result: Vec<FileEntry> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files
            if name.starts_with('.') {
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
            })
        })
        .collect();

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

#[tauri::command]
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

#[tauri::command]
fn scan_all_files(workspace_path: String) -> Result<Vec<String>, String> {
    let skip_dirs: &[&str] = &["node_modules", "target", ".git", "dist", "build", ".next", ".nuxt"];
    let files: Vec<String> = WalkDir::new(&workspace_path)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_dir() {
                if name.starts_with('.') { return false; }
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

#[tauri::command]
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
#[tauri::command]
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .manage(lsp::LspState::new())
        .manage(terminal::TerminalState::new())
        .manage(claude::ClaudeState::new())
        .manage(Mutex::new(file_scanner::FileWatcherState::new()))
        .manage(unity_ipc::UnityIpcState::new())
        .manage(dap::DapState::new())
        .invoke_handler(tauri::generate_handler![
            read_directory,
            read_file,
            write_file,
            scan_workspace_files,
            scan_all_files,
            create_file,
            create_directory,
            rename_path,
            delete_path,
            read_files_bulk,
            scan_node_modules_types,
            settings::read_settings,
            settings::write_settings,
            search::search_in_files,
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
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::acp_terminal_create,
            terminal::acp_terminal_output,
            terminal::acp_terminal_wait,
            terminal::acp_terminal_kill,
            terminal::acp_terminal_release,
            file_scanner::scan_all_files_v2,
            file_scanner::fuzzy_search_files,
            file_scanner::start_file_watcher,
            file_scanner::stop_file_watcher,
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
            claude::claude_start,
            claude::claude_send,
            claude::claude_stop,
            claude::claude_check_install,
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
                // Per-window LSP cleanup
                if let Some(state) = window.try_state::<lsp::LspState>() {
                    let inner = state.0.clone();
                    let label_clone = label.clone();
                    tauri::async_runtime::spawn(async move {
                        let dummy = lsp::LspState(inner);
                        dummy.drop_window(&label_clone).await;
                    });
                }
                // Per-window Claude bridge cleanup
                if let Some(state) = window.try_state::<claude::ClaudeState>() {
                    let inner = state.0.clone();
                    let label_clone = label.clone();
                    tauri::async_runtime::spawn(async move {
                        let dummy = claude::ClaudeState(inner);
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
                        use tauri::Manager;
                        if let Some(w) = app_handle.webview_windows().get("welcome") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        } else {
                            let app = app_handle.clone();
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
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (&app_handle, &event);
            }
        });
}
