//! Finding something to attach to.
//!
//! Unity's editor opens its debugger agent on a port derived from its own
//! process id — `56000 + (pid % 1000)` — and records that pid in
//! `Library/EditorInstance.json` inside the project. Both halves were confirmed
//! against a running Unity 6000.0.24f1: pid 24748, agent listening on 56748.
//!
//! This is deliberately independent of the Unity bridge. The previous
//! implementation resolved the port by asking the bridge over IPC and aborted
//! the whole attach when the bridge was not connected — so a perfectly
//! debuggable editor was unreachable whenever the in-editor package was not
//! running. The bridge is still preferred when present (it can answer for
//! configurations this formula does not cover), but it is no longer required.

use std::path::Path;

/// Where Unity's debugger agent listens for a given editor process.
///
/// Unity's own tooling uses this formula; it is not a heuristic.
pub fn editor_port(pid: u32) -> u16 {
    (56000 + (pid % 1000)) as u16
}

/// What `Library/EditorInstance.json` records about the editor holding a
/// project open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorInstance {
    pub process_id: u32,
    pub version: String,
    pub app_path: String,
}

/// Something the debugger can attach to.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Stable across refreshes, so the UI can keep a selection.
    pub id: String,
    pub kind: TargetKind,
    /// What the user sees in the picker.
    pub label: String,
    pub host: String,
    pub port: u16,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    UnityEditor,
    /// A standalone or mobile player, found by PlayerConnection multicast.
    UnityPlayer,
}

/// Parse `Library/EditorInstance.json`.
pub fn parse_editor_instance(json: &str) -> Option<EditorInstance> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    // Without a pid there is no port to compute, so the record is useless.
    let process_id = u32::try_from(value.get("process_id")?.as_u64()?).ok()?;
    Some(EditorInstance {
        process_id,
        // Cosmetic; a record missing them is still attachable.
        version: value
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        app_path: value
            .get("app_path")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Read the editor instance record for a project, if one is present.
pub fn read_editor_instance(workspace: &Path) -> Option<EditorInstance> {
    let path = workspace.join("Library").join("EditorInstance.json");
    parse_editor_instance(&std::fs::read_to_string(path).ok()?)
}

/// Attach targets for a workspace.
pub fn targets_for_workspace(workspace: &Path) -> Vec<Target> {
    targets_with(workspace, |pid| crate::unity_ipc::process_is_alive(pid))
}

/// Testable core: liveness is injected so the "editor has exited but left its
/// file behind" case can be exercised without spawning a process.
fn targets_with(workspace: &Path, is_alive: impl Fn(u32) -> bool) -> Vec<Target> {
    let Some(instance) = read_editor_instance(workspace) else {
        return Vec::new();
    };
    // Unity does not reliably delete this file on exit, so a record naming a
    // dead process is common. Offering it would produce a connection failure
    // that reads to the user as a broken debugger.
    if !is_alive(instance.process_id) {
        return Vec::new();
    }

    let label = if instance.version.is_empty() {
        format!("Unity Editor (pid {})", instance.process_id)
    } else {
        format!("Unity Editor {} (pid {})", instance.version, instance.process_id)
    };

    vec![Target {
        // Derived from the pid, so a refresh while the picker is open keeps
        // pointing at the same editor.
        id: format!("unity-editor-{}", instance.process_id),
        kind: TargetKind::UnityEditor,
        label,
        host: "127.0.0.1".to_string(),
        port: editor_port(instance.process_id),
        pid: Some(instance.process_id),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured verbatim from a running Unity 6000.0.24f1, whose agent was
    /// confirmed listening on 127.0.0.1:56748.
    const CAPTURED: &str = r#"{
	"process_id" : 24748,
	"version" : "6000.0.24f1",
	"app_path" : "C:/Program Files/Unity/Hub/Editor/6000.0.24f1/Editor/Unity.exe",
	"app_contents_path" : "C:/Program Files/Unity/Hub/Editor/6000.0.24f1/Editor/Data"
}"#;

    #[test]
    fn the_port_matches_the_running_editor_that_was_observed() {
        assert_eq!(editor_port(24748), 56748);
    }

    #[test]
    fn the_port_stays_inside_unitys_thousand_block() {
        for pid in [1u32, 999, 1000, 65_535, 123_456] {
            let port = editor_port(pid);
            assert!(
                (56000..57000).contains(&port),
                "pid {} produced {}",
                pid,
                port
            );
        }
    }

    #[test]
    fn parses_the_captured_editor_instance_file() {
        assert_eq!(
            parse_editor_instance(CAPTURED).unwrap(),
            EditorInstance {
                process_id: 24748,
                version: "6000.0.24f1".to_string(),
                app_path:
                    "C:/Program Files/Unity/Hub/Editor/6000.0.24f1/Editor/Unity.exe".to_string(),
            }
        );
    }

    #[test]
    fn a_record_without_a_process_id_is_unusable() {
        assert_eq!(parse_editor_instance(r#"{"version":"6000.0.24f1"}"#), None);
    }

    #[test]
    fn malformed_json_is_not_a_target() {
        assert_eq!(parse_editor_instance("not json at all"), None);
    }

    #[test]
    fn a_record_missing_optional_fields_still_parses() {
        let parsed = parse_editor_instance(r#"{"process_id": 7}"#).unwrap();
        assert_eq!(parsed.process_id, 7);
        assert!(parsed.version.is_empty());
    }

    fn workspace_with(json: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let library = dir.path().join("Library");
        std::fs::create_dir_all(&library).unwrap();
        if let Some(json) = json {
            std::fs::write(library.join("EditorInstance.json"), json).unwrap();
        }
        dir
    }

    #[test]
    fn a_live_editor_is_offered_as_a_target() {
        let dir = workspace_with(Some(CAPTURED));
        let targets = targets_with(dir.path(), |pid| pid == 24748);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].kind, TargetKind::UnityEditor);
        assert_eq!(targets[0].port, 56748);
        assert_eq!(targets[0].host, "127.0.0.1");
        assert_eq!(targets[0].pid, Some(24748));
        assert!(
            targets[0].label.contains("6000.0.24f1"),
            "the version helps when several editors are open: {}",
            targets[0].label
        );
    }

    /// Unity does not always remove this file when it exits, so a stale record
    /// would otherwise offer a target that cannot be attached to — and the
    /// resulting connection failure looks like a broken debugger.
    #[test]
    fn a_stale_record_for_a_dead_process_is_not_offered() {
        let dir = workspace_with(Some(CAPTURED));
        assert!(targets_with(dir.path(), |_| false).is_empty());
    }

    #[test]
    fn a_project_unity_never_opened_offers_nothing() {
        let dir = workspace_with(None);
        assert!(targets_with(dir.path(), |_| true).is_empty());
    }

    /// The id must survive a refresh so the picker does not lose its selection
    /// while the user is looking at it.
    #[test]
    fn target_ids_are_stable_across_refreshes() {
        let dir = workspace_with(Some(CAPTURED));
        let first = targets_with(dir.path(), |_| true);
        let second = targets_with(dir.path(), |_| true);
        assert_eq!(first[0].id, second[0].id);
        assert!(!first[0].id.is_empty());
    }
}
