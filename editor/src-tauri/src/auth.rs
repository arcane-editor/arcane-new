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
pub fn config_dir_name(identifier: &str) -> &'static str {
    if identifier.ends_with(".dev") {
        ".unityide-dev"
    } else {
        ".unityide"
    }
}

/// Absolute per-app config dir: ~/.unityide (prod) or ~/.unityide-dev (dev build).
pub fn config_home_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(config_dir_name(&app.config().identifier)))
}

fn auth_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(config_home_dir(app)?.join("auth.json"))
}

/// Read the stored auth token from the per-app config dir (see `config_home_dir`)
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

/// Write auth token to the per-app config dir (see `config_home_dir`) with 0600 permissions
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
    // chmod; on Windows it lives under the user profile's per-app config dir
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

/// Absolute path of the per-app config dir (~/.unityide or ~/.unityide-dev),
/// for frontend code that persists files (e.g. AI session history).
#[tauri::command]
pub fn get_config_home_dir(app: tauri::AppHandle) -> Result<String, String> {
    config_home_dir(&app).map(|p| p.to_string_lossy().to_string())
}

/// First deep-link scheme from the MERGED tauri config
/// (`plugins.deep-link.desktop.schemes[0]`). Reading the runtime config —
/// rather than hardcoding — makes the dev overlay (`tauri.dev.conf.json`,
/// schemes ["arcane-dev"]) the single source of truth: a dev build
/// automatically reports "arcane-dev" with zero extra plumbing.
fn scheme_from_plugin_config(deep_link: Option<&serde_json::Value>) -> String {
    deep_link
        .and_then(|v| v.get("desktop"))
        .and_then(|d| d.get("schemes"))
        .and_then(|s| s.get(0))
        .and_then(|s| s.as_str())
        .unwrap_or("arcane")
        .to_string()
}

/// Deep-link scheme of the running app: "arcane" (prod) or "arcane-dev"
/// (dev overlay build). Also used by the single-instance callback in lib.rs
/// to tell "re-launch with a deep link" from "plain re-launch".
pub fn deep_link_scheme(app: &tauri::AppHandle) -> String {
    scheme_from_plugin_config(app.config().plugins.0.get("deep-link"))
}

// ── Release-channel consistency ─────────────────────────────────────────────
//
// "Dev-ness" is encoded in two independent places: the Vite mode picks the API
// endpoints, and the Tauri config file picks the bundle identifier (and with it
// the config dir and the deep-link scheme). A plain `tauri dev` used to take the
// dev endpoints with the PRODUCTION identifier, so a token minted against the
// dev API was written into ~/.unityide — where the real app then found it and
// presented it to the production API. Nothing surfaced that; the two halves just
// disagreed, silently.

/// Production endpoint. The only API URL that belongs to the prod channel.
const PROD_API_URL: &str = "https://api.arcaneai.org";

/// Channel implied by the bundle identifier — the same signal `config_dir_name`
/// keys the config dir off.
pub fn channel_for_identifier(identifier: &str) -> &'static str {
    if identifier.ends_with(".dev") {
        "dev"
    } else {
        "prod"
    }
}

/// Channel implied by the API endpoint the frontend was built against. Anything
/// that is not production — the dev API, a staging host, a local `wrangler dev`
/// — is a non-production build and must not share the production config dir.
pub fn channel_for_api_url(api_url: &str) -> &'static str {
    if api_url.trim().trim_end_matches('/') == PROD_API_URL {
        "prod"
    } else {
        "dev"
    }
}

/// Fail loudly when the two halves disagree, rather than quietly writing a
/// dev-API token into the production app's config dir. Called once at boot.
#[tauri::command]
pub fn auth_check_channel(app: tauri::AppHandle, api_url: String) -> Result<(), String> {
    let identifier = &app.config().identifier;
    let by_id = channel_for_identifier(identifier);
    let by_url = channel_for_api_url(&api_url);
    if by_id == by_url {
        return Ok(());
    }
    let message = format!(
        "Release channel mismatch: the bundle identifier `{}` is the {} channel \
         (config dir `{}`), but the frontend targets `{}`, which is the {} channel. \
         Credentials would be written to the wrong app. \
         Run the dev app with `bun run tauri:dev-app`, or build with the matching config.",
        identifier,
        by_id,
        config_dir_name(identifier),
        api_url,
        by_url,
    );
    eprintln!("[Arcane] {}", message);
    Err(message)
}

/// The scheme the frontend passes to the website's /auth page (`scheme=` param)
/// so the browser redirects back to THIS build of the app.
#[tauri::command]
pub fn auth_deep_link_scheme(app: tauri::AppHandle) -> String {
    deep_link_scheme(&app)
}

#[cfg(test)]
mod tests {
    use super::{
        config_dir_name, channel_for_api_url, channel_for_identifier, scheme_from_plugin_config,
        PROD_API_URL,
    };
    use serde_json::json;

    #[test]
    fn channel_is_derived_consistently_from_both_halves() {
        assert_eq!(channel_for_identifier("com.inno.editor"), "prod");
        assert_eq!(channel_for_identifier("com.inno.editor.dev"), "dev");

        assert_eq!(channel_for_api_url(PROD_API_URL), "prod");
        assert_eq!(channel_for_api_url("https://api.arcaneai.org/"), "prod");
        // Everything else is non-production and must not touch ~/.unityide.
        assert_eq!(channel_for_api_url("https://api-dev.arcaneai.org"), "dev");
        assert_eq!(channel_for_api_url("http://localhost:8787"), "dev");
        assert_eq!(channel_for_api_url(""), "dev");
    }

    /// The two halves of "dev-ness" live in different files and are wired up by
    /// different tooling, so nothing but a test stops them drifting apart. This
    /// is what caught `tauri dev` shipping dev endpoints under the production
    /// identifier — i.e. writing dev tokens into the real app's config dir.
    #[test]
    fn the_dev_build_config_and_the_dev_env_file_agree_on_the_channel() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));

        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("tauri.dev.conf.json")).unwrap(),
        )
        .unwrap();
        let identifier = conf["identifier"].as_str().unwrap();
        assert_eq!(
            channel_for_identifier(identifier),
            "dev",
            "tauri.dev.conf.json must carry a `.dev` identifier, or the dev build \
             shares ~/.unityide with production"
        );

        let env_file = std::fs::read_to_string(root.join("../.env.development")).unwrap();
        let api_url = env_file
            .lines()
            .find_map(|l| l.trim().strip_prefix("VITE_API_URL="))
            .expect("VITE_API_URL must be set in .env.development");
        assert_eq!(
            channel_for_api_url(api_url),
            "dev",
            ".env.development must point at a non-production API"
        );

        // And the deep-link scheme has to follow the identifier, or the browser
        // sign-in callback lands in the other build.
        let scheme = scheme_from_plugin_config(conf["plugins"].get("deep-link"));
        assert_eq!(scheme, "arcane-dev");
    }

    #[test]
    fn prod_identifier_uses_arcane() {
        assert_eq!(config_dir_name("com.inno.editor"), ".unityide");
    }

    #[test]
    fn dev_identifier_uses_arcane_dev() {
        assert_eq!(config_dir_name("com.inno.editor.dev"), ".unityide-dev");
    }

    #[test]
    fn scheme_read_from_merged_plugin_config() {
        let v = json!({ "desktop": { "schemes": ["arcane-dev"] } });
        assert_eq!(scheme_from_plugin_config(Some(&v)), "arcane-dev");
    }

    #[test]
    fn scheme_falls_back_to_arcane() {
        assert_eq!(scheme_from_plugin_config(None), "arcane");
        let empty = json!({ "desktop": { "schemes": [] } });
        assert_eq!(scheme_from_plugin_config(Some(&empty)), "arcane");
    }
}
