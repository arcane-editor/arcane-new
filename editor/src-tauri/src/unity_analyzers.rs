//! Provisioning for the Unity Roslyn analyzers.
//!
//! **What this is.** `Microsoft.Unity.Analyzers` (MIT) is the analyzer set
//! behind Visual Studio's Unity workload: 43 diagnostics and 23 suppressors
//! that encode what is wrong *for Unity* rather than what is wrong for C#. An
//! empty `Update()`, `tag == "Player"` instead of `CompareTag`, a message with
//! the wrong signature, `GetComponent` on a non-Component type. The
//! suppressors matter as much in the other direction: without them Roslyn
//! reports every `[SerializeField]` field as unused, which is a warning on
//! nearly every MonoBehaviour anyone writes.
//!
//! **How it reaches the server.** csharp-ls 0.24+ runs the analyzers a project
//! references (`Roslyn/Analyzers.fs`), so delivery means naming the assembly in
//! an `<Analyzer Include>` item in the generated `.unityide.csproj` — see
//! [`crate::unity::generate_ide_csproj_from`]. MSBuild resolves it, Roslyn
//! loads it, and its diagnostics arrive over the same pull-diagnostics request
//! the compiler's do.
//!
//! **Why unzip at runtime rather than ship the loose DLL.** csharp-ls
//! memory-maps an analyzer assembly for as long as the project is loaded. A
//! path inside the app's own installation directory would therefore be locked
//! by a running editor, which breaks an in-place update on Windows — and Tauri
//! reports its resource directory as an extended-length `\\?\C:\...` path,
//! which MSBuild does not handle (the same trap documented in
//! `csharp_ls.rs` and `path_util.rs`). Unpacking into the per-user data
//! directory, versioned, avoids both.
//!
//! **Failure is degradation, never an error.** Missing analyzers cost Unity
//! inspections; they do not cost C# IntelliSense. Every entry point here
//! returns `Option` and logs to the LSP trace rather than surfacing an error,
//! and the generator simply omits the `<Analyzer>` item when the assembly is
//! absent.

use crate::csharp_ls::InstallError;
use crate::lsp::trace_append;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The pinned release. Bumping this is a two-part change: this constant and
/// the version + SHA-512 in `scripts/fetch-unity-analyzers-package.ts`.
pub const UNITY_ANALYZERS_VERSION: &str = "1.27.0";

/// NuGet package id, lower-cased the way the flat container serves it.
const PACKAGE_ID: &str = "microsoft.unity.analyzers";

/// Where the analyzer assembly lives inside the package. NuGet's convention
/// for a C#-only analyzer; `dotnet/cs` is the language-specific slot.
const DLL_ENTRY: &str = "analyzers/dotnet/cs/Microsoft.Unity.Analyzers.dll";

/// The file name the assembly is unpacked as.
const DLL_NAME: &str = "Microsoft.Unity.Analyzers.dll";

fn nupkg_file_name() -> String {
    format!("{PACKAGE_ID}.{UNITY_ANALYZERS_VERSION}.nupkg")
}

/// `<data dir>/editor/lsp/unity-analyzers`. Mirrors the layout `csharp_ls.rs`
/// uses for the server, so both live under one directory a user can delete.
pub fn managed_root() -> Option<PathBuf> {
    Some(
        dirs::data_dir()?
            .join("editor")
            .join("lsp")
            .join("unity-analyzers"),
    )
}

/// The unpacked assembly for the pinned version, whether or not it exists yet.
pub fn managed_dll_path() -> Option<PathBuf> {
    Some(managed_root()?.join(UNITY_ANALYZERS_VERSION).join(DLL_NAME))
}

/// The vendored package inside the app bundle, or the repo copy in dev.
pub fn bundled_package_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resolve(
        "unity-analyzers",
        tauri::path::BaseDirectory::Resource,
    ) {
        let candidate = PathBuf::from(crate::path_util::normalize_windows_path(
            &dir.to_string_lossy(),
        ))
        .join(nupkg_file_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // `cargo test` / `tauri dev` before a bundle exists.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("unity-analyzers")
        .join(nupkg_file_name());
    dev.is_file().then_some(dev)
}

/// Extract just the analyzer assembly from `nupkg` to `dest`.
///
/// Writes to a staging name and renames, so an interrupted extraction cannot
/// leave a truncated DLL that later looks installed — Roslyn would load it and
/// fail in a way that reads as "the analyzers are broken" rather than "the
/// download was cut short".
pub(crate) fn extract_dll(nupkg: &Path, dest: &Path) -> Result<(), InstallError> {
    let file = std::fs::File::open(nupkg).map_err(|e| {
        InstallError::new(
            "package-missing",
            format!("Could not open {}: {e}", nupkg.display()),
        )
    })?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| {
        InstallError::new(
            "install-failed",
            format!("The analyzer package is not readable: {e}"),
        )
    })?;

    let mut entry = archive.by_name(DLL_ENTRY).map_err(|_| {
        InstallError::new(
            "install-failed",
            format!("The analyzer package does not contain {DLL_ENTRY}"),
        )
    })?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            InstallError::new(
                "install-failed",
                format!("Could not create {}: {e}", parent.display()),
            )
        })?;
    }

    let staging = dest.with_extension(format!("tmp-{}", std::process::id()));
    let mut out = std::fs::File::create(&staging).map_err(|e| {
        InstallError::new(
            "install-failed",
            format!("Could not write {}: {e}", staging.display()),
        )
    })?;
    let copied = std::io::copy(&mut entry, &mut out).map_err(|e| {
        let _ = std::fs::remove_file(&staging);
        InstallError::new("install-failed", format!("Could not unpack the analyzer: {e}"))
    });
    drop(out);
    if let Err(err) = copied {
        let _ = std::fs::remove_file(&staging);
        return Err(err);
    }

    std::fs::rename(&staging, dest).map_err(|e| {
        let _ = std::fs::remove_file(&staging);
        InstallError::new(
            "install-failed",
            format!("Could not install the analyzer: {e}"),
        )
    })?;
    Ok(())
}

/// Remove staging files and superseded versions.
fn sweep(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == UNITY_ANALYZERS_VERSION {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else if name.contains(".tmp-") {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Unpack the analyzer from `nupkg` into `root`, returning its path.
///
/// Idempotent: an already-unpacked assembly is returned as is. Separated from
/// [`ensure_installed`] so tests can drive it without a Tauri app.
pub fn ensure_installed_from(nupkg: &Path, root: &Path) -> Result<PathBuf, InstallError> {
    let dll = root.join(UNITY_ANALYZERS_VERSION).join(DLL_NAME);
    if dll.is_file() {
        return Ok(dll);
    }
    extract_dll(nupkg, &dll)?;
    sweep(root);
    Ok(dll)
}

/// The analyzer assembly for this build, unpacking it on first use.
///
/// Never returns an error. Unity inspections are an enhancement over working
/// C# IntelliSense, so a missing or unreadable package must degrade to "no
/// inspections" rather than block project generation — which is what would
/// happen if this were fallible and `unity_setup_lsp` propagated it.
pub fn ensure_installed(app: &AppHandle) -> Option<PathBuf> {
    let root = managed_root()?;
    let dll = root.join(UNITY_ANALYZERS_VERSION).join(DLL_NAME);
    if dll.is_file() {
        return Some(dll);
    }

    let Some(nupkg) = bundled_package_path(app) else {
        trace_append(
            "csharp",
            "!!",
            "unity-analyzers: no bundled package found — Unity inspections are off",
        );
        return None;
    };

    match ensure_installed_from(&nupkg, &root) {
        Ok(path) => {
            trace_append(
                "csharp",
                "--",
                &format!("unity-analyzers: unpacked {UNITY_ANALYZERS_VERSION} to {}", path.display()),
            );
            Some(path)
        }
        Err(err) => {
            trace_append(
                "csharp",
                "!!",
                &format!("unity-analyzers: {} — Unity inspections are off", err.message),
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Build a nupkg-shaped archive containing `entries`.
    fn make_package(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join(nupkg_file_name());
        let file = std::fs::File::create(&path).expect("create package");
        let mut zip = zip::ZipWriter::new(file);
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default())
                .expect("start entry");
            zip.write_all(bytes).expect("write entry");
        }
        zip.finish().expect("finish zip");
        path
    }

    #[test]
    fn extracts_only_the_analyzer_assembly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nupkg = make_package(
            dir.path(),
            &[
                (DLL_ENTRY, b"MZ-analyzer"),
                ("analyzers/dotnet/vb/Other.dll", b"vb"),
                ("_rels/.rels", b"<rels/>"),
                ("Microsoft.Unity.Analyzers.nuspec", b"<package/>"),
            ],
        );
        let root = dir.path().join("managed");

        let dll = ensure_installed_from(&nupkg, &root).expect("unpack");

        assert_eq!(dll.file_name().unwrap(), DLL_NAME);
        assert_eq!(std::fs::read(&dll).unwrap(), b"MZ-analyzer");
        // Packaging metadata and the VB analyzer are not part of a working
        // install; unpacking the whole archive would put a second analyzer
        // assembly next to the one the csproj names.
        let siblings: Vec<String> = std::fs::read_dir(dll.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(siblings, vec![DLL_NAME.to_string()]);
    }

    #[test]
    fn is_idempotent_and_does_not_re_extract() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nupkg = make_package(dir.path(), &[(DLL_ENTRY, b"first")]);
        let root = dir.path().join("managed");

        let first = ensure_installed_from(&nupkg, &root).expect("unpack");
        std::fs::write(&first, b"edited-in-place").expect("write");
        let second = ensure_installed_from(&nupkg, &root).expect("second call");

        assert_eq!(first, second);
        assert_eq!(std::fs::read(&second).unwrap(), b"edited-in-place");
    }

    #[test]
    fn a_package_without_the_analyzer_fails_and_leaves_nothing_behind() {
        // A truncated DLL that "exists" is worse than no DLL: Roslyn would
        // load it and fail in a way that reads as broken analyzers.
        let dir = tempfile::tempdir().expect("tempdir");
        let nupkg = make_package(dir.path(), &[("_rels/.rels", b"<rels/>")]);
        let root = dir.path().join("managed");

        let err = ensure_installed_from(&nupkg, &root).expect_err("should fail");
        assert_eq!(err.code, "install-failed");
        let version_dir = root.join(UNITY_ANALYZERS_VERSION);
        let leftovers: Vec<String> = std::fs::read_dir(&version_dir)
            .map(|d| {
                d.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
    }

    #[test]
    fn a_corrupt_package_reports_rather_than_panicking() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nupkg = dir.path().join(nupkg_file_name());
        std::fs::write(&nupkg, b"not a zip").expect("write");

        let err = ensure_installed_from(&nupkg, &dir.path().join("managed")).expect_err("fail");
        assert_eq!(err.code, "install-failed");
    }

    #[test]
    fn a_missing_package_is_reported_as_missing_not_as_a_bad_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = ensure_installed_from(&dir.path().join("absent.nupkg"), dir.path())
            .expect_err("fail");
        assert_eq!(err.code, "package-missing");
    }

    #[test]
    fn superseded_versions_are_swept_and_the_pinned_one_kept() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nupkg = make_package(dir.path(), &[(DLL_ENTRY, b"analyzer")]);
        let root = dir.path().join("managed");
        std::fs::create_dir_all(root.join("1.0.0")).expect("old version");
        std::fs::write(root.join("1.0.0").join(DLL_NAME), b"old").expect("old dll");

        ensure_installed_from(&nupkg, &root).expect("unpack");

        assert!(!root.join("1.0.0").exists(), "old version should be swept");
        assert!(root.join(UNITY_ANALYZERS_VERSION).join(DLL_NAME).is_file());
    }

    /// The real bundled package, when it has been vendored. Loud skip: the
    /// whole point of these modules is that an environmental failure must not
    /// look like a pass.
    #[test]
    fn unpacks_the_real_bundled_analyzer() {
        let nupkg = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("unity-analyzers")
            .join(nupkg_file_name());
        if !nupkg.is_file() {
            eprintln!(
                "SKIPPED unpacks_the_real_bundled_analyzer: package not vendored — \
                 run `bun run prepare:unity-analyzers`"
            );
            assert!(
                std::env::var("UNITYIDE_UNITY_ANALYZERS_E2E").as_deref() != Ok("required"),
                "UNITYIDE_UNITY_ANALYZERS_E2E=required but the package is not vendored"
            );
            return;
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let dll = ensure_installed_from(&nupkg, dir.path()).expect("unpack the real package");

        let bytes = std::fs::read(&dll).expect("read the analyzer");
        assert!(bytes.len() > 100_000, "suspiciously small: {} bytes", bytes.len());
        assert_eq!(&bytes[..2], b"MZ", "not a PE assembly");
    }
}
