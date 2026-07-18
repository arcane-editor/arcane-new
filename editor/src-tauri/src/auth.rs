use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthToken {
    pub token: String,
    pub email: String,
}

/// Directory NAME for per-app config under $HOME, keyed off the bundle
/// identifier so the side-by-side dev build (com.inno.editor.dev) never
/// shares tokens/sessions/graphs with the prod app.
pub fn arcane_dir_name(identifier: &str) -> &'static str {
    if identifier.ends_with(".dev") {
        ".arcane-dev"
    } else {
        ".arcane"
    }
}

/// Absolute per-app config dir: ~/.arcane (prod) or ~/.arcane-dev (dev build).
pub fn arcane_home_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(arcane_dir_name(&app.config().identifier)))
}

fn auth_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(arcane_home_dir(app)?.join("auth.json"))
}

/// Read the stored auth token from the per-app config dir (see `arcane_home_dir`)
#[tauri::command]
pub fn auth_read_token(app: tauri::AppHandle) -> Result<Option<AuthToken>, String> {
    let path = auth_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let token: AuthToken = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(token))
}

/// Write auth token to the per-app config dir (see `arcane_home_dir`) with 0600 permissions
#[tauri::command]
pub fn auth_write_token(app: tauri::AppHandle, token: String, email: String) -> Result<(), String> {
    let path = auth_file_path(&app)?;

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let auth = AuthToken { token, email };
    let content = serde_json::to_string_pretty(&auth).map_err(|e| e.to_string())?;

    fs::write(&path, &content).map_err(|e| e.to_string())?;

    // Restrict the token file to the owner. On Unix that's an explicit 0600
    // chmod; on Windows it lives under the user profile (%USERPROFILE%\.arcane)
    // and inherits the user's ACLs, so no extra step is needed.
    #[cfg(unix)]
    {
        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Delete the auth token file
#[tauri::command]
pub fn auth_delete_token(app: tauri::AppHandle) -> Result<(), String> {
    let path = auth_file_path(&app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Absolute path of the per-app config dir (~/.arcane or ~/.arcane-dev),
/// for frontend code that persists files (e.g. AI session history).
#[tauri::command]
pub fn get_arcane_home_dir(app: tauri::AppHandle) -> Result<String, String> {
    arcane_home_dir(&app).map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::arcane_dir_name;

    #[test]
    fn prod_identifier_uses_arcane() {
        assert_eq!(arcane_dir_name("com.inno.editor"), ".arcane");
    }

    #[test]
    fn dev_identifier_uses_arcane_dev() {
        assert_eq!(arcane_dir_name("com.inno.editor.dev"), ".arcane-dev");
    }
}
