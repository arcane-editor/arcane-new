//! Which project window has which workspace open.
//!
//! Rust needs this to answer one question the frontend cannot be asked in time:
//! when Unity re-launches the app with a `--goto`, *which* existing window
//! should receive it and be raised? The single-instance callback runs in the
//! main process with only argv in hand, and it has to decide before any window
//! replies — otherwise the fallback (open/focus the 720x480 welcome window)
//! fires first and lands on top of the project window that is opening the file.
//!
//! It cannot be derived. A project window's label is `hashLabel(path)` from
//! `utils/window-label.ts`, and the Rust `hash_workspace` that used to mirror it
//! was deliberately retired (see `unity_ipc.rs`) precisely so the two sides
//! could not drift. So each window registers itself once its workspace is
//! actually open, and this map is read back here.
//!
//! Stale entries are harmless: a lookup only returns a label that still names a
//! live window, and labels are deterministic per project, so a re-open of the
//! same project overwrites its own entry rather than adding one.

use std::collections::HashMap;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::sync_util::lock_recover;

#[derive(Default)]
pub struct WindowWorkspaces(pub std::sync::Mutex<HashMap<String, String>>);

/// Record that this window has `workspace_path` open.
///
/// Called from the frontend after `setWorkspace` resolves — not before. A
/// window that is still booting cannot serve a goto, and registering early
/// would route one to a window that then fails to open the project.
#[tauri::command]
pub fn register_window_workspace(
    state: tauri::State<'_, WindowWorkspaces>,
    window: tauri::Window,
    workspace_path: String,
) {
    let mut map = lock_recover(&state.0);
    map.insert(window.label().to_string(), workspace_path);
}

/// The live window that has `project` open, if any.
pub fn find_window_for_project(app: &AppHandle, project: &str) -> Option<WebviewWindow> {
    let state = app.state::<WindowWorkspaces>();
    let labels: Vec<(String, String)> = {
        let map = lock_recover(&state.0);
        map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    };
    labels
        .into_iter()
        .filter(|(_, path)| crate::cli::same_path(path, project))
        .find_map(|(label, _)| app.get_webview_window(&label))
}

/// Bring a window to the front.
///
/// The order matters and is not interchangeable: tao's macOS `set_focus`
/// returns early when the window is miniaturized or not visible, so calling it
/// alone on a minimized window silently does nothing at all. Unminimize and
/// show first, every time.
pub fn raise(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Raise a window by label, if it still exists.
pub fn raise_by_label(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        raise(&w);
    }
}

/// Bring the calling window to the front.
///
/// A single command rather than three JS calls (`unminimize`/`show`/`setFocus`)
/// so the ordering above is enforced in one place instead of being re-derived
/// at every call site.
#[tauri::command]
pub fn raise_current_window(window: WebviewWindow) {
    raise(&window);
}
