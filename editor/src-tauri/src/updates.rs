//! Background update watcher.
//!
//! Scheduling lives here rather than in the webview because each Tauri window
//! runs its own JS context: a frontend timer would fire once per open window
//! and could download the same update several times over. There is one Rust
//! process, so once-per-app falls out for free.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Event the frontend listens on once an update is staged.
pub const UPDATE_READY_EVENT: &str = "arcane-update-ready";

/// Delay before the first check. Startup is already contended — Monaco, the
/// LSP sidecars and the file index all boot at once — so the check waits
/// rather than competing for bandwidth with what the user is waiting for.
const INITIAL_DELAY: Duration = Duration::from_secs(60);

/// Gap between checks in a long-lived session.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize)]
pub struct UpdateReady {
    pub version: String,
    /// True when the new version is already in place and only a relaunch is
    /// outstanding (macOS). False when the install still has to run and will
    /// terminate the app to do it (Windows).
    pub installed: bool,
}

/// Whether background installs are enabled, per the persisted settings.
///
/// Defaults to true for every shape it cannot read. A corrupt settings file
/// switching auto-update off silently is the worse failure: nothing would
/// ever tell the user, and they would sit on a stale build indefinitely.
pub fn auto_install_from_settings(settings: &Value) -> bool {
    settings
        .get("updates.autoInstall")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn auto_install_enabled() -> bool {
    crate::settings::read_settings()
        .map(|v| auto_install_from_settings(&v))
        .unwrap_or(true)
}

/// Start the watcher. Non-blocking; safe to call once from `setup`.
pub fn spawn_watcher(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            if check_once(&app).await {
                // An update is staged. Checking again would re-find it — the
                // running process still reports the OLD version until it
                // restarts — and on macOS would re-download and re-install the
                // same build on every tick, forever. Stop instead.
                break;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// One check. Returns true when an update is staged and the watcher should stop.
///
/// Every failure path is swallowed after a log line: this runs unprompted in
/// the background, and there is nothing a user can do about a transient
/// network error they never asked to hear about.
async fn check_once(app: &AppHandle) -> bool {
    if !auto_install_enabled() {
        return false;
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updates] updater unavailable: {e}");
            return false;
        }
    };

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return false,
        Err(e) => {
            eprintln!("[updates] check failed: {e}");
            return false;
        }
    };

    let version = update.version.clone();

    if cfg!(target_os = "windows") {
        // install() launches the NSIS installer, which terminates this
        // process — so downloading now would mean holding the installer
        // resident until the user happens to restart. Announce only; the
        // download runs from `updates_apply_and_restart`.
        let _ = app.emit(UPDATE_READY_EVENT, UpdateReady { version, installed: false });
        return true;
    }

    // macOS: replacing the .app under a running process is safe, and the new
    // version is simply what launches next time.
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            let _ = app.emit(UPDATE_READY_EVENT, UpdateReady { version, installed: true });
            true
        }
        Err(e) => {
            eprintln!("[updates] install failed: {e}");
            false
        }
    }
}

/// Finish the update the user was told about.
///
/// On macOS the new bundle is already in place, so this is just a relaunch.
/// On Windows the download happens here and the NSIS installer replaces us.
#[tauri::command]
pub async fn updates_apply_and_restart(app: AppHandle) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        let update = app
            .updater()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "that update is no longer available".to_string())?;
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        // Not reached in practice — the installer terminates this process.
        Ok(())
    } else {
        app.restart();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_on_when_the_setting_is_absent() {
        assert!(auto_install_from_settings(&json!({})));
    }

    #[test]
    fn respects_an_explicit_opt_out() {
        assert!(!auto_install_from_settings(&json!({"updates.autoInstall": false})));
    }

    #[test]
    fn respects_an_explicit_opt_in() {
        assert!(auto_install_from_settings(&json!({"updates.autoInstall": true})));
    }

    #[test]
    fn defaults_on_for_a_non_boolean_value() {
        // A corrupt or half-written settings file must not silently switch
        // auto-update off: nothing would ever surface that it had happened,
        // and the user would sit on a stale build believing otherwise.
        assert!(auto_install_from_settings(&json!({"updates.autoInstall": "yes"})));
        assert!(auto_install_from_settings(&json!({"updates.autoInstall": null})));
    }
}
