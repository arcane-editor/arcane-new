use super::*;
use serde_json::json;
use std::fs;

fn request(revision: u64) -> ApplyEditorPreferencesRequest {
    ApplyEditorPreferencesRequest {
        expected_revision: revision,
        profile: "rider".into(),
        shortcut_profile: Some("rider".into()),
        keymap: "intellij".into(),
        theme_id: Some("rider-dark".into()),
        settings_patch: json!({"editor.fontSize": 13}).as_object().unwrap().clone(),
        imported_bindings: Some(vec![KeyBinding {
            command_id: "file.save".into(),
            strokes: vec!["ctrl+s".into()],
            context: Some("global".into()),
            removed: None,
        }]),
        user_bindings: None,
        setup_status: "complete".into(),
        report: None,
        source_label: Some("Fixture Rider".into()),
    }
}

#[test]
fn fresh_and_legacy_are_identified_before_renderer_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let (fresh, migrated) = load(&path, None, false).unwrap();
    assert!(migrated);
    assert_eq!(fresh.experience.setup_status, "fresh");
    assert!(fresh.settings.is_empty());
    fs::write(
        &path,
        r#"{"editor.fontSize":17,"unity.bridge.enabled":false}"#,
    )
    .unwrap();
    let (old, migrated) = load(&path, Some("unityide-light"), false).unwrap();
    assert!(migrated);
    assert_eq!(old.experience.setup_status, "invited");
    assert_eq!(old.theme_id, "unityide-light");
    assert_eq!(old.settings["unity.bridge.enabled"], false);
    save(&path, &old).unwrap();
    let (same, migrated) = load(&path, None, false).unwrap();
    assert!(!migrated);
    assert_eq!(same.public(), old.public());
}

#[test]
fn read_and_failed_mutations_never_overwrite_corrupt_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    for content in [
        "{broken",
        "[]",
        r#"{"schemaVersion":1,"settings":{}}"#,
        r#"{"schemaVersion":99}"#,
    ] {
        fs::write(&path, content).unwrap();
        assert!(load(&path, None, false).is_err());
        assert!(apply_at(&path, request(0)).is_err());
        assert!(patch_at(&path, json!({"editor.fontSize":14}), None, None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }
}

#[test]
fn atomic_envelope_backup_and_revision_checks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    fs::write(&path, r#"{"editor.fontSize":17,"editor.tabSize":4}"#).unwrap();
    let applied = apply_at(&path, request(0)).unwrap();
    assert_eq!(applied.revision, 1);
    assert!(applied.can_restore);
    assert_eq!(applied.settings["editor.tabSize"], 4);
    let disk = fs::read(&path).unwrap();
    assert!(apply_at(&path, request(0)).is_err());
    assert_eq!(fs::read(&path).unwrap(), disk);
    let patched = patch_at(
        &path,
        json!({"editor.wordWrap":"on"}),
        Some("rider-light"),
        None,
    )
    .unwrap();
    assert_eq!(patched.revision, 2);
    assert_eq!(patched.experience.profile, "rider");
    assert!(restore_at(&path, 1).is_err());
    let restored = restore_at(&path, 2).unwrap();
    assert_eq!(restored.revision, 3);
    assert_eq!(restored.settings["editor.fontSize"], 17);
    assert_eq!(restored.theme_id, "unityide-dark");
    assert!(!restored.can_restore);
    assert!(restore_at(&path, 3).is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn invalid_changes_leave_atomic_envelope_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut bad = request(0);
    bad.theme_id = Some("external-theme".into());
    assert!(apply_at(&path, bad).is_err());
    assert!(!path.exists());
    let mut bad = request(0);
    bad.imported_bindings.as_mut().unwrap()[0].strokes = vec!["cmd+q".into()];
    assert!(apply_at(&path, bad).is_err());
    assert!(!path.exists());
    let mut bad = request(0);
    bad.settings_patch
        .insert("auth.token".into(), json!("never accepted"));
    assert!(apply_at(&path, bad).is_err());
    assert!(!path.exists());
}

#[test]
fn dismissal_preserves_import_and_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let applied = apply_at(&path, request(0)).unwrap();
    let mut dismiss = request(1);
    dismiss.setup_status = "dismissed".into();
    dismiss.settings_patch.clear();
    dismiss.theme_id = None;
    dismiss.imported_bindings = None;
    dismiss.user_bindings = None;
    dismiss.shortcut_profile = None;
    let dismissed = apply_at(&path, dismiss).unwrap();
    assert_eq!(
        dismissed.experience.source_label,
        applied.experience.source_label
    );
    assert_eq!(
        dismissed.experience.imported_bindings,
        applied.experience.imported_bindings
    );
    assert!(dismissed.can_restore);
    let restored = restore_at(&path, 2).unwrap();
    assert_eq!(restored.experience.setup_status, "complete");
}

#[test]
fn source_label_survives_shortcut_edits_and_clears_on_profile_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    apply_at(&path, request(0)).unwrap();
    let mut edit = request(1);
    edit.source_label = None;
    let edited = apply_at(&path, edit).unwrap();
    assert_eq!(
        edited.experience.source_label.as_deref(),
        Some("Fixture Rider")
    );
    let mut switch = request(2);
    switch.profile = "vscode".into();
    switch.source_label = None;
    let switched = apply_at(&path, switch).unwrap();
    assert!(switched.experience.source_label.is_none());
}

#[test]
fn standalone_shortcut_edits_preserve_the_pre_import_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    fs::write(&path, r#"{"editor.fontSize":17}"#).unwrap();
    apply_at(&path, request(0)).unwrap();
    let mut edit = request(1);
    edit.settings_patch.clear();
    edit.theme_id = None;
    edit.imported_bindings = None;
    edit.source_label = None;
    edit.user_bindings = Some(vec![KeyBinding {
        command_id: "file.save".into(),
        strokes: vec!["ctrl+shift+s".into()],
        context: Some("global".into()),
        removed: None,
    }]);
    edit.shortcut_profile = None;
    let edited = apply_at(&path, edit).unwrap();
    assert_eq!(edited.experience.user_bindings.len(), 1);
    assert_eq!(
        edited.experience.source_label.as_deref(),
        Some("Fixture Rider")
    );
    let restored = restore_at(&path, 2).unwrap();
    assert_eq!(restored.experience.profile, "unityide");
    assert_eq!(restored.settings["editor.fontSize"], 17);
    assert!(restored.experience.user_bindings.is_empty());
}

#[test]
fn appearance_only_switch_preserves_shortcut_profile_and_keymap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut rider = request(0);
    rider.keymap = "resharper".into();
    apply_at(&path, rider).unwrap();
    let mut appearance = request(1);
    appearance.profile = "vscode".into();
    appearance.shortcut_profile = None;
    appearance.keymap = "vscode".into();
    appearance.imported_bindings = None;
    appearance.user_bindings = None;
    appearance.theme_id = Some("dark-plus".into());
    let switched = apply_at(&path, appearance).unwrap();
    assert_eq!(switched.experience.profile, "vscode");
    assert_eq!(
        switched.experience.shortcut_profile.as_deref(),
        Some("rider")
    );
    assert_eq!(switched.experience.keymap, "resharper");
    assert_eq!(switched.theme_id, "dark-plus");
}

#[test]
fn setup_owner_releases_closed_windows_without_a_new_run_deadlock() {
    let mut owner = None;
    assert!(claim(&mut owner, "one", "lease1", |_| true));
    assert!(!claim(&mut owner, "two", "lease2", |_| true));
    assert!(claim(&mut owner, "two", "lease2", |label| label == "two"));
    assert!(!claim(&mut owner, "missing", "lease3", |label| label == "two"));
}

#[test]
fn stale_setup_cleanup_cannot_release_a_new_effect_lease() {
    let mut owner = None;
    assert!(claim(&mut owner, "one", "first", |_| true));
    assert!(claim(&mut owner, "one", "second", |_| true));
    release(&mut owner, "one", "first");
    assert_eq!(owner.as_ref().unwrap().lease, "second");
    assert!(!claim(&mut owner, "two", "other", |_| true));
    release(&mut owner, "two", "second");
    assert!(owner.is_some());
    release(&mut owner, "one", "second");
    assert!(owner.is_none());
    assert!(claim(&mut owner, "two", "other", |_| true));
}

#[test]
fn migration_patches_check_optional_revision_and_normal_patches_merge() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    apply_at(&path, request(0)).unwrap();
    let disk = fs::read(&path).unwrap();
    assert!(patch_at(&path, json!({"editor.fontSize": 16}), None, Some(0)).is_err());
    assert_eq!(fs::read(&path).unwrap(), disk);
    let migrated = patch_at(&path, json!({"editor.tabSize": 2}), None, Some(1)).unwrap();
    assert_eq!(migrated.revision, 2);
    let patched = patch_at(&path, json!({"editor.wordWrap": "on"}), None, None).unwrap();
    assert_eq!(patched.revision, 3);
    assert_eq!(patched.settings["editor.fontSize"], 13);
    assert_eq!(patched.settings["editor.tabSize"], 2);
    assert_eq!(patched.settings["editor.wordWrap"], "on");
    assert!(patched.can_restore);
}

#[test]
fn contract_serializes_camel_case_without_backup_values() {
    let dir = tempfile::tempdir().unwrap();
    let preferences = apply_at(&dir.path().join("settings.json"), request(0)).unwrap();
    let value = serde_json::to_value(preferences).unwrap();
    assert!(value.get("schemaVersion").is_some());
    assert!(value.get("canRestore").is_some());
    assert!(value.get("themeId").is_some());
    assert!(value["experience"].get("importedBindings").is_some());
    assert!(value["experience"]["importedBindings"][0]
        .get("commandId")
        .is_some());
    assert!(value.get("backup").is_none());
}
