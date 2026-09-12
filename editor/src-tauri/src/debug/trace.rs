//! The debugger trace log.
//!
//! Same convention as `lsp.rs` and `acp.rs`: `->` sent, `<-` received, `!!`
//! error, `--` informational. `dap.rs` never had one, which is part of why its
//! failures were only ever visible as "the debugger doesn't work".
//!
//! A binary protocol is undebuggable from a hex dump, so packets are traced
//! **decoded** — `-> [42] TYPE/GET_METHODS` rather than the bytes. Every
//! protocol mistake found while building this client (a modifier count written
//! as an int, a reply read as the wrong command, a string missing its flag
//! byte) would have been one line in this file.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex as StdMutex, OnceLock};

static TRACE: OnceLock<StdMutex<Option<File>>> = OnceLock::new();

pub fn path() -> Option<PathBuf> {
    Some(
        dirs::cache_dir()?
            .join("editor-unityide")
            .join("debug-trace.log"),
    )
}

/// Start a session's trace, truncating the previous one.
pub fn open_session(header: &str) {
    let Some(path) = path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let opened = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .ok();

    let slot = TRACE.get_or_init(|| StdMutex::new(None));
    let mut guard = crate::sync_util::lock_recover(slot);
    *guard = opened;
    if let Some(file) = guard.as_mut() {
        let _ = writeln!(file, "=== debug session {} {} ===", timestamp(), header);
        let _ = file.flush();
    }
}

/// Append one tagged line. `prefix` is `->`, `<-`, `!!` or `--`.
pub fn append(prefix: &str, body: &str) {
    let Some(slot) = TRACE.get() else { return };
    let mut guard = crate::sync_util::lock_recover(slot);
    if let Some(file) = guard.as_mut() {
        let _ = writeln!(file, "[{}] {} {}", timestamp(), prefix, body);
        let _ = file.flush();
    }
}

fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appending_before_a_session_opens_is_harmless() {
        // The socket can fail before any session exists; tracing must not be
        // the thing that panics on that path.
        append("!!", "no session yet");
    }

    #[test]
    fn the_trace_path_sits_beside_the_other_logs() {
        if let Some(path) = path() {
            assert!(path.ends_with("editor-unityide/debug-trace.log") || path.ends_with("editor-unityide\\debug-trace.log"));
        }
    }
}
