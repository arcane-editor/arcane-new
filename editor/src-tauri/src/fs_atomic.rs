// ── Atomic file replacement ─────────────────────────────────────────────────
//
// `lib.rs::write_file` is a bare `fs::write`: it truncates the target and then
// streams into it, so a crash or a full disk mid-write leaves a half-written
// file and the original is gone. For an editor buffer that is survivable — the
// text is still in memory. For a Unity `.asset` it is not: the file IS the data,
// and a truncated one loses a designer's tuning and breaks every reference into
// it.
//
// So writes on the ScriptableObject path go through here instead: write a temp
// file beside the target, fsync it, then rename over the target. `rename` is
// atomic within a filesystem, so a reader sees either the whole old file or the
// whole new one, never a torn one.
//
// This deliberately does NOT replace `write_file`. That call backs every editor
// save in the app, and changing its durability, temp-file footprint and Windows
// sharing-violation surface at the same time as shipping a new feature would
// make any save regression look like this feature's fault.

use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Distinguishes the temp files from anything a user or Unity would create.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Removes its path on drop unless disarmed, so a failed write leaves no litter.
struct TempGuard(Option<PathBuf>);

impl TempGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// `.<file_name>.unityide-<pid>-<n>.tmp`
///
/// Both the leading dot and the `.tmp` extension matter: Unity's asset importer
/// skips dot-files and unknown extensions, so a temp file that appears inside
/// `Assets/` for a few milliseconds is never imported and never grows a stray
/// `.meta` beside it.
fn temp_name(file_name: &OsStr) -> OsString {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = OsString::from(".");
    name.push(file_name);
    name.push(format!(".unityide-{}-{}.tmp", std::process::id(), n));
    name
}

/// True when the path exists and is marked read-only.
fn is_read_only(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.permissions().readonly())
        .unwrap_or(false)
}

/// Rename, retrying briefly on Windows.
///
/// `std::fs::rename` uses `MOVEFILE_REPLACE_EXISTING`, so unlike C's `rename` it
/// does replace an existing file — but it fails with a sharing violation while
/// another process holds the destination open without `FILE_SHARE_DELETE`.
/// Unity's importer and most antivirus scanners do exactly that, for a few
/// milliseconds at a time.
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let mut last = match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => e,
        };
        for delay_ms in [20u64, 50, 120] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            match fs::rename(from, to) {
                Ok(()) => return Ok(()),
                Err(e) => last = e,
            }
        }
        Err(last)
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to)
    }
}

/// Write `bytes` to `path`, replacing it atomically.
///
/// Takes `&[u8]` and never `&str` on purpose: a signature that accepted text
/// could round-trip through `String` and silently normalise line endings, which
/// is the exact class of corruption the byte-exact asset writer exists to
/// prevent.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no file name: {}", path.display()),
        )
    })?;

    // Report a checked-out-read-only asset as itself. Perforce and Plastic mark
    // Unity assets read-only until checkout, which makes this the single most
    // likely failure on a studio machine — an opaque OS error there sends
    // people looking in the wrong place.
    if is_read_only(path) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{} is read-only — check it out from source control first",
                path.display()
            ),
        ));
    }

    // The temp lives in the TARGET's directory, which is what makes the rename
    // a same-filesystem operation by construction rather than by hope. A temp
    // in the system temp dir fails with EXDEV across mount points.
    let tmp_path = parent.join(temp_name(file_name));
    let mut guard = TempGuard(Some(tmp_path.clone()));

    {
        // `create_new` so a leftover temp from a crashed run is an error rather
        // than something we silently overwrite.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        file.write_all(bytes)?;
        // Durability before visibility. Without this the rename can land while
        // the data has not, and a power loss leaves a zero-length asset — the
        // classic ext4 truncate-on-rename hazard.
        file.sync_all()?;
    }

    // Keep the target's mode; otherwise the file silently picks up the umask
    // default and git/Unity see a spurious permission change.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mode = meta.permissions().mode();
            let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(mode));
        }
    }

    rename_with_retry(&tmp_path, path)?;
    guard.disarm();

    // Make the rename itself durable. Best-effort: the data is already visible.
    #[cfg(unix)]
    {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn replaces_contents_and_leaves_no_temp_behind() {
        let dir = tmpdir();
        let path = dir.path().join("Weapon.asset");
        fs::write(&path, b"old").unwrap();

        write_atomic(&path, b"new contents").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new contents");
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap()).collect();
        assert_eq!(entries.len(), 1, "a temp file was left behind");
    }

    #[test]
    fn creates_the_file_when_it_does_not_exist() {
        let dir = tmpdir();
        let path = dir.path().join("New.asset");
        write_atomic(&path, b"hello").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello");
    }

    #[test]
    fn is_byte_exact_for_non_utf8_input() {
        // Proves the API cannot normalise: bytes in, identical bytes out.
        let dir = tmpdir();
        let path = dir.path().join("bin.asset");
        let payload: &[u8] = &[0xFF, 0x00, 0x80, b'\r', b'\n', 0xFE];
        write_atomic(&path, payload).unwrap();
        assert_eq!(fs::read(&path).unwrap(), payload);
    }

    #[test]
    fn preserves_crlf_and_a_missing_trailing_newline() {
        let dir = tmpdir();
        let path = dir.path().join("crlf.asset");
        let payload = b"a: 1\r\nb: 2";
        write_atomic(&path, payload).unwrap();
        let back = fs::read(&path).unwrap();
        assert_eq!(back, payload);
        assert!(!back.ends_with(b"\n"));
    }

    #[test]
    fn temp_name_is_unity_ignored_and_unique() {
        let a = temp_name(OsStr::new("Weapon.asset"));
        let b = temp_name(OsStr::new("Weapon.asset"));
        let a = a.to_string_lossy().to_string();
        let b = b.to_string_lossy().to_string();
        assert!(a.starts_with('.'), "{a} must be a dot-file so Unity skips it");
        assert!(a.ends_with(".tmp"), "{a} must end in .tmp");
        assert!(a.contains("Weapon.asset"));
        assert_ne!(a, b, "two temps in the same directory must not collide");
    }

    #[test]
    fn temp_guard_removes_the_file_when_the_write_fails() {
        let dir = tmpdir();
        let path = dir.path().join("guarded.tmp");
        fs::write(&path, b"x").unwrap();
        {
            let _guard = TempGuard(Some(path.clone()));
        }
        assert!(!path.exists(), "guard should remove the temp on drop");
    }

    #[test]
    fn temp_guard_keeps_the_file_once_disarmed() {
        let dir = tmpdir();
        let path = dir.path().join("kept.tmp");
        fs::write(&path, b"x").unwrap();
        {
            let mut guard = TempGuard(Some(path.clone()));
            guard.disarm();
        }
        assert!(path.exists());
    }

    #[test]
    fn errors_on_a_path_with_no_parent() {
        let err = write_atomic(Path::new("/"), b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmpdir();
        let path = dir.path().join("perm.asset");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        write_atomic(&path, b"new").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640, "the target's mode must survive the replace");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_read_only_target_without_corrupting_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmpdir();
        let path = dir.path().join("locked.asset");
        fs::write(&path, b"original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();

        let err = write_atomic(&path, b"new").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            err.to_string().contains("read-only"),
            "the message should name the cause: {err}"
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            b"original",
            "a refused write must not touch the file"
        );

        // Leave it writable so the tempdir can be cleaned up.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    }
}
