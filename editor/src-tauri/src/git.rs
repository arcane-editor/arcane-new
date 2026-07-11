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

#[tauri::command]
pub fn git_commit(workspace_path: String, message: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", &workspace_path, "commit", "-m", &message])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn git_show_head(workspace_path: String, file_path: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", &workspace_path, "show", &format!("HEAD:{}", file_path)])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // New/untracked file — no HEAD version
        return Ok(String::new());
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

#[tauri::command]
pub fn git_fetch(workspace_path: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", &workspace_path, "fetch"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub fn git_pull(workspace_path: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", &workspace_path, "pull"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub fn git_push(workspace_path: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", &workspace_path, "push"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
        return Ok(Vec::new());
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
