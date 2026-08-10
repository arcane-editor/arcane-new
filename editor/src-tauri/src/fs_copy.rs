//! Copying files and directories into the workspace.
//!
//! Backs the explorer's drop-to-copy: files dragged in from the OS file
//! manager land in the directory they were dropped on. Collisions never
//! overwrite — a drop is an easy gesture to make by accident, and the source
//! of truth for what was already there is the user's, not ours.

use std::fs;
use std::path::{Path, PathBuf};

use crate::path_util;

/// How many `name N.ext` candidates to probe before giving up.
///
/// Bounded so a pathological directory (or a race where something else keeps
/// claiming the next name) fails with a message instead of spinning forever.
const MAX_RENAME_ATTEMPTS: u32 = 10_000;

/// Recursively copy a directory tree (creating `dst` and parents as needed).
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Splits a file name into the part that gets the ` N` suffix and the
/// extension that must stay last.
///
/// Uses the *last* dot only, so `a.service.ts` yields `("a.service", "ts")`
/// and renames to `a.service 2.ts`. Suffixing the first dot instead would
/// produce `a 2.service.ts`, which changes how the icon resolver and every
/// `*.service.ts` glob classify the file.
///
/// A dotfile like `.gitignore` has no stem before the dot, so it is treated as
/// all-stem and renames to `.gitignore 2`.
fn split_name(file_name: &str) -> (&str, Option<&str>) {
    match file_name.rfind('.') {
        Some(idx) if idx > 0 => (&file_name[..idx], Some(&file_name[idx + 1..])),
        _ => (file_name, None),
    }
}

/// Finder-style non-destructive destination: `Player.cs`, then `Player 2.cs`,
/// `Player 3.cs`, ...
pub fn unique_destination(dest_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let direct = dest_dir.join(file_name);
    if !direct.exists() {
        return Ok(direct);
    }

    let (stem, ext) = split_name(file_name);
    for n in 2..MAX_RENAME_ATTEMPTS {
        let candidate = match ext {
            Some(e) => format!("{stem} {n}.{e}"),
            None => format!("{stem} {n}"),
        };
        let path = dest_dir.join(candidate);
        if !path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "Could not find a free name for \"{file_name}\" after {MAX_RENAME_ATTEMPTS} attempts"
    ))
}

/// Unity's sidecar suffix.
const META_SUFFIX: &str = ".meta";

/// A fresh 32-hex-character Unity GUID.
///
/// Copying a `.meta` verbatim duplicates its GUID, and two assets claiming one
/// GUID is a collision Unity resolves by reassigning one of them at random —
/// silently breaking whichever references it lost. Regenerating keeps the
/// import settings (which is why the meta is worth copying at all) while
/// giving the copy its own identity.
///
/// Not cryptographic, and does not need to be: it only has to be unique within
/// one project. Derived from the clock, the destination path, and a
/// monotonically increasing counter so a batch copy in the same nanosecond
/// still produces distinct values.
fn fresh_guid(seed_path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);

    let mut h1 = DefaultHasher::new();
    (nanos, n, seed_path).hash(&mut h1);
    let mut h2 = DefaultHasher::new();
    (n, seed_path, nanos.rotate_left(17)).hash(&mut h2);

    format!("{:016x}{:016x}", h1.finish(), h2.finish())
}

/// Rewrite the `guid:` line of a `.meta`'s contents.
///
/// Returns the input unchanged when there is no guid line — a malformed meta
/// is Unity's problem to report, and refusing to copy it would lose the user's
/// import settings over a formatting detail.
pub fn rewrite_meta_guid(contents: &str, guid: &str) -> String {
    let mut out = String::with_capacity(contents.len());
    let mut replaced = false;
    for line in contents.lines() {
        if !replaced && line.trim_start().starts_with("guid:") {
            let indent = &line[..line.len() - line.trim_start().len()];
            out.push_str(indent);
            out.push_str("guid: ");
            out.push_str(guid);
            replaced = true;
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

/// Copy `<src>.meta` to `<dest>.meta` with a fresh GUID, if the sidecar exists.
///
/// Called as part of copying the asset itself so the pair can never separate.
/// Copying them as two independent operations is what broke: on a name
/// collision `Player.cs` becomes `Player 2.cs` while `Player.cs.meta` becomes
/// `Player.cs 2.meta` — because the rename splits at the LAST dot — leaving the
/// copy with no meta and an orphan meta beside it.
fn copy_meta_sidecar(src: &Path, dest: &Path) -> std::io::Result<()> {
    let src_meta = PathBuf::from(format!("{}{}", src.to_string_lossy(), META_SUFFIX));
    if !src_meta.is_file() {
        return Ok(());
    }
    let dest_meta = PathBuf::from(format!("{}{}", dest.to_string_lossy(), META_SUFFIX));

    match fs::read_to_string(&src_meta) {
        Ok(text) => fs::write(&dest_meta, rewrite_meta_guid(&text, &fresh_guid(dest))),
        // Not UTF-8 (shouldn't happen for a meta): copy verbatim rather than
        // dropping it, so import settings still survive.
        Err(_) => fs::copy(&src_meta, &dest_meta).map(|_| ()),
    }
}

/// True when this path is itself a Unity sidecar.
pub fn is_meta_path(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(META_SUFFIX)
}

/// True when `dest_dir` is `src` itself or lives underneath it.
///
/// Copying a directory into its own subtree recurses until the disk fills, so
/// this is checked before any bytes move. Falls back to the uncanonicalized
/// paths when canonicalization fails (a broken symlink, a permissions edge)
/// rather than allowing the copy on the strength of an error.
fn is_self_or_descendant(src: &Path, dest_dir: &Path) -> bool {
    let src_c = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    let dest_c = fs::canonicalize(dest_dir).unwrap_or_else(|_| dest_dir.to_path_buf());
    dest_c == src_c || dest_c.starts_with(&src_c)
}

/// Copy `src` (file or directory) into `dest_dir`, returning the path written.
///
/// Never overwrites: an existing name is sidestepped by [`unique_destination`].
#[tauri::command(async)]
pub fn copy_path(src: String, dest_dir: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    let dest_dir_path = Path::new(&dest_dir);

    if !src_path.exists() {
        return Err(format!("Source does not exist: {src}"));
    }
    if !dest_dir_path.is_dir() {
        return Err(format!("Destination is not a directory: {dest_dir}"));
    }

    let file_name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Source has no file name: {src}"))?;

    if src_path.is_dir() && is_self_or_descendant(src_path, dest_dir_path) {
        return Err("Cannot copy a folder into itself".to_string());
    }

    let dest = unique_destination(dest_dir_path, file_name)?;

    if src_path.is_dir() {
        copy_dir_recursive(src_path, &dest).map_err(|e| e.to_string())?;
    } else {
        fs::copy(src_path, &dest).map_err(|e| e.to_string())?;
    }

    // Carry the Unity sidecar with its asset. Done here, not by a second
    // copy_path call, because only this function knows the name the asset
    // actually got after collision handling. Skipped when the source IS a
    // meta — the caller is copying the sidecar deliberately.
    if !is_meta_path(&src) {
        copy_meta_sidecar(src_path, &dest).map_err(|e| e.to_string())?;
    }

    Ok(path_util::to_ui_path(dest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arcane-fs-copy-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

#[test]
    fn rewrite_meta_guid_replaces_only_the_first_guid_line() {
        let meta = "fileFormatVersion: 2\nguid: 1111111111111111111111111111aaaa\nMonoImporter:\n  guid: nested\n";
        let out = rewrite_meta_guid(meta, "beef0000000000000000000000000000");
        assert!(out.contains("guid: beef0000000000000000000000000000"));
        // A nested guid (e.g. a script reference) must be left alone.
        assert!(out.contains("  guid: nested"));
        assert!(!out.contains("1111111111111111111111111111aaaa"));
    }

    #[test]
    fn rewrite_meta_guid_leaves_a_meta_without_a_guid_alone() {
        assert_eq!(rewrite_meta_guid("fileFormatVersion: 2\n", "x"), "fileFormatVersion: 2\n");
    }

    #[test]
    fn fresh_guid_is_32_hex_chars_and_does_not_repeat() {
        let a = fresh_guid(Path::new("/a/Player.cs"));
        let b = fresh_guid(Path::new("/a/Player.cs"));
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "a batch copy must not reuse a GUID");
    }

    /// The bug: two independent copies renamed the pair apart, because the
    /// rename splits at the LAST dot — `Player.cs.meta` became
    /// `Player.cs 2.meta` while the asset became `Player 2.cs`.
    #[test]
    fn a_colliding_copy_keeps_its_meta_paired() {
        let dir = tmp_dir("meta-collide");
        let src_dir = dir.join("src");
        let dst_dir = dir.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();

        fs::write(src_dir.join("Player.cs"), b"class Player {}").unwrap();
        fs::write(
            src_dir.join("Player.cs.meta"),
            b"fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .unwrap();
        // Force the collision.
        fs::write(dst_dir.join("Player.cs"), b"other").unwrap();

        let written = copy_path(
            src_dir.join("Player.cs").to_string_lossy().to_string(),
            dst_dir.to_string_lossy().to_string(),
        )
        .unwrap();

        assert!(written.ends_with("Player 2.cs"), "got {written}");
        assert!(dst_dir.join("Player 2.cs.meta").is_file(), "sidecar must follow the asset's new name");
        assert!(!dst_dir.join("Player.cs 2.meta").exists(), "the old broken name must not appear");

        let copied_meta = fs::read_to_string(dst_dir.join("Player 2.cs.meta")).unwrap();
        assert!(
            !copied_meta.contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            "the copy must not duplicate the original GUID"
        );
    }

    #[test]
    fn an_asset_with_no_meta_copies_without_inventing_one() {
        let dir = tmp_dir("meta-absent");
        let src_dir = dir.join("src");
        let dst_dir = dir.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("notes.txt"), b"hi").unwrap();

        copy_path(
            src_dir.join("notes.txt").to_string_lossy().to_string(),
            dst_dir.to_string_lossy().to_string(),
        )
        .unwrap();

        assert!(dst_dir.join("notes.txt").is_file());
        assert!(!dst_dir.join("notes.txt.meta").exists());
    }

    #[test]
    fn copying_a_meta_directly_does_not_recurse_into_a_meta_meta() {
        let dir = tmp_dir("meta-direct");
        let src_dir = dir.join("src");
        let dst_dir = dir.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("Player.cs.meta"), b"guid: aaaa\n").unwrap();

        copy_path(
            src_dir.join("Player.cs.meta").to_string_lossy().to_string(),
            dst_dir.to_string_lossy().to_string(),
        )
        .unwrap();

        assert!(dst_dir.join("Player.cs.meta").is_file());
        assert!(!dst_dir.join("Player.cs.meta.meta").exists());
    }

    #[test]
    fn split_name_uses_the_last_dot_so_compound_suffixes_survive() {
        assert_eq!(split_name("Player.cs"), ("Player", Some("cs")));
        assert_eq!(split_name("auth.service.ts"), ("auth.service", Some("ts")));
        assert_eq!(split_name("Makefile"), ("Makefile", None));
        // Leading dot is not an extension separator.
        assert_eq!(split_name(".gitignore"), (".gitignore", None));
    }

    #[test]
    fn unique_destination_returns_the_plain_name_when_free() {
        let dir = tmp_dir("free");
        let got = unique_destination(&dir, "Player.cs").unwrap();
        assert_eq!(got, dir.join("Player.cs"));
    }

    #[test]
    fn unique_destination_counts_up_from_two() {
        let dir = tmp_dir("seq");
        fs::write(dir.join("Player.cs"), "").unwrap();
        assert_eq!(
            unique_destination(&dir, "Player.cs").unwrap(),
            dir.join("Player 2.cs")
        );

        fs::write(dir.join("Player 2.cs"), "").unwrap();
        assert_eq!(
            unique_destination(&dir, "Player.cs").unwrap(),
            dir.join("Player 3.cs")
        );
    }

    #[test]
    fn unique_destination_keeps_the_extension_last_for_compound_names() {
        let dir = tmp_dir("compound");
        fs::write(dir.join("auth.service.ts"), "").unwrap();
        // `auth 2.service.ts` would change how the icon resolver and every
        // *.service.ts glob classify the copy.
        assert_eq!(
            unique_destination(&dir, "auth.service.ts").unwrap(),
            dir.join("auth.service 2.ts")
        );
    }

    #[test]
    fn unique_destination_handles_extensionless_names_and_dotfiles() {
        let dir = tmp_dir("noext");
        fs::write(dir.join("Makefile"), "").unwrap();
        assert_eq!(
            unique_destination(&dir, "Makefile").unwrap(),
            dir.join("Makefile 2")
        );

        fs::write(dir.join(".gitignore"), "").unwrap();
        assert_eq!(
            unique_destination(&dir, ".gitignore").unwrap(),
            dir.join(".gitignore 2")
        );
    }

    #[test]
    fn copy_path_copies_a_file_and_never_overwrites() {
        let root = tmp_dir("file");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("Player.cs"), "original").unwrap();
        fs::write(dst_dir.join("Player.cs"), "pre-existing").unwrap();

        let out = copy_path(
            src_dir.join("Player.cs").to_string_lossy().into_owned(),
            dst_dir.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert!(out.ends_with("Player 2.cs"), "got {out}");
        // The file already in the destination is untouched.
        assert_eq!(
            fs::read_to_string(dst_dir.join("Player.cs")).unwrap(),
            "pre-existing"
        );
        assert_eq!(
            fs::read_to_string(dst_dir.join("Player 2.cs")).unwrap(),
            "original"
        );
    }

    #[test]
    fn copy_path_copies_a_directory_tree() {
        let root = tmp_dir("tree");
        let src_dir = root.join("Scripts");
        let nested = src_dir.join("Gameplay");
        let dst_dir = root.join("dst");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(nested.join("Player.cs"), "body").unwrap();

        let out = copy_path(
            src_dir.to_string_lossy().into_owned(),
            dst_dir.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert!(out.ends_with("Scripts"), "got {out}");
        assert_eq!(
            fs::read_to_string(dst_dir.join("Scripts/Gameplay/Player.cs")).unwrap(),
            "body"
        );
    }

    #[test]
    fn copy_path_refuses_to_copy_a_directory_into_itself() {
        let root = tmp_dir("selfcopy");
        let src_dir = root.join("Scripts");
        fs::create_dir_all(src_dir.join("Gameplay")).unwrap();

        // Into itself.
        let err = copy_path(
            src_dir.to_string_lossy().into_owned(),
            src_dir.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(err.contains("into itself"), "got {err}");

        // Into a descendant — the case that would otherwise recurse forever.
        let err = copy_path(
            src_dir.to_string_lossy().into_owned(),
            src_dir.join("Gameplay").to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(err.contains("into itself"), "got {err}");
    }

    #[test]
    fn copy_path_rejects_a_missing_source_and_a_file_destination() {
        let root = tmp_dir("bad");
        fs::write(root.join("a.txt"), "").unwrap();

        assert!(copy_path(
            root.join("nope.txt").to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
        )
        .is_err());

        assert!(copy_path(
            root.join("a.txt").to_string_lossy().into_owned(),
            root.join("a.txt").to_string_lossy().into_owned(),
        )
        .is_err());
    }
}
