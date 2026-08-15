use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitFileStatus {
    pub path: String,
    pub absolute_path: String,
    pub status: String,
    pub staged: bool,
    /// True when this entry is an unmerged (conflicted) path. Conflicted files
    /// surface in the `unstaged` list with `staged: false` and this flag set so
    /// the SCM UI can offer merge-resolution affordances.
    #[serde(default)]
    pub conflicted: bool,
    /// For a rename/copy entry, the path this file had BEFORE the rename;
    /// `None` for every other status.
    ///
    /// `path` alone is the new path, which does not exist in HEAD — so a
    /// staged rename diffed as `HEAD:<path>` vs the index came back empty on
    /// the left and rendered as a 100%-added file. The HEAD side has to be
    /// read from this instead. Also lets the SCM row show `old → new`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitStatusResult {
    pub branch: String,
    pub staged: Vec<GitFileStatus>,
    pub unstaged: Vec<GitFileStatus>,
    pub ahead: i32,
    pub behind: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

fn map_status_char(c: char) -> &'static str {
    match c {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        '?' => "untracked",
        '.' => "unchanged",
        _ => "unknown",
    }
}

/// Resolve the root of the repository containing `workspace_path`, expressed
/// in the caller's own path spelling.
///
/// Every git path in this module is repo-root-relative, because that is the
/// only base all of git's own interfaces agree on: `git show <rev>:<path>`
/// resolves against the repo root, `git show --name-status` *emits* root
/// -relative paths, and `git status --porcelain` can be made to emit them with
/// `status.relativePaths=false`. Without this normalization, a workspace
/// opened at a subdirectory of the repo fed CWD-relative status paths into
/// root-relative object specs — which silently returned a DIFFERENT file's
/// contents whenever a same-named path existed nearer the root.
///
/// Derived by stripping `git rev-parse --show-prefix` (the CWD's path relative
/// to the root — `UnityProject/`, or empty at the root itself) off the tail of
/// `workspace_path`, deliberately NOT by reading `--show-toplevel`.
/// `--show-toplevel` resolves symlinks, so on macOS a workspace opened at
/// `/tmp/x` comes back as `/private/tmp/x`; `absolute_path` would then stop
/// matching the frontend's tree node ids and every explorer git badge would
/// quietly disappear. Stripping a relative prefix preserves the caller's
/// spelling and can't introduce that drift. `--show-toplevel` is kept only as
/// a fallback for the odd spelling that won't strip (`..` segments, say).
///
/// Not cached: `--show-prefix` costs ~3ms against ~9ms for the `git status` it
/// accompanies, and a cache that went stale (`git init` in a subdirectory of
/// an open workspace) would resurrect exactly the silent wrong-file-contents
/// failure this function exists to prevent.
fn repo_root(workspace_path: &str) -> Result<String, String> {
    let prefix_out = crate::process_util::command("git")
        .args(["-C", workspace_path, "rev-parse", "--show-prefix"])
        // Read-only command — see the comment on `git_status`'s call.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| e.to_string())?;

    if !prefix_out.status.success() {
        // Outside a repo git says "fatal: not a git repository (...)", which
        // `doRefreshStatus` in `stores/git.ts` classifies to blank the SCM
        // panel rather than show an error banner. Pass it through verbatim.
        return Err(String::from_utf8_lossy(&prefix_out.stderr).to_string());
    }

    let prefix = String::from_utf8_lossy(&prefix_out.stdout)
        .trim()
        .trim_end_matches('/')
        .to_string();
    let workspace = workspace_path.trim_end_matches('/');

    if prefix.is_empty() {
        return Ok(workspace.to_string());
    }

    if let Some(root) = workspace.strip_suffix(&format!("/{prefix}")) {
        // A workspace one level below the filesystem root strips to "", which
        // as a `-C` argument would mean "current directory" rather than "/".
        return Ok(if root.is_empty() {
            "/".to_string()
        } else {
            root.to_string()
        });
    }

    // The prefix didn't line up with the caller's spelling (`..` segments, a
    // case-insensitive filesystem, ...). Fall back to the authoritative answer
    // and accept the symlink-resolution risk in this rare case.
    let toplevel = crate::process_util::command("git")
        .args(["-C", workspace_path, "rev-parse", "--show-toplevel"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !toplevel.status.success() {
        return Err(String::from_utf8_lossy(&toplevel.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&toplevel.stdout).trim().to_string())
}

/// Expose `repo_root` to the frontend.
///
/// Every path in a `GitFileStatus` / `CommitFileChange` is repo-root-relative,
/// so any frontend code that needs to turn one back into a filesystem path
/// (reading the worktree side of a diff, say) has to join it against the root
/// rather than the opened workspace — those differ whenever the workspace is a
/// subdirectory of the repository.
#[tauri::command]
pub fn git_repo_root(workspace_path: String) -> Result<String, String> {
    repo_root(&workspace_path)
}

#[tauri::command]
pub fn git_status(workspace_path: String) -> Result<GitStatusResult, String> {
    let workspace_path = repo_root(&workspace_path)?;
    let output = crate::process_util::command("git")
        .args([
            // Emit paths relative to the repo root rather than the CWD. The
            // command already runs at the root so this is belt-and-braces,
            // but it makes the contract explicit and immune to a stray
            // `status.relativePaths` in the user's config.
            "-c",
            "status.relativePaths=false",
            "-C",
            &workspace_path,
            "status",
            "--porcelain=v2",
            "--branch",
            // List untracked files individually. Git's default collapses a
            // directory of new files into one `? newfolder/` entry — a row
            // the panel can neither diff nor discard, because it's a
            // directory. This is what VS Code passes too.
            "-uall",
            // NUL-delimit records so paths arrive as raw bytes. Without it
            // git C-quotes anything non-ASCII or containing a quote
            // (`"h\303\251llo.txt"`), and that literal string then fails as a
            // pathspec, as a file to read, and as an explorer-node match.
            // `core.quotePath=false` fixes only the non-ASCII half.
            "-z",
        ])
        // Read-only command: opt out of git's opportunistic `.git/index`
        // refresh-write. The file watcher treats `.git/index` as a
        // git-state path (see file_scanner.rs), so without this a
        // `git-state-changed` event would trigger a `git status` call that
        // itself rewrites the index, re-triggering the watcher — an
        // infinite feedback loop. Mutating commands (add/commit/etc.) must
        // NOT set this — they take a mandatory lock regardless.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_status(&stdout, &workspace_path))
}

/// Parse `git status --porcelain=v2 --branch -z` output into the frontend's
/// status shape. Pure so the porcelain field layout is pinned by direct
/// tests — a silent field-count mismatch here drops entries from the SCM
/// panel with no error anywhere.
///
/// Records are NUL-separated rather than newline-separated (`-z`), which is
/// what keeps paths unquoted. One consequence needs care: a rename/copy entry
/// spans TWO records — the entry itself, then the original path on its own.
/// Verified against git 2.52.0:
///
/// ```text
/// 2 RM N... ... R100 src/new-name.txt\0src/old-name.txt\0
/// ```
///
/// So this iterates an explicit cursor instead of a `for` loop: the `2 ` arm
/// consumes the following record. Treating that record as a fresh entry would
/// shift every subsequent one by a position.
fn parse_status(stdout: &str, workspace_path: &str) -> GitStatusResult {
    let mut branch = String::from("HEAD");
    let mut ahead: i32 = 0;
    let mut behind: i32 = 0;
    let mut staged: Vec<GitFileStatus> = Vec::new();
    let mut unstaged: Vec<GitFileStatus> = Vec::new();

    // A trailing NUL yields a final empty record; `filter` drops it (and any
    // stray blank) so it can't be mistaken for an entry.
    let records: Vec<&str> = stdout.split('\0').filter(|r| !r.is_empty()).collect();
    let mut idx = 0;
    while idx < records.len() {
        let line = records[idx];
        idx += 1;
        if let Some(name) = line.strip_prefix("# branch.head ") {
            branch = name.to_string();
            continue;
        }

        if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
            continue;
        }

        if let Some(rest) = line.strip_prefix("1 ") {
            // Ordinary changed entry: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // — 8 fields after the prefix. splitn's last capture is <path>,
            // which may contain spaces.
            let parts: Vec<&str> = rest.splitn(8, ' ').collect();
            if parts.len() < 8 {
                continue;
            }
            let xy = parts[0];
            let path = parts[7];
            let mut xy_chars = xy.chars();
            let x = xy_chars.next().unwrap_or('.');
            let y = xy_chars.next().unwrap_or('.');

            let absolute_path = format!("{}/{}", workspace_path, path);

            if x != '.' {
                staged.push(GitFileStatus {
                    path: path.to_string(),
                    absolute_path: absolute_path.clone(),
                    status: map_status_char(x).to_string(),
                    staged: true,
                    conflicted: false,
                    orig_path: None,
                });
            }
            if y != '.' {
                unstaged.push(GitFileStatus {
                    path: path.to_string(),
                    absolute_path,
                    status: map_status_char(y).to_string(),
                    staged: false,
                    conflicted: false,
                    orig_path: None,
                });
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // Renamed/copied entry, which under `-z` spans two records:
            //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
            //   <origPath>
            // — 9 fields after the prefix, then the original path alone in the
            // NEXT record. Consuming it here is what keeps the entries after a
            // rename from shifting by one.
            let parts: Vec<&str> = rest.splitn(9, ' ').collect();
            if parts.len() < 9 {
                continue;
            }
            let xy = parts[0];
            let path = parts[8];
            let orig_path = records.get(idx).map(|s| s.to_string());
            idx += 1;
            let mut xy_chars = xy.chars();
            let x = xy_chars.next().unwrap_or('.');
            let y = xy_chars.next().unwrap_or('.');

            let absolute_path = format!("{}/{}", workspace_path, path);

            if x != '.' {
                staged.push(GitFileStatus {
                    path: path.to_string(),
                    absolute_path: absolute_path.clone(),
                    status: map_status_char(x).to_string(),
                    staged: true,
                    conflicted: false,
                    orig_path: orig_path.clone(),
                });
            }
            if y != '.' {
                // The worktree-side change of a rename is an ordinary edit to
                // the file at its NEW path, so the pre-rename path is not
                // meaningful for it — only the staged (index) side diffs
                // against HEAD.
                unstaged.push(GitFileStatus {
                    path: path.to_string(),
                    absolute_path,
                    status: map_status_char(y).to_string(),
                    staged: false,
                    conflicted: false,
                    orig_path: None,
                });
            }
        } else if let Some(rest) = line.strip_prefix("u ") {
            // Unmerged (conflicted) entry:
            //   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            // We only need the conflict marker pair and the path.
            let parts: Vec<&str> = rest.splitn(10, ' ').collect();
            if parts.len() < 10 {
                continue;
            }
            let path = parts[9];
            let absolute_path = format!("{}/{}", workspace_path, path);
            unstaged.push(GitFileStatus {
                path: path.to_string(),
                absolute_path,
                status: "conflicted".to_string(),
                staged: false,
                conflicted: true,
                orig_path: None,
            });
        } else if let Some(rest) = line.strip_prefix("? ") {
            // Untracked entry: ? <path>
            let path = rest;
            let absolute_path = format!("{}/{}", workspace_path, path);
            unstaged.push(GitFileStatus {
                path: path.to_string(),
                absolute_path,
                status: "untracked".to_string(),
                staged: false,
                conflicted: false,
                orig_path: None,
            });
        }
    }

    GitStatusResult {
        branch,
        staged,
        unstaged,
        ahead,
        behind,
    }
}

/// A branch as surfaced to the frontend's branch picker: its name, plus the
/// unix timestamp (seconds) of the most recent `git reflog`-recorded
/// checkout onto it, when known. `None` covers both "no reflog entry exists
/// for this branch yet" (e.g. it was created but never checked out) and "the
/// reflog itself couldn't be read" (fresh repo, no commits yet) — both cases
/// degrade to "no recency data", never an error.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BranchInfo {
    /// Display name: `main` for a local branch, `origin/feature-x` for a
    /// remote-tracking one.
    pub name: String,
    pub last_checkout_ts: Option<i64>,
    /// True for a remote-tracking branch (`refs/remotes/**`). The picker groups
    /// these below local branches, and checking one out goes through
    /// `git_checkout_remote_branch` rather than a plain switch.
    #[serde(default)]
    pub is_remote: bool,
    /// For a remote branch, the local branch name to create or switch to
    /// (`origin/feature-x` -> `feature-x`). `None` for local branches.
    ///
    /// Taken from `%(refname:lstrip=3)` rather than by splitting `name` on the
    /// first `/`, so a nested branch name like `origin/release/1.x` resolves to
    /// `release/1.x` instead of `release`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_name: Option<String>,
}

/// Parse `git reflog --date=unix` output into a map of branch name → unix
/// timestamp of the most recent `checkout: moving from A to B` entry that
/// named it as the TARGET (`B`). Every other reflog action (`commit`,
/// `clone`, `branch`, `merge`, `pull`, ...) is skipped — those lines simply
/// don't contain the `: checkout: moving from ` marker this function looks
/// for. Malformed/garbage lines (missing `HEAD@{...}`, a non-numeric
/// timestamp, no `to` separator) are likewise skipped rather than treated as
/// an error, since a single unparseable reflog line must never take down the
/// whole branch list.
///
/// `git reflog` prints newest-first, so the FIRST entry seen for a given
/// target branch is its most recent checkout — `HashMap::entry().or_insert()`
/// during straight forward iteration gives exactly that "newest wins" result
/// for free, no explicit max/sort needed.
///
/// Branch (and ref) names can never contain a space, so splitting the
/// `"<from> to <to>"` remainder on the literal `" to "` is unambiguous even
/// for slashed names like `feature/x`.
///
/// A detached-HEAD checkout target is a raw (abbreviated or full) SHA rather
/// than a branch name — e.g. `checkout: moving from main to
/// f54bc437f72428517cd7d03ee59760aff5e4247c`. Such an entry is recorded under
/// that SHA same as any other target; harmless, since `git_list_branches`
/// only ever looks up real branch names when joining, so a SHA key simply
/// never matches anything (cheaper than special-casing SHA-shaped targets
/// here).
///
/// Verbatim fixtures used in this module's tests were generated in a scratch
/// repo — see the task-8 report for the exact commands and full provenance.
fn parse_checkout_timestamps(reflog_output: &str) -> HashMap<String, i64> {
    const MARKER: &str = "HEAD@{";
    const ACTION: &str = ": checkout: moving from ";

    let mut result: HashMap<String, i64> = HashMap::new();

    for line in reflog_output.lines() {
        let Some(marker_pos) = line.find(MARKER) else {
            continue;
        };
        let after_marker = &line[marker_pos + MARKER.len()..];
        let Some(close_pos) = after_marker.find('}') else {
            continue;
        };
        let Ok(ts) = after_marker[..close_pos].parse::<i64>() else {
            continue;
        };

        let rest = &after_marker[close_pos + 1..];
        let Some(action_rest) = rest.strip_prefix(ACTION) else {
            continue;
        };
        let Some((_from, to)) = action_rest.split_once(" to ") else {
            continue;
        };
        if to.is_empty() {
            continue;
        }

        result.entry(to.to_string()).or_insert(ts);
    }

    result
}

/// List branches, each annotated with its last-checkout recency sourced from
/// `git reflog` (true last-checkout time, including checkouts made outside
/// this app via the CLI). Base ordering is alphabetical by name (matching
/// the pre-recency behavior) — the frontend's `branch-results` layer is
/// responsible for any recency-based re-sort.
///
/// The reflog read is best-effort: on failure (most commonly a brand-new
/// repo with no commits yet, where `git reflog` errors with "does not have
/// any commits yet") every branch simply gets `last_checkout_ts: None` —
/// this command never fails because reflog data happens to be unavailable.
/// Parse `git for-each-ref` output (one NUL-joined
/// `<refname>\0<lstrip2>\0<lstrip3>\0<symref>` record per line) into branch
/// entries. Pure so the ref-name handling is pinned by direct tests.
///
/// Two things this gets right that `git branch --list --format=%(refname:short)`
/// did not:
///
/// - **Names survive tag collisions.** `%(refname:short)` shortens a ref only
///   as far as stays unambiguous, so a branch named `v1.0.0` that also has a
///   tag `v1.0.0` comes back as `heads/v1.0.0` — a string `git switch` then
///   rejects (`fatal: a branch is expected`). `%(refname:lstrip=2)` always
///   yields the real name.
/// - **`refs/remotes/*/HEAD` is dropped.** It's a symbolic ref, not a branch;
///   left in, it renders as a bare `origin` row that checks out nothing.
fn parse_branch_refs(stdout: &str) -> Vec<BranchInfo> {
    let mut branches: Vec<BranchInfo> = Vec::new();

    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\0');
        let (Some(refname), Some(name), Some(local), symref) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next().unwrap_or(""),
        ) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        // A non-empty symref means this is `refs/remotes/<remote>/HEAD`.
        if !symref.is_empty() {
            continue;
        }

        let is_remote = refname.starts_with("refs/remotes/");
        branches.push(BranchInfo {
            name: name.to_string(),
            last_checkout_ts: None,
            is_remote,
            local_name: if is_remote && !local.is_empty() {
                Some(local.to_string())
            } else {
                None
            },
        });
    }

    branches
}

/// List local and remote-tracking branches, each annotated with its
/// last-checkout recency sourced from `git reflog` (true last-checkout time,
/// including checkouts made outside this app via the CLI). Base ordering is
/// local branches first, then remotes, alphabetical within each group — the
/// frontend's `branch-results` layer applies any recency re-sort.
///
/// The reflog read is best-effort: on failure (most commonly a brand-new repo
/// with no commits yet, where `git reflog` errors with "does not have any
/// commits yet") every branch simply gets `last_checkout_ts: None` — this
/// command never fails because reflog data happens to be unavailable.
#[tauri::command]
pub fn git_list_branches(workspace_path: String) -> Result<Vec<BranchInfo>, String> {
    let output = crate::process_util::command("git")
        .args([
            "-C",
            &workspace_path,
            "for-each-ref",
            // <refname>\0<display name>\0<local name>\0<symref>
            "--format=%(refname)%00%(refname:lstrip=2)%00%(refname:lstrip=3)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    let mut branches = parse_branch_refs(&String::from_utf8_lossy(&output.stdout));
    branches.sort_by(|a, b| a.is_remote.cmp(&b.is_remote).then_with(|| a.name.cmp(&b.name)));

    let timestamps = crate::process_util::command("git")
        .args(["-C", &workspace_path, "reflog", "--date=unix"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_checkout_timestamps(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();

    for branch in &mut branches {
        branch.last_checkout_ts = timestamps.get(&branch.name).copied();
    }

    Ok(branches)
}

/// Check out a remote-tracking branch the way VS Code does: create a local
/// branch of the same name tracking it, or — if that local branch already
/// exists — simply switch to it. Returns the local branch name now checked
/// out.
///
/// `remote_branch` is a display name like `origin/feature-x`; `local_name` is
/// derived by the caller from `%(refname:lstrip=3)` so nested names
/// (`origin/release/1.x` -> `release/1.x`) survive. Falling back to splitting
/// on the first `/` here would mangle those, so an explicit local name is
/// required rather than inferred.
#[tauri::command]
pub fn git_checkout_remote_branch(
    workspace_path: String,
    remote_branch: String,
) -> Result<String, String> {
    validate_ref_name(&remote_branch)?;

    // Strip the remote name off the front. `git remote` is authoritative —
    // matching the longest configured remote avoids mis-splitting a branch
    // whose own name contains a slash.
    let remotes_out = crate::process_util::command("git")
        .args(["-C", &workspace_path, "remote"])
        .output()
        .map_err(|e| e.to_string())?;
    let remotes = String::from_utf8_lossy(&remotes_out.stdout);
    let local_name = remotes
        .lines()
        .filter_map(|r| remote_branch.strip_prefix(&format!("{}/", r.trim())))
        .max_by_key(|s| remote_branch.len() - s.len())
        .ok_or_else(|| format!("'{remote_branch}' does not name a remote branch"))?
        .to_string();

    if local_name.is_empty() {
        return Err(format!("'{remote_branch}' does not name a remote branch"));
    }

    // Already have the local branch? Just switch — re-creating it would fail.
    let exists = crate::process_util::command("git")
        .args([
            "-C",
            &workspace_path,
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{local_name}"),
        ])
        .output()
        .map_err(|e| e.to_string())?
        .status
        .success();

    let args: Vec<String> = if exists {
        vec![
            "-C".into(),
            workspace_path.clone(),
            "switch".into(),
            local_name.clone(),
        ]
    } else {
        vec![
            "-C".into(),
            workspace_path.clone(),
            "switch".into(),
            "-c".into(),
            local_name.clone(),
            "--track".into(),
            remote_branch.clone(),
        ]
    };

    let output = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(local_name)
}

#[tauri::command]
pub fn git_switch_branch(workspace_path: String, branch: String) -> Result<(), String> {
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "switch", &branch])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn git_diff(
    workspace_path: String,
    file_path: String,
    staged: bool,
) -> Result<String, String> {
    // `file_path` is repo-root-relative (see `repo_root`); pathspecs resolve
    // against the CWD, so the command has to run at the root.
    let workspace_path = repo_root(&workspace_path)?;
    let mut args = vec!["-C", &workspace_path, "diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&file_path);

    let output = crate::process_util::command("git")
        .args(&args)
        // Read-only command — see the comment on `git_status`'s call.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

/// Diff a single file against HEAD, combining staged and unstaged changes —
/// what the editor gutter should reflect (`git diff <path>` alone would miss
/// staged-but-uncommitted edits). `HEAD` is a hardcoded literal, never
/// user-supplied, so it needs no ref validation; `file_path` is passed after
/// `--` so it can never be parsed as a flag, but an empty path is still
/// rejected explicitly since `git diff HEAD --` (no path) would diff the
/// whole tree instead of erroring.
///
/// For a file with no HEAD version (untracked/newly added), this returns an
/// empty diff — the gutter simply shows no decorations for it. Acceptable
/// for v1.
#[tauri::command]
pub fn git_diff_file_head(workspace_path: String, file_path: String) -> Result<String, String> {
    if file_path.is_empty() {
        return Err("file path must not be empty".to_string());
    }

    let workspace_path = repo_root(&workspace_path)?;
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "diff", "HEAD", "--", &file_path])
        // Read-only command — see the comment on `git_status`'s call.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

#[tauri::command]
pub fn git_stage_file(workspace_path: String, file_path: String) -> Result<(), String> {
    let workspace_path = repo_root(&workspace_path)?;
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "add", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn git_unstage_file(workspace_path: String, file_path: String) -> Result<(), String> {
    let workspace_path = repo_root(&workspace_path)?;
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "restore", "--staged", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn git_stage_all(workspace_path: String) -> Result<(), String> {
    // Run at the root so "stage all" means every file the panel lists, not
    // just the ones under a subdirectory workspace.
    let workspace_path = repo_root(&workspace_path)?;
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "add", "-A"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

/// Create a commit. When `amend` is `true`, rewrites HEAD (`git commit
/// --amend -m <message>`) instead of creating a new commit — used by the
/// "Amend Last Commit" flow. `amend` defaults to `false` when omitted so
/// existing callers that don't pass it are unaffected.
#[tauri::command]
pub fn git_commit(
    workspace_path: String,
    message: String,
    amend: Option<bool>,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["-C", &workspace_path, "commit"];
    if amend.unwrap_or(false) {
        args.push("--amend");
    }
    args.push("-m");
    args.push(&message);

    let output = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// A8: Stash push/list/apply/pop/drop
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    pub date: String,
}

/// Parse the numeric index out of a `stash@{N}` reflog selector (as produced
/// by `%gd`). Returns `None` for anything not matching that exact shape.
fn parse_stash_index(gd: &str) -> Option<u32> {
    gd.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()
}

/// Build a `stash@{N}` ref from a caller-supplied index. Indices are always
/// constructed here from a `u32` — never interpolated from a raw string — so
/// there is no argument-injection surface for `git_stash_apply`/`_pop`/`_drop`.
fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

#[tauri::command]
pub fn git_stash_push(
    workspace_path: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "-C".into(),
        workspace_path,
        "stash".into(),
        "push".into(),
    ];
    if include_untracked {
        args.push("-u".into());
    }
    if let Some(m) = message {
        args.push("-m".into());
        args.push(m);
    }

    let output = crate::process_util::command("git")
        .args(args.iter().map(String::as_str).collect::<Vec<_>>())
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// List stashes via `git stash list --format=%gd%x00%gs%x00%ci`: `%gd` is the
/// `stash@{N}` reflog selector (index parsed from it), `%gs` the reflog
/// subject (the stash "message"), `%ci` the committer date.
#[tauri::command]
pub fn git_stash_list(workspace_path: String) -> Result<Vec<StashEntry>, String> {
    let output = crate::process_util::command("git")
        .args([
            "-C",
            &workspace_path,
            "stash",
            "list",
            "--format=%gd%x00%gs%x00%ci",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, '\0').collect();
            if parts.len() < 3 {
                return None;
            }
            let index = parse_stash_index(parts[0])?;
            Some(StashEntry {
                index,
                message: parts[1].to_string(),
                date: parts[2].to_string(),
            })
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub fn git_stash_apply(workspace_path: String, index: u32) -> Result<(), String> {
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "stash", "apply", &stash_ref(index)])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn git_stash_pop(workspace_path: String, index: u32) -> Result<(), String> {
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "stash", "pop", &stash_ref(index)])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn git_stash_drop(workspace_path: String, index: u32) -> Result<(), String> {
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "stash", "drop", &stash_ref(index)])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Fetch a file's content at HEAD (`git show HEAD:<file_path>`).
///
/// `Ok(String::new())` for the "no HEAD version" cases (new/untracked file —
/// same stderr shapes `git_show_file_at` already classifies: `does not exist
/// in 'HEAD'` when the path never existed, `exists on disk, but not in
/// 'HEAD'` when it's untracked on disk); `Err(stderr)` for everything else
/// (e.g. `workspace_path` isn't a git repo at all), so a genuinely broken repo
/// is no longer indistinguishable from a plain new file.
#[tauri::command]
pub fn git_show_head(workspace_path: String, file_path: String) -> Result<String, String> {
    let workspace_path = repo_root(&workspace_path)?;
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "show", &format!("HEAD:{}", file_path)])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let missing_path =
            stderr.contains("does not exist in") || stderr.contains("exists on disk, but not in");
        if missing_path {
            return Ok(String::new());
        }
        return Err(stderr.to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Content of `file_path` as staged in the index (`git show :<file_path>` —
/// stage 0).
///
/// `Ok(String::new())` when the path isn't in the index at all — untracked
/// (`fatal: path '<p>' exists on disk, but not in the index`), never existed
/// (`fatal: path '<p>' does not exist (neither on disk nor in the index)`),
/// or a staged deletion (which leaves the same "exists on disk, but not in
/// the index" shape once removed from the index). `Err(stderr)` for
/// everything else — including unmerged/conflicted paths, which have no
/// stage 0 at all (`fatal: path '<p>' is in the index, but not at stage 0`)
/// and so must not be silently swallowed into an empty diff.
#[tauri::command]
pub fn git_show_index(workspace_path: String, file_path: String) -> Result<String, String> {
    let workspace_path = repo_root(&workspace_path)?;
    let spec = format!(":{}", file_path);
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "show", &spec])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Note: unlike `git_show_file_at`'s `<rev>:<path>` form (whose
        // "missing" message is `does not exist in '<rev>'`), the stage-0
        // `:<path>` form phrases the never-existed case as `does not exist
        // (neither on disk nor in the index)` — no trailing "in" — so the
        // "does not exist" check here is intentionally broader than
        // `git_show_file_at`'s.
        let missing_from_index =
            stderr.contains("does not exist") || stderr.contains("exists on disk, but not in");
        if missing_from_index {
            return Ok(String::new());
        }
        return Err(stderr.to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommitFileChange {
    pub path: String,
    /// Same vocabulary as `GitFileStatus.status` ("modified"/"added"/"deleted"/
    /// "renamed"/…) so the frontend's `statusLabel()` helper can be reused
    /// as-is for the per-file letter (A/M/D/R).
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommitDetail {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub files: Vec<CommitFileChange>,
}

/// Fetch a single commit's metadata + changed-files list.
///
/// `--no-patch` suppresses `--name-status` too (both are diff output), so we
/// can't combine them — instead this runs a single `git show` with
/// `--name-status` and a `%x00`-delimited `--format` header. Output shape:
/// `<hash>\0<subject>\0<author>\0<date>` on the first line, a blank line,
/// then one name-status line per changed file (`M\tpath`, `A\tpath`, or
/// `R100\told\tnew` for renames — the score-suffixed R/C codes are the only
/// ones with a third column).
///
/// `--first-parent -m` is what makes MERGE commits work. By default git
/// suppresses diff output for a merge entirely, so `git show <merge>
/// --name-status` emits the header and nothing else — every merge in the
/// Commits list rendered as "No file changes". `-m` diffs against each parent
/// and `--first-parent` restricts that to the first, giving "what did merging
/// this bring onto my branch", which is the question the panel is asking.
/// Ordinary single-parent and root commits are unaffected (verified).
///
/// Because `-m` emits one header per parent diff, only the FIRST header is
/// treated as the metadata line; any later one is skipped rather than parsed
/// as a file.
#[tauri::command]
pub fn git_show_commit(workspace_path: String, hash: String) -> Result<CommitDetail, String> {
    validate_ref_name(&hash)?;
    let workspace_path = repo_root(&workspace_path)?;

    let output = crate::process_util::command("git")
        .args([
            "-C",
            &workspace_path,
            "show",
            &hash,
            "--name-status",
            "--format=%H%x00%s%x00%an%x00%aI",
            // See the doc comment: without these, merge commits report no
            // changed files at all.
            "--first-parent",
            "-m",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();

    let header = lines
        .next()
        .ok_or_else(|| "git show returned no output".to_string())?;
    let parts: Vec<&str> = header.splitn(4, '\0').collect();
    if parts.len() < 4 {
        return Err(format!("unexpected git show header: {header}"));
    }
    let commit_hash = parts[0].to_string();
    let message = parts[1].to_string();
    let author = parts[2].to_string();
    let date = parts[3].to_string();

    let mut files: Vec<CommitFileChange> = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        // `-m` repeats the `--format` header once per parent diff. Those lines
        // are NUL-delimited (a name-status line never is), so skipping on that
        // keeps a repeated header from being parsed as a bogus file entry.
        if line.contains('\0') {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        let Some(status_code) = cols.first() else {
            continue;
        };
        let status_char = status_code.chars().next().unwrap_or('?');

        // Rename/copy lines carry three columns: <status>\t<old>\t<new>.
        // Use the new path; everything else is <status>\t<path>.
        let path = if (status_char == 'R' || status_char == 'C') && cols.len() >= 3 {
            cols[2].to_string()
        } else {
            cols.get(1).copied().unwrap_or("").to_string()
        };
        if path.is_empty() {
            continue;
        }

        files.push(CommitFileChange {
            path,
            status: map_status_char(status_char).to_string(),
        });
    }

    Ok(CommitDetail {
        hash: commit_hash,
        message,
        author,
        date,
        files,
    })
}

/// Fetch a file's content at a given revision (`git show <rev>:<file_path>`).
///
/// Returns `Ok("")` — rather than erroring — for the two "nothing to diff
/// against" cases the commit-diff UI relies on:
/// - the path doesn't exist at `rev` (file was added or deleted by the commit
///   being viewed), and
/// - `rev` is `<hash>^` on a root commit (no parent to show), which the
///   caller uses to diff a first-commit file against empty.
///
/// Both failure modes surface as `fatal: invalid object name '<rev>'` from
/// git, indistinguishable by message alone from a genuinely bad revision —
/// so the root-commit case is recognized by `rev` itself ending in `^`
/// (that's the only shape this command is ever called with for a parent
/// reference). A truly invalid `rev` with no trailing `^` still errors.
#[tauri::command]
pub fn git_show_file_at(
    workspace_path: String,
    rev: String,
    file_path: String,
) -> Result<String, String> {
    validate_ref_name(&rev)?;

    let workspace_path = repo_root(&workspace_path)?;
    let spec = format!("{rev}:{file_path}");
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "show", &spec])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let missing_path =
            stderr.contains("does not exist in") || stderr.contains("exists on disk, but not in");
        let root_commit_no_parent = rev.ends_with('^') && stderr.contains("invalid object name");
        if missing_path || root_commit_no_parent {
            return Ok(String::new());
        }
        return Err(stderr.to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub fn git_unstage_all(workspace_path: String) -> Result<(), String> {
    let workspace_path = repo_root(&workspace_path)?;
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "reset", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn git_discard_file(
    workspace_path: String,
    file_path: String,
    is_untracked: bool,
) -> Result<(), String> {
    let workspace_path = repo_root(&workspace_path)?;
    if is_untracked {
        // `git clean` rather than `std::fs::remove_file`: the latter errors
        // outright on a directory ("Is a directory") and leaves empty parent
        // directories behind after removing a nested file. `-d` is added only
        // for a directory target, since `git clean -f -- <dir>` alone refuses
        // to recurse into it.
        let full_path = std::path::Path::new(&workspace_path).join(&file_path);
        let mut args: Vec<&str> = vec!["-C", &workspace_path, "clean", "-f"];
        if full_path.is_dir() {
            args.push("-d");
        }
        args.push("--");
        args.push(&file_path);

        let output = crate::process_util::command("git")
            .args(&args)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    } else {
        let output = crate::process_util::command("git")
            .args(["-C", &workspace_path, "checkout", "--", &file_path])
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(stderr.to_string());
        }
    }

    Ok(())
}

#[tauri::command]
pub fn git_discard_all(workspace_path: String) -> Result<(), String> {
    // Must run at the root: both `checkout -- .` and `clean -fd` are scoped to
    // the current directory, so from a subdirectory workspace "discard all"
    // would silently leave every change outside that subtree in place while
    // the panel reported them discarded.
    let workspace_path = repo_root(&workspace_path)?;
    // Restore tracked files
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "checkout", "--", "."])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    // Remove untracked files
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "clean", "-fd"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

/// Decide what `GIT_SSH_COMMAND` should be set to for a remote git call, if
/// anything. git resolves its SSH transport with the precedence
/// `GIT_SSH_COMMAND` (env) > `core.sshCommand` (config) > plain `ssh`, so
/// unconditionally setting the env var would silently clobber a user's
/// corporate proxy wrapper or custom transport. Decision table:
///
/// | `GIT_SSH_COMMAND` env | `core.sshCommand` config | result |
/// |-----------------------|--------------------------|--------|
/// | set (non-empty)       | anything                 | `Some("<env> -oBatchMode=yes")` — keep the user's transport, add batch mode so it fails instead of prompting |
/// | unset/blank           | set (non-empty)          | `None` — set nothing; env beats config, so setting the env var would override the user's configured transport (`GIT_TERMINAL_PROMPT=0` still applies) |
/// | unset/blank           | unset/blank              | `Some("ssh -oBatchMode=yes")` — default ssh in batch mode |
fn ssh_command_override(env_val: Option<String>, config_val: Option<String>) -> Option<String> {
    if let Some(env) = env_val.filter(|v| !v.trim().is_empty()) {
        return Some(format!("{env} -oBatchMode=yes"));
    }
    if config_val.is_some_and(|v| !v.trim().is_empty()) {
        return None;
    }
    Some("ssh -oBatchMode=yes".to_string())
}

/// Read `core.sshCommand` from the repo's effective git config (local >
/// global > system). Returns `None` when unset or blank.
fn core_ssh_command(workspace_path: &str) -> Option<String> {
    let output = crate::process_util::command("git")
        .args(["-C", workspace_path, "config", "--get", "core.sshCommand"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Shared runner for the three network-touching git commands (fetch/pull/push).
///
/// `GIT_TERMINAL_PROMPT=0` is always set: it disables git's own interactive
/// username/password prompt (it errors immediately instead, e.g. "could not
/// read Username").
///
/// The SSH transport is nudged into batch mode (fail rather than prompt when
/// a key needs a passphrase or a host key must be accepted; an already-loaded
/// ssh-agent key still works fine) *without* clobbering a transport the user
/// configured themselves — see [`ssh_command_override`] for the precedence
/// rules.
///
/// stderr is returned verbatim (not wrapped) on failure so callers — both
/// `git_push`'s own retry logic and the frontend store — can string-match
/// specific git failure messages.
fn run_git_remote(workspace_path: &str, args: &[&str]) -> Result<String, String> {
    let env_ssh = std::env::var("GIT_SSH_COMMAND").ok();
    // Only consult git config when the env var can't decide on its own
    // (`git config --get` is one cheap local subprocess, but skipping it
    // when the env var wins is free).
    let config_ssh = if env_ssh.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        None
    } else {
        core_ssh_command(workspace_path)
    };

    let mut command = crate::process_util::command("git");
    command
        .args(["-C", workspace_path])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(ssh_command) = ssh_command_override(env_ssh, config_ssh) {
        command.env("GIT_SSH_COMMAND", ssh_command);
    }

    let output = command.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub fn git_fetch(workspace_path: String) -> Result<String, String> {
    run_git_remote(&workspace_path, &["fetch"])
}

#[tauri::command]
pub fn git_pull(workspace_path: String) -> Result<String, String> {
    run_git_remote(&workspace_path, &["pull"])
}

/// Result of `git_push`. `set_upstream` is `true` only when the plain `push`
/// failed with "no upstream branch" and this call transparently retried as
/// `push -u origin <branch>` — the frontend uses it to show a "pushed and set
/// upstream" toast instead of a plain "pushed" one. `stdout` is git's raw
/// output from whichever invocation (plain or retried) actually succeeded.
#[derive(Debug, Serialize, Deserialize)]
pub struct GitPushResult {
    pub stdout: String,
    pub set_upstream: bool,
}

/// Push the current branch. If the branch has no configured upstream (first
/// push of a new local branch), automatically resolve the current branch name
/// and retry once as `push -u origin <branch>` so the caller never has to
/// make a second round-trip. Any other failure (auth, rejected non-fast-
/// forward, etc.) is returned as-is with no retry.
#[tauri::command]
pub fn git_push(workspace_path: String) -> Result<GitPushResult, String> {
    match run_git_remote(&workspace_path, &["push"]) {
        Ok(stdout) => Ok(GitPushResult {
            stdout,
            set_upstream: false,
        }),
        Err(err) => {
            if !err.contains("has no upstream branch") {
                return Err(err);
            }

            let branch_output = crate::process_util::command("git")
                .args(["-C", &workspace_path, "rev-parse", "--abbrev-ref", "HEAD"])
                .output()
                .map_err(|e| e.to_string())?;
            if !branch_output.status.success() {
                // Couldn't resolve the current branch — surface the original push error.
                return Err(err);
            }
            let branch = String::from_utf8_lossy(&branch_output.stdout)
                .trim()
                .to_string();
            if branch.is_empty() || branch == "HEAD" {
                // Detached HEAD or unresolvable ref — nothing sensible to set
                // upstream on; surface the original push error.
                return Err(err);
            }

            let stdout = run_git_remote(&workspace_path, &["push", "-u", "origin", &branch])?;
            Ok(GitPushResult {
                stdout,
                set_upstream: true,
            })
        }
    }
}

#[tauri::command]
pub fn git_log(workspace_path: String, count: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let n = count.unwrap_or(20);
    let output = crate::process_util::command("git")
        .args([
            "-C",
            &workspace_path,
            "log",
            "--format=%h%x00%s%x00%an%x00%aI",
            "-n",
            &n.to_string(),
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\0').collect();
            if parts.len() >= 4 {
                Some(GitLogEntry {
                    hash: parts[0].to_string(),
                    message: parts[1].to_string(),
                    author: parts[2].to_string(),
                    date: parts[3].to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(entries)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_locked: bool,
    pub is_prunable: bool,
    pub is_main: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BlameLine {
    pub line: u32,
    pub sha: String,
    pub author: String,
    pub author_email: String,
    pub date: String,
    pub summary: String,
    pub is_uncommitted: bool,
}

#[tauri::command]
pub fn git_worktree_list(workspace_path: String) -> Result<Vec<WorktreeInfo>, String> {
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result: Vec<WorktreeInfo> = Vec::new();
    let mut current: Option<WorktreeInfo> = None;

    for raw in stdout.lines() {
        if raw.is_empty() {
            if let Some(w) = current.take() {
                result.push(w);
            }
            continue;
        }
        let (key, value) = match raw.split_once(' ') {
            Some((k, v)) => (k, v),
            None => (raw, ""),
        };
        match key {
            "worktree" => {
                if let Some(w) = current.take() {
                    result.push(w);
                }
                current = Some(WorktreeInfo {
                    path: value.to_string(),
                    branch: None,
                    head: String::new(),
                    is_locked: false,
                    is_prunable: false,
                    is_main: result.is_empty(),
                });
            }
            "HEAD" => {
                if let Some(w) = current.as_mut() {
                    w.head = value.to_string();
                }
            }
            "branch" => {
                if let Some(w) = current.as_mut() {
                    w.branch = Some(value.trim_start_matches("refs/heads/").to_string());
                }
            }
            "detached" => {
                if let Some(w) = current.as_mut() {
                    w.branch = None;
                }
            }
            "locked" => {
                if let Some(w) = current.as_mut() {
                    w.is_locked = true;
                }
            }
            "prunable" => {
                if let Some(w) = current.as_mut() {
                    w.is_prunable = true;
                }
            }
            _ => {}
        }
    }
    if let Some(w) = current.take() {
        result.push(w);
    }
    Ok(result)
}

#[tauri::command]
pub fn git_worktree_add(
    workspace_path: String,
    path: String,
    branch: Option<String>,
    new_branch: Option<String>,
    force: bool,
) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("worktree path must be absolute".to_string());
    }
    let mut args: Vec<String> = vec![
        "-C".into(),
        workspace_path,
        "worktree".into(),
        "add".into(),
    ];
    if force {
        args.push("-f".into());
    }
    if let Some(nb) = new_branch.as_ref() {
        args.push("-b".into());
        args.push(nb.clone());
        args.push(path);
        if let Some(b) = branch {
            args.push(b);
        }
    } else if let Some(b) = branch {
        args.push(path);
        args.push(b);
    } else {
        args.push(path);
    }
    let output = crate::process_util::command("git")
        .args(args.iter().map(String::as_str).collect::<Vec<_>>())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn git_worktree_remove(
    workspace_path: String,
    path: String,
    force: bool,
) -> Result<(), String> {
    let mut args = vec!["-C", &workspace_path, "worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    let output = crate::process_util::command("git")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn git_worktree_prune(workspace_path: String) -> Result<(), String> {
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "worktree", "prune"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

const ZERO_SHA: &str = "0000000000000000000000000000000000000000";

#[derive(Default, Clone)]
struct BlameMeta {
    author: String,
    author_email: String,
    author_time: i64,
    summary: String,
}

#[tauri::command]
pub async fn git_blame_file(
    workspace_path: String,
    file_path: String,
) -> Result<Vec<BlameLine>, String> {
    let workspace_path = repo_root(&workspace_path)?;
    let output = crate::process_util::async_command("git")
        .args([
            "-C",
            &workspace_path,
            "blame",
            "--line-porcelain",
            "--root",
            "--",
            &file_path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Untracked / never-existed paths (blame has no history to walk):
        // `fatal: no such path '<p>' in HEAD`. Everything else (e.g. a bogus
        // repo path) is a real failure and must not be swallowed into an
        // empty blame result.
        let missing_path = stderr.contains("no such path") || stderr.contains("does not exist");
        if missing_path {
            return Ok(Vec::new());
        }
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits: HashMap<String, BlameMeta> = HashMap::new();
    let mut result: Vec<BlameLine> = Vec::new();
    let mut iter = stdout.lines().peekable();

    while let Some(header) = iter.next() {
        let parts: Vec<&str> = header.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let sha = parts[0].to_string();
        let final_line: u32 = parts[2].parse().unwrap_or(0);
        let mut meta = commits.get(&sha).cloned().unwrap_or_default();

        while let Some(peek) = iter.peek() {
            if peek.starts_with('\t') {
                iter.next();
                break;
            }
            let line = match iter.next() {
                Some(l) => l,
                None => break,
            };
            if let Some(rest) = line.strip_prefix("author ") {
                meta.author = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("author-mail ") {
                meta.author_email = rest.trim_matches(['<', '>']).to_string();
            } else if let Some(rest) = line.strip_prefix("author-time ") {
                meta.author_time = rest.parse().unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("summary ") {
                meta.summary = rest.to_string();
            }
        }

        commits.entry(sha.clone()).or_insert_with(|| meta.clone());
        let is_uncommitted = sha == ZERO_SHA;
        let date = if meta.author_time > 0 {
            chrono_iso_from_unix(meta.author_time)
        } else {
            String::new()
        };
        result.push(BlameLine {
            line: final_line,
            sha,
            author: meta.author.clone(),
            author_email: meta.author_email.clone(),
            date,
            summary: meta.summary.clone(),
            is_uncommitted,
        });
    }

    result.sort_by_key(|b| b.line);
    Ok(result)
}

fn chrono_iso_from_unix(ts: i64) -> String {
    let secs = ts;
    let days = secs / 86_400;
    let rem = secs.rem_euclid(86_400);
    let hours = rem / 3600;
    let mins = (rem % 3600) / 60;
    let s = rem % 60;
    let (year, month, day) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, mins, s
    )
}

fn days_to_ymd(mut days: i64) -> (i32, u32, u32) {
    days += 719_468;
    let era = if days >= 0 { days / 146_097 } else { (days - 146_096) / 146_097 };
    let doe = (days - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

// ---------------------------------------------------------------------------
// T9: Unity-aware git — UnityYAMLMerge integration + .gitignore doctor
// ---------------------------------------------------------------------------

/// Lines that wire the `unityyamlmerge` merge driver to Unity asset types in
/// `.gitattributes`. Only lines not already present are appended.
const GITATTRIBUTES_LINES: &[&str] = &[
    "*.unity merge=unityyamlmerge",
    "*.prefab merge=unityyamlmerge",
    "*.asset merge=unityyamlmerge",
];

/// Configure the `unityyamlmerge` git merge driver and ensure the relevant
/// `.gitattributes` entries exist.
///
/// - Appends the `merge=unityyamlmerge` attribute lines (skipping any already
///   present) to `<workspace>/.gitattributes`.
/// - Runs `git config merge.unityyamlmerge.name "Unity SmartMerge"` and
///   `git config merge.unityyamlmerge.driver "'<tool>' merge -p %O %B %A %A"`.
///
/// `%O` = ancestor/base (stage 1), `%B` = theirs (stage 3), `%A` = ours (stage
/// 2) and also the output path — matching UnityYAMLMerge's
/// `merge -p <base> <theirs> <ours> <result>` argument order.
#[tauri::command]
pub fn git_setup_unityyamlmerge(workspace_path: String, tool_path: String) -> Result<(), String> {
    if tool_path.trim().is_empty() {
        return Err("UnityYAMLMerge tool path is empty (Unity editor not resolved)".to_string());
    }

    // `.gitattributes` and the merge-driver config belong to the repository,
    // so both are written at its root rather than under a subdirectory
    // workspace (where git would ignore the config and scope the attributes).
    let workspace_path = repo_root(&workspace_path)?;

    // 1. Append missing .gitattributes lines.
    let attrs_path = std::path::Path::new(&workspace_path).join(".gitattributes");
    let existing = std::fs::read_to_string(&attrs_path).unwrap_or_default();
    let existing_lines: std::collections::HashSet<String> = existing
        .lines()
        .map(|l| l.trim().to_string())
        .collect();

    let mut to_add: Vec<&str> = Vec::new();
    for line in GITATTRIBUTES_LINES {
        if !existing_lines.contains(*line) {
            to_add.push(line);
        }
    }

    if !to_add.is_empty() {
        let mut content = existing;
        // Ensure we start the appended block on a fresh line.
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        for line in &to_add {
            content.push_str(line);
            content.push('\n');
        }
        std::fs::write(&attrs_path, content)
            .map_err(|e| format!("Failed to write .gitattributes: {e}"))?;
    }

    // 2. Configure the merge driver.
    let driver = format!("'{}' merge -p %O %B %A %A", tool_path);

    let name_out = crate::process_util::command("git")
        .args([
            "-C",
            &workspace_path,
            "config",
            "merge.unityyamlmerge.name",
            "Unity SmartMerge",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !name_out.status.success() {
        return Err(String::from_utf8_lossy(&name_out.stderr).to_string());
    }

    let driver_out = crate::process_util::command("git")
        .args([
            "-C",
            &workspace_path,
            "config",
            "merge.unityyamlmerge.driver",
            &driver,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !driver_out.status.success() {
        return Err(String::from_utf8_lossy(&driver_out.stderr).to_string());
    }

    Ok(())
}

/// Extract a single conflict stage (`:1:`/`:2:`/`:3:`) of `file_path` into
/// `dest`. Returns Ok(false) when the stage does not exist (e.g. add/add
/// conflicts have no base), Ok(true) on success.
fn extract_stage(
    workspace_path: &str,
    stage: u8,
    file_path: &str,
    dest: &std::path::Path,
) -> Result<bool, String> {
    let spec = format!(":{}:{}", stage, file_path);
    let output = crate::process_util::command("git")
        .args(["-C", workspace_path, "show", &spec])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(false);
    }
    std::fs::write(dest, &output.stdout)
        .map_err(|e| format!("Failed to write temp stage file: {e}"))?;
    Ok(true)
}

/// Run UnityYAMLMerge on a single conflicted working-tree file.
///
/// Extracts the three conflict stages via `git show :1:/:2:/:3:` into temp
/// files, then runs `<tool> merge -p <base> <theirs> <ours> <merged>` writing
/// the result back over the working-tree file. The `-p` form merges as much as
/// possible without prompting; on tool failure this returns an error so the UI
/// can fall back to ours/theirs.
///
/// On success the file is also staged (`git add`) so the conflict is resolved.
#[tauri::command]
pub fn git_run_unityyamlmerge(
    workspace_path: String,
    tool_path: String,
    file_path: String,
) -> Result<(), String> {
    if tool_path.trim().is_empty() {
        return Err("UnityYAMLMerge tool path is empty (Unity editor not resolved)".to_string());
    }

    let workspace_path = repo_root(&workspace_path)?;

    // Unique temp prefix so concurrent merges don't collide.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let safe_name = file_path.replace(['/', '\\'], "_");
    let tmp_dir = std::env::temp_dir();
    let base_path = tmp_dir.join(format!("uym-{stamp}-base-{safe_name}"));
    let theirs_path = tmp_dir.join(format!("uym-{stamp}-theirs-{safe_name}"));
    let ours_path = tmp_dir.join(format!("uym-{stamp}-ours-{safe_name}"));
    let merged_path = tmp_dir.join(format!("uym-{stamp}-merged-{safe_name}"));

    // Always clean up temp files, even on early return.
    let cleanup = |paths: &[&std::path::Path]| {
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    };
    let all_tmp = [
        base_path.as_path(),
        theirs_path.as_path(),
        ours_path.as_path(),
        merged_path.as_path(),
    ];

    // Stage 2 = ours, stage 3 = theirs are required for a content conflict.
    let ours_ok = extract_stage(&workspace_path, 2, &file_path, &ours_path)?;
    let theirs_ok = extract_stage(&workspace_path, 3, &file_path, &theirs_path)?;
    if !ours_ok || !theirs_ok {
        cleanup(&all_tmp);
        return Err(
            "File is not a content conflict (missing ours/theirs stage); use ours/theirs fallback"
                .to_string(),
        );
    }
    // Stage 1 = base may be absent (add/add). Fall back to an empty base file.
    let base_ok = extract_stage(&workspace_path, 1, &file_path, &base_path)?;
    if !base_ok {
        if let Err(e) = std::fs::write(&base_path, b"") {
            cleanup(&all_tmp);
            return Err(format!("Failed to write empty base file: {e}"));
        }
    }

    // merge -p <base> <theirs> <ours> <merged>
    let status = crate::process_util::command(&tool_path)
        .arg("merge")
        .arg("-p")
        .arg(&base_path)
        .arg(&theirs_path)
        .arg(&ours_path)
        .arg(&merged_path)
        .status();

    let status = match status {
        Ok(s) => s,
        Err(e) => {
            cleanup(&all_tmp);
            return Err(format!("Failed to launch UnityYAMLMerge: {e}"));
        }
    };

    if !status.success() {
        cleanup(&all_tmp);
        return Err(
            "UnityYAMLMerge could not fully resolve the conflict; falling back to manual resolution"
                .to_string(),
        );
    }

    // Copy merged result over the working-tree file.
    let merged_contents = match std::fs::read(&merged_path) {
        Ok(c) => c,
        Err(e) => {
            cleanup(&all_tmp);
            return Err(format!("Failed to read merged output: {e}"));
        }
    };
    let target = std::path::Path::new(&workspace_path).join(&file_path);
    if let Err(e) = std::fs::write(&target, &merged_contents) {
        cleanup(&all_tmp);
        return Err(format!("Failed to write merged file: {e}"));
    }

    cleanup(&all_tmp);

    // Stage the resolved file to clear the conflict.
    let add_out = crate::process_util::command("git")
        .args(["-C", &workspace_path, "add", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !add_out.status.success() {
        return Err(String::from_utf8_lossy(&add_out.stderr).to_string());
    }

    Ok(())
}

/// Resolve a conflicted file by taking entirely one side.
/// `side` must be "ours" or "theirs". Uses `git checkout --ours/--theirs`
/// then stages the file.
#[tauri::command]
pub fn git_resolve_conflict_side(
    workspace_path: String,
    file_path: String,
    side: String,
) -> Result<(), String> {
    let flag = match side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err(format!("invalid side '{side}' (expected ours|theirs)")),
    };

    let workspace_path = repo_root(&workspace_path)?;
    let checkout = crate::process_util::command("git")
        .args(["-C", &workspace_path, "checkout", flag, "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !checkout.status.success() {
        return Err(String::from_utf8_lossy(&checkout.stderr).to_string());
    }

    let add_out = crate::process_util::command("git")
        .args(["-C", &workspace_path, "add", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !add_out.status.success() {
        return Err(String::from_utf8_lossy(&add_out.stderr).to_string());
    }

    Ok(())
}

/// Append lines to the repository's root `.gitignore`, skipping any already
/// present (exact-trimmed-line match). Used by the gitignore doctor's "Fix"
/// action. Returns the lines that were actually appended.
///
/// Written at the repo root, not under a subdirectory workspace: the patterns
/// the doctor suggests (`Library/`, `Temp/`, ...) are repo-wide, and a
/// `.gitignore` dropped in a subdirectory would silently scope them to that
/// subtree.
#[tauri::command]
pub fn git_append_gitignore(
    workspace_path: String,
    lines: Vec<String>,
) -> Result<Vec<String>, String> {
    let workspace_path = repo_root(&workspace_path)?;
    let ignore_path = std::path::Path::new(&workspace_path).join(".gitignore");
    let existing = std::fs::read_to_string(&ignore_path).unwrap_or_default();
    let existing_set: std::collections::HashSet<String> =
        existing.lines().map(|l| l.trim().to_string()).collect();

    let to_add: Vec<String> = lines
        .into_iter()
        .filter(|l| !l.trim().is_empty() && !existing_set.contains(l.trim()))
        .collect();

    if to_add.is_empty() {
        return Ok(Vec::new());
    }

    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    // Add a small header before the appended block for readability.
    content.push_str("\n# Added by Unity .gitignore doctor\n");
    for line in &to_add {
        content.push_str(line);
        content.push('\n');
    }
    std::fs::write(&ignore_path, content)
        .map_err(|e| format!("Failed to write .gitignore: {e}"))?;

    Ok(to_add)
}

// ---------------------------------------------------------------------------
// A1: Branch lifecycle — create / rename / delete
// ---------------------------------------------------------------------------

/// Validate that a branch name does not start with '-' and is not empty.
/// This prevents leading dashes from being parsed as git flags.
fn validate_ref_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') {
        return Err(format!("invalid branch name: '{name}'"));
    }
    Ok(())
}

/// Create a new branch. When `checkout` is true, uses `git switch -c <name>
/// [<base>]` so the new branch also becomes HEAD; otherwise `git branch
/// <name> [<base>]` creates it without touching the working tree.
#[tauri::command]
pub fn git_create_branch(
    workspace_path: String,
    name: String,
    base: Option<String>,
    checkout: bool,
) -> Result<(), String> {
    validate_ref_name(&name)?;
    if let Some(ref b) = base {
        validate_ref_name(b)?;
    }

    let mut args: Vec<String> = vec!["-C".into(), workspace_path];
    if checkout {
        args.push("switch".into());
        args.push("-c".into());
    } else {
        args.push("branch".into());
    }
    args.push(name);
    if let Some(b) = base {
        args.push(b);
    }

    let output = crate::process_util::command("git")
        .args(args.iter().map(String::as_str).collect::<Vec<_>>())
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Rename a branch via `git branch -m <old> <new>`. Works whether or not
/// `old_name` is the currently checked-out branch.
#[tauri::command]
pub fn git_rename_branch(
    workspace_path: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    validate_ref_name(&old_name)?;
    validate_ref_name(&new_name)?;

    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "branch", "-m", &old_name, &new_name])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

/// Delete a branch via `git branch -d|-D <name>`. Stderr is passed through
/// verbatim (not wrapped) so callers can detect git's "not fully merged"
/// message and offer to retry with `force: true`.
#[tauri::command]
pub fn git_delete_branch(workspace_path: String, name: String, force: bool) -> Result<(), String> {
    validate_ref_name(&name)?;

    let flag = if force { "-D" } else { "-d" };
    let output = crate::process_util::command("git")
        .args(["-C", &workspace_path, "branch", flag, &name])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[cfg(test)]
mod branch_lifecycle_tests {
    use super::*;

    /// Create a throwaway git repo (deterministic `main` initial branch,
    /// local user identity so commits don't depend on global git config) with
    /// one empty commit so HEAD is valid.
    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();
        run_git(path, &["init", "--initial-branch=main"]);
        // Windows git defaults to core.autocrlf=true and would rewrite LF to
        // CRLF every time it materialises a file (restore, stash pop, discard);
        // these tests assert on exact contents, so pin the temp repo instead.
        run_git(path, &["config", "core.autocrlf", "false"]);
        run_git(path, &["config", "user.email", "test@example.com"]);
        run_git(path, &["config", "user.name", "Test User"]);
        run_git(path, &["commit", "--allow-empty", "-m", "init"]);
        tmp
    }

    fn run_git(path: &str, args: &[&str]) {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = crate::process_util::command("git").args(&full).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// `git_list_branches` now returns `Vec<BranchInfo>` (name + recency)
    /// instead of `Vec<String>`; these lifecycle tests only care about which
    /// names are present, so this collapses back to bare names.
    fn branch_names(branches: Vec<BranchInfo>) -> Vec<String> {
        branches.into_iter().map(|b| b.name).collect()
    }

    #[test]
    fn create_branch_from_head() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        git_create_branch(path.clone(), "feature-a".into(), None, false).unwrap();

        let branches = branch_names(git_list_branches(path).unwrap());
        assert!(branches.contains(&"feature-a".to_string()));
    }

    #[test]
    fn create_branch_with_base() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        run_git(&path, &["branch", "base-branch"]);

        git_create_branch(
            path.clone(),
            "feature-b".into(),
            Some("base-branch".into()),
            false,
        )
        .unwrap();

        let branches = branch_names(git_list_branches(path).unwrap());
        assert!(branches.contains(&"feature-b".to_string()));
    }

    #[test]
    fn create_branch_with_checkout_switches_head() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        git_create_branch(path.clone(), "feature-c".into(), None, true).unwrap();

        let status = git_status(path).unwrap();
        assert_eq!(status.branch, "feature-c");
    }

    #[test]
    fn create_branch_without_checkout_leaves_head_unchanged() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        git_create_branch(path.clone(), "feature-d".into(), None, false).unwrap();

        let status = git_status(path).unwrap();
        assert_eq!(status.branch, "main");
    }

    #[test]
    fn rename_branch() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        git_create_branch(path.clone(), "old-name".into(), None, false).unwrap();

        git_rename_branch(path.clone(), "old-name".into(), "new-name".into()).unwrap();

        let branches = branch_names(git_list_branches(path).unwrap());
        assert!(!branches.contains(&"old-name".to_string()));
        assert!(branches.contains(&"new-name".to_string()));
    }

    #[test]
    fn delete_merged_branch() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        git_create_branch(path.clone(), "merged-branch".into(), None, false).unwrap();

        git_delete_branch(path.clone(), "merged-branch".into(), false).unwrap();

        let branches = branch_names(git_list_branches(path).unwrap());
        assert!(!branches.contains(&"merged-branch".to_string()));
    }

    #[test]
    fn delete_unmerged_branch_without_force_errs() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        git_create_branch(path.clone(), "unmerged-branch".into(), None, true).unwrap();
        std::fs::write(std::path::Path::new(&path).join("file.txt"), "content").unwrap();
        run_git(&path, &["add", "."]);
        run_git(&path, &["commit", "-m", "add file"]);
        run_git(&path, &["switch", "main"]);

        let result = git_delete_branch(path, "unmerged-branch".into(), false);

        let err = result.unwrap_err();
        assert!(
            err.contains("not fully merged"),
            "expected 'not fully merged' in error, got: {err}"
        );
    }

    #[test]
    fn delete_unmerged_branch_with_force_succeeds() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        git_create_branch(path.clone(), "unmerged-branch2".into(), None, true).unwrap();
        std::fs::write(std::path::Path::new(&path).join("file2.txt"), "content").unwrap();
        run_git(&path, &["add", "."]);
        run_git(&path, &["commit", "-m", "add file2"]);
        run_git(&path, &["switch", "main"]);

        git_delete_branch(path.clone(), "unmerged-branch2".into(), true).unwrap();

        let branches = branch_names(git_list_branches(path).unwrap());
        assert!(!branches.contains(&"unmerged-branch2".to_string()));
    }

    #[test]
    fn create_branch_rejects_leading_dash_name() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let result = git_create_branch(path.clone(), "-D".into(), Some("main".into()), false);

        let err = result.unwrap_err();
        assert!(
            err.contains("invalid branch name"),
            "expected 'invalid branch name' in error, got: {err}"
        );
        // Verify main still exists (wasn't force-deleted by the malicious input)
        let branches = branch_names(git_list_branches(path).unwrap());
        assert!(branches.contains(&"main".to_string()));
    }

    #[test]
    fn delete_branch_rejects_leading_dash_name() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let result = git_delete_branch(path, "-x".into(), false);

        let err = result.unwrap_err();
        assert!(
            err.contains("invalid branch name"),
            "expected 'invalid branch name' in error, got: {err}"
        );
    }

    #[test]
    fn rename_branch_rejects_leading_dash_old_name() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let result = git_rename_branch(path, "-m".into(), "new".into());

        let err = result.unwrap_err();
        assert!(
            err.contains("invalid branch name"),
            "expected 'invalid branch name' in error, got: {err}"
        );
    }

    #[test]
    fn rename_branch_rejects_leading_dash_new_name() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        git_create_branch(path.clone(), "old".into(), None, false).unwrap();

        let result = git_rename_branch(path, "old".into(), "-m".into());

        let err = result.unwrap_err();
        assert!(
            err.contains("invalid branch name"),
            "expected 'invalid branch name' in error, got: {err}"
        );
    }

    #[test]
    fn create_branch_rejects_leading_dash_base() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let result = git_create_branch(
            path.clone(),
            "feature".into(),
            Some("-D".into()),
            false,
        );

        let err = result.unwrap_err();
        assert!(
            err.contains("invalid branch name"),
            "expected 'invalid branch name' in error, got: {err}"
        );
        // Verify main still exists
        let branches = branch_names(git_list_branches(path).unwrap());
        assert!(branches.contains(&"main".to_string()));
    }
}

// ---------------------------------------------------------------------------
// R2-T8: Branch recency — parse_checkout_timestamps + git_list_branches join
//
// PROJECT LESSON (the porcelain-v2 status parser dropped every tracked-file
// change twice before verbatim-line tests caught it): the fixtures below are
// real `git reflog --date=unix` output captured from a scratch repo, not
// hand-imagined lines. See the task-8 report for the exact commands used to
// produce them.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod branch_reflog_tests {
    use super::*;

    fn run_git(path: &str, args: &[&str]) {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = crate::process_util::command("git").args(&full).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Repo with one commit on `main` (deterministic initial branch, local
    /// user identity) so HEAD is valid but — importantly — no explicit
    /// checkout has ever been recorded for `main` itself (creating the repo
    /// and committing writes a `commit (initial)` reflog line, not a
    /// `checkout` one).
    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();
        run_git(path, &["init", "--initial-branch=main"]);
        // Windows git defaults to core.autocrlf=true and would rewrite LF to
        // CRLF every time it materialises a file (restore, stash pop, discard);
        // these tests assert on exact contents, so pin the temp repo instead.
        run_git(path, &["config", "core.autocrlf", "false"]);
        run_git(path, &["config", "user.email", "test@example.com"]);
        run_git(path, &["config", "user.name", "Test User"]);
        run_git(path, &["commit", "--allow-empty", "-m", "init"]);
        tmp
    }

    // --- parse_checkout_timestamps: verbatim-line fixtures ------------------

    #[test]
    fn parses_normal_checkout_entry() {
        // Verbatim line from `git reflog --date=unix`, scratch repo, after
        // `git switch -c feature/x && git switch main`.
        let reflog = "f54bc43 HEAD@{1784090195}: checkout: moving from feature/x to main\n";
        let ts = parse_checkout_timestamps(reflog);
        assert_eq!(ts.get("main"), Some(&1784090195));
    }

    #[test]
    fn parses_slashed_branch_names_on_either_side() {
        // Verbatim lines from the same scratch-repo reflog: a slashed name as
        // the checkout TARGET, then as the checkout SOURCE.
        let target_slashed =
            "f54bc43 HEAD@{1784090195}: checkout: moving from main to feature/x\n";
        let ts = parse_checkout_timestamps(target_slashed);
        assert_eq!(ts.get("feature/x"), Some(&1784090195));

        let source_slashed =
            "f54bc43 HEAD@{1784090195}: checkout: moving from feature/x to another-branch\n";
        let ts = parse_checkout_timestamps(source_slashed);
        assert_eq!(ts.get("another-branch"), Some(&1784090195));
    }

    #[test]
    fn newest_entry_per_branch_wins_and_non_checkout_lines_are_ignored() {
        // Verbatim FULL `git reflog --date=unix` output from a scratch repo:
        // init -> switch -c feature/x -> switch main -> switch feature/x ->
        // switch -c another-branch -> switch main -> checkout <own-HEAD-sha>
        // (detached) -> switch main. Newest first, as git prints it.
        let reflog = "\
f54bc43 HEAD@{1784090212}: checkout: moving from f54bc437f72428517cd7d03ee59760aff5e4247c to main
f54bc43 HEAD@{1784090212}: checkout: moving from main to f54bc437f72428517cd7d03ee59760aff5e4247c
f54bc43 HEAD@{1784090195}: checkout: moving from another-branch to main
f54bc43 HEAD@{1784090195}: checkout: moving from feature/x to another-branch
f54bc43 HEAD@{1784090195}: checkout: moving from main to feature/x
f54bc43 HEAD@{1784090195}: checkout: moving from feature/x to main
f54bc43 HEAD@{1784090195}: checkout: moving from main to feature/x
f54bc43 HEAD@{1784090195}: commit (initial): init
";
        let ts = parse_checkout_timestamps(reflog);

        // "main" is a checkout target three times; the newest (topmost, since
        // reflog is newest-first) wins over the two older entries.
        assert_eq!(ts.get("main"), Some(&1784090212));
        assert_eq!(ts.get("feature/x"), Some(&1784090195));
        assert_eq!(ts.get("another-branch"), Some(&1784090195));

        // Detached-HEAD target (a raw SHA, not a branch name) is recorded
        // like any other target — harmless dead entry, since the join step
        // in `git_list_branches` only looks up real branch names.
        assert_eq!(
            ts.get("f54bc437f72428517cd7d03ee59760aff5e4247c"),
            Some(&1784090212)
        );

        // The trailing `commit (initial): init` line is not a checkout entry
        // and must not be misparsed into a bogus "init" branch.
        assert!(!ts.contains_key("init"));
        assert_eq!(ts.len(), 4, "expected exactly 4 distinct checkout targets");
    }

    #[test]
    fn clone_line_is_ignored() {
        // Verbatim `git reflog --date=unix` output from a repo produced by
        // `git clone <scratch-repo>` (no checkouts have happened in the
        // clone itself yet — only the implicit clone entry).
        let reflog = "f54bc43 HEAD@{1784090212}: clone: from /private/tmp/claude-501/-Users-inno-Documents-experiments-arcane-editor-editor/8b311b96-3b71-416e-94a5-16e2ea64db4b/scratchpad/reflog-scratch\n";
        let ts = parse_checkout_timestamps(reflog);
        assert!(ts.is_empty());
    }

    #[test]
    fn commit_only_reflog_yields_no_checkout_entries() {
        // Verbatim `git reflog --date=unix` output from a freshly-committed
        // repo that has never had an explicit checkout.
        let reflog = "f77f23e HEAD@{1784090230}: commit (initial): init\n";
        let ts = parse_checkout_timestamps(reflog);
        assert!(ts.is_empty());
    }

    #[test]
    fn garbage_lines_are_ignored() {
        let reflog = "not a reflog line at all\n\n   \nHEAD@{not-a-number}: checkout: moving from a to b\nHEAD@{123} checkout: moving from a to b (no colon after brace)\n";
        let ts = parse_checkout_timestamps(reflog);
        assert!(ts.is_empty());
    }

    #[test]
    fn empty_input_yields_empty_map() {
        assert!(parse_checkout_timestamps("").is_empty());
    }

    // --- git_list_branches: real end-to-end reflog join ---------------------

    #[test]
    fn list_branches_reports_last_checkout_ts_from_real_reflog() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        run_git(&path, &["switch", "-c", "feature-a"]);
        run_git(&path, &["switch", "main"]);

        let branches = git_list_branches(path).unwrap();
        let by_name: HashMap<String, Option<i64>> =
            branches.into_iter().map(|b| (b.name, b.last_checkout_ts)).collect();

        let feature_ts = by_name.get("feature-a").copied().flatten();
        let main_ts = by_name.get("main").copied().flatten();
        assert!(feature_ts.is_some(), "feature-a should have a checkout timestamp");
        assert!(main_ts.is_some(), "main should have a checkout timestamp");
        assert!(
            main_ts.unwrap() >= feature_ts.unwrap(),
            "main was checked out most recently and should sort at least as new"
        );
    }

    #[test]
    fn list_branches_on_repo_with_no_checkouts_yields_none_timestamp() {
        // `init_repo()` commits on `main` but never explicitly checks it
        // out — there is no `checkout` reflog entry for it at all.
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let branches = git_list_branches(path).unwrap();
        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0].name, "main");
        assert_eq!(branches[0].last_checkout_ts, None);
    }

    #[test]
    fn list_branches_on_completely_fresh_repo_does_not_error_despite_reflog_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap().to_string();
        run_git(&path, &["init", "--initial-branch=main"]);
        // No commits at all yet: `git reflog --date=unix` exits non-zero
        // here ("fatal: your current branch 'main' does not have any
        // commits yet") and `git branch --list` has nothing to list either.
        // `git_list_branches` must swallow the reflog failure and still
        // return Ok, not propagate it as an error.
        let branches = git_list_branches(path).unwrap();
        assert!(branches.is_empty());
    }

    #[test]
    fn list_branches_base_order_stays_alphabetical() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        run_git(&path, &["branch", "zeta"]);
        run_git(&path, &["branch", "alpha"]);

        let branches = git_list_branches(path).unwrap();
        let names: Vec<String> = branches.into_iter().map(|b| b.name).collect();
        assert_eq!(names, vec!["alpha", "main", "zeta"]);
    }

    // --- serde contract: BranchInfo field names -----------------------------

    /// Pins the exact JSON field names the frontend's `BranchInfo` TypeScript
    /// type consumes (see `src/stores/git.ts`). Same rationale as
    /// `git_status_result_serde_field_names` below: the Tauri IPC boundary is
    /// JSON, not shared types, so a silent field rename here would break the
    /// frontend with no compiler error anywhere.
    #[test]
    fn branch_info_serde_field_names() {
        let info = BranchInfo {
            name: "main".to_string(),
            last_checkout_ts: Some(1736831145),
            is_remote: false,
            local_name: None,
        };
        let value = serde_json::to_value(&info).unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("name"));
        assert!(obj.contains_key("last_checkout_ts"));
        assert!(obj.contains_key("is_remote"));
        // `local_name` is `skip_serializing_if = "Option::is_none"`, so a local
        // branch stays a 3-field payload.
        assert!(!obj.contains_key("local_name"));
        assert_eq!(obj.len(), 3, "unexpected extra/missing field on BranchInfo");
        assert_eq!(obj["name"], serde_json::json!("main"));
        assert_eq!(obj["last_checkout_ts"], serde_json::json!(1736831145));
        assert_eq!(obj["is_remote"], serde_json::json!(false));

        let info_none = BranchInfo {
            name: "feature/x".to_string(),
            last_checkout_ts: None,
            is_remote: false,
            local_name: None,
        };
        let value_none = serde_json::to_value(&info_none).unwrap();
        assert_eq!(value_none["name"], serde_json::json!("feature/x"));
        assert_eq!(value_none["last_checkout_ts"], serde_json::Value::Null);

        let remote = BranchInfo {
            name: "origin/release/1.x".to_string(),
            last_checkout_ts: None,
            is_remote: true,
            local_name: Some("release/1.x".to_string()),
        };
        let remote_value = serde_json::to_value(&remote).unwrap();
        assert_eq!(remote_value["is_remote"], serde_json::json!(true));
        assert_eq!(
            remote_value["local_name"],
            serde_json::json!("release/1.x"),
            "nested remote branch names must not be split on the first slash"
        );
    }

    // --- ref-name parsing ---------------------------------------------------

    #[test]
    fn parse_branch_refs_uses_lstrip_names_and_flags_remotes() {
        let out = concat!(
            "refs/heads/main\0main\0\0\n",
            // A branch colliding with a tag: `%(refname:short)` would have
            // yielded `heads/v1.0.0` here.
            "refs/heads/v1.0.0\0v1.0.0\0\0\n",
            "refs/remotes/origin/feature-x\0origin/feature-x\0feature-x\0\n",
            "refs/remotes/origin/release/1.x\0origin/release/1.x\0release/1.x\0\n",
        );
        let branches = parse_branch_refs(out);
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["main", "v1.0.0", "origin/feature-x", "origin/release/1.x"]
        );
        assert!(!branches[0].is_remote);
        assert_eq!(branches[0].local_name, None);
        assert!(branches[2].is_remote);
        assert_eq!(branches[2].local_name.as_deref(), Some("feature-x"));
        assert_eq!(branches[3].local_name.as_deref(), Some("release/1.x"));
    }

    #[test]
    fn parse_branch_refs_drops_the_remote_head_symref() {
        let out = concat!(
            "refs/heads/main\0main\0\0\n",
            "refs/remotes/origin/HEAD\0origin/HEAD\0HEAD\0refs/remotes/origin/main\n",
            "refs/remotes/origin/main\0origin/main\0main\0\n",
        );
        let names: Vec<String> = parse_branch_refs(out)
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert_eq!(names, vec!["main", "origin/main"]);
    }
}

// ---------------------------------------------------------------------------
// A4: Commit visibility — git_show_commit / git_show_file_at
// ---------------------------------------------------------------------------

#[cfg(test)]
mod commit_detail_tests {
    use super::*;

    fn run_git(path: &str, args: &[&str]) -> String {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = crate::process_util::command("git").args(&full).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();
        run_git(path, &["init", "--initial-branch=main"]);
        // Windows git defaults to core.autocrlf=true and would rewrite LF to
        // CRLF every time it materialises a file (restore, stash pop, discard);
        // these tests assert on exact contents, so pin the temp repo instead.
        run_git(path, &["config", "core.autocrlf", "false"]);
        run_git(path, &["config", "user.email", "test@example.com"]);
        run_git(path, &["config", "user.name", "Test User"]);
        tmp
    }

    /// Two-commit fixture:
    /// - first (root) commit: adds a.txt, b.txt
    /// - second commit: modifies a.txt, renames b.txt -> c.txt, adds d.txt
    /// Returns (tmp dir, first hash, second hash).
    fn two_commit_repo() -> (tempfile::TempDir, String, String) {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1\n").unwrap();
        std::fs::write(std::path::Path::new(&path).join("b.txt"), "b\n").unwrap();
        run_git(&path, &["add", "a.txt", "b.txt"]);
        run_git(&path, &["commit", "-m", "first commit"]);
        let first = run_git(&path, &["rev-parse", "HEAD"]);

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1-mod\n").unwrap();
        run_git(&path, &["mv", "b.txt", "c.txt"]);
        std::fs::write(std::path::Path::new(&path).join("d.txt"), "new file\n").unwrap();
        run_git(&path, &["add", "-A"]);
        run_git(&path, &["commit", "-m", "second commit"]);
        let second = run_git(&path, &["rev-parse", "HEAD"]);

        (tmp, first, second)
    }

    #[test]
    fn show_commit_parses_added_modified_and_renamed_files() {
        let (tmp, _first, second) = two_commit_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let detail = git_show_commit(path, second.clone()).unwrap();

        assert_eq!(detail.hash, second);
        assert_eq!(detail.message, "second commit");
        assert_eq!(detail.author, "Test User");
        assert!(!detail.date.is_empty());

        let mut by_path: HashMap<String, String> = HashMap::new();
        for f in &detail.files {
            by_path.insert(f.path.clone(), f.status.clone());
        }
        assert_eq!(by_path.get("a.txt"), Some(&"modified".to_string()));
        assert_eq!(by_path.get("d.txt"), Some(&"added".to_string()));
        // Rename line (R100\tb.txt\tc.txt) — path is the new path, status is "renamed".
        assert_eq!(by_path.get("c.txt"), Some(&"renamed".to_string()));
        assert!(!by_path.contains_key("b.txt"));
        assert_eq!(detail.files.len(), 3);
    }

    /// `git show <merge> --name-status` prints NO file lines at all — git
    /// suppresses diff output for merge commits by default — so expanding a
    /// merge in the Commits list read "No file changes" however much it
    /// actually brought in. `--first-parent -m` produces the diff against the
    /// first parent, which is the "what did merging this bring to my branch"
    /// view the panel wants.
    #[test]
    fn show_commit_lists_files_for_a_merge_commit() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(tmp.path().join("base.txt"), "base\n").unwrap();
        run_git(&path, &["add", "-A"]);
        run_git(&path, &["commit", "-m", "base"]);

        run_git(&path, &["switch", "-c", "feature"]);
        std::fs::write(tmp.path().join("feature.txt"), "feat\n").unwrap();
        run_git(&path, &["add", "-A"]);
        run_git(&path, &["commit", "-m", "feature work"]);

        run_git(&path, &["switch", "main"]);
        std::fs::write(tmp.path().join("main.txt"), "main\n").unwrap();
        run_git(&path, &["add", "-A"]);
        run_git(&path, &["commit", "-m", "main work"]);

        run_git(&path, &["merge", "--no-ff", "feature", "-m", "Merge feature"]);
        let merge_hash = run_git(&path, &["rev-parse", "HEAD"]);

        let detail = git_show_commit(path, merge_hash.clone()).unwrap();

        assert_eq!(detail.message, "Merge feature");
        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["feature.txt"],
            "a merge must list what it brought in relative to the first parent"
        );
        assert_eq!(detail.files[0].status, "added");
    }

    /// Guard that adding `-m` didn't disturb the ordinary single-parent case
    /// (`-m` can repeat the header once per parent).
    #[test]
    fn show_commit_still_parses_a_root_commit() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        std::fs::write(tmp.path().join("only.txt"), "x\n").unwrap();
        run_git(&path, &["add", "-A"]);
        run_git(&path, &["commit", "-m", "root work"]);
        let hash = run_git(&path, &["rev-parse", "HEAD"]);

        let detail = git_show_commit(path, hash).unwrap();
        assert_eq!(detail.message, "root work");
        assert_eq!(
            detail.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["only.txt"]
        );
    }

    #[test]
    fn show_commit_rejects_invalid_hash() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        run_git(&path, &["commit", "--allow-empty", "-m", "init"]);

        let result = git_show_commit(path, "not-a-real-hash".into());

        assert!(result.is_err());
    }

    #[test]
    fn show_commit_rejects_leading_dash_hash() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        run_git(&path, &["commit", "--allow-empty", "-m", "init"]);

        let result = git_show_commit(path, "-D".into());

        let err = result.unwrap_err();
        assert!(
            err.contains("invalid"),
            "expected validation error, got: {err}"
        );
    }

    #[test]
    fn show_file_at_returns_content_at_both_revisions() {
        let (tmp, first, second) = two_commit_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let at_first = git_show_file_at(path.clone(), first, "a.txt".into()).unwrap();
        assert_eq!(at_first, "line1\n");

        let at_second = git_show_file_at(path, second, "a.txt".into()).unwrap();
        assert_eq!(at_second, "line1-mod\n");
    }

    #[test]
    fn show_file_at_root_commit_parent_returns_empty() {
        let (tmp, first, _second) = two_commit_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        // The root commit has no parent — `<hash>^` for an added-in-first-commit
        // file must diff against empty, not error.
        let content = git_show_file_at(path, format!("{first}^"), "a.txt".into()).unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn show_file_at_missing_path_returns_empty() {
        let (tmp, _first, second) = two_commit_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        // d.txt was added in `second`, so it doesn't exist at second^.
        let content =
            git_show_file_at(path.clone(), format!("{second}^"), "d.txt".into()).unwrap();
        assert_eq!(content, "");

        // A path that never existed at all.
        let content2 = git_show_file_at(path, second, "never-existed.txt".into()).unwrap();
        assert_eq!(content2, "");
    }

    #[test]
    fn show_file_at_rejects_invalid_rev() {
        let (tmp, _first, _second) = two_commit_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let result = git_show_file_at(path, "totally-bogus-rev".into(), "a.txt".into());

        assert!(result.is_err());
    }

    #[test]
    fn show_file_at_rejects_leading_dash_rev() {
        let (tmp, _first, _second) = two_commit_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let result = git_show_file_at(path, "-D".into(), "a.txt".into());

        let err = result.unwrap_err();
        assert!(
            err.contains("invalid"),
            "expected validation error, got: {err}"
        );
    }
}

// ---------------------------------------------------------------------------
// A7: Push/pull/fetch robustness — run_git_remote env vars + auto set-upstream
// ---------------------------------------------------------------------------

#[cfg(test)]
mod remote_ops_tests {
    use super::*;

    fn run_git(path: &str, args: &[&str]) -> String {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = crate::process_util::command("git").args(&full).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// A bare repo (no working tree) that stands in for a remote "origin",
    /// with its HEAD symbolic-ref pointing at a not-yet-existing `main` —
    /// mirroring a freshly created empty GitHub/GitLab repo.
    fn init_bare_origin() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();
        run_git(path, &["init", "--bare", "--initial-branch=main"]);
        tmp
    }

    /// A bare origin already containing one commit on `main`, pushed from a
    /// disposable seed checkout. Unlike `init_bare_origin`, cloning *this*
    /// repo gives `main` real upstream tracking from the clone itself
    /// (`git clone` only sets up tracking for branches that already exist on
    /// the remote) — needed so tests can put the "no upstream branch" case
    /// on a genuinely untracked *second* branch, matching how it happens in
    /// practice (a fresh local branch that's never been pushed).
    fn seeded_bare_origin() -> tempfile::TempDir {
        let bare_tmp = init_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();

        let seed_tmp = tempfile::tempdir().unwrap();
        let seed_path = seed_tmp.path().to_str().unwrap().to_string();
        run_git(&seed_path, &["init", "--initial-branch=main"]);
        run_git(&seed_path, &["config", "user.email", "test@example.com"]);
        run_git(&seed_path, &["config", "user.name", "Test User"]);
        write_and_commit(&seed_path, "seed.txt", "seed\n", "seed commit");
        run_git(&seed_path, &["remote", "add", "origin", &bare_path]);
        run_git(&seed_path, &["push", "-u", "origin", "main"]);

        bare_tmp
    }

    /// Clone `bare_path` into a fresh working directory and configure a local
    /// commit identity (clone doesn't inherit global user.name/email in a
    /// sandboxed test environment).
    fn clone_into_work(bare_path: &str) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_str().unwrap().to_string();
        let output = crate::process_util::command("git")
            .args(["clone", bare_path, &work_path])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "clone failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        run_git(&work_path, &["config", "user.email", "test@example.com"]);
        run_git(&work_path, &["config", "user.name", "Test User"]);
        tmp
    }

    fn write_and_commit(work_path: &str, file_name: &str, contents: &str, message: &str) {
        std::fs::write(std::path::Path::new(work_path).join(file_name), contents).unwrap();
        run_git(work_path, &["add", file_name]);
        run_git(work_path, &["commit", "-m", message]);
    }

    #[test]
    fn push_new_branch_auto_sets_upstream() {
        let bare_tmp = seeded_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();
        let work_tmp = clone_into_work(&bare_path);
        let work_path = work_tmp.path().to_str().unwrap().to_string();

        // `main` is tracked (from the clone); a brand-new local branch is
        // not — that's the "first push of a new local branch" case A7 fixes.
        run_git(&work_path, &["switch", "-c", "feature"]);
        write_and_commit(&work_path, "a.txt", "hello\n", "feature commit");

        // Plain `git push` on `feature` fails with "no upstream branch".
        // `git_push` must detect that and transparently retry as
        // `push -u origin feature`.
        let result = git_push(work_path.clone()).expect("push should succeed via auto-retry");
        assert!(
            result.set_upstream,
            "expected the no-upstream retry path to have fired"
        );

        let remote_cfg = run_git(&work_path, &["config", "--get", "branch.feature.remote"]);
        assert_eq!(remote_cfg, "origin");
        let merge_cfg = run_git(&work_path, &["config", "--get", "branch.feature.merge"]);
        assert_eq!(merge_cfg, "refs/heads/feature");

        // The bare origin actually received the branch + commit.
        let bare_log = run_git(&bare_path, &["log", "-1", "--format=%s", "feature"]);
        assert_eq!(bare_log, "feature commit");
    }

    #[test]
    fn ordinary_push_after_upstream_set_does_not_report_set_upstream() {
        let bare_tmp = seeded_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();
        let work_tmp = clone_into_work(&bare_path);
        let work_path = work_tmp.path().to_str().unwrap().to_string();

        run_git(&work_path, &["switch", "-c", "feature"]);
        write_and_commit(&work_path, "a.txt", "hello\n", "feature commit 1");
        let first = git_push(work_path.clone()).unwrap();
        assert!(first.set_upstream, "first push should have set upstream");

        write_and_commit(&work_path, "b.txt", "world\n", "feature commit 2");
        let second = git_push(work_path.clone()).unwrap();
        assert!(
            !second.set_upstream,
            "a push on an already-tracked branch should not need the retry"
        );

        let bare_log = run_git(&bare_path, &["log", "-1", "--format=%s", "feature"]);
        assert_eq!(bare_log, "feature commit 2");
    }

    #[test]
    fn fetch_and_pull_retrieve_remote_commits() {
        let bare_tmp = init_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();

        // work1 establishes `main` on the bare origin.
        let work1_tmp = clone_into_work(&bare_path);
        let work1_path = work1_tmp.path().to_str().unwrap().to_string();
        write_and_commit(&work1_path, "a.txt", "hello\n", "first commit");
        git_push(work1_path.clone()).unwrap();

        // work2 clones after `main` exists, so git itself sets up tracking —
        // this exercises the ordinary (non-retry) fetch/pull path.
        let work2_tmp = clone_into_work(&bare_path);
        let work2_path = work2_tmp.path().to_str().unwrap().to_string();

        // A second commit lands on the origin via work1.
        write_and_commit(&work1_path, "b.txt", "world\n", "second commit");
        let push_result = git_push(work1_path.clone()).unwrap();
        assert!(!push_result.set_upstream);

        // `git_fetch` updates the remote-tracking ref but not work2's local
        // `main` or working tree.
        git_fetch(work2_path.clone()).unwrap();
        let remote_tracking_log =
            run_git(&work2_path, &["log", "-1", "--format=%s", "origin/main"]);
        assert_eq!(remote_tracking_log, "second commit");
        let local_log_before_pull = run_git(&work2_path, &["log", "-1", "--format=%s"]);
        assert_eq!(local_log_before_pull, "first commit");

        // `git_pull` fast-forwards the local branch.
        git_pull(work2_path.clone()).unwrap();
        let local_log_after_pull = run_git(&work2_path, &["log", "-1", "--format=%s"]);
        assert_eq!(local_log_after_pull, "second commit");
    }

    #[test]
    fn push_no_upstream_retry_to_nonexistent_origin_remote_errors_cleanly() {
        // A repo with one commit and a remote that is NOT named "origin" —
        // `git push` still fails with "has no upstream branch" (that message
        // doesn't depend on the remote's name), but `git_push`'s hardcoded
        // `push -u origin <branch>` retry target genuinely doesn't exist in
        // this repo. This must surface a clean Err (not panic, not loop).
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap().to_string();
        run_git(&path, &["init", "--initial-branch=main"]);
        run_git(&path, &["config", "user.email", "test@example.com"]);
        run_git(&path, &["config", "user.name", "Test User"]);
        run_git(&path, &["commit", "--allow-empty", "-m", "init"]);

        let bare_tmp = tempfile::tempdir().unwrap();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();
        run_git(&bare_path, &["init", "--bare"]);
        run_git(&path, &["remote", "add", "not-origin", &bare_path]);

        let result = git_push(path);

        let err = result.expect_err("push should fail: no 'origin' remote to retry against");
        assert!(!err.is_empty());
        // Sanity: the "not-origin" remote was untouched (no upstream config
        // was ever written for it), proving the retry never silently
        // succeeded against the wrong remote.
        let bare_has_main = crate::process_util::command("git")
            .args(["-C", &bare_path, "rev-parse", "--verify", "refs/heads/main"])
            .output()
            .unwrap();
        assert!(
            !bare_has_main.status.success(),
            "the non-origin remote should not have received a push"
        );
    }

    // Note: interactive-prompt suppression (GIT_TERMINAL_PROMPT=0 / ssh batch
    // mode preventing hangs on real remotes) is intentionally covered by code
    // read of `run_git_remote`, not by a test — a network/DNS-dependent test
    // is flaky offline and a DNS failure precedes any prompt anyway.

    // --- ssh_command_override decision table (pure fn, no subprocess) ------

    #[test]
    fn ssh_override_composes_batch_mode_onto_existing_env_var() {
        assert_eq!(
            ssh_command_override(Some("ssh -i /corp/key -F /corp/config".into()), None),
            Some("ssh -i /corp/key -F /corp/config -oBatchMode=yes".into())
        );
    }

    #[test]
    fn ssh_override_env_var_wins_over_core_ssh_command_config() {
        // Mirrors git's own precedence: env beats config.
        assert_eq!(
            ssh_command_override(Some("custom-ssh".into()), Some("/bin/echo".into())),
            Some("custom-ssh -oBatchMode=yes".into())
        );
    }

    #[test]
    fn ssh_override_defers_to_core_ssh_command_config_when_env_unset() {
        // Setting GIT_SSH_COMMAND here would clobber the user's configured
        // transport, so nothing must be set at all.
        assert_eq!(ssh_command_override(None, Some("/bin/echo".into())), None);
    }

    #[test]
    fn ssh_override_defaults_to_batch_ssh_when_nothing_configured() {
        assert_eq!(
            ssh_command_override(None, None),
            Some("ssh -oBatchMode=yes".into())
        );
    }

    #[test]
    fn ssh_override_treats_blank_values_as_unset() {
        assert_eq!(
            ssh_command_override(Some(String::new()), None),
            Some("ssh -oBatchMode=yes".into())
        );
        assert_eq!(
            ssh_command_override(None, Some("  ".into())),
            Some("ssh -oBatchMode=yes".into())
        );
        assert_eq!(
            ssh_command_override(Some("  ".into()), Some("/bin/echo".into())),
            None
        );
    }

    // --- core.sshCommand fixture ------------------------------------------

    #[test]
    fn configured_core_ssh_command_suppresses_the_env_override() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap().to_string();
        run_git(&path, &["init", "--initial-branch=main"]);

        // Baseline: whatever the ambient (global/system) config says, it is
        // not our sentinel — proving the Some below comes from the local key.
        assert_ne!(core_ssh_command(&path), Some("/bin/echo".to_string()));

        run_git(&path, &["config", "core.sshCommand", "/bin/echo"]);
        assert_eq!(core_ssh_command(&path), Some("/bin/echo".to_string()));

        // With core.sshCommand configured and no GIT_SSH_COMMAND env var,
        // run_git_remote must not set the env var (the user's configured
        // transport wins).
        assert_eq!(ssh_command_override(None, core_ssh_command(&path)), None);
    }

    // --- no-retry pass-through cases --------------------------------------

    #[test]
    fn detached_head_push_failure_does_not_trigger_set_upstream_retry() {
        let bare_tmp = seeded_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();
        let work_tmp = clone_into_work(&bare_path);
        let work_path = work_tmp.path().to_str().unwrap().to_string();

        run_git(&work_path, &["checkout", "--detach"]);
        write_and_commit(&work_path, "a.txt", "hello\n", "detached commit");

        let err = git_push(work_path.clone()).expect_err("push from detached HEAD should fail");
        // git's detached-HEAD message ("You are not currently on a branch.")
        // does not contain "has no upstream branch", so the `-u origin`
        // retry must not fire and the raw error passes through verbatim.
        assert!(
            err.contains("not currently on a branch"),
            "expected the detached-HEAD error verbatim, got: {err}"
        );
        // The retry never invented an upstream for HEAD.
        let head_cfg = crate::process_util::command("git")
            .args(["-C", &work_path, "config", "--get", "branch.HEAD.remote"])
            .output()
            .unwrap();
        assert!(
            !head_cfg.status.success(),
            "no branch.HEAD.remote should have been configured"
        );
    }

    #[test]
    fn non_fast_forward_rejection_passes_through_without_retry() {
        let bare_tmp = seeded_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();

        // work1 advances origin/main; work2 (cloned at the same seed) commits
        // without pulling, so its push is a non-fast-forward rejection.
        let work1_tmp = clone_into_work(&bare_path);
        let work1_path = work1_tmp.path().to_str().unwrap().to_string();
        let work2_tmp = clone_into_work(&bare_path);
        let work2_path = work2_tmp.path().to_str().unwrap().to_string();

        write_and_commit(&work1_path, "a.txt", "one\n", "advance origin");
        assert!(!git_push(work1_path.clone()).unwrap().set_upstream);

        write_and_commit(&work2_path, "b.txt", "two\n", "stale commit");
        let err = git_push(work2_path.clone()).expect_err("non-fast-forward push should fail");
        assert!(
            err.contains("[rejected]"),
            "expected git's rejection to pass through verbatim, got: {err}"
        );
        // No retry rewrote history: origin/main still points at work1's commit.
        let bare_log = run_git(&bare_path, &["log", "-1", "--format=%s", "main"]);
        assert_eq!(bare_log, "advance origin");
    }

    // -----------------------------------------------------------------------
    // Branch listing: remote branches, and names that survive tag collisions.
    // -----------------------------------------------------------------------

    /// `%(refname:short)` shortens a ref only as far as stays unambiguous, so
    /// a branch sharing its name with a TAG comes back as `heads/v1.0.0` —
    /// which `git switch` then rejects outright:
    /// `fatal: a branch is expected, got 'refs/heads/v1.0.0'`.
    /// `%(refname:lstrip=2)` yields the real name in both cases.
    #[test]
    fn branch_name_is_not_mangled_by_a_colliding_tag() {
        let bare_tmp = seeded_bare_origin();
        let work_tmp = clone_into_work(bare_tmp.path().to_str().unwrap());
        let work = work_tmp.path().to_str().unwrap().to_string();

        run_git(&work, &["branch", "v1.0.0"]);
        run_git(&work, &["tag", "v1.0.0"]);

        let names: Vec<String> = git_list_branches(work.clone())
            .unwrap()
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert!(
            names.contains(&"v1.0.0".to_string()),
            "expected the real branch name, got: {names:?}"
        );
        assert!(
            !names.contains(&"heads/v1.0.0".to_string()),
            "branch name must not be prefix-disambiguated, got: {names:?}"
        );

        // And the name we surface is one git will actually switch to.
        git_switch_branch(work, "v1.0.0".to_string()).unwrap();
    }

    #[test]
    fn remote_branches_are_listed_and_flagged() {
        let bare_tmp = seeded_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();

        // Publish a branch that exists ONLY on the remote.
        let seed_tmp = clone_into_work(&bare_path);
        let seed = seed_tmp.path().to_str().unwrap().to_string();
        run_git(&seed, &["switch", "-c", "feature-x"]);
        write_and_commit(&seed, "f.txt", "x\n", "feature work");
        run_git(&seed, &["push", "-u", "origin", "feature-x"]);

        let work_tmp = clone_into_work(&bare_path);
        let work = work_tmp.path().to_str().unwrap().to_string();
        let branches = git_list_branches(work).unwrap();

        let remote = branches
            .iter()
            .find(|b| b.name == "origin/feature-x")
            .expect("remote-only branch must be listed");
        assert!(remote.is_remote);
        assert_eq!(
            remote.local_name.as_deref(),
            Some("feature-x"),
            "the branch to create on checkout comes from lstrip=3, so nested names survive"
        );

        let local = branches
            .iter()
            .find(|b| b.name == "main")
            .expect("local branch must still be listed");
        assert!(!local.is_remote);
        assert_eq!(local.local_name, None);
    }

    /// `refs/remotes/origin/HEAD` is a symbolic ref, not a branch. Left in, it
    /// renders as a bare `origin` row that switches to nothing.
    #[test]
    fn remote_head_symref_is_not_listed_as_a_branch() {
        let bare_tmp = seeded_bare_origin();
        let work_tmp = clone_into_work(bare_tmp.path().to_str().unwrap());
        let work = work_tmp.path().to_str().unwrap().to_string();
        // A fresh clone may not create origin/HEAD; set it explicitly so the
        // filter is genuinely exercised.
        run_git(&work, &["remote", "set-head", "origin", "main"]);

        let names: Vec<String> = git_list_branches(work)
            .unwrap()
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert!(
            !names.iter().any(|n| n == "origin" || n == "origin/HEAD"),
            "origin/HEAD must be filtered out, got: {names:?}"
        );
    }

    #[test]
    fn checking_out_a_remote_branch_creates_a_local_tracking_branch() {
        let bare_tmp = seeded_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();

        let seed_tmp = clone_into_work(&bare_path);
        let seed = seed_tmp.path().to_str().unwrap().to_string();
        run_git(&seed, &["switch", "-c", "feature-x"]);
        write_and_commit(&seed, "f.txt", "x\n", "feature work");
        run_git(&seed, &["push", "-u", "origin", "feature-x"]);

        let work_tmp = clone_into_work(&bare_path);
        let work = work_tmp.path().to_str().unwrap().to_string();

        let local = git_checkout_remote_branch(work.clone(), "origin/feature-x".to_string()).unwrap();
        assert_eq!(local, "feature-x");

        assert_eq!(git_status(work.clone()).unwrap().branch, "feature-x");
        let upstream = run_git(
            &work,
            &["rev-parse", "--abbrev-ref", "feature-x@{upstream}"],
        );
        assert_eq!(upstream, "origin/feature-x", "tracking must be configured");
    }

    /// Picking a remote branch whose local counterpart already exists must
    /// just switch to it, not fail trying to re-create it.
    #[test]
    fn checking_out_a_remote_branch_switches_to_an_existing_local_branch() {
        let bare_tmp = seeded_bare_origin();
        let bare_path = bare_tmp.path().to_str().unwrap().to_string();

        let seed_tmp = clone_into_work(&bare_path);
        let seed = seed_tmp.path().to_str().unwrap().to_string();
        run_git(&seed, &["switch", "-c", "feature-x"]);
        write_and_commit(&seed, "f.txt", "x\n", "feature work");
        run_git(&seed, &["push", "-u", "origin", "feature-x"]);

        let work_tmp = clone_into_work(&bare_path);
        let work = work_tmp.path().to_str().unwrap().to_string();
        // Local branch already present, and we're currently elsewhere.
        run_git(&work, &["switch", "-c", "feature-x", "origin/feature-x"]);
        run_git(&work, &["switch", "main"]);

        let local = git_checkout_remote_branch(work.clone(), "origin/feature-x".to_string()).unwrap();
        assert_eq!(local, "feature-x");
        assert_eq!(git_status(work).unwrap().branch, "feature-x");
    }
}

#[cfg(test)]
mod diff_file_head_tests {
    use super::*;

    fn run_git(path: &str, args: &[&str]) -> String {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = crate::process_util::command("git").args(&full).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Repo with one committed file (`a.txt`), so HEAD is valid and there is
    /// a tracked file to modify/stage in tests.
    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();
        run_git(path, &["init", "--initial-branch=main"]);
        // Windows git defaults to core.autocrlf=true and would rewrite LF to
        // CRLF every time it materialises a file (restore, stash pop, discard);
        // these tests assert on exact contents, so pin the temp repo instead.
        run_git(path, &["config", "core.autocrlf", "false"]);
        run_git(path, &["config", "user.email", "test@example.com"]);
        run_git(path, &["config", "user.name", "Test User"]);
        std::fs::write(std::path::Path::new(path).join("a.txt"), "line1\nline2\n").unwrap();
        run_git(path, &["add", "a.txt"]);
        run_git(path, &["commit", "-m", "init"]);
        tmp
    }

    #[test]
    fn modifying_a_committed_file_produces_a_non_empty_diff() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(
            std::path::Path::new(&path).join("a.txt"),
            "line1\nline2-modified\n",
        )
        .unwrap();

        let diff = git_diff_file_head(path, "a.txt".to_string()).unwrap();
        assert!(!diff.is_empty());
        assert!(diff.contains("-line2"));
        assert!(diff.contains("+line2-modified"));
    }

    #[test]
    fn untracked_file_produces_an_empty_diff() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("new.txt"), "hello\n").unwrap();

        let diff = git_diff_file_head(path, "new.txt".to_string()).unwrap();
        assert_eq!(diff, "");
    }

    #[test]
    fn staged_and_unstaged_changes_are_both_included_vs_head() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        // Stage one change...
        std::fs::write(
            std::path::Path::new(&path).join("a.txt"),
            "line1-staged\nline2\n",
        )
        .unwrap();
        run_git(&path, &["add", "a.txt"]);

        // ...then make a further unstaged change on top.
        std::fs::write(
            std::path::Path::new(&path).join("a.txt"),
            "line1-staged\nline2-unstaged\n",
        )
        .unwrap();

        let diff = git_diff_file_head(path, "a.txt".to_string()).unwrap();
        assert!(
            diff.contains("+line1-staged"),
            "staged change missing from diff vs HEAD: {diff}"
        );
        assert!(
            diff.contains("+line2-unstaged"),
            "unstaged change missing from diff vs HEAD: {diff}"
        );
    }

    #[test]
    fn clean_file_produces_an_empty_diff() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let diff = git_diff_file_head(path, "a.txt".to_string()).unwrap();
        assert_eq!(diff, "");
    }

    #[test]
    fn empty_file_path_is_rejected() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let err = git_diff_file_head(path, "".to_string()).expect_err("empty path should error");
        assert!(!err.is_empty());
    }
}

// ---------------------------------------------------------------------------
// A8: Stash push/list/apply/pop/drop + commit --amend
// ---------------------------------------------------------------------------

#[cfg(test)]
mod stash_and_amend_tests {
    use super::*;

    fn run_git(path: &str, args: &[&str]) -> String {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = crate::process_util::command("git").args(&full).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Repo with one committed file (`a.txt`), so HEAD is valid and there is
    /// a tracked file to modify for stash tests.
    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();
        run_git(path, &["init", "--initial-branch=main"]);
        // Windows git defaults to core.autocrlf=true and would rewrite LF to
        // CRLF every time it materialises a file (restore, stash pop, discard);
        // these tests assert on exact contents, so pin the temp repo instead.
        run_git(path, &["config", "core.autocrlf", "false"]);
        run_git(path, &["config", "user.email", "test@example.com"]);
        run_git(path, &["config", "user.name", "Test User"]);
        std::fs::write(std::path::Path::new(path).join("a.txt"), "line1\n").unwrap();
        run_git(path, &["add", "a.txt"]);
        run_git(path, &["commit", "-m", "init"]);
        tmp
    }

    #[test]
    fn parse_stash_index_extracts_n_from_selector() {
        assert_eq!(parse_stash_index("stash@{0}"), Some(0));
        assert_eq!(parse_stash_index("stash@{12}"), Some(12));
        assert_eq!(parse_stash_index("not-a-selector"), None);
    }

    #[test]
    fn stash_ref_builds_selector_from_index() {
        assert_eq!(stash_ref(0), "stash@{0}");
        assert_eq!(stash_ref(7), "stash@{7}");
    }

    #[test]
    fn stash_push_then_list_reports_index_and_message() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1\nline2\n").unwrap();

        git_stash_push(path.clone(), Some("my custom message".into()), false).unwrap();

        let stashes = git_stash_list(path).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);
        assert!(
            stashes[0].message.contains("my custom message"),
            "expected custom message in stash subject, got: {}",
            stashes[0].message
        );
        assert!(!stashes[0].date.is_empty());
    }

    #[test]
    fn stash_push_without_message_uses_default_wip_subject() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1\nline2\n").unwrap();

        git_stash_push(path.clone(), None, false).unwrap();

        let stashes = git_stash_list(path).unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(
            stashes[0].message.contains("WIP on main"),
            "expected default WIP subject, got: {}",
            stashes[0].message
        );
    }

    #[test]
    fn stash_push_includes_untracked_file_when_requested() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("untracked.txt"), "new\n").unwrap();

        git_stash_push(path.clone(), Some("with untracked".into()), true).unwrap();

        // The untracked file is gone from the working tree after the stash...
        assert!(!std::path::Path::new(&path).join("untracked.txt").exists());

        // ...and comes back after popping.
        let stashes = git_stash_list(path.clone()).unwrap();
        assert_eq!(stashes.len(), 1);
        git_stash_pop(path.clone(), stashes[0].index).unwrap();
        assert!(std::path::Path::new(&path).join("untracked.txt").exists());
    }

    #[test]
    fn stash_push_without_include_untracked_leaves_untracked_file_on_disk() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1\nline2\n").unwrap();
        std::fs::write(std::path::Path::new(&path).join("untracked.txt"), "new\n").unwrap();

        git_stash_push(path.clone(), Some("no untracked".into()), false).unwrap();

        // Tracked change was stashed away...
        let content = std::fs::read_to_string(std::path::Path::new(&path).join("a.txt")).unwrap();
        assert_eq!(content, "line1\n");
        // ...but the untracked file was left alone.
        assert!(std::path::Path::new(&path).join("untracked.txt").exists());
    }

    #[test]
    fn stash_pop_restores_file_and_removes_stash_from_list() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1\nline2\n").unwrap();
        git_stash_push(path.clone(), Some("to pop".into()), false).unwrap();

        // File reverted to HEAD's content after the stash.
        let content = std::fs::read_to_string(std::path::Path::new(&path).join("a.txt")).unwrap();
        assert_eq!(content, "line1\n");

        git_stash_pop(path.clone(), 0).unwrap();

        // File back on disk with the stashed change...
        let content = std::fs::read_to_string(std::path::Path::new(&path).join("a.txt")).unwrap();
        assert_eq!(content, "line1\nline2\n");
        // ...and the stash entry is gone.
        let stashes = git_stash_list(path).unwrap();
        assert_eq!(stashes.len(), 0);
    }

    #[test]
    fn stash_apply_restores_file_but_keeps_stash_entry() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1\nline2\n").unwrap();
        git_stash_push(path.clone(), Some("to apply".into()), false).unwrap();

        git_stash_apply(path.clone(), 0).unwrap();

        let content = std::fs::read_to_string(std::path::Path::new(&path).join("a.txt")).unwrap();
        assert_eq!(content, "line1\nline2\n");

        // Unlike pop, apply leaves the stash entry in place.
        let stashes = git_stash_list(path).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);
    }

    #[test]
    fn stash_drop_removes_entry_from_list() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1\nline2\n").unwrap();
        git_stash_push(path.clone(), Some("to drop".into()), false).unwrap();
        assert_eq!(git_stash_list(path.clone()).unwrap().len(), 1);

        git_stash_drop(path.clone(), 0).unwrap();

        assert_eq!(git_stash_list(path).unwrap().len(), 0);
    }

    #[test]
    fn stash_indices_shift_after_drop_of_most_recent() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("a.txt"), "v1\n").unwrap();
        git_stash_push(path.clone(), Some("first".into()), false).unwrap();
        std::fs::write(std::path::Path::new(&path).join("a.txt"), "v2\n").unwrap();
        git_stash_push(path.clone(), Some("second".into()), false).unwrap();

        // Newest stash is index 0.
        let stashes = git_stash_list(path.clone()).unwrap();
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].index, 0);
        assert!(stashes[0].message.contains("second"));
        assert_eq!(stashes[1].index, 1);
        assert!(stashes[1].message.contains("first"));

        // Dropping stash@{0} ("second") shifts "first" down to index 0.
        git_stash_drop(path.clone(), 0).unwrap();
        let stashes = git_stash_list(path).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);
        assert!(stashes[0].message.contains("first"));
    }

    #[test]
    fn apply_and_pop_reject_out_of_range_index() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        let apply_err = git_stash_apply(path.clone(), 99).unwrap_err();
        assert!(!apply_err.is_empty());
        let pop_err = git_stash_pop(path, 99).unwrap_err();
        assert!(!pop_err.is_empty());
    }

    #[test]
    fn commit_without_amend_creates_a_new_commit() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("b.txt"), "b\n").unwrap();
        run_git(&path, &["add", "b.txt"]);

        git_commit(path.clone(), "second commit".into(), Some(false)).unwrap();

        let log = git_log(path, None).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].message, "second commit");
        assert_eq!(log[1].message, "init");
    }

    #[test]
    fn commit_amend_true_rewrites_head_message_without_new_commit() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        git_commit(path.clone(), "amended message".into(), Some(true)).unwrap();

        let log = git_log(path, None).unwrap();
        assert_eq!(log.len(), 1, "amend must not add a new commit");
        assert_eq!(log[0].message, "amended message");
    }

    #[test]
    fn commit_amend_omitted_defaults_to_false() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("c.txt"), "c\n").unwrap();
        run_git(&path, &["add", "c.txt"]);

        // Backward-compat: calling with `amend: None` behaves exactly like
        // the pre-A8 two-argument signature (plain commit, no amend).
        git_commit(path.clone(), "third commit".into(), None).unwrap();

        let log = git_log(path, None).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].message, "third commit");
    }
}

// ---------------------------------------------------------------------------
// Status parsing — pins the porcelain-v2 field layout, in two layers:
// literal-line fixtures through parse_status (the spec as we read it), and
// hermetic end-to-end runs of git_status against real git output (the spec
// as git actually emits it). The second layer exists because a field-count
// off-by-one in the `1 `/`2 ` arms silently dropped EVERY tracked-file
// change from the SCM panel while branch/log kept working — an error state
// invisible to any test that constructs GitStatusResult by hand.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod status_parse_tests {
    use super::*;

    const WS: &str = "/ws";

    // ── Layer 1: literal porcelain-v2 lines ────────────────────────────────

    /// Captured verbatim from a real repo (admissions-new, git 2.52.0) — the
    /// exact line the shipped parser dropped.
    #[test]
    fn ordinary_unstaged_modification_is_parsed() {
        let line = "1 .M N... 100644 100644 100644 5a536053ed889576f9e8b10780fb019a0f6dce72 5a536053ed889576f9e8b10780fb019a0f6dce72 api/controllers/counsellingSlot.controller.ts";
        let r = parse_status(line, WS);
        assert_eq!(r.staged.len(), 0);
        assert_eq!(r.unstaged.len(), 1);
        let f = &r.unstaged[0];
        assert_eq!(f.path, "api/controllers/counsellingSlot.controller.ts");
        assert_eq!(
            f.absolute_path,
            "/ws/api/controllers/counsellingSlot.controller.ts"
        );
        assert_eq!(f.status, map_status_char('M').to_string());
        assert!(!f.staged);
        assert!(!f.conflicted);
    }

    #[test]
    fn ordinary_staged_only_modification_goes_to_staged_list() {
        let line = "1 M. N... 100644 100644 100644 aaaa bbbb src/a.ts";
        let r = parse_status(line, WS);
        assert_eq!(r.staged.len(), 1);
        assert_eq!(r.unstaged.len(), 0);
        assert!(r.staged[0].staged);
        assert_eq!(r.staged[0].path, "src/a.ts");
    }

    #[test]
    fn ordinary_both_staged_and_unstaged_lands_in_both_lists() {
        let line = "1 MM N... 100644 100644 100644 aaaa bbbb src/a.ts";
        let r = parse_status(line, WS);
        assert_eq!(r.staged.len(), 1);
        assert_eq!(r.unstaged.len(), 1);
    }

    #[test]
    fn ordinary_added_and_deleted_status_chars_map() {
        let added = parse_status("1 A. N... 000000 100644 100644 0000 bbbb new.ts", WS);
        assert_eq!(added.staged.len(), 1);
        assert_eq!(added.staged[0].status, map_status_char('A').to_string());

        let deleted = parse_status("1 .D N... 100644 100644 000000 aaaa 0000 gone.ts", WS);
        assert_eq!(deleted.unstaged.len(), 1);
        assert_eq!(deleted.unstaged[0].status, map_status_char('D').to_string());
    }

    #[test]
    fn ordinary_path_with_spaces_survives_as_last_field() {
        let line = "1 .M N... 100644 100644 100644 aaaa bbbb Assets/My Scripts/Player Controller.cs";
        let r = parse_status(line, WS);
        assert_eq!(r.unstaged.len(), 1);
        assert_eq!(r.unstaged[0].path, "Assets/My Scripts/Player Controller.cs");
    }

    /// Under `-z` a rename's original path is its OWN NUL record, not a
    /// tab-joined suffix of the entry record. Verified against git 2.52.0:
    ///
    /// ```text
    /// 2 RM N... ... R100 src/new-name.txt\0src/old-name.txt\0
    /// ```
    #[test]
    fn rename_entry_carries_orig_path_from_its_own_record() {
        let out = "2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new.ts\0src/old.ts";
        let r = parse_status(out, WS);
        assert_eq!(r.staged.len(), 1);
        assert_eq!(r.staged[0].path, "src/new.ts");
        assert_eq!(
            r.staged[0].orig_path.as_deref(),
            Some("src/old.ts"),
            "the pre-rename path is what the HEAD side of the diff must be read from"
        );
        assert_eq!(r.staged[0].status, map_status_char('R').to_string());
        assert_eq!(r.unstaged.len(), 0);
    }

    /// Failing to consume the rename's extra record would treat `src/old.ts`
    /// as the next entry and shift everything after it by one — the kind of
    /// silent corruption that drops real changes off the panel.
    #[test]
    fn rename_does_not_shift_the_entries_that_follow_it() {
        let out = concat!(
            "2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new.ts\0src/old.ts\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/after.ts\0",
            "? untracked-after.ts"
        );
        let r = parse_status(out, WS);
        assert_eq!(r.staged.len(), 1, "only the rename is staged");
        assert_eq!(r.staged[0].path, "src/new.ts");

        let unstaged: Vec<&str> = r.unstaged.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            unstaged,
            vec!["src/after.ts", "untracked-after.ts"],
            "entries after a rename must not shift, and `src/old.ts` is not an entry"
        );
    }

    #[test]
    fn unmerged_and_untracked_still_parse() {
        let out = "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicted.cs\0? junk.log";
        let r = parse_status(out, WS);
        assert_eq!(r.unstaged.len(), 2);
        assert!(r.unstaged[0].conflicted);
        assert_eq!(r.unstaged[0].status, "conflicted");
        assert_eq!(r.unstaged[1].status, "untracked");
    }

    #[test]
    fn branch_headers_and_unknown_lines_parse_without_entries() {
        let out = "# branch.oid deadbeef\0# branch.head feat/x\0# branch.upstream origin/feat/x\0# branch.ab +2 -1\0# stash 3\0bogus line";
        let r = parse_status(out, WS);
        assert_eq!(r.branch, "feat/x");
        assert_eq!(r.ahead, 2);
        assert_eq!(r.behind, 1);
        assert!(r.staged.is_empty() && r.unstaged.is_empty());
    }

    /// `-z` exists precisely so paths arrive as raw bytes. Without it git
    /// C-quotes anything non-ASCII (`"h\303\251llo.txt"`), and that literal
    /// string then fails every downstream use — `git add` rejects it as a
    /// non-matching pathspec, and no explorer node ever matches it.
    #[test]
    fn non_ascii_paths_arrive_unquoted() {
        let out = "1 .M N... 100644 100644 100644 aaaa bbbb Assets/héllo wörld.cs";
        let r = parse_status(out, WS);
        assert_eq!(r.unstaged.len(), 1);
        assert_eq!(r.unstaged[0].path, "Assets/héllo wörld.cs");
        assert_eq!(r.unstaged[0].absolute_path, "/ws/Assets/héllo wörld.cs");
    }

    // ── Layer 2: end-to-end against real `git status` output ───────────────

    /// Setup commands isolate host gitconfig, mirroring staged_diff_tests.
    fn run_git(path: &str, args: &[&str]) {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = crate::process_util::command("git")
            .args(&full)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        run_git(p, &["init", "-q"]);
        // See the note in the other init_repo helpers: Windows git would
        // rewrite LF to CRLF on every checkout without this.
        run_git(p, &["config", "core.autocrlf", "false"]);
        run_git(p, &["config", "user.email", "t@t.t"]);
        run_git(p, &["config", "user.name", "t"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        run_git(p, &["add", "a.txt"]);
        run_git(p, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn e2e_modified_tracked_file_appears_unstaged() {
        let dir = init_repo();
        let p = dir.path().to_str().unwrap().to_string();
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        let r = git_status(p).unwrap();
        assert_eq!(r.staged.len(), 0, "nothing staged yet");
        assert_eq!(r.unstaged.len(), 1, "the edit must appear as unstaged");
        assert_eq!(r.unstaged[0].path, "a.txt");
    }

    #[test]
    fn e2e_staged_then_edited_appears_in_both_lists() {
        let dir = init_repo();
        let p = dir.path().to_str().unwrap().to_string();
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        run_git(&p, &["add", "a.txt"]);
        let r = git_status(p.clone()).unwrap();
        assert_eq!(r.staged.len(), 1, "staged edit must appear");
        assert_eq!(r.unstaged.len(), 0);

        std::fs::write(dir.path().join("a.txt"), "three\n").unwrap();
        let r = git_status(p).unwrap();
        assert_eq!(r.staged.len(), 1);
        assert_eq!(r.unstaged.len(), 1, "second edit must appear unstaged too");
    }

    #[test]
    fn e2e_rename_appears_staged() {
        let dir = init_repo();
        let p = dir.path().to_str().unwrap().to_string();
        run_git(&p, &["mv", "a.txt", "b.txt"]);
        let r = git_status(p).unwrap();
        assert_eq!(r.staged.len(), 1, "rename must appear staged");
        assert_eq!(r.staged[0].path, "b.txt");
    }

    #[test]
    fn e2e_untracked_file_appears() {
        let dir = init_repo();
        let p = dir.path().to_str().unwrap().to_string();
        std::fs::write(dir.path().join("new.txt"), "x\n").unwrap();
        let r = git_status(p).unwrap();
        assert_eq!(r.unstaged.len(), 1);
        assert_eq!(r.unstaged[0].status, "untracked");
    }

    /// The reported "created folders show up in the diff" bug. Git's default
    /// untracked mode collapses a new directory into a single `? newfolder/`
    /// entry, which the panel rendered as a file row that could be neither
    /// diffed (it's a directory) nor discarded. `-uall` lists the files.
    #[test]
    fn e2e_untracked_files_in_a_new_folder_are_listed_individually() {
        let dir = init_repo();
        let p = dir.path().to_str().unwrap().to_string();
        std::fs::create_dir_all(dir.path().join("newfolder/inner")).unwrap();
        std::fs::write(dir.path().join("newfolder/two.txt"), "x\n").unwrap();
        std::fs::write(dir.path().join("newfolder/inner/one.txt"), "y\n").unwrap();

        let r = git_status(p).unwrap();
        let mut paths: Vec<&str> = r.unstaged.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["newfolder/inner/one.txt", "newfolder/two.txt"]);
        assert!(
            !r.unstaged.iter().any(|f| f.path.ends_with('/')),
            "a directory must never be listed as a changed file"
        );
    }

    /// Without `-z`, git C-quotes this path to `"h\303\251llo.txt"` and every
    /// downstream operation on it fails.
    #[test]
    fn e2e_non_ascii_path_round_trips_through_staging() {
        let dir = init_repo();
        let p = dir.path().to_str().unwrap().to_string();
        std::fs::write(dir.path().join("héllo wörld.txt"), "x\n").unwrap();

        let r = git_status(p.clone()).unwrap();
        assert_eq!(r.unstaged.len(), 1);
        assert_eq!(r.unstaged[0].path, "héllo wörld.txt");

        // The path the panel shows must be one git will actually accept back.
        git_stage_file(p.clone(), r.unstaged[0].path.clone()).unwrap();
        let r = git_status(p).unwrap();
        assert_eq!(r.staged.len(), 1);
        assert_eq!(r.staged[0].path, "héllo wörld.txt");
    }

    /// Unlike a rename, an unmerged (`u `) entry is a SINGLE `-z` record — no
    /// trailing original-path record to consume. Pinning that against real git
    /// guards the parser's cursor arithmetic: consuming one record too many
    /// here would swallow whichever entry follows a conflict.
    #[test]
    fn e2e_conflicted_entry_does_not_swallow_the_next_entry() {
        let dir = init_repo();
        let p = dir.path().to_str().unwrap().to_string();

        std::fs::write(dir.path().join("c.txt"), "base\n").unwrap();
        run_git(&p, &["add", "-A"]);
        run_git(&p, &["commit", "-q", "-m", "base"]);

        run_git(&p, &["switch", "-qc", "feature"]);
        std::fs::write(dir.path().join("c.txt"), "theirs\n").unwrap();
        run_git(&p, &["commit", "-qam", "theirs"]);

        // `-` rather than a literal name: this module's `init_repo` runs a
        // bare `git init`, so the initial branch is whatever the host's
        // `init.defaultBranch` says (main, master, ...).
        run_git(&p, &["switch", "-q", "-"]);
        std::fs::write(dir.path().join("c.txt"), "ours\n").unwrap();
        run_git(&p, &["commit", "-qam", "ours"]);

        // Conflicting merge — expected to fail, so not run through `run_git`.
        let _ = crate::process_util::command("git")
            .args(["-C", &p, "merge", "feature"])
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();

        std::fs::write(dir.path().join("untracked-after.txt"), "zzz\n").unwrap();

        let r = git_status(p).unwrap();
        let conflicted: Vec<&str> = r
            .unstaged
            .iter()
            .filter(|f| f.conflicted)
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(conflicted, vec!["c.txt"]);
        assert!(
            r.unstaged.iter().any(|f| f.path == "untracked-after.txt"),
            "the entry after a conflict must survive, got: {:?}",
            r.unstaged.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
    }

    #[test]
    fn e2e_rename_reports_its_original_path() {
        let dir = init_repo();
        let p = dir.path().to_str().unwrap().to_string();
        run_git(&p, &["mv", "a.txt", "b.txt"]);
        let r = git_status(p).unwrap();
        assert_eq!(r.staged.len(), 1);
        assert_eq!(r.staged[0].path, "b.txt");
        assert_eq!(r.staged[0].orig_path.as_deref(), Some("a.txt"));
    }
}

// ---------------------------------------------------------------------------
// T5: Staged-diff correctness — git_show_index + tightened error
// classification for git_show_head / git_blame_file, plus a serde contract
// pin for GitStatusResult (the frontend consumes these exact field names).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod staged_diff_tests {
    use super::*;

    /// Every git invocation in this module ignores the host's global/system
    /// gitconfig (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` -> `/dev/null`) so a
    /// developer machine's commit signing, hooks, or aliases can't make these
    /// tests hang or fail. Applied to the *setup* commands this module runs
    /// directly (init/config/add/commit/rm) — the production commands under
    /// test (`git_show_head`/`git_show_index`/`git_blame_file`) never invoke
    /// `git commit`, so they carry no signing/hook risk of their own.
    fn run_git(path: &str, args: &[&str]) -> String {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = crate::process_util::command("git")
            .args(&full)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Repo with one committed file (`a.txt`), so HEAD is valid and there is
    /// a tracked file to stage/edit/delete in tests.
    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap();
        run_git(path, &["init", "--initial-branch=main"]);
        // Windows git defaults to core.autocrlf=true and would rewrite LF to
        // CRLF every time it materialises a file (restore, stash pop, discard);
        // these tests assert on exact contents, so pin the temp repo instead.
        run_git(path, &["config", "core.autocrlf", "false"]);
        run_git(path, &["config", "user.email", "test@example.com"]);
        run_git(path, &["config", "user.name", "Test User"]);
        std::fs::write(std::path::Path::new(path).join("a.txt"), "line1\n").unwrap();
        run_git(path, &["add", "a.txt"]);
        run_git(path, &["commit", "-m", "init"]);
        tmp
    }

    // --- git_show_index ------------------------------------------------

    #[test]
    fn show_index_returns_staged_version_not_worktree() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        // Stage one change...
        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1-staged\n").unwrap();
        run_git(&path, &["add", "a.txt"]);
        // ...then make a further UNSTAGED change on top.
        std::fs::write(std::path::Path::new(&path).join("a.txt"), "line1-worktree\n").unwrap();

        let indexed = git_show_index(path, "a.txt".into()).unwrap();
        assert_eq!(
            indexed, "line1-staged\n",
            "git_show_index must return the INDEX content, not the working tree"
        );
    }

    #[test]
    fn show_index_untracked_file_returns_empty() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("new.txt"), "hello\n").unwrap();

        let content = git_show_index(path, "new.txt".into()).unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn show_index_staged_deletion_returns_empty() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        run_git(&path, &["rm", "--cached", "a.txt"]);

        let content = git_show_index(path, "a.txt".into()).unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn show_index_never_existed_path_returns_empty() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        // A path that was never on disk and never staged at all — git phrases
        // this differently ("does not exist (neither on disk nor in the
        // index)") from the plain-untracked case, but it's still "not in the
        // index" and must not surface as an error.
        let content = git_show_index(path, "totally-missing.txt".into()).unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn show_index_unmerged_path_errors() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        run_git(&path, &["switch", "-c", "branch-a"]);
        std::fs::write(std::path::Path::new(&path).join("a.txt"), "a-version\n").unwrap();
        run_git(&path, &["commit", "-am", "a"]);
        run_git(&path, &["switch", "main"]);
        run_git(&path, &["switch", "-c", "branch-b"]);
        std::fs::write(std::path::Path::new(&path).join("a.txt"), "b-version\n").unwrap();
        run_git(&path, &["commit", "-am", "b"]);

        // Merge branch-a into branch-b — conflicts on a.txt, leaving it
        // unmerged (no stage 0). This `git merge` is expected to fail (exit
        // non-zero) — that's the conflict itself, not a test setup error.
        let _ = crate::process_util::command("git")
            .args(["-C", &path, "merge", "--no-edit", "branch-a"])
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();

        let result = git_show_index(path, "a.txt".into());
        let err = result.expect_err("unmerged path has no stage 0 and must error, not Ok(\"\")");
        assert!(
            !err.is_empty(),
            "expected a non-empty stderr message, got empty string"
        );
    }

    // --- git_show_head ---------------------------------------------------

    #[test]
    fn show_head_new_file_not_yet_in_head_returns_empty() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        std::fs::write(std::path::Path::new(&path).join("new.txt"), "hello\n").unwrap();
        run_git(&path, &["add", "new.txt"]);

        let content = git_show_head(path, "new.txt".into()).unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn show_head_bogus_repo_path_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap().to_string();
        // Deliberately NOT a git repo — no `git init` here.

        let result = git_show_head(path, "a.txt".into());

        let err = result.expect_err("a non-git directory must error, not Ok(\"\")");
        assert!(!err.is_empty());
    }

    // --- git_blame_file ----------------------------------------------------

    #[tokio::test]
    async fn blame_untracked_or_missing_path_returns_empty_vec() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        // Untracked (on disk, never committed): `fatal: no such path ... in
        // HEAD` — classified as "nothing to blame", not an error.
        std::fs::write(std::path::Path::new(&path).join("new.txt"), "hello\n").unwrap();
        let lines = git_blame_file(path.clone(), "new.txt".into()).await.unwrap();
        assert!(lines.is_empty());

        // Never existed anywhere: same stderr shape, same classification.
        let lines = git_blame_file(path, "never-existed.txt".into())
            .await
            .unwrap();
        assert!(lines.is_empty());
    }

    #[tokio::test]
    async fn blame_bogus_repo_path_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_str().unwrap().to_string();
        // Deliberately NOT a git repo — no `git init` here.

        let result = git_blame_file(path, "a.txt".into()).await;

        let err = result.expect_err("a non-git directory must error, not Ok(vec![])");
        assert!(!err.is_empty());
    }

    // --- serde contract: GitStatusResult / GitFileStatus field names ------

    /// Pins the exact JSON field names the frontend's `GitStatusResult`/
    /// `GitFileStatus` TypeScript types consume (see
    /// `src/features/git`/`src/stores/git.ts`). A future rename or
    /// `#[serde(rename)]` change here would otherwise silently break the
    /// frontend without any type error, since the Tauri IPC boundary is
    /// JSON, not shared types.
    #[test]
    fn git_status_result_serde_field_names() {
        let file = GitFileStatus {
            path: "src/a.txt".to_string(),
            absolute_path: "/repo/src/a.txt".to_string(),
            status: "modified".to_string(),
            staged: true,
            conflicted: false,
            orig_path: None,
        };
        let file_value = serde_json::to_value(&file).unwrap();
        let file_obj = file_value.as_object().unwrap();
        assert!(file_obj.contains_key("path"));
        assert!(file_obj.contains_key("absolute_path"));
        assert!(file_obj.contains_key("status"));
        assert!(file_obj.contains_key("staged"));
        assert!(file_obj.contains_key("conflicted"));
        // `orig_path` is `skip_serializing_if = "Option::is_none"`, so it is
        // absent for every non-rename entry — the common case stays a 5-field
        // payload.
        assert!(!file_obj.contains_key("orig_path"));
        assert_eq!(file_obj.len(), 5, "unexpected extra/missing field on GitFileStatus");

        let renamed = GitFileStatus {
            orig_path: Some("src/old.txt".to_string()),
            ..GitFileStatus {
                path: "src/new.txt".to_string(),
                absolute_path: "/repo/src/new.txt".to_string(),
                status: "renamed".to_string(),
                staged: true,
                conflicted: false,
                orig_path: None,
            }
        };
        let renamed_obj = serde_json::to_value(&renamed).unwrap();
        assert_eq!(
            renamed_obj["orig_path"],
            serde_json::json!("src/old.txt"),
            "renames must carry their pre-rename path to the frontend"
        );

        let result = GitStatusResult {
            branch: "main".to_string(),
            staged: vec![file],
            unstaged: vec![],
            ahead: 1,
            behind: 2,
        };
        let value = serde_json::to_value(&result).unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("branch"));
        assert!(obj.contains_key("staged"));
        assert!(obj.contains_key("unstaged"));
        assert!(obj.contains_key("ahead"));
        assert!(obj.contains_key("behind"));
        assert_eq!(obj.len(), 5, "unexpected extra/missing field on GitStatusResult");

        // Values round-trip as expected (not just key presence).
        assert_eq!(obj["branch"], serde_json::json!("main"));
        assert_eq!(obj["ahead"], serde_json::json!(1));
        assert_eq!(obj["behind"], serde_json::json!(2));
        let staged_arr = obj["staged"].as_array().unwrap();
        assert_eq!(staged_arr.len(), 1);
        assert_eq!(staged_arr[0]["path"], serde_json::json!("src/a.txt"));
        assert_eq!(
            staged_arr[0]["absolute_path"],
            serde_json::json!("/repo/src/a.txt")
        );
        assert_eq!(staged_arr[0]["status"], serde_json::json!("modified"));
        assert_eq!(staged_arr[0]["conflicted"], serde_json::json!(false));
    }

    // -----------------------------------------------------------------------
    // Repo-root resolution
    //
    // `git status --porcelain` prints paths relative to the CURRENT DIRECTORY,
    // but `git show <rev>:<path>` resolves them relative to the REPOSITORY
    // ROOT. Treating those as interchangeable silently showed the wrong file
    // whenever the opened workspace was a subdirectory of the repo. These
    // tests pin the resolution that keeps every path on one base.
    // -----------------------------------------------------------------------

    #[test]
    fn repo_root_at_the_root_is_the_workspace_itself() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        // `--show-prefix` is empty here, so the workspace passes through
        // untouched — the common case must be a no-op.
        assert_eq!(repo_root(&path).unwrap(), path);
    }

    #[test]
    fn repo_root_from_a_subdirectory_strips_the_prefix() {
        let tmp = init_repo();
        let root = tmp.path().to_str().unwrap().to_string();
        std::fs::create_dir_all(tmp.path().join("UnityProject/Assets")).unwrap();

        let nested = format!("{root}/UnityProject/Assets");
        assert_eq!(repo_root(&nested).unwrap(), root);

        let one_deep = format!("{root}/UnityProject");
        assert_eq!(repo_root(&one_deep).unwrap(), root);
    }

    // Unix-only, matching `canonicalize_path_tests` in lib.rs: creating a
    // symlink on Windows needs elevated privileges / dev mode, which isn't
    // guaranteed in CI. The trap this guards is macOS-specific anyway.
    #[cfg(unix)]
    #[test]
    fn repo_root_preserves_the_callers_path_spelling() {
        // Regression guard for the macOS symlink trap: `--show-toplevel`
        // resolves symlinks (`/tmp/x` -> `/private/tmp/x`), which would make
        // `absolute_path` stop matching the frontend's tree node ids and
        // silently kill every explorer git badge. Deriving the root by
        // stripping `--show-prefix` keeps whatever spelling the caller used.
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(real.join("nested")).unwrap();
        let real_str = real.to_str().unwrap();
        run_git(real_str, &["init", "--initial-branch=main"]);

        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let via_link = format!("{}/nested", link.to_str().unwrap());
        assert_eq!(repo_root(&via_link).unwrap(), link.to_str().unwrap());
    }

    #[test]
    fn repo_root_outside_a_repo_reports_not_a_git_repository() {
        // `stores/git.ts`'s `doRefreshStatus` classifies this exact substring
        // to blank the panel instead of showing an error banner.
        let tmp = tempfile::tempdir().unwrap();
        let err = repo_root(tmp.path().to_str().unwrap()).unwrap_err();
        assert!(
            err.contains("not a git repository"),
            "expected a not-a-repo error, got: {err}"
        );
    }

    /// The reported bug, end to end: a repo holding BOTH `Assets/Player.cs`
    /// and `UnityProject/Assets/Player.cs`, with the workspace opened at
    /// `UnityProject/`. `git status` reports the changed file as
    /// `Assets/Player.cs` (CWD-relative); feeding that straight to
    /// `git show HEAD:` used to return the ROOT file's contents with no error
    /// at all.
    #[test]
    fn diff_of_a_subdirectory_workspace_reads_the_right_file() {
        let tmp = init_repo();
        let root = tmp.path().to_str().unwrap().to_string();
        std::fs::create_dir_all(tmp.path().join("Assets")).unwrap();
        std::fs::create_dir_all(tmp.path().join("UnityProject/Assets")).unwrap();
        std::fs::write(tmp.path().join("Assets/Player.cs"), "ROOT LEVEL\n").unwrap();
        std::fs::write(
            tmp.path().join("UnityProject/Assets/Player.cs"),
            "UNITY PROJECT\n",
        )
        .unwrap();
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "both"]);
        std::fs::write(
            tmp.path().join("UnityProject/Assets/Player.cs"),
            "UNITY PROJECT edited\n",
        )
        .unwrap();

        let workspace = format!("{root}/UnityProject");
        let status = git_status(workspace.clone()).unwrap();

        // Status paths are repo-root-relative, so the row is unambiguous.
        let entry = status
            .unstaged
            .iter()
            .find(|f| f.path.ends_with("Player.cs"))
            .expect("modified Player.cs should be listed");
        assert_eq!(entry.path, "UnityProject/Assets/Player.cs");
        assert_eq!(
            entry.absolute_path,
            format!("{root}/UnityProject/Assets/Player.cs"),
            "absolute_path must be built from the repo root"
        );

        // And that path resolves to the file the user actually clicked.
        let head = git_show_head(workspace, entry.path.clone()).unwrap();
        assert_eq!(head, "UNITY PROJECT\n", "diff showed the wrong file");
    }

    /// Discarding an untracked path used to call `std::fs::remove_file`, which
    /// fails outright on a directory ("Is a directory") and leaves empty parent
    /// directories behind for a nested file. `git clean` is what git itself
    /// uses and handles both.
    #[test]
    fn discarding_an_untracked_file_removes_it() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        std::fs::create_dir_all(tmp.path().join("nested")).unwrap();
        std::fs::write(tmp.path().join("nested/junk.txt"), "x\n").unwrap();

        git_discard_file(path.clone(), "nested/junk.txt".to_string(), true).unwrap();

        assert!(!tmp.path().join("nested/junk.txt").exists());
        assert!(git_status(path).unwrap().unstaged.is_empty());
    }

    #[test]
    fn discarding_an_untracked_directory_removes_it() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        std::fs::create_dir_all(tmp.path().join("newfolder/inner")).unwrap();
        std::fs::write(tmp.path().join("newfolder/inner/a.txt"), "x\n").unwrap();

        git_discard_file(path.clone(), "newfolder".to_string(), true).unwrap();

        assert!(!tmp.path().join("newfolder").exists());
        assert!(git_status(path).unwrap().unstaged.is_empty());
    }

    /// Discarding a tracked file still restores it from the index rather than
    /// deleting it.
    #[test]
    fn discarding_a_tracked_file_restores_its_content() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        std::fs::write(tmp.path().join("tracked.txt"), "original\n").unwrap();
        run_git(&path, &["add", "-A"]);
        run_git(&path, &["commit", "-m", "add tracked"]);
        std::fs::write(tmp.path().join("tracked.txt"), "edited\n").unwrap();

        git_discard_file(path.clone(), "tracked.txt".to_string(), false).unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.path().join("tracked.txt")).unwrap(),
            "original\n"
        );
    }

    /// Pathspec commands must reach files outside a subdirectory workspace,
    /// since every path they are handed is now repo-root-relative.
    #[test]
    fn pathspec_commands_run_at_the_root_from_a_subdirectory_workspace() {
        let tmp = init_repo();
        let root = tmp.path().to_str().unwrap().to_string();
        std::fs::create_dir_all(tmp.path().join("UnityProject/Assets")).unwrap();
        std::fs::write(tmp.path().join("UnityProject/Assets/A.cs"), "one\n").unwrap();
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "add"]);
        std::fs::write(tmp.path().join("UnityProject/Assets/A.cs"), "two\n").unwrap();

        let workspace = format!("{root}/UnityProject");
        let rel = "UnityProject/Assets/A.cs".to_string();

        // Staging a root-relative path from a subdirectory workspace.
        git_stage_file(workspace.clone(), rel.clone()).unwrap();
        let status = git_status(workspace.clone()).unwrap();
        assert!(
            status.staged.iter().any(|f| f.path == rel),
            "file should be staged, got staged={:?}",
            status.staged.iter().map(|f| &f.path).collect::<Vec<_>>()
        );

        git_unstage_file(workspace.clone(), rel.clone()).unwrap();
        let status = git_status(workspace.clone()).unwrap();
        assert!(status.staged.is_empty(), "file should be unstaged again");

        // The gutter passes an ABSOLUTE pathspec (see `pathInWorkspace` in
        // gutter-decorations.ts) — git accepts those from any directory.
        let abs = format!("{root}/UnityProject/Assets/A.cs");
        let diff = git_diff_file_head(workspace, abs).unwrap();
        assert!(
            diff.contains("UnityProject/Assets/A.cs"),
            "absolute pathspec should produce a diff, got: {diff:?}"
        );
    }
}
