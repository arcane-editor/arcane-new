//! Command-line arguments UnityIDE is launched with.
//!
//! Unity invokes the configured external script editor as
//! `UnityIDE.exe --goto "<file>:<line>:<col>" "<projectPath>"` (see
//! `UnityIDEEditor.cs`). Nothing read argv, so double-clicking a script in
//! Unity's Project window opened the 720x480 Welcome window instead of the
//! file — on every platform. That is the core Unity-to-IDE workflow.

use std::sync::Mutex;

/// A file/line/column the app was asked to open at launch.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GotoTarget {
    pub file: String,
    pub line: u32,
    pub column: u32,
    /// The project root Unity passed alongside the file, when present.
    pub project: Option<String>,
}

/// A `--goto` seen at launch (or on a second launch) and not yet acted on.
///
/// Tauri-managed state rather than an event, because the frontend may not be
/// listening yet: on a cold start the window is still booting when argv is
/// parsed, so an event fired here would be dropped. The frontend collects this
/// once it is ready via `take_pending_goto`.
#[derive(Default)]
pub struct PendingGoto(pub Mutex<Option<GotoTarget>>);

/// Store a target for the frontend to collect. Last one wins — if the user
/// double-clicks two scripts in quick succession before the app is up, the
/// second is the one they are waiting on.
pub fn set_pending(state: &PendingGoto, target: GotoTarget) {
    if let Ok(mut slot) = state.0.lock() {
        *slot = Some(target);
    }
}

/// Look at the pending `--goto` without consuming it.
///
/// The welcome window uses this to learn which project to open. It must not
/// clear the slot: the project window that opens next is the one that should
/// actually claim the target.
#[tauri::command]
pub fn peek_pending_goto(state: tauri::State<'_, PendingGoto>) -> Option<GotoTarget> {
    state.0.lock().ok().and_then(|slot| slot.clone())
}

/// Claim the pending `--goto` if it belongs to `workspace_path`.
///
/// Claiming is conditional and atomic so no window has to take a target and
/// hand it back — a put-back races every other window's boot, and losing the
/// target means Unity's double-click silently does nothing.
///
/// A target with no project belongs to whoever asks first.
#[tauri::command]
pub fn claim_pending_goto(
    state: tauri::State<'_, PendingGoto>,
    workspace_path: Option<String>,
) -> Option<GotoTarget> {
    let mut slot = state.0.lock().ok()?;
    let target = slot.as_ref()?;

    let mine = match (&target.project, &workspace_path) {
        (None, _) => true,
        (Some(project), Some(ws)) => same_path(project, ws),
        (Some(_), None) => false,
    };

    if mine {
        slot.take()
    } else {
        None
    }
}

/// Compare two paths for "same project" purposes.
///
/// Case-insensitive and separator-insensitive: Unity hands back whatever
/// spelling the OS gave it, which on Windows may differ in drive-letter case
/// and separator from the path the window was opened with.
fn same_path(a: &str, b: &str) -> bool {
    fn norm(p: &str) -> String {
        p.replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    }
    norm(a) == norm(b)
}

/// Parse `--goto <file>[:<line>[:<col>]] [<projectPath>]` out of argv.
///
/// Returns `None` when the flag is absent — a plain launch, which must keep its
/// existing behaviour.
pub fn parse_goto(argv: &[String]) -> Option<GotoTarget> {
    let flag = argv.iter().position(|a| a == "--goto")?;
    let target = argv.get(flag + 1)?;
    if target.is_empty() {
        return None;
    }

    let (file, line, column) = split_target(target);

    // The next argument, if it is not another flag, is the project root.
    let project = argv
        .get(flag + 2)
        .filter(|a| !a.starts_with("--"))
        .filter(|a| !a.is_empty())
        .cloned();

    Some(GotoTarget {
        file,
        line,
        column,
        project,
    })
}

/// Split `path:line:col` from the RIGHT.
///
/// Splitting from the left destroys a Windows path: `C:\Proj\Player.cs:42:1`
/// carries a drive-letter colon that has nothing to do with the line/column
/// suffix. Only a trailing segment that parses as a number is treated as one,
/// so a path containing a colon and no suffix survives intact.
fn split_target(target: &str) -> (String, u32, u32) {
    let mut file = target;
    let mut nums: Vec<u32> = Vec::new();

    // At most two trailing numeric segments: :line:col.
    for _ in 0..2 {
        let Some(idx) = file.rfind(':') else { break };
        let (head, tail) = file.split_at(idx);
        let Ok(n) = tail[1..].parse::<u32>() else { break };
        nums.push(n);
        file = head;
    }

    nums.reverse(); // rfind collected right-to-left.
    let line = nums.first().copied().unwrap_or(1);
    let column = nums.get(1).copied().unwrap_or(1);
    (file.to_string(), line, column.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_a_posix_goto() {
        let t = parse_goto(&argv(&[
            "unityide",
            "--goto",
            "/Users/me/Proj/Assets/Player.cs:42:7",
            "/Users/me/Proj",
        ]))
        .expect("parsed");
        assert_eq!(t.file, "/Users/me/Proj/Assets/Player.cs");
        assert_eq!(t.line, 42);
        assert_eq!(t.column, 7);
        assert_eq!(t.project.as_deref(), Some("/Users/me/Proj"));
    }

    /// The whole reason this splits from the right.
    #[test]
    fn parses_a_windows_goto_with_a_drive_letter() {
        let t = parse_goto(&argv(&[
            "UnityIDE.exe",
            "--goto",
            r"C:\Proj\Assets\Player.cs:42:1",
            r"C:\Proj",
        ]))
        .expect("parsed");
        assert_eq!(t.file, r"C:\Proj\Assets\Player.cs");
        assert_eq!(t.line, 42);
        assert_eq!(t.column, 1);
        assert_eq!(t.project.as_deref(), Some(r"C:\Proj"));
    }

    #[test]
    fn tolerates_a_missing_column() {
        let t = parse_goto(&argv(&["unityide", "--goto", "/a/b.cs:9"])).expect("parsed");
        assert_eq!(t.file, "/a/b.cs");
        assert_eq!(t.line, 9);
        assert_eq!(t.column, 1);
    }

    #[test]
    fn tolerates_a_bare_path_with_no_position() {
        let t = parse_goto(&argv(&["unityide", "--goto", "/a/b.cs"])).expect("parsed");
        assert_eq!(t.file, "/a/b.cs");
        assert_eq!(t.line, 1);
        assert_eq!(t.column, 1);
    }

    /// A drive-lettered path with no :line:col must not lose its drive.
    #[test]
    fn a_bare_windows_path_keeps_its_drive() {
        let t = parse_goto(&argv(&["UnityIDE.exe", "--goto", r"D:\Unity\Player.cs"])).expect("parsed");
        assert_eq!(t.file, r"D:\Unity\Player.cs");
        assert_eq!(t.line, 1);
    }

    #[test]
    fn returns_none_without_the_flag() {
        assert!(parse_goto(&argv(&["unityide"])).is_none());
        assert!(parse_goto(&argv(&["unityide", "/some/project"])).is_none());
    }

    #[test]
    fn returns_none_when_the_flag_has_no_value() {
        assert!(parse_goto(&argv(&["unityide", "--goto"])).is_none());
    }

    #[test]
    fn treats_a_following_flag_as_not_a_project_path() {
        let t = parse_goto(&argv(&["unityide", "--goto", "/a/b.cs:3:4", "--other"])).expect("parsed");
        assert_eq!(t.project, None);
    }

    /// A deep link must not be mistaken for a goto target.
    #[test]
    fn ignores_argv_without_the_goto_flag_even_if_it_has_colons() {
        assert!(parse_goto(&argv(&["unityide", "unityide://auth/callback?code=1"])).is_none());
    }

    #[test]
    fn same_path_ignores_separator_drive_case_and_trailing_slash() {
        assert!(same_path(r"C:\Proj", "c:/proj"));
        assert!(same_path("/Users/me/Proj/", "/Users/me/Proj"));
        assert!(!same_path("/Users/me/A", "/Users/me/B"));
    }
}
