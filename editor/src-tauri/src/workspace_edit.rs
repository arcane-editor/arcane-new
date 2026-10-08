//! Recoverable, compare-before-write text changes. Resource operations are
//! deliberately rejected by the frontend until they share this contract.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

static TRANSACTION_LOCK: Mutex<()> = Mutex::new(());

/// File identity, rather than spelling, distinguishes aliases on both
/// case-sensitive and case-insensitive macOS volumes. Windows identity uses
/// its canonical, normalized path (including UNC and verbatim paths).
fn file_identity(path: &Path) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        Ok(crate::path_util::to_ui_path(canonical).to_lowercase())
    }
}

#[tauri::command]
pub async fn workspace_edit_identities(
    paths: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    if paths.len() > 10000 {
        return Err("Too many document paths".into());
    }
    crate::blocking_fs(move || {
        Ok(paths
            .into_iter()
            .filter_map(|path| {
                // Missing unrelated tabs must not block a change; an edited document
                // with no identity is rejected by the frontend and native preflight.
                file_identity(Path::new(&path))
                    .ok()
                    .map(|identity| (path, identity))
            })
            .collect())
    })
    .await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextChange {
    pub path: String,
    pub before: String,
    pub after: String,
    /// Open documents stay dirty; their before/after text is backed up too.
    pub buffer: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    schema_version: u32,
    workspace: String,
    status: String,
    changes: Vec<TextChange>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    id: String,
    applied: bool,
    recovery_required: bool,
    error: Option<String>,
}

fn journal_dir(cache: &Path, workspace: &Path) -> PathBuf {
    use sha1::{Digest, Sha1};
    cache.join("workspace-changes").join(format!(
        "{:x}",
        Sha1::digest(workspace.to_string_lossy().as_bytes())
    ))
}

fn save(path: &Path, journal: &Journal) -> Result<(), String> {
    crate::fs_atomic::write_atomic(
        path,
        &serde_json::to_vec(journal).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Cannot save recovery journal {}: {e}", path.display()))
}

fn validate(workspace: &Path, changes: &mut [TextChange]) -> Result<(), String> {
    let mut paths = HashSet::new();
    let workspace_identity = file_identity(workspace)?;
    for change in changes {
        let path =
            std::fs::canonicalize(&change.path).map_err(|e| format!("{}: {e}", change.path))?;
        let in_workspace = path.starts_with(workspace)
            || path
                .ancestors()
                .any(|parent| file_identity(parent).ok().as_ref() == Some(&workspace_identity));
        if !in_workspace || !path.is_file() {
            return Err(format!(
                "Change is outside the workspace or is not a file: {}",
                change.path
            ));
        }
        let identity = crate::path_util::to_ui_path(&path);
        if !paths.insert(file_identity(&path)?) {
            return Err(format!("Duplicate document identity: {}", change.path));
        }
        change.path = identity;
        if !change.buffer {
            if change.before != change.after
                && std::fs::metadata(&path)
                    .map_err(|e| e.to_string())?
                    .permissions()
                    .readonly()
            {
                return Err(format!("{} is read-only", path.display()));
            }
            if std::fs::read_to_string(&path).map_err(|e| e.to_string())? != change.before {
                return Err(format!(
                    "{} changed since the edit was prepared",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

/// Restore only bytes owned by this operation. A concurrent external edit is
/// left intact and reported for recovery instead of being overwritten.
fn restore(changes: &[TextChange]) -> Result<(), String> {
    let mut errors = Vec::new();
    for change in changes.iter().rev().filter(|c| !c.buffer) {
        let path = Path::new(&change.path);
        if std::fs::read_to_string(path).ok().as_deref() == Some(&change.before) {
            continue;
        }
        match crate::fs_atomic::write_if_unchanged(
            path,
            change.before.as_bytes(),
            Some(&change.after),
        ) {
            Ok(true) => {}
            Ok(false) => errors.push(format!("{} changed during recovery", change.path)),
            Err(e) => errors.push(format!("{}: {e}", change.path)),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn apply(cache: &Path, workspace: &Path, mut changes: Vec<TextChange>) -> Result<Outcome, String> {
    apply_with(cache, workspace, &mut changes, |_| Ok(()))
}

fn apply_with(
    cache: &Path,
    workspace: &Path,
    changes: &mut [TextChange],
    before_write: impl Fn(usize) -> Result<(), String>,
) -> Result<Outcome, String> {
    let _guard = TRANSACTION_LOCK.lock().map_err(|e| e.to_string())?;
    let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
    validate(&workspace, changes)?;
    let dir = journal_dir(cache, &workspace);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // create_dir reserves the ID before any journal or target writes.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let id = format!("{stamp}-{}", std::process::id());
    let run = dir.join(&id);
    std::fs::create_dir(&run).map_err(|e| e.to_string())?;
    let path = run.join("journal.json");
    let mut journal = Journal {
        schema_version: 1,
        workspace: workspace.to_string_lossy().into(),
        status: "prepared".into(),
        changes: changes.to_vec(),
    };
    save(&path, &journal)?;
    for (index, change) in journal.changes.iter().filter(|c| !c.buffer).enumerate() {
        let result = before_write(index).and_then(|_| {
            crate::fs_atomic::write_if_unchanged(
                Path::new(&change.path),
                change.after.as_bytes(),
                Some(&change.before),
            )
            .map_err(|e| e.to_string())
        });
        if !matches!(result, Ok(true)) {
            let error = format!(
                "{}: {}",
                change.path,
                match result {
                    Ok(_) => "document changed".into(),
                    Err(e) => e.to_string(),
                }
            );
            let recovery = restore(&journal.changes);
            journal.status = if recovery.is_ok() {
                "rolledBack"
            } else {
                "recoveryRequired"
            }
            .into();
            save(&path, &journal)?;
            return Ok(Outcome {
                id,
                applied: false,
                recovery_required: recovery.is_err(),
                error: Some(format!(
                    "{error}{}",
                    recovery.err().map(|e| format!("; {e}")).unwrap_or_default()
                )),
            });
        }
    }
    journal.status = "filesApplied".into();
    if let Err(error) = save(&path, &journal) {
        let recovery = restore(&journal.changes);
        return Ok(Outcome {
            id,
            applied: false,
            recovery_required: recovery.is_err(),
            error: Some(format!("{error}; recovery journal: {}", path.display())),
        });
    }
    Ok(Outcome {
        id,
        applied: true,
        recovery_required: false,
        error: None,
    })
}

fn undo(cache: &Path, workspace: &Path, id: &str) -> Result<(), String> {
    let _guard = TRANSACTION_LOCK.lock().map_err(|e| e.to_string())?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("Invalid transaction ID".into());
    }
    let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
    let path = journal_dir(cache, &workspace).join(id).join("journal.json");
    let mut journal: Journal =
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if journal.schema_version != 1 || journal.workspace != workspace.to_string_lossy() {
        return Err("Recovery journal does not belong to this workspace".into());
    }
    // Revalidate scope AND all baselines before reverting the first file.
    let mut inverse = journal.changes.clone();
    for c in &mut inverse {
        std::mem::swap(&mut c.before, &mut c.after);
    }
    if matches!(
        journal.status.as_str(),
        "prepared" | "filesApplied" | "filesRestored" | "recoveryRequired"
    ) {
        for change in inverse.iter_mut().filter(|c| !c.buffer) {
            // A crash may have stopped before this particular write.
            let current = std::fs::read_to_string(&change.path).map_err(|e| e.to_string())?;
            if current == change.after {
                change.before = current;
            }
        }
    }
    validate(&workspace, &mut inverse)?;
    let result = restore(&journal.changes);
    journal.status = if result.is_ok() {
        "filesRestored"
    } else {
        "recoveryRequired"
    }
    .into();
    save(&path, &journal)?;
    result
}

#[tauri::command]
pub async fn workspace_edit_apply(
    app: AppHandle,
    workspace_path: String,
    changes: Vec<TextChange>,
) -> Result<Outcome, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    crate::blocking_fs(move || apply(&cache, Path::new(&workspace_path), changes)).await
}

#[tauri::command]
pub async fn workspace_edit_undo(
    app: AppHandle,
    workspace_path: String,
    id: String,
) -> Result<(), String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    crate::blocking_fs(move || undo(&cache, Path::new(&workspace_path), &id)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingEdit {
    id: String,
    status: String,
    changes: Vec<TextChange>,
}

fn pending(cache: &Path, workspace: &Path) -> Result<Vec<PendingEdit>, String> {
    let _guard = TRANSACTION_LOCK.lock().map_err(|e| e.to_string())?;
    let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
    let dir = journal_dir(cache, &workspace);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().join("journal.json");
        if !path.is_file() {
            continue;
        }
        let journal: Journal =
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Recovery journal {} cannot be read: {e}", path.display()))?;
        if journal.schema_version != 1 || journal.workspace != workspace.to_string_lossy() {
            continue;
        }
        if matches!(
            journal.status.as_str(),
            "prepared" | "filesApplied" | "filesRestored" | "recoveryRequired"
        ) {
            result.push(PendingEdit {
                id: entry.file_name().to_string_lossy().into(),
                status: journal.status,
                changes: journal.changes,
            });
        }
    }
    result.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(result)
}

#[tauri::command]
pub async fn workspace_edit_pending(
    app: AppHandle,
    workspace_path: String,
) -> Result<Vec<PendingEdit>, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    crate::blocking_fs(move || pending(&cache, Path::new(&workspace_path))).await
}

fn complete(cache: &Path, workspace: &Path, id: &str, undone: bool) -> Result<(), String> {
    let _guard = TRANSACTION_LOCK.lock().map_err(|e| e.to_string())?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("Invalid transaction ID".into());
    }
    let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
    let path = journal_dir(cache, &workspace).join(id).join("journal.json");
    let mut journal: Journal =
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if journal.schema_version != 1 || journal.workspace != workspace.to_string_lossy() {
        return Err("Recovery workspace mismatch".into());
    }
    let expected = if undone {
        "filesRestored"
    } else {
        "filesApplied"
    };
    if journal.status != expected {
        return Err("Unexpected transaction phase".into());
    }
    journal.status = if undone { "undone" } else { "applied" }.into();
    save(&path, &journal)
}

#[tauri::command]
pub async fn workspace_edit_complete(
    app: AppHandle,
    workspace_path: String,
    id: String,
    undone: bool,
) -> Result<(), String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    crate::blocking_fs(move || complete(&cache, Path::new(&workspace_path), &id, undone)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn file_identity_resolves_symlink_aliases_without_collapsing_distinct_files() {
        let ws = tempfile::tempdir().unwrap();
        let a = ws.path().join("A.cs");
        let b = ws.path().join("B.cs");
        let alias = ws.path().join("Alias.cs");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        std::os::unix::fs::symlink(&a, &alias).unwrap();
        assert_eq!(file_identity(&a).unwrap(), file_identity(&alias).unwrap());
        assert_ne!(file_identity(&a).unwrap(), file_identity(&b).unwrap());
    }
    fn change(path: &Path, before: &str, after: &str) -> TextChange {
        TextChange {
            path: path.to_string_lossy().into(),
            before: before.into(),
            after: after.into(),
            buffer: false,
        }
    }
    #[test]
    fn closed_files_have_one_durable_undo() {
        let ws = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let a = ws.path().join("A.cs");
        let b = ws.path().join("B.cs");
        std::fs::write(&a, "old A").unwrap();
        std::fs::write(&b, "old B").unwrap();
        let outcome = apply(
            cache.path(),
            ws.path(),
            vec![change(&a, "old A", "new A"), change(&b, "old B", "new B")],
        )
        .unwrap();
        assert!(outcome.applied);
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "new B");
        undo(cache.path(), ws.path(), &outcome.id).unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "old A");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "old B");
    }
    #[test]
    fn stale_second_file_prevents_all_changes_and_stale_undo_does_too() {
        let ws = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let a = ws.path().join("A.cs");
        let b = ws.path().join("B.cs");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        assert!(apply(
            cache.path(),
            ws.path(),
            vec![change(&a, "a", "A"), change(&b, "stale", "B")]
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a");
        let applied = apply(
            cache.path(),
            ws.path(),
            vec![change(&a, "a", "A"), change(&b, "b", "B")],
        )
        .unwrap();
        std::fs::write(&a, "user edit").unwrap();
        assert!(undo(cache.path(), ws.path(), &applied.id).is_err());
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "B");
    }
    #[test]
    fn outside_workspace_and_duplicate_aliases_are_rejected() {
        let ws = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let a = ws.path().join("A.cs");
        let outside = cache.path().join("B.cs");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&outside, "b").unwrap();
        assert!(apply(cache.path(), ws.path(), vec![change(&outside, "b", "B")]).is_err());
        assert!(apply(
            cache.path(),
            ws.path(),
            vec![change(&a, "a", "A"), change(&a, "a", "other")]
        )
        .is_err());
    }

    #[test]
    fn injected_failure_rolls_back_prior_writes() {
        let ws = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let a = ws.path().join("A.cs");
        let b = ws.path().join("B.cs");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let mut changes = vec![change(&a, "a", "A"), change(&b, "b", "B")];
        let result = apply_with(cache.path(), ws.path(), &mut changes, |index| {
            if index == 1 {
                Err("injected disk error".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert!(!result.applied);
        assert!(!result.recovery_required);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b");
    }

    #[test]
    fn interrupted_operation_is_discoverable_until_buffer_acknowledgement() {
        let ws = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let a = ws.path().join("A.cs");
        std::fs::write(&a, "a").unwrap();
        let applied = apply(cache.path(), ws.path(), vec![change(&a, "a", "A")]).unwrap();
        assert_eq!(pending(cache.path(), ws.path()).unwrap().len(), 1);
        complete(cache.path(), ws.path(), &applied.id, false).unwrap();
        assert!(pending(cache.path(), ws.path()).unwrap().is_empty());
        undo(cache.path(), ws.path(), &applied.id).unwrap();
        assert_eq!(
            pending(cache.path(), ws.path()).unwrap()[0].status,
            "filesRestored"
        );
        // Recovery after a crash during undo is idempotent.
        undo(cache.path(), ws.path(), &applied.id).unwrap();
        complete(cache.path(), ws.path(), &applied.id, true).unwrap();
        assert!(pending(cache.path(), ws.path()).unwrap().is_empty());
    }

    #[test]
    fn rollback_preserves_external_edits_and_retains_recovery_record() {
        let ws = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let a = ws.path().join("A.cs");
        let b = ws.path().join("B.cs");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let mut changes = vec![change(&a, "a", "A"), change(&b, "b", "B")];
        let result = apply_with(cache.path(), ws.path(), &mut changes, |index| {
            if index == 1 {
                std::fs::write(&a, "external edit").unwrap();
                Err("disk failure".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert!(!result.applied);
        assert!(result.recovery_required);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "external edit");
        let journal = journal_dir(cache.path(), &ws.path().canonicalize().unwrap())
            .join(result.id)
            .join("journal.json");
        assert!(std::fs::read_to_string(journal)
            .unwrap()
            .contains("recoveryRequired"));
    }
}
