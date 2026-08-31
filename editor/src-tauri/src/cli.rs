//! Command-line arguments UnityIDE is launched with.
//!
//! Unity reaches the IDE through argv in two shapes, and both had to be made to
//! work before "open my project in UnityIDE" was a thing a user could do:
//!
//!   * `UnityIDE --goto "<file>:<line>:<col>" "<projectPath>"` — the configured
//!     external script editor, i.e. double-clicking a script in Unity's Project
//!     window. Nothing read argv at all once, so this opened the 720x480 Welcome
//!     window instead of the file, on every platform.
//!   * `UnityIDE --project "<projectPath>"` (and the bare `UnityIDE
//!     "<projectPath>"` that Unity's own `Assets > Open C# Project` produces) —
//!     open the project, no particular file. This parsed to *nothing*: the old
//!     parser returned `None` for anything without `--goto`, so the menu item
//!     Unity has shipped forever was a no-op against us.
//!
//! Both shapes collapse into one `OpenRequest`. `--goto` is still accepted
//! verbatim because the Unity package and the app ship separately — an already
//! installed extension keeps launching us that way for as long as the user does
//! not update it.
//!
//! There is a third route into the same `OpenRequest`, and it is the one Unity
//! prefers now: the `unityide://open?project=…&file=…&line=…&column=…` deep
//! link (`parse_deep_link`). It exists because argv means somebody had to know
//! where the app is installed, and the OS already does. See `UnityIDELauncher`
//! on the Unity side for when each route is taken.

use std::path::Path;
use std::sync::Mutex;

/// A project (and optionally a file position inside it) the app was asked to
/// open at launch.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// The project root to open, when one was named.
    pub project: Option<String>,
    /// The file to open inside it. `None` for a project-only request.
    pub file: Option<String>,
    pub line: u32,
    pub column: u32,
}

/// An open request seen at launch (or on a second launch) and not yet acted on.
///
/// Tauri-managed state rather than an event, because the frontend may not be
/// listening yet: on a cold start the window is still booting when argv is
/// parsed, so an event fired here would be dropped. The frontend collects this
/// once it is ready via `claim_pending_open`.
#[derive(Default)]
pub struct PendingOpen(pub Mutex<Option<OpenRequest>>);

/// Store a request for the frontend to collect. Last one wins — if the user
/// double-clicks two scripts in quick succession before the app is up, the
/// second is the one they are waiting on.
pub fn set_pending(state: &PendingOpen, request: OpenRequest) {
    if let Ok(mut slot) = state.0.lock() {
        *slot = Some(request);
    }
}

/// Look at the pending request without consuming it.
///
/// The welcome window uses this to learn which project to open. It must not
/// clear the slot: the project window that opens next is the one that should
/// actually claim the request.
#[tauri::command]
pub fn peek_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<OpenRequest> {
    state.0.lock().ok().and_then(|slot| slot.clone())
}

/// Claim the pending request if it belongs to `workspace_path`.
///
/// Claiming is conditional and atomic so no window has to take a request and
/// hand it back — a put-back races every other window's boot, and losing the
/// request means Unity's double-click silently does nothing.
///
/// A request with no project belongs to whoever asks first.
#[tauri::command]
pub fn claim_pending_open(
    state: tauri::State<'_, PendingOpen>,
    workspace_path: Option<String>,
) -> Option<OpenRequest> {
    let mut slot = state.0.lock().ok()?;
    let request = slot.as_ref()?;

    let mine = match (&request.project, &workspace_path) {
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
/// Two layers, because either one alone leaves a real case unmatched:
///
///  1. Case- and separator-insensitive string compare. Unity hands back
///     whatever spelling the OS gave it, which on Windows may differ in
///     drive-letter case and separator from the path the window was opened
///     with.
///  2. `canonicalize` on both sides. The window was opened through
///     `canonicalize_path` (which resolves symlinks); Unity derives its project
///     root from `Application.dataPath`, and .NET's `Path.GetFullPath` does
///     not resolve them. On macOS that is the difference between `/var/…` and
///     `/private/var/…`, and without this the request would sit unclaimed while
///     the welcome window opened a *second* window for the same project under
///     the other spelling.
pub fn same_path(a: &str, b: &str) -> bool {
    fn norm(p: &str) -> String {
        p.replace('\\', "/").trim_end_matches('/').to_lowercase()
    }
    if norm(a) == norm(b) {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => norm(&ca.to_string_lossy()) == norm(&cb.to_string_lossy()),
        _ => false,
    }
}

/// Parse an open request out of argv.
///
/// Returns `None` for a plain launch, which must keep its existing behaviour.
pub fn parse_open(argv: &[String]) -> Option<OpenRequest> {
    parse_open_with(argv, |p| Path::new(p).is_file())
}

/// `parse_open` with the "is this a file?" question injected, so the bare
/// positional case is testable without touching the filesystem.
fn parse_open_with(argv: &[String], is_file: impl Fn(&str) -> bool) -> Option<OpenRequest> {
    if let Some(request) = parse_goto(argv) {
        return Some(request);
    }

    // `--project <path>`: explicit, and unambiguous next to a deep-link URL.
    if let Some(idx) = argv.iter().position(|a| a == "--project") {
        if let Some(path) = argv.get(idx + 1).filter(|a| !a.is_empty() && !is_flag(a)) {
            return Some(OpenRequest {
                project: Some(path.clone()),
                file: None,
                line: 1,
                column: 1,
            });
        }
        return None;
    }

    // A bare positional. This is what Unity's `Assets > Open C# Project`
    // produces (`OpenProject("")` -> we launch with just the project path), and
    // what a user typing `unityide .` in a terminal expects. A path that is a
    // file opens as a file; anything else — including a path that does not
    // exist, which surfaces a proper "project folder not found" error later —
    // is treated as a project.
    let positional = argv.iter().skip(1).find(|a| !is_flag(a) && !is_url(a))?;
    if positional.is_empty() {
        return None;
    }
    if is_file(positional) {
        Some(OpenRequest {
            project: None,
            file: Some(positional.clone()),
            line: 1,
            column: 1,
        })
    } else {
        Some(OpenRequest {
            project: Some(positional.clone()),
            file: None,
            line: 1,
            column: 1,
        })
    }
}

/// `--goto <file>[:<line>[:<col>]] [<projectPath>]`, the external-script-editor
/// shape. Kept as its own function so the legacy form stays legible and
/// separately tested.
fn parse_goto(argv: &[String]) -> Option<OpenRequest> {
    let flag = argv.iter().position(|a| a == "--goto")?;
    let target = argv.get(flag + 1)?;
    if target.is_empty() {
        return None;
    }

    let (file, line, column) = split_target(target);

    // The next argument, if it is not another flag, is the project root.
    let project = argv
        .get(flag + 2)
        .filter(|a| !is_flag(a))
        .filter(|a| !a.is_empty())
        .cloned();

    Some(OpenRequest {
        project,
        file: Some(file),
        line,
        column,
    })
}

/// The deep-link host that means "open this".
///
/// Discriminating on the host keeps this and the auth callback
/// (`unityide://auth/callback?…`) from having to know about each other: an
/// `open` URL never reaches the auth handler and an `auth` URL never reaches
/// this one.
const OPEN_HOST: &str = "open";

/// Parse `unityide://open?project=…&file=…&line=…&column=…`.
///
/// Returns `None` for any other deep link (the auth callback, above all) and
/// for an `open` link that names neither a project nor a file — an empty
/// request would be claimed by the first window to ask and do nothing visible.
///
/// Percent-decoding is `url`'s: paths with spaces, `#`, or non-ASCII arrive
/// intact as long as the sender encoded them, which is the one thing the Unity
/// side has to get right.
pub fn parse_deep_link(url: &url::Url) -> Option<OpenRequest> {
    if url.host_str() != Some(OPEN_HOST) {
        return None;
    }

    let mut request = OpenRequest {
        project: None,
        file: None,
        line: 1,
        column: 1,
    };

    for (key, value) in url.query_pairs() {
        if value.is_empty() {
            continue;
        }
        match key.as_ref() {
            "project" => request.project = Some(value.into_owned()),
            "file" => request.file = Some(value.into_owned()),
            // A junk position is not worth refusing the whole open over.
            "line" => request.line = value.parse().unwrap_or(1).max(1),
            "column" => request.column = value.parse().unwrap_or(1).max(1),
            _ => {}
        }
    }

    if request.project.is_none() && request.file.is_none() {
        return None;
    }
    Some(request)
}

fn is_flag(arg: &str) -> bool {
    arg.starts_with("--")
}

/// A deep link (`unityide://…`) rides in argv on Windows and Linux and must
/// never be mistaken for a path. Matching on `://` rather than on the app's own
/// scheme keeps this correct for the dev build's `unityide-dev://` too, without
/// needing the AppHandle here.
fn is_url(arg: &str) -> bool {
    arg.contains("://")
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

    /// `parse_open` with nothing on disk: every bare positional is a project.
    fn parse(items: &[&str]) -> Option<OpenRequest> {
        parse_open_with(&argv(items), |_| false)
    }

    #[test]
    fn parses_a_posix_goto() {
        let t = parse(&[
            "unityide",
            "--goto",
            "/Users/me/Proj/Assets/Player.cs:42:7",
            "/Users/me/Proj",
        ])
        .expect("parsed");
        assert_eq!(t.file.as_deref(), Some("/Users/me/Proj/Assets/Player.cs"));
        assert_eq!(t.line, 42);
        assert_eq!(t.column, 7);
        assert_eq!(t.project.as_deref(), Some("/Users/me/Proj"));
    }

    /// The whole reason this splits from the right.
    #[test]
    fn parses_a_windows_goto_with_a_drive_letter() {
        let t = parse(&[
            "UnityIDE.exe",
            "--goto",
            r"C:\Proj\Assets\Player.cs:42:1",
            r"C:\Proj",
        ])
        .expect("parsed");
        assert_eq!(t.file.as_deref(), Some(r"C:\Proj\Assets\Player.cs"));
        assert_eq!(t.line, 42);
        assert_eq!(t.column, 1);
        assert_eq!(t.project.as_deref(), Some(r"C:\Proj"));
    }

    #[test]
    fn tolerates_a_missing_column() {
        let t = parse(&["unityide", "--goto", "/a/b.cs:9"]).expect("parsed");
        assert_eq!(t.file.as_deref(), Some("/a/b.cs"));
        assert_eq!(t.line, 9);
        assert_eq!(t.column, 1);
    }

    #[test]
    fn tolerates_a_bare_path_with_no_position() {
        let t = parse(&["unityide", "--goto", "/a/b.cs"]).expect("parsed");
        assert_eq!(t.file.as_deref(), Some("/a/b.cs"));
        assert_eq!(t.line, 1);
        assert_eq!(t.column, 1);
    }

    /// A drive-lettered path with no :line:col must not lose its drive.
    #[test]
    fn a_bare_windows_path_keeps_its_drive() {
        let t = parse(&["UnityIDE.exe", "--goto", r"D:\Unity\Player.cs"]).expect("parsed");
        assert_eq!(t.file.as_deref(), Some(r"D:\Unity\Player.cs"));
        assert_eq!(t.line, 1);
    }

    #[test]
    fn returns_none_for_a_plain_launch() {
        assert!(parse(&["unityide"]).is_none());
    }

    #[test]
    fn returns_none_when_goto_has_no_value() {
        assert!(parse(&["unityide", "--goto"]).is_none());
    }

    #[test]
    fn treats_a_following_flag_as_not_a_project_path() {
        let t = parse(&["unityide", "--goto", "/a/b.cs:3:4", "--other"]).expect("parsed");
        assert_eq!(t.project, None);
    }

    // ── project-only shapes ──────────────────────────────────────────────

    #[test]
    fn parses_an_explicit_project_flag() {
        let t = parse(&["unityide", "--project", "/Users/me/Proj"]).expect("parsed");
        assert_eq!(t.project.as_deref(), Some("/Users/me/Proj"));
        assert_eq!(t.file, None);
        assert_eq!(t.line, 1);
    }

    #[test]
    fn returns_none_when_project_flag_has_no_value() {
        assert!(parse(&["unityide", "--project"]).is_none());
        assert!(parse(&["unityide", "--project", "--other"]).is_none());
    }

    /// What `Assets > Open C# Project` sends. This used to parse to nothing.
    #[test]
    fn parses_a_bare_positional_as_a_project() {
        let t = parse(&["unityide", "/Users/me/Proj"]).expect("parsed");
        assert_eq!(t.project.as_deref(), Some("/Users/me/Proj"));
        assert_eq!(t.file, None);
    }

    #[test]
    fn a_bare_positional_that_is_a_file_opens_as_a_file() {
        let t = parse_open_with(&argv(&["unityide", "/Users/me/Proj/Player.cs"]), |_| true)
            .expect("parsed");
        assert_eq!(t.file.as_deref(), Some("/Users/me/Proj/Player.cs"));
        assert_eq!(t.project, None);
    }

    /// `--goto` wins over a positional so the legacy shape can never be
    /// reinterpreted by the new one.
    #[test]
    fn goto_takes_precedence_over_a_positional() {
        let t = parse(&["unityide", "/Users/me/Proj", "--goto", "/a/b.cs:5"]).expect("parsed");
        assert_eq!(t.file.as_deref(), Some("/a/b.cs"));
        assert_eq!(t.line, 5);
    }

    // ── deep links are never paths ───────────────────────────────────────

    #[test]
    fn ignores_a_deep_link_url() {
        assert!(parse(&["unityide", "unityide://auth/callback?code=1"]).is_none());
        assert!(parse(&["unityide", "unityide-dev://auth/callback?code=1"]).is_none());
    }

    #[test]
    fn a_deep_link_does_not_shadow_a_real_project_arg() {
        let t = parse(&["unityide", "unityide://x/y", "/Users/me/Proj"]).expect("parsed");
        assert_eq!(t.project.as_deref(), Some("/Users/me/Proj"));
    }

    // ── same_path ────────────────────────────────────────────────────────

    #[test]
    fn same_path_ignores_separator_drive_case_and_trailing_slash() {
        assert!(same_path(r"C:\Proj", "c:/proj"));
        assert!(same_path("/Users/me/Proj/", "/Users/me/Proj"));
        assert!(!same_path("/Users/me/A", "/Users/me/B"));
    }

    /// The symlink case: the window's path went through `canonicalize_path`,
    /// Unity's did not.
    #[test]
    fn same_path_matches_through_a_symlink() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real");
        std::fs::create_dir(&real).expect("mkdir");
        let link = dir.path().join("link");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&real, &link).is_err() {
            return; // unprivileged Windows cannot create symlinks; nothing to assert
        }

        assert!(same_path(
            &link.to_string_lossy(),
            &std::fs::canonicalize(&real).expect("canon").to_string_lossy()
        ));
    }

    #[test]
    fn same_path_does_not_match_two_unrelated_missing_paths() {
        assert!(!same_path("/nope/one", "/nope/two"));
    }

    // ── deep links ───────────────────────────────────────────────────────
    //
    // The route Unity takes first now: it needs no idea where the app is
    // installed, because the OS already knows.

    fn link(s: &str) -> url::Url {
        url::Url::parse(s).expect("parsed")
    }

    #[test]
    fn parses_a_project_and_file_deep_link() {
        let t = parse_deep_link(&link(
            "unityide://open?project=%2FUsers%2Fme%2FProj\
             &file=%2FUsers%2Fme%2FProj%2FAssets%2FPlayer.cs&line=42&column=7",
        ))
        .expect("parsed");
        assert_eq!(t.project.as_deref(), Some("/Users/me/Proj"));
        assert_eq!(t.file.as_deref(), Some("/Users/me/Proj/Assets/Player.cs"));
        assert_eq!(t.line, 42);
        assert_eq!(t.column, 7);
    }

    #[test]
    fn parses_a_project_only_deep_link() {
        let t = parse_deep_link(&link("unityide://open?project=%2FUsers%2Fme%2FProj"))
            .expect("parsed");
        assert_eq!(t.project.as_deref(), Some("/Users/me/Proj"));
        assert_eq!(t.file, None);
        assert_eq!(t.line, 1);
        assert_eq!(t.column, 1);
    }

    /// A Windows path percent-encodes its backslashes and its drive colon.
    #[test]
    fn a_windows_path_survives_percent_encoding() {
        let t = parse_deep_link(&link(
            "unityide://open?project=C%3A%5CProj&file=C%3A%5CProj%5CAssets%5CPlayer.cs&line=9",
        ))
        .expect("parsed");
        assert_eq!(t.project.as_deref(), Some(r"C:\Proj"));
        assert_eq!(t.file.as_deref(), Some(r"C:\Proj\Assets\Player.cs"));
        assert_eq!(t.line, 9);
    }

    #[test]
    fn a_path_with_spaces_and_non_ascii_survives() {
        let t = parse_deep_link(&link(
            "unityide://open?project=%2FUsers%2Fme%2FMy%20Unity%20Pr%C3%B8ject",
        ))
        .expect("parsed");
        assert_eq!(t.project.as_deref(), Some("/Users/me/My Unity Prøject"));
    }

    /// The dev build answers a different scheme; the shape is otherwise the
    /// same, and nothing here should care which one arrived.
    #[test]
    fn the_dev_scheme_parses_the_same_way() {
        let t = parse_deep_link(&link("unityide-dev://open?project=%2Fp")).expect("parsed");
        assert_eq!(t.project.as_deref(), Some("/p"));
    }

    /// The whole point of discriminating on the host: an auth callback must
    /// never be mistaken for an open request, in either direction.
    #[test]
    fn ignores_the_auth_callback() {
        assert!(parse_deep_link(&link("unityide://auth/callback?code=1&state=2")).is_none());
    }

    #[test]
    fn ignores_an_unknown_host() {
        assert!(parse_deep_link(&link("unityide://something-else?project=%2Fp")).is_none());
    }

    /// An empty request would be claimed by the first window to ask and then do
    /// nothing at all, which is worse than declining it here.
    #[test]
    fn ignores_an_open_link_that_names_nothing() {
        assert!(parse_deep_link(&link("unityide://open")).is_none());
        assert!(parse_deep_link(&link("unityide://open?line=42")).is_none());
        assert!(parse_deep_link(&link("unityide://open?project=&file=")).is_none());
    }

    #[test]
    fn a_junk_position_falls_back_to_the_top_of_the_file() {
        let t = parse_deep_link(&link(
            "unityide://open?file=%2Fa.cs&line=not-a-number&column=-4",
        ))
        .expect("parsed");
        assert_eq!(t.line, 1);
        assert_eq!(t.column, 1);
    }

    /// The cross-language contract, verbatim.
    ///
    /// Every URL below is the literal output of `UnityIDELauncher.BuildDeepLink`
    /// (`Uri.EscapeDataString` on .NET), captured by running that code rather
    /// than by reasoning about it. If the two encoders ever disagree — over a
    /// space, a `&`, a backslash, a non-ASCII byte — a double-click in Unity
    /// opens the wrong path or nothing at all, and nothing else in either suite
    /// would notice.
    #[test]
    fn decodes_what_the_unity_package_actually_encodes() {
        let cases: &[(&str, Option<&str>, Option<&str>, u32, u32)] = &[
            (
                "unityide://open?project=%2FUsers%2Fme%2FProj",
                Some("/Users/me/Proj"),
                None,
                1,
                1,
            ),
            (
                "unityide://open?project=%2FUsers%2Fme%2FProj\
                 &file=%2FUsers%2Fme%2FProj%2FAssets%2FPlayer.cs&line=42&column=7",
                Some("/Users/me/Proj"),
                Some("/Users/me/Proj/Assets/Player.cs"),
                42,
                7,
            ),
            (
                "unityide://open?project=C%3A%5CProj\
                 &file=C%3A%5CProj%5CAssets%5CPlayer.cs&line=9&column=1",
                Some(r"C:\Proj"),
                Some(r"C:\Proj\Assets\Player.cs"),
                9,
                1,
            ),
            // `&` and `#` raw would truncate the query; a space would end the
            // argument. This is the case that proves they do not.
            (
                "unityide://open?project=%2FUsers%2Fme%2FRock%20%26%20Roll%20%232",
                Some("/Users/me/Rock & Roll #2"),
                None,
                1,
                1,
            ),
            (
                "unityide://open?project=%2FUsers%2Fme%2FPr%C3%B8ject",
                Some("/Users/me/Prøject"),
                None,
                1,
                1,
            ),
            (
                "unityide-dev://open?project=%2Fp",
                Some("/p"),
                None,
                1,
                1,
            ),
        ];

        for (url, project, file, line, column) in cases {
            let parsed = parse_deep_link(&link(url)).unwrap_or_else(|| panic!("failed: {url}"));
            assert_eq!(parsed.project.as_deref(), *project, "project in {url}");
            assert_eq!(parsed.file.as_deref(), *file, "file in {url}");
            assert_eq!(parsed.line, *line, "line in {url}");
            assert_eq!(parsed.column, *column, "column in {url}");
        }
    }

    #[test]
    fn unknown_query_parameters_are_ignored() {
        let t = parse_deep_link(&link("unityide://open?project=%2Fp&utm_source=whatever"))
            .expect("parsed");
        assert_eq!(t.project.as_deref(), Some("/p"));
    }
}
