//! Process-wide preferences, first-run ownership and bounded local editor import.
//! Source files are read-only. The settings file is one atomic envelope so a
//! failed write cannot leave a new keymap paired with the old theme/settings.

mod imports;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const SCHEMA_VERSION: u32 = 1;
const MAX_PREFERENCES_BYTES: u64 = 4 * 1024 * 1024;
static PREFERENCES_LOCK: Mutex<()> = Mutex::new(());
static SETUP_OWNER: Mutex<Option<SetupOwner>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq)]
struct SetupOwner {
    window_label: String,
    lease: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyBinding {
    pub command_id: String,
    pub strokes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReportItem {
    pub category: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub id: String,
    pub editor: String,
    pub label: String,
    pub path: String,
    pub recommended: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keybindings_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub source: ImportSource,
    pub settings: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keymap: Option<String>,
    pub keybindings: Vec<KeyBinding>,
    pub report: Vec<ImportReportItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorExperienceState {
    pub profile: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut_profile: Option<String>,
    pub keymap: String,
    pub setup_status: String,
    pub imported_bindings: Vec<KeyBinding>,
    pub user_bindings: Vec<KeyBinding>,
    pub last_report: Vec<ImportReportItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
}

impl EditorExperienceState {
    fn initial(established: bool) -> Self {
        Self {
            profile: "unityide".into(),
            shortcut_profile: Some("unityide".into()),
            keymap: "intellij".into(),
            setup_status: if established { "invited" } else { "fresh" }.into(),
            imported_bindings: vec![],
            user_bindings: vec![],
            last_report: vec![],
            source_label: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorPreferences {
    pub schema_version: u32,
    pub revision: u64,
    pub settings: Map<String, Value>,
    pub theme_id: String,
    pub experience: EditorExperienceState,
    pub can_restore: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditorPreferencesRequest {
    pub expected_revision: u64,
    pub profile: String,
    #[serde(default)]
    pub shortcut_profile: Option<String>,
    pub keymap: String,
    pub theme_id: Option<String>,
    pub settings_patch: Map<String, Value>,
    pub imported_bindings: Option<Vec<KeyBinding>>,
    pub user_bindings: Option<Vec<KeyBinding>>,
    pub setup_status: String,
    pub report: Option<Vec<ImportReportItem>>,
    pub source_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    settings: Map<String, Value>,
    theme_id: String,
    experience: EditorExperienceState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesFile {
    schema_version: u32,
    revision: u64,
    settings: Map<String, Value>,
    theme_id: String,
    experience: EditorExperienceState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backup: Option<Snapshot>,
}

impl PreferencesFile {
    fn public(&self) -> EditorPreferences {
        EditorPreferences {
            schema_version: self.schema_version,
            revision: self.revision,
            settings: self.settings.clone(),
            theme_id: self.theme_id.clone(),
            experience: self.experience.clone(),
            can_restore: self.backup.is_some(),
        }
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            settings: self.settings.clone(),
            theme_id: self.theme_id.clone(),
            experience: self.experience.clone(),
        }
    }
    fn advance(&mut self) -> Result<(), String> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or("Preferences revision overflow")?;
        Ok(())
    }
}

pub(crate) fn settings_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("editor/settings.json")
}

fn read_file(path: &Path) -> Result<Option<Value>, String> {
    match imports::read_bounded(path, MAX_PREFERENCES_BYTES) {
        Ok(Some(content)) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|_| "Preferences file is malformed; it has been left unchanged".into()),
        Ok(None) => Ok(None),
        Err(_) => Err("Unable to read preferences; the file has been left unchanged".into()),
    }
}

fn theme_id(id: &str) -> Result<String, String> {
    if [
        "unityide-dark",
        "unityide-light",
        "rider-dark",
        "rider-light",
        "dark-plus",
        "light-plus",
        "monokai",
        "dracula",
    ]
    .contains(&id)
    {
        Ok(id.into())
    } else {
        Err("Unknown theme".into())
    }
}

fn validate_experience(experience: &EditorExperienceState) -> Result<(), String> {
    if !["unityide", "rider", "vscode"].contains(&experience.profile.as_str())
        || experience
            .shortcut_profile
            .as_ref()
            .is_some_and(|p| !["unityide", "rider", "vscode"].contains(&p.as_str()))
        || ![
            "intellij",
            "visual-studio",
            "visual-studio-2022",
            "resharper",
            "vscode",
        ]
        .contains(&experience.keymap.as_str())
        || !["fresh", "invited", "complete", "dismissed"]
            .contains(&experience.setup_status.as_str())
    {
        return Err("Invalid editor experience".into());
    }
    validate_bindings(&experience.imported_bindings)?;
    validate_bindings(&experience.user_bindings)?;
    if experience.last_report.len() > 4000
        || experience
            .source_label
            .as_ref()
            .is_some_and(|s| s.len() > 512)
    {
        return Err("Editor experience exceeds its size limit".into());
    }
    Ok(())
}

fn validate_bindings(bindings: &[KeyBinding]) -> Result<(), String> {
    if bindings.len() > 2000 {
        return Err("Too many shortcuts".into());
    }
    for binding in bindings {
        if binding.command_id.is_empty()
            || binding.command_id.len() > 256
            || binding
                .context
                .as_ref()
                .is_some_and(|c| !["global", "editor", "terminal", "input"].contains(&c.as_str()))
            || (binding.strokes.is_empty() && binding.removed != Some(true))
            || binding.strokes.len() > 2
            || binding
                .strokes
                .iter()
                .any(|s| imports::normalize_stroke(s, false).as_deref() != Some(s.as_str()))
            || imports::protected_binding(&binding.strokes)
        {
            return Err("Invalid or protected shortcut".into());
        }
    }
    Ok(())
}

fn load(
    path: &Path,
    legacy_theme: Option<&str>,
    established: bool,
) -> Result<(PreferencesFile, bool), String> {
    let raw = read_file(path)?;
    if let Some(value) = raw.as_ref() {
        if value.get("schemaVersion").is_some() {
            let mut file: PreferencesFile = serde_json::from_value(value.clone())
                .map_err(|_| "Preferences envelope is malformed; it has been left unchanged")?;
            if file.schema_version != SCHEMA_VERSION {
                return Err("Unsupported preferences version; file left unchanged".into());
            }
            theme_id(&file.theme_id)?;
            validate_experience(&file.experience)?;
            file.experience
                .shortcut_profile
                .get_or_insert(file.experience.profile.clone());
            if let Some(backup) = &mut file.backup {
                theme_id(&backup.theme_id)?;
                validate_experience(&backup.experience)?;
                backup
                    .experience
                    .shortcut_profile
                    .get_or_insert(backup.experience.profile.clone());
            }
            return Ok((file, false));
        }
    }
    let settings = match raw {
        Some(Value::Object(settings)) => settings,
        Some(_) => return Err("Preferences must be an object; file left unchanged".into()),
        None => Map::new(),
    };
    // Capture this before the renderer writes its default settings/migrations.
    let established = established || !settings.is_empty() || legacy_theme.is_some();
    Ok((
        PreferencesFile {
            schema_version: SCHEMA_VERSION,
            revision: 0,
            settings,
            theme_id: legacy_theme
                .and_then(|id| theme_id(id).ok())
                .unwrap_or_else(|| "unityide-dark".into()),
            experience: EditorExperienceState::initial(established),
            backup: None,
        },
        true,
    ))
}

fn save(path: &Path, file: &PreferencesFile) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(file).map_err(|_| "Unable to encode preferences")?;
    if bytes.len() as u64 > MAX_PREFERENCES_BYTES {
        return Err("Preferences exceed the size limit".into());
    }
    std::fs::create_dir_all(path.parent().ok_or("Invalid preferences path")?)
        .map_err(|_| "Unable to create preferences directory")?;
    crate::fs_atomic::write_atomic(path, &bytes)
        .map_err(|_| "Unable to save preferences; previous preferences retained".into())
}

fn broadcast(app: &AppHandle, preferences: &EditorPreferences) {
    // Commit success is authoritative even if a window closed before delivery.
    let _ = app.emit("editor-preferences-changed", preferences);
}

#[tauri::command]
pub fn read_editor_preferences(
    legacy_theme_id: Option<String>,
    legacy_established: Option<bool>,
) -> Result<EditorPreferences, String> {
    let _guard = crate::sync_util::lock_recover(&PREFERENCES_LOCK);
    let path = settings_path();
    let (file, migrated) = load(
        &path,
        legacy_theme_id.as_deref(),
        legacy_established.unwrap_or(false),
    )?;
    if migrated {
        save(&path, &file)?;
    }
    Ok(file.public())
}

fn apply_at(
    path: &Path,
    request: ApplyEditorPreferencesRequest,
) -> Result<EditorPreferences, String> {
    let (mut file, _) = load(path, None, false)?;
    if file.revision != request.expected_revision {
        return Err(
            "Preferences changed in another window. Review the latest settings and try again."
                .into(),
        );
    }
    // Dismissing the invitation records only that decision. It must not turn
    // dismissal into an import, clear its report, or replace the import backup.
    if request.setup_status == "dismissed"
        && request.settings_patch.is_empty()
        && request.theme_id.is_none()
        && request.imported_bindings.is_none()
        && request.user_bindings.is_none()
    {
        file.experience.setup_status = "dismissed".into();
        file.advance()?;
        save(path, &file)?;
        return Ok(file.public());
    }
    imports::validate_settings_patch(&request.settings_patch)?;
    let shortcut_profile = request.shortcut_profile.clone().or_else(|| {
        Some(
            file.experience
                .shortcut_profile
                .clone()
                .unwrap_or_else(|| file.experience.profile.clone()),
        )
    });
    let keymap = if request.shortcut_profile.is_some() {
        request.keymap.clone()
    } else {
        file.experience.keymap.clone()
    };
    let configuration_change = request.profile != file.experience.profile
        || shortcut_profile != file.experience.shortcut_profile
        || keymap != file.experience.keymap
        || request.theme_id.is_some()
        || !request.settings_patch.is_empty()
        || request.imported_bindings.is_some();
    let source_label = request.source_label.or_else(|| {
        (request.profile == file.experience.profile)
            .then(|| file.experience.source_label.clone())
            .flatten()
    });
    let experience = EditorExperienceState {
        profile: request.profile,
        shortcut_profile,
        keymap,
        setup_status: request.setup_status,
        imported_bindings: request
            .imported_bindings
            .unwrap_or_else(|| file.experience.imported_bindings.clone()),
        user_bindings: request
            .user_bindings
            .unwrap_or_else(|| file.experience.user_bindings.clone()),
        last_report: request
            .report
            .unwrap_or_else(|| file.experience.last_report.clone()),
        source_label,
    };
    validate_experience(&experience)?;
    let new_theme = request.theme_id.map(|id| theme_id(&id)).transpose()?;
    if configuration_change {
        file.backup = Some(file.snapshot());
    }
    file.settings.extend(request.settings_patch);
    if let Some(theme) = new_theme {
        file.theme_id = theme;
    }
    file.experience = experience;
    file.advance()?;
    save(path, &file)?;
    Ok(file.public())
}

#[tauri::command]
pub fn apply_editor_preferences(
    request: ApplyEditorPreferencesRequest,
    app: AppHandle,
) -> Result<EditorPreferences, String> {
    let _guard = crate::sync_util::lock_recover(&PREFERENCES_LOCK);
    let preferences = apply_at(&settings_path(), request)?;
    broadcast(&app, &preferences);
    Ok(preferences)
}

fn patch_at(
    path: &Path,
    patch: Value,
    theme: Option<&str>,
    expected_revision: Option<u64>,
) -> Result<EditorPreferences, String> {
    let patch = patch
        .as_object()
        .ok_or("Settings patch must be an object")?;
    let (mut file, _) = load(path, None, false)?;
    if expected_revision.is_some_and(|revision| revision != file.revision) {
        return Err(
            "Preferences changed in another window. Review the latest settings and try again."
                .into(),
        );
    }
    file.settings.extend(patch.clone());
    if let Some(theme) = theme {
        file.theme_id = theme_id(theme)?;
    }
    file.advance()?;
    save(path, &file)?;
    Ok(file.public())
}

#[tauri::command]
pub fn patch_editor_settings(
    patch: Value,
    expected_revision: Option<u64>,
    app: AppHandle,
) -> Result<EditorPreferences, String> {
    let _guard = crate::sync_util::lock_recover(&PREFERENCES_LOCK);
    let preferences = patch_at(&settings_path(), patch, None, expected_revision)?;
    broadcast(&app, &preferences);
    Ok(preferences)
}

#[tauri::command]
pub fn patch_editor_theme(theme_id: String, app: AppHandle) -> Result<EditorPreferences, String> {
    let _guard = crate::sync_util::lock_recover(&PREFERENCES_LOCK);
    let preferences = patch_at(
        &settings_path(),
        Value::Object(Map::new()),
        Some(&theme_id),
        None,
    )?;
    broadcast(&app, &preferences);
    Ok(preferences)
}

fn restore_at(path: &Path, expected_revision: u64) -> Result<EditorPreferences, String> {
    let (mut file, _) = load(path, None, false)?;
    if file.revision != expected_revision {
        return Err("Preferences changed in another window. Reload before restoring.".into());
    }
    let backup = file
        .backup
        .take()
        .ok_or("No previous editor preferences to restore")?;
    file.settings = backup.settings;
    file.theme_id = backup.theme_id;
    file.experience = backup.experience;
    if file.experience.setup_status != "dismissed" {
        file.experience.setup_status = "complete".into();
    }
    file.advance()?;
    save(path, &file)?;
    Ok(file.public())
}

#[tauri::command]
pub fn restore_editor_preferences(
    expected_revision: u64,
    app: AppHandle,
) -> Result<EditorPreferences, String> {
    let _guard = crate::sync_util::lock_recover(&PREFERENCES_LOCK);
    let preferences = restore_at(&settings_path(), expected_revision)?;
    broadcast(&app, &preferences);
    Ok(preferences)
}

pub(crate) fn read_legacy_settings() -> Result<Value, String> {
    let _guard = crate::sync_util::lock_recover(&PREFERENCES_LOCK);
    let (file, _) = load(&settings_path(), None, false)?;
    Ok(Value::Object(file.settings))
}

pub(crate) fn write_legacy_settings(settings: Value, app: &AppHandle) -> Result<(), String> {
    let settings = settings.as_object().ok_or("Settings must be an object")?;
    let _guard = crate::sync_util::lock_recover(&PREFERENCES_LOCK);
    let path = settings_path();
    let (mut file, _) = load(&path, None, false)?;
    file.settings = settings.clone();
    file.advance()?;
    save(&path, &file)?;
    broadcast(app, &file.public());
    Ok(())
}

#[tauri::command]
pub fn discover_editor_sources(
    editor: String,
    custom_path: Option<String>,
) -> Result<Vec<ImportSource>, String> {
    imports::discover(&editor, custom_path.as_deref())
}

#[tauri::command]
pub fn preview_editor_import(source: ImportSource) -> Result<ImportPreview, String> {
    imports::preview(source)
}

fn claim(
    owner: &mut Option<SetupOwner>,
    label: &str,
    lease: &str,
    exists: impl Fn(&str) -> bool,
) -> bool {
    if !exists(label) || lease.is_empty() || lease.len() > 128 {
        return false;
    }
    if owner
        .as_ref()
        .is_some_and(|old| old.window_label != label && exists(&old.window_label))
    {
        return false;
    }
    *owner = Some(SetupOwner {
        window_label: label.into(),
        lease: lease.into(),
    });
    true
}

#[tauri::command]
pub fn claim_editor_setup(window_label: String, lease: String, app: AppHandle) -> bool {
    let mut owner = crate::sync_util::lock_recover(&SETUP_OWNER);
    claim(&mut owner, &window_label, &lease, |label| {
        app.get_webview_window(label).is_some()
    })
}

fn release(owner: &mut Option<SetupOwner>, label: &str, lease: &str) {
    if owner
        .as_ref()
        .is_some_and(|old| old.window_label == label && old.lease == lease)
    {
        *owner = None;
    }
}

#[tauri::command]
pub fn release_editor_setup(window_label: String, lease: String) {
    let mut owner = crate::sync_util::lock_recover(&SETUP_OWNER);
    release(&mut owner, &window_label, &lease);
}

#[cfg(test)]
mod tests;
