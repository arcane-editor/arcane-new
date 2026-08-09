//! One place that owns Windows process-creation flags.
//!
//! Every child process spawned without `CREATE_NO_WINDOW` pops a console window
//! on Windows. `git.rs` alone spawns 61 of them — a status refresh, a blame, a
//! branch list — so the app flickered black boxes constantly on the platform
//! most Unity developers use. It is invisible from macOS, where the flag does
//! not exist and nothing needs it.
//!
//! Routing every spawn through here means the flag is set in exactly one place
//! and a new call site cannot forget it.

use std::ffi::OsStr;

/// `CREATE_NO_WINDOW` from the Win32 process-creation flags. Declared locally
/// rather than pulled from `winapi`/`windows-sys` — it is one stable constant
/// and not worth a dependency.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `std::process::Command` that will not flash a console window on Windows.
pub fn command<S: AsRef<OsStr>>(program: S) -> std::process::Command {
    // `mut` is only needed on Windows, where the cfg block below mutates it.
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// A `tokio::process::Command` that will not flash a console window on Windows.
pub fn async_command<S: AsRef<OsStr>>(program: S) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_produces_a_runnable_child() {
        let out = command("git")
            .arg("--version")
            .output()
            .expect("git should be runnable");
        assert!(out.status.success());
    }

    /// Structural, because the flag itself is unobservable from a passing
    /// process: what actually regresses is someone adding a bare
    /// `Command::new` back to a hot path.
    #[test]
    fn no_module_spawns_a_bare_command() {
        let src_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut offenders = Vec::new();

        for entry in std::fs::read_dir(src_dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            // This module is where the real `Command::new` calls live.
            if path.file_name().and_then(|f| f.to_str()) == Some("process_util.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            for (i, line) in text.lines().enumerate() {
                let trimmed = line.trim_start();
                if trimmed.starts_with("//") {
                    continue;
                }
                if trimmed.contains("Command::new(") {
                    offenders.push(format!(
                        "{}:{}",
                        path.file_name().unwrap().to_string_lossy(),
                        i + 1
                    ));
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "spawn via process_util::command / async_command so CREATE_NO_WINDOW is set: {:?}",
            offenders
        );
    }
}
