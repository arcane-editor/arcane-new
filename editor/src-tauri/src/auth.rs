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

fn auth_file_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(".arcane").join("auth.json"))
}

/// Read the stored auth token from ~/.arcane/auth.json
#[tauri::command]
pub fn auth_read_token() -> Result<Option<AuthToken>, String> {
    let path = auth_file_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let token: AuthToken = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(token))
}

/// Write auth token to ~/.arcane/auth.json with 0600 permissions
#[tauri::command]
pub fn auth_write_token(token: String, email: String) -> Result<(), String> {
    let path = auth_file_path()?;

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
pub fn auth_delete_token() -> Result<(), String> {
    let path = auth_file_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
