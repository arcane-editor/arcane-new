use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthToken {
    pub token: String,
    pub email: String,
}

/// Directory NAME for per-app config under $HOME, keyed off the bundle
/// identifier so the side-by-side dev build (app.unityide.desktop.dev) never
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

/// The same directory's name before the rename, keyed off the identifier the
/// same way `config_dir_name` is, so dev and prod migrate independently.
pub fn legacy_config_dir_name(identifier: &str) -> &'static str {
    if identifier.ends_with(".dev") {
        ".arcane-dev"
    } else {
        ".arcane"
    }
}

/// Written into the new dir once the copy has run.
///
/// A marker rather than "is the destination empty?": the destination gets
/// created by the first `auth_write_token`, so an emptiness check would re-run
/// later and resurrect a token the user had deliberately signed out of.
const MIGRATION_MARKER: &str = ".migrated-from-arcane";

/// Copy `src` over `dst`, never replacing a file that already exists.
///
/// Skip-existing rather than overwrite (which is what `fs_copy`'s helper does,
/// deliberately, for a different job): this runs at startup, and if it ever ran
/// twice — or ran after the user had already signed in to the new app — the
/// newer file is the correct one.
fn copy_dir_skip_existing(src: &Path, dst: &Path) -> std::io::Result<u32> {
    fs::create_dir_all(dst)?;
    let mut copied = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copied += copy_dir_skip_existing(&entry.path(), &target)?;
        } else if !target.exists() {
            fs::copy(entry.path(), &target)?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// One-time carry-forward of `~/.arcane` -> `~/.unityide`.
///
/// The bundle identifier changed with the rename, so the OS treats this as a
/// different app: the webview's localStorage, the tauri-store files and the
/// window geometry all start empty and there is nothing to be done about that.
/// This directory is the exception — it is keyed off a name we choose, not one
/// the OS derives — and it holds everything expensive: the auth token, every AI
/// session transcript, checkpoints, edit reviews, `mcp-servers.json` and the
/// cached project graphs.
///
/// The token stays VALID after the move. D1 and `JWT_ISSUER` are unchanged, and
/// the middleware validates `iss` against that constant — only the hostname the
/// token is presented to has moved, and it is the same worker behind it. So the
/// difference this makes is "nobody notices the rename" instead of "everyone
/// re-logs-in and loses their history", on what is now the only upgrade path.
///
/// Copies rather than moves: the old app may still be installed, and possibly
/// running. Deleting `~/.arcane` is the user's call.
pub fn migrate_legacy_config_dir(app: &tauri::AppHandle) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let old_dir = home.join(legacy_config_dir_name(&app.config().identifier));
    migrate_config_dir(&old_dir, &config_home_dir(app)?).map(|_| ())
}

/// The migration itself, over plain paths so it is testable without a Tauri
/// runtime. Returns how many files were copied.
fn migrate_config_dir(old_dir: &Path, new_dir: &Path) -> Result<u32, String> {
    if new_dir.join(MIGRATION_MARKER).exists() {
        return Ok(0);
    }

    fs::create_dir_all(new_dir).map_err(|e| e.to_string())?;

    let mut copied = 0;
    if old_dir.is_dir() {
        copied = copy_dir_skip_existing(old_dir, new_dir).map_err(|e| e.to_string())?;
        // `fs::copy` carries permissions on Unix, but the source may predate the
        // 0600 tightening — and this is the one file where a loose mode matters.
        #[cfg(unix)]
        {
            let token = new_dir.join("auth.json");
            if token.exists() {
                if let Ok(meta) = fs::metadata(&token) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o600);
                    let _ = fs::set_permissions(&token, perms);
                }
            }
        }
        eprintln!(
            "[UnityIDE] migrated {copied} file(s) from {} to {}",
            old_dir.display(),
            new_dir.display()
        );
    }

    fs::write(new_dir.join(MIGRATION_MARKER), "").map_err(|e| e.to_string())?;
    Ok(copied)
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
/// schemes ["unityide-dev"]) the single source of truth: a dev build
/// automatically reports "unityide-dev" with zero extra plumbing.
fn scheme_from_plugin_config(deep_link: Option<&serde_json::Value>) -> String {
    deep_link
        .and_then(|v| v.get("desktop"))
        .and_then(|d| d.get("schemes"))
        .and_then(|s| s.get(0))
        .and_then(|s| s.as_str())
        .unwrap_or("unityide")
        .to_string()
}

/// Deep-link scheme of the running app: "unityide" (prod) or "unityide-dev"
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
const PROD_API_URL: &str = "https://api.unityide.app";

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
    eprintln!("[UnityIDE] {}", message);
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
        assert_eq!(channel_for_identifier("app.unityide.desktop"), "prod");
        assert_eq!(channel_for_identifier("app.unityide.desktop.dev"), "dev");

        assert_eq!(channel_for_api_url(PROD_API_URL), "prod");
        assert_eq!(channel_for_api_url("https://api.unityide.app/"), "prod");
        // Everything else is non-production and must not touch ~/.unityide.
        assert_eq!(channel_for_api_url("https://api-dev.unityide.app"), "dev");
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
        assert_eq!(scheme, "unityide-dev");
    }

    #[test]
    fn prod_identifier_uses_the_base_config_dir() {
        assert_eq!(config_dir_name("app.unityide.desktop"), ".unityide");
    }

    #[test]
    fn dev_identifier_uses_the_dev_config_dir() {
        assert_eq!(config_dir_name("app.unityide.desktop.dev"), ".unityide-dev");
    }

    #[test]
    fn scheme_read_from_merged_plugin_config() {
        let v = json!({ "desktop": { "schemes": ["unityide-dev"] } });
        assert_eq!(scheme_from_plugin_config(Some(&v)), "unityide-dev");
    }

    #[test]
    fn scheme_falls_back_to_the_prod_scheme() {
        assert_eq!(scheme_from_plugin_config(None), "unityide");
        let empty = json!({ "desktop": { "schemes": [] } });
        assert_eq!(scheme_from_plugin_config(Some(&empty)), "unityide");
    }
}

/// The one-time carry-forward of the pre-rename config dir.
///
/// This directory is the only user state that survives the identifier change —
/// localStorage, the tauri-store files and window geometry are all keyed off
/// the bundle id and start empty — so it holds the auth token, every AI session
/// transcript, checkpoints and the cached project graphs. Getting it wrong is
/// not a cosmetic failure.
#[cfg(test)]
mod migration_tests {
    use super::{legacy_config_dir_name, migrate_config_dir, MIGRATION_MARKER};
    use std::fs;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "unityide-migrate-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed_old(root: &PathBuf) -> PathBuf {
        let old = root.join(".arcane");
        fs::create_dir_all(old.join("sessions")).unwrap();
        fs::write(old.join("auth.json"), r#"{"token":"t","email":"e"}"#).unwrap();
        fs::write(old.join("sessions/a.json"), "{}").unwrap();
        fs::write(old.join("mcp-servers.json"), "{}").unwrap();
        old
    }

    #[test]
    fn copies_the_old_tree_forward_and_marks_it_done() {
        let root = tmp("copies");
        let old = seed_old(&root);
        let new = root.join(".unityide");

        let copied = migrate_config_dir(&old, &new).expect("migrate ok");

        assert_eq!(copied, 3, "auth.json, sessions/a.json and mcp-servers.json");
        assert!(new.join("auth.json").exists(), "the token must come across — that is the point");
        assert!(new.join("sessions/a.json").exists(), "nested dirs must be copied too");
        assert!(new.join(MIGRATION_MARKER).exists());
        assert!(old.join("auth.json").exists(), "copy, not move: the old app may still run");
    }

    /// The marker, not "is the destination empty", is what stops a re-run. The
    /// destination is created by the first token write, so an emptiness check
    /// would fire again later and resurrect a token the user had signed out of.
    #[test]
    fn does_not_run_twice() {
        let root = tmp("twice");
        let old = seed_old(&root);
        let new = root.join(".unityide");

        migrate_config_dir(&old, &new).unwrap();
        fs::remove_file(new.join("auth.json")).unwrap(); // user signs out

        let copied = migrate_config_dir(&old, &new).expect("second run ok");
        assert_eq!(copied, 0);
        assert!(!new.join("auth.json").exists(), "a signed-out user must stay signed out");
    }

    #[test]
    fn never_overwrites_a_file_already_in_the_new_dir() {
        let root = tmp("noclobber");
        let old = seed_old(&root);
        let new = root.join(".unityide");
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("auth.json"), "NEWER").unwrap();

        migrate_config_dir(&old, &new).unwrap();

        assert_eq!(fs::read_to_string(new.join("auth.json")).unwrap(), "NEWER");
    }

    #[test]
    fn succeeds_and_still_marks_when_there_is_nothing_to_migrate() {
        let root = tmp("absent");
        let new = root.join(".unityide");

        let copied = migrate_config_dir(&root.join(".arcane"), &new).expect("no-op ok");

        assert_eq!(copied, 0);
        assert!(new.join(MIGRATION_MARKER).exists(), "mark it so it is not retried every boot");
    }

    #[cfg(unix)]
    #[test]
    fn the_migrated_token_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmp("perms");
        let old = seed_old(&root);
        // A token written before the 0600 tightening.
        fs::set_permissions(old.join("auth.json"), fs::Permissions::from_mode(0o644)).unwrap();
        let new = root.join(".unityide");

        migrate_config_dir(&old, &new).unwrap();

        let mode = fs::metadata(new.join("auth.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "a world-readable auth token is a real regression");
    }

    /// Same invariant `config_dir_name` upholds, on the legacy side: the dev
    /// build must never migrate the production app's tokens into its own dir.
    #[test]
    fn dev_and_prod_migrate_independently() {
        assert_eq!(legacy_config_dir_name("app.unityide.desktop"), ".arcane");
        assert_eq!(legacy_config_dir_name("app.unityide.desktop.dev"), ".arcane-dev");
        assert_ne!(
            legacy_config_dir_name("app.unityide.desktop"),
            legacy_config_dir_name("app.unityide.desktop.dev")
        );
    }
}
