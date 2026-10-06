use serde_json::Value;

#[tauri::command]
pub fn read_settings() -> Result<Value, String> {
    crate::editor_experience::read_legacy_settings()
}

#[tauri::command]
pub fn write_settings(settings: Value, app: tauri::AppHandle) -> Result<(), String> {
    crate::editor_experience::write_legacy_settings(settings, &app)
}
