use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

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

#[tauri::command]
pub fn git_status(workspace_path: String) -> Result<GitStatusResult, String> {
    let output = Command::new("git")
        .args(["-C", &workspace_path, "status", "--porcelain=v2", "--branch"])
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

    let mut branch = String::from("HEAD");
    let mut ahead: i32 = 0;
    let mut behind: i32 = 0;
    let mut staged: Vec<GitFileStatus> = Vec::new();
    let mut unstaged: Vec<GitFileStatus> = Vec::new();

    for line in stdout.lines() {
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
            // Ordinary changed entry: 1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let parts: Vec<&str> = rest.splitn(9, ' ').collect();
            if parts.len() < 9 {
                continue;
            }
            let xy = parts[0];
            let path = parts[8];
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
                });
            }
            if y != '.' {
                unstaged.push(GitFileStatus {
                    path: path.to_string(),
                    absolute_path,
                    status: map_status_char(y).to_string(),
                    staged: false,
                    conflicted: false,
                });
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // Renamed/copied entry: 2 XY <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
            let parts: Vec<&str> = rest.splitn(10, ' ').collect();
            if parts.len() < 10 {
                continue;
            }
            let xy = parts[0];
            // The last field contains <path>\t<origPath>
            let path_field = parts[9];
            let path = path_field.split('\t').next().unwrap_or(path_field);
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
                });
            }
            if y != '.' {
                unstaged.push(GitFileStatus {
                    path: path.to_string(),
                    absolute_path,
                    status: map_status_char(y).to_string(),
                    staged: false,
                    conflicted: false,
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
            });
        }
    }

    Ok(GitStatusResult {
        branch,
        staged,
        unstaged,
        ahead,
        behind,
    })
}

#[tauri::command]
pub fn git_list_branches(workspace_path: String) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args([
            "-C",
            &workspace_path,
            "branch",
            "--list",
            "--format=%(refname:short)",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    branches.sort();

    Ok(branches)
}

#[tauri::command]
pub fn git_switch_branch(workspace_path: String, branch: String) -> Result<(), String> {
    let output = Command::new("git")
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
    let mut args = vec!["-C", &workspace_path, "diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&file_path);

    let output = Command::new("git")
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

    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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

    let output = Command::new("git")
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

    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let spec = format!(":{}", file_path);
    let output = Command::new("git")
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
#[tauri::command]
pub fn git_show_commit(workspace_path: String, hash: String) -> Result<CommitDetail, String> {
    validate_ref_name(&hash)?;

    let output = Command::new("git")
        .args([
            "-C",
            &workspace_path,
            "show",
            &hash,
            "--name-status",
            "--format=%H%x00%s%x00%an%x00%aI",
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

    let spec = format!("{rev}:{file_path}");
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    if is_untracked {
        let full_path = std::path::Path::new(&workspace_path).join(&file_path);
        std::fs::remove_file(&full_path).map_err(|e| e.to_string())?;
    } else {
        let output = Command::new("git")
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
    // Restore tracked files
    let output = Command::new("git")
        .args(["-C", &workspace_path, "checkout", "--", "."])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    // Remove untracked files
    let output = Command::new("git")
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
    let output = Command::new("git")
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

    let mut command = Command::new("git");
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

            let branch_output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
    let output = tokio::process::Command::new("git")
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

    let name_out = Command::new("git")
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

    let driver_out = Command::new("git")
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
    let output = Command::new("git")
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
    let status = Command::new(&tool_path)
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
    let add_out = Command::new("git")
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

    let checkout = Command::new("git")
        .args(["-C", &workspace_path, "checkout", flag, "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !checkout.status.success() {
        return Err(String::from_utf8_lossy(&checkout.stderr).to_string());
    }

    let add_out = Command::new("git")
        .args(["-C", &workspace_path, "add", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !add_out.status.success() {
        return Err(String::from_utf8_lossy(&add_out.stderr).to_string());
    }

    Ok(())
}

/// Append lines to `<workspace>/.gitignore`, skipping any already present
/// (exact-trimmed-line match). Used by the gitignore doctor's "Fix" action.
/// Returns the lines that were actually appended.
#[tauri::command]
pub fn git_append_gitignore(
    workspace_path: String,
    lines: Vec<String>,
) -> Result<Vec<String>, String> {
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

    let output = Command::new("git")
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

    let output = Command::new("git")
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
    let output = Command::new("git")
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
        run_git(path, &["config", "user.email", "test@example.com"]);
        run_git(path, &["config", "user.name", "Test User"]);
        run_git(path, &["commit", "--allow-empty", "-m", "init"]);
        tmp
    }

    fn run_git(path: &str, args: &[&str]) {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = Command::new("git").args(&full).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn create_branch_from_head() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();

        git_create_branch(path.clone(), "feature-a".into(), None, false).unwrap();

        let branches = git_list_branches(path).unwrap();
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

        let branches = git_list_branches(path).unwrap();
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

        let branches = git_list_branches(path).unwrap();
        assert!(!branches.contains(&"old-name".to_string()));
        assert!(branches.contains(&"new-name".to_string()));
    }

    #[test]
    fn delete_merged_branch() {
        let tmp = init_repo();
        let path = tmp.path().to_str().unwrap().to_string();
        git_create_branch(path.clone(), "merged-branch".into(), None, false).unwrap();

        git_delete_branch(path.clone(), "merged-branch".into(), false).unwrap();

        let branches = git_list_branches(path).unwrap();
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

        let branches = git_list_branches(path).unwrap();
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
        let branches = git_list_branches(path).unwrap();
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
        let branches = git_list_branches(path).unwrap();
        assert!(branches.contains(&"main".to_string()));
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
        let output = Command::new("git").args(&full).output().unwrap();
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
        let output = Command::new("git").args(&full).output().unwrap();
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
        let output = Command::new("git")
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
        let bare_has_main = Command::new("git")
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
        let head_cfg = Command::new("git")
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
}

#[cfg(test)]
mod diff_file_head_tests {
    use super::*;

    fn run_git(path: &str, args: &[&str]) -> String {
        let mut full: Vec<&str> = vec!["-C", path];
        full.extend_from_slice(args);
        let output = Command::new("git").args(&full).output().unwrap();
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
        let output = Command::new("git").args(&full).output().unwrap();
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
        let output = Command::new("git")
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
        let _ = Command::new("git")
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
        };
        let file_value = serde_json::to_value(&file).unwrap();
        let file_obj = file_value.as_object().unwrap();
        assert!(file_obj.contains_key("path"));
        assert!(file_obj.contains_key("absolute_path"));
        assert!(file_obj.contains_key("status"));
        assert!(file_obj.contains_key("staged"));
        assert!(file_obj.contains_key("conflicted"));
        assert_eq!(file_obj.len(), 5, "unexpected extra/missing field on GitFileStatus");

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
}
