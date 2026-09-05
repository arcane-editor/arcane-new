//! Provisioning for the C# language server (`csharp-ls`).
//!
//! **Why this exists.** C# is the whole point of this editor, and until now
//! getting it working required the user to run `dotnet tool install -g
//! csharp-ls` by hand — a step nobody discovers, in a product whose headline
//! feature is C# intelligence. This module makes the editor provision its own
//! copy instead.
//!
//! **How.** A pinned `csharp-ls` nupkg ships inside the app bundle. On the
//! first C# start we unzip its `tools/<tfm>/any/` payload into the app's data
//! directory and run it with `dotnet <entry point>.dll`. That is exactly what
//! `dotnet tool install` would have produced — the package declares
//! `Runner="dotnet"` and carries no native code, so the "install" is an unzip
//! and nothing more.
//!
//! **Why we unzip it ourselves rather than call `dotnet tool install`.** That
//! is how this started, and it failed on Windows. `dotnet tool install` needs
//! a NuGet *source*, and the only local source we have is the app's own
//! resource directory — which Tauri reports as an extended-length
//! `\\?\C:\Users\...` path. NuGet cannot enumerate a local folder given in
//! that form, and reports the package as simply "not found in NuGet feeds
//! <path>", which reads like a failed download rather than an unusable path.
//! (The same `\\?\` prefix has bitten this codebase before — see the module
//! docs in `path_util.rs`.) Unzipping removes NuGet, the package source, the
//! generated config and the SDK requirement for installing, all at once. What
//! is left is reading a file we shipped and writing files into a directory we
//! own, which is the whole job.
//!
//! **What it deliberately does not do.** It never overrides a `csharp-ls` the
//! user already has — [`resolve_existing`] checks their install first and the
//! managed copy last, so nobody's working setup changes underneath them.
//!
//! **The prerequisite that is easy to get wrong.** csharp-ls 0.22.0 targets
//! `net10.0`, so "has dotnet" is not the requirement — the .NET 10 *runtime*
//! is, plus an SDK on top of that because the server loads projects through
//! MSBuildLocator. Both are probed before installing and each gets its own
//! error code, because "it didn't work" is not an actionable message.

use crate::lsp::{find_dotnet_dir, path_with_prepended, trace_append};
use crate::process_util::async_command;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

/// The pinned csharp-ls release. Bumping this is a three-part change: this
/// constant, the SHA-512 in `scripts/fetch-csharp-ls-package.ts`, and
/// [`REQUIRED_RUNTIME_MAJOR`] if the new release retargets. The version is
/// also load-bearing for `project-readiness.ts`, which parses log lines this
/// release emits — see the notes there before moving it.
pub const CSHARP_LS_VERSION: &str = "0.22.0";

/// The NuGet package id, which is also the command name users know.
const PACKAGE_ID: &str = "csharp-ls";

/// Major version of `Microsoft.NETCore.App` the pinned tool needs. Tied to
/// the tool package's target framework: 0.22.0 ships `tools/net10.0/any`, so
/// a machine with only .NET 8 unpacks it fine and then cannot run it.
const REQUIRED_RUNTIME_MAJOR: u32 = 10;

/// `dotnet --list-runtimes` and friends are near-instant; anything slower is
/// a hung host, not a slow one.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// First launch of a freshly unpacked .NET tool pays JIT and assembly-load
/// costs, so this is deliberately not tight.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(90);

/// Escape hatch for users who build csharp-ls themselves or pin their own
/// version. Mirrors `EDITOR_USE_SYSTEM_LSP` in `lsp.rs`.
const PATH_OVERRIDE_ENV: &str = "UNITYIDE_CSHARP_LS_PATH";

/// The package's own manifest, naming the assembly to run.
const TOOL_SETTINGS: &str = "DotnetToolSettings.xml";

// ── Paths ───────────────────────────────────────────────────────

/// Platform-correct executable name for a bare stem.
pub(crate) fn exe_name(stem: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Root of every managed install: `<data dir>/editor/lsp/csharp-ls`.
/// Matches the `dirs::data_dir()/editor` convention used for `panics.log`.
pub fn managed_root() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("editor").join("lsp").join(PACKAGE_ID))
}

/// Install directory for the pinned version under an arbitrary root.
///
/// Version-scoped so a future bump unpacks alongside the old one and can only
/// replace it after the new copy verifies — an app update can never leave a
/// user with no working server.
pub(crate) fn version_dir(root: &Path) -> PathBuf {
    root.join(CSHARP_LS_VERSION)
}

/// Install directory for the pinned version in the managed location.
pub fn managed_version_dir() -> Option<PathBuf> {
    Some(version_dir(&managed_root()?))
}

/// Where a csharp-ls installed by `dotnet tool install -g` lands.
fn global_tool_binary() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".dotnet")
            .join("tools")
            .join(exe_name(PACKAGE_ID)),
    )
}

/// First `csharp-ls` on PATH.
///
/// Scanned explicitly rather than left to the OS so the precedence below is
/// deterministic: without this we could not tell "the user has one on PATH"
/// from "nothing exists", and would unpack a second copy nobody asked for.
fn path_binary() -> Option<PathBuf> {
    let name = exe_name(PACKAGE_ID);
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(&name))
        .find(|p| p.is_file())
}

/// The assembly the package says to run, e.g. `CSharpLanguageServer.dll`.
///
/// Read from the package's own `DotnetToolSettings.xml` rather than hardcoded:
/// the assembly name is not derivable from the package id, and a version that
/// renamed it would otherwise leave us pointing at a file that is not there.
pub(crate) fn parse_entry_point(settings_xml: &str) -> Option<String> {
    let after = settings_xml.split("EntryPoint=\"").nth(1)?;
    let name = after.split('"').next()?;
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return None;
    }
    Some(name.to_string())
}

/// The entry-point assembly inside an unpacked install, if it is really there.
pub(crate) fn entry_point_in(dir: &Path) -> Option<PathBuf> {
    let xml = std::fs::read_to_string(dir.join(TOOL_SETTINGS)).ok()?;
    let dll = dir.join(parse_entry_point(&xml)?);
    dll.is_file().then_some(dll)
}

/// How a resolved server has to be started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerLaunch {
    /// An executable to run directly — the user's own shim.
    Executable(PathBuf),
    /// A managed tool assembly, run by the dotnet host.
    DotnetDll(PathBuf),
}

impl ServerLaunch {
    /// The path this launch is built around, for display and logging.
    pub fn path(&self) -> &Path {
        match self {
            ServerLaunch::Executable(p) | ServerLaunch::DotnetDll(p) => p,
        }
    }
}

/// Which copy of csharp-ls a resolution landed on. Surfaced to the frontend
/// so the install prompt can stay silent when the user already has one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// `UNITYIDE_CSHARP_LS_PATH`.
    Override,
    /// The user's own `dotnet tool install -g`.
    User,
    /// Somewhere on PATH.
    Path,
    /// Unpacked and owned by this editor.
    Managed,
}

/// Locate an existing csharp-ls, in precedence order.
///
/// The user's own install wins over ours on purpose. Someone who ran
/// `dotnet tool install -g csharp-ls`, or who pinned a build for a reason we
/// cannot see, must not have that silently replaced by an app update.
pub fn resolve_existing() -> Option<(ServerLaunch, Source)> {
    if let Some(raw) = std::env::var_os(PATH_OVERRIDE_ENV) {
        let p = PathBuf::from(raw);
        if p.is_file() {
            return Some((ServerLaunch::Executable(p), Source::Override));
        }
    }
    if let Some(p) = global_tool_binary() {
        if p.is_file() {
            return Some((ServerLaunch::Executable(p), Source::User));
        }
    }
    if let Some(p) = path_binary() {
        return Some((ServerLaunch::Executable(p), Source::Path));
    }
    if let Some(dll) = managed_version_dir().as_deref().and_then(entry_point_in) {
        return Some((ServerLaunch::DotnetDll(dll), Source::Managed));
    }
    None
}

/// The bundled nupkg, if it shipped with this build.
///
/// Packaged builds get it from the Tauri resource dir; `cargo`/`tauri dev`
/// from the crate. This path may be an extended-length `\\?\` path on Windows,
/// which is fine — only Rust's `std` ever reads it. Handing such a path to
/// another tool is what broke before.
pub fn bundled_package_path(app: &AppHandle) -> Option<PathBuf> {
    let name = nupkg_file_name();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(PACKAGE_ID).join(&name));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(PACKAGE_ID)
            .join(&name),
    );
    candidates.into_iter().find(|p| p.is_file())
}

/// NuGet's on-disk name for the pinned package.
pub(crate) fn nupkg_file_name() -> String {
    format!("{PACKAGE_ID}.{CSHARP_LS_VERSION}.nupkg")
}

// ── dotnet probes ───────────────────────────────────────────────

/// What the machine can actually run, as opposed to what it merely has.
#[derive(Debug, Clone, Serialize)]
pub struct DotnetStatus {
    /// A `dotnet` executable was located.
    pub present: bool,
    /// `dotnet --list-sdks` returned at least one SDK. Not needed to unpack
    /// the server, but needed to *use* it: csharp-ls loads projects through
    /// MSBuildLocator, which resolves MSBuild out of an installed SDK.
    pub has_sdk: bool,
    /// Highest `Microsoft.NETCore.App` major version installed.
    pub runtime_major: Option<u32>,
}

impl DotnetStatus {
    fn missing() -> Self {
        Self { present: false, has_sdk: false, runtime_major: None }
    }
}

/// Run a `dotnet` subcommand and capture stdout, or `None` on any failure.
///
/// Every probe goes through the same env injection the LSP spawn path uses:
/// GUI apps on macOS do not inherit the shell PATH, so `dotnet` must be
/// addressed by absolute path with `DOTNET_ROOT` set, or it cannot find its
/// own shared framework.
async fn dotnet_output(dotnet_dir: &Path, args: &[&str]) -> Option<String> {
    let exe = dotnet_dir.join(exe_name("dotnet"));
    let mut cmd = async_command(&exe);
    cmd.args(args)
        .env("DOTNET_ROOT", dotnet_dir)
        .env("DOTNET_HOST_PATH", &exe)
        .env("PATH", path_with_prepended(dotnet_dir))
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .env("DOTNET_NOLOGO", "1")
        .kill_on_drop(true);

    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Probe the machine's .NET installation.
pub async fn probe_dotnet() -> DotnetStatus {
    let Some(dir) = find_dotnet_dir() else {
        return DotnetStatus::missing();
    };
    let sdks = dotnet_output(&dir, &["--list-sdks"]).await.unwrap_or_default();
    let runtimes = dotnet_output(&dir, &["--list-runtimes"]).await.unwrap_or_default();
    DotnetStatus {
        present: true,
        has_sdk: parse_has_sdk(&sdks),
        runtime_major: parse_max_runtime_major(&runtimes),
    }
}

/// True if `dotnet --list-sdks` listed at least one SDK.
///
/// Verbatim shape (macOS, .NET 10):
/// `10.0.200 [/usr/local/share/dotnet/sdk]`
pub(crate) fn parse_has_sdk(stdout: &str) -> bool {
    stdout.lines().any(|line| {
        line.split_whitespace()
            .next()
            .and_then(|v| v.split('.').next())
            .map(|major| !major.is_empty() && major.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false)
    })
}

/// Highest `Microsoft.NETCore.App` major version in `dotnet --list-runtimes`.
///
/// Verbatim shape (macOS, .NET 10):
/// ```text
/// Microsoft.AspNetCore.App 10.0.4 [/usr/local/share/dotnet/shared/Microsoft.AspNetCore.App]
/// Microsoft.NETCore.App 10.0.4 [/usr/local/share/dotnet/shared/Microsoft.NETCore.App]
/// ```
/// Only `Microsoft.NETCore.App` counts — ASP.NET Core and Windows Desktop
/// ship their own version lines, and matching those would report a runtime
/// the tool cannot actually run on.
pub(crate) fn parse_max_runtime_major(stdout: &str) -> Option<u32> {
    stdout
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("Microsoft.NETCore.App ")?;
            rest.split_whitespace()
                .next()?
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
        })
        .max()
}

/// True if `--version` reported the pinned version.
///
/// Verbatim shape: `csharp-ls, 0.22.0.0` — a four-part assembly version, so
/// this is a prefix match against the three-part package version.
pub(crate) fn version_output_matches(stdout: &str) -> bool {
    stdout
        .split(',')
        .nth(1)
        .map(|v| v.trim().starts_with(CSHARP_LS_VERSION))
        .unwrap_or(false)
}

// ── Install ─────────────────────────────────────────────────────

/// A failed provision, with a code the frontend maps to specific copy.
///
/// The codes exist because every one of these needs a different sentence to
/// be actionable: "install .NET 10" and "the package did not ship" are not
/// the same problem, and collapsing them into "install failed" is how a user
/// ends up stuck.
#[derive(Debug, Clone, Serialize)]
pub struct InstallError {
    pub code: String,
    pub message: String,
}

impl InstallError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
}

/// Serialized single-flight guard.
///
/// Two windows, or two `.cs` files opened at once, must not both unpack into
/// the same directory. The second caller waits, then finds the server already
/// there and returns it.
#[derive(Default)]
pub struct CsharpLsState(Mutex<()>);

impl CsharpLsState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Delete leftover `<version>.tmp-<pid>` staging dirs.
///
/// An unpack killed mid-flight (app quit, crash, power loss) leaves one
/// behind. They are never read, so the only cost of a stale one is disk.
fn sweep_stale_staging(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.contains(".tmp-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Delete managed installs of versions we no longer pin. Runs only after the
/// current version has verified, so a failed upgrade cannot leave the user
/// with nothing.
fn sweep_old_versions(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == CSHARP_LS_VERSION {
            continue;
        }
        if entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn emit_phase(app: &AppHandle, phase: &str, detail: &str) {
    trace_append("csharp", "install", &format!("{phase}: {detail}"));
    let _ = app.emit(
        "csharp-ls-install-progress",
        serde_json::json!({ "phase": phase, "detail": detail }),
    );
}

/// Unpack the tool payload out of a nupkg.
///
/// A `DotnetTool` package puts everything under `tools/<tfm>/any/`, which this
/// flattens into `dest`. The prefix is matched structurally rather than
/// against the literal `net10.0`, so a version bump that retargets keeps
/// working.
///
/// Entry names come from `enclosed_name`, which refuses absolute paths and
/// `..` traversal. The package is ours and SHA-512 pinned, but an archive
/// extractor that can write outside its destination is not a thing to leave
/// lying around.
pub(crate) fn extract_tool(nupkg: &Path, dest: &Path) -> Result<usize, InstallError> {
    let file = std::fs::File::open(nupkg).map_err(|e| {
        InstallError::new("package-missing", format!("Could not open {}: {e}", nupkg.display()))
    })?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| {
        InstallError::new("install-failed", format!("The bundled package is not readable: {e}"))
    })?;

    let mut written = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| {
            InstallError::new("install-failed", format!("Could not read the package: {e}"))
        })?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else { continue };

        // tools/<tfm>/any/<relative path>
        let mut parts = name.components();
        let is_payload = matches!(parts.next(), Some(c) if c.as_os_str() == "tools")
            && parts.next().is_some()
            && matches!(parts.next(), Some(c) if c.as_os_str() == "any");
        if !is_payload {
            continue;
        }
        let relative: PathBuf = parts.collect();
        if relative.as_os_str().is_empty() {
            continue;
        }

        let out_path = dest.join(relative);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                InstallError::new("io", format!("Could not create {}: {e}", parent.display()))
            })?;
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| {
            InstallError::new("io", format!("Could not write {}: {e}", out_path.display()))
        })?;
        std::io::copy(&mut entry, &mut out).map_err(|e| {
            InstallError::new("io", format!("Could not write {}: {e}", out_path.display()))
        })?;
        written += 1;
    }

    if written == 0 {
        return Err(InstallError::new(
            "install-failed",
            "The bundled package contained no tool payload.",
        ));
    }
    Ok(written)
}

/// Unpack the pinned csharp-ls into the managed directory.
///
/// Returns the assembly to run — one that has actually been *started*, not
/// merely written. The verify step is what separates this from an install
/// that reports success and then fails on first use.
pub async fn install(app: &AppHandle) -> Result<PathBuf, InstallError> {
    let root = managed_root()
        .ok_or_else(|| InstallError::new("io", "Could not resolve the application data directory."))?;

    // Another caller may have finished while we waited for the lock.
    if let Some(dll) = entry_point_in(&version_dir(&root)) {
        return Ok(dll);
    }

    emit_phase(app, "preflight", "checking .NET");
    let dotnet_dir = preflight().await?;

    let nupkg = bundled_package_path(app).ok_or_else(|| {
        InstallError::new(
            "package-missing",
            "The C# language server package did not ship with this build.",
        )
    })?;

    emit_phase(app, "installing", "unpacking the bundled package");
    let installed =
        install_into(&dotnet_dir, &root, &nupkg, |phase, detail| emit_phase(app, phase, detail))
            .await?;

    emit_phase(app, "done", &installed.to_string_lossy());
    Ok(installed)
}

/// Confirm the machine can both unpack and run the pinned tool.
///
/// Returns the directory holding `dotnet`. Each failure is separately
/// actionable, which is why they are distinct codes rather than one
/// "prerequisites missing".
async fn preflight() -> Result<PathBuf, InstallError> {
    let dotnet_dir = find_dotnet_dir().ok_or_else(|| {
        InstallError::new(
            "dotnet-missing",
            "The .NET SDK was not found. Install it from https://dotnet.microsoft.com/download, \
             then reopen this project.",
        )
    })?;

    let status = probe_dotnet().await;
    if !status.has_sdk {
        return Err(InstallError::new(
            "sdk-missing",
            "Only the .NET runtime is installed, not the SDK. The C# language server needs the \
             SDK to load your project — install it from https://dotnet.microsoft.com/download.",
        ));
    }
    match status.runtime_major {
        Some(major) if major >= REQUIRED_RUNTIME_MAJOR => Ok(dotnet_dir),
        Some(major) => Err(InstallError::new(
            "runtime-too-old",
            format!(
                "The C# language server needs the .NET {REQUIRED_RUNTIME_MAJOR} runtime, but the \
                 newest installed is .NET {major}. Install .NET {REQUIRED_RUNTIME_MAJOR} from \
                 https://dotnet.microsoft.com/download."
            ),
        )),
        None => Err(InstallError::new(
            "runtime-too-old",
            format!(
                "No .NET runtime was found. The C# language server needs .NET \
                 {REQUIRED_RUNTIME_MAJOR} — install it from \
                 https://dotnet.microsoft.com/download."
            ),
        )),
    }
}

/// The unpack itself, with no dependency on Tauri.
///
/// Split out from [`install`] so the real thing — unpacking the real bundled
/// package and then running what came out of it — can be exercised by a test.
/// Every failure mode this feature has is environmental, and none of them
/// appear in a diff.
pub(crate) async fn install_into(
    dotnet_dir: &Path,
    root: &Path,
    nupkg: &Path,
    report: impl Fn(&str, &str),
) -> Result<PathBuf, InstallError> {
    // Unpack into a sibling directory, then rename into place.
    //
    // Writing straight to the final path would leave a directory that *looks*
    // installed if the process dies partway. Renaming a finished, verified
    // staging dir means the target either does not exist or works.
    std::fs::create_dir_all(root)
        .map_err(|e| InstallError::new("io", format!("Could not create {}: {e}", root.display())))?;
    sweep_stale_staging(root);

    let target = version_dir(root);
    let staging = root.join(format!("{CSHARP_LS_VERSION}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| {
        InstallError::new("io", format!("Could not create {}: {e}", staging.display()))
    })?;

    let files = match extract_tool(nupkg, &staging) {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    report("installing", &format!("unpacked {files} files"));

    let Some(dll) = entry_point_in(&staging) else {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(InstallError::new(
            "install-failed",
            "The unpacked package is missing its entry point.",
        ));
    };

    // Verify by running it.
    //
    // Files on disk prove nothing: the tool still fails at launch if the host
    // cannot start it — which is exactly what a too-old .NET looks like.
    // Catching it here, while we can still report it as an install problem, is
    // the difference between one clear message and a stream of confusing LSP
    // crashes later.
    report("verifying", "starting the server once");
    if let Err(e) = verify_server(&dll, dotnet_dir).await {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    let _ = std::fs::remove_dir_all(&target);
    if let Err(e) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(InstallError::new(
            "io",
            format!("Could not move the install into place: {e}"),
        ));
    }

    sweep_old_versions(root);
    entry_point_in(&target).ok_or_else(|| {
        InstallError::new("install-failed", "The install vanished after being put in place.")
    })
}

/// Run the freshly unpacked assembly and confirm it reports the pinned version.
async fn verify_server(dll: &Path, dotnet_dir: &Path) -> Result<(), InstallError> {
    let dotnet_exe = dotnet_dir.join(exe_name("dotnet"));
    let mut cmd = async_command(&dotnet_exe);
    cmd.arg(dll)
        .arg("--version")
        .env("DOTNET_ROOT", dotnet_dir)
        .env("DOTNET_HOST_PATH", &dotnet_exe)
        .env("PATH", path_with_prepended(dotnet_dir))
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .env("DOTNET_NOLOGO", "1")
        .kill_on_drop(true);

    let out = match tokio::time::timeout(VERIFY_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return Err(InstallError::new(
                "verify-failed",
                format!("The installed server could not be started: {e}"),
            ));
        }
        Err(_) => {
            return Err(InstallError::new(
                "verify-failed",
                "The installed server did not respond to --version.",
            ));
        }
    };

    if !out.status.success() {
        return Err(InstallError::new(
            "verify-failed",
            format!(
                "The installed server exited with an error: {}",
                collapse_output(&out.stderr, &out.stdout)
            ),
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    if !version_output_matches(&stdout) {
        return Err(InstallError::new(
            "verify-failed",
            format!("Installed server reported an unexpected version: {}", stdout.trim()),
        ));
    }
    Ok(())
}

/// Prefer stderr, fall back to stdout, and keep it short enough for a toast.
fn collapse_output(stderr: &[u8], stdout: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr);
    let text = if err.trim().is_empty() {
        String::from_utf8_lossy(stdout).into_owned()
    } else {
        err.into_owned()
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "no output".to_string();
    }
    trimmed.lines().take(4).collect::<Vec<_>>().join(" ")
}

// ── Tauri commands ──────────────────────────────────────────────

/// Where csharp-ls stands on this machine, and whether .NET can support it.
#[derive(Debug, Clone, Serialize)]
pub struct CsharpLsStatus {
    pub found: bool,
    /// `None` when nothing was found.
    pub source: Option<Source>,
    pub path: Option<String>,
    pub dotnet: DotnetStatus,
    /// Whether an install could succeed right now. `false` means the
    /// prerequisites are missing, so the frontend should explain rather than
    /// offer to install.
    pub can_install: bool,
    /// The .NET major version the pinned tool needs. Reported rather than
    /// duplicated in the frontend, so bumping the pin cannot leave the UI
    /// telling users to install the wrong version of .NET.
    pub required_runtime_major: u32,
}

#[tauri::command]
pub async fn csharp_ls_status() -> CsharpLsStatus {
    let existing = resolve_existing();
    let dotnet = probe_dotnet().await;
    let can_install = dotnet.present
        && dotnet.has_sdk
        && dotnet.runtime_major.map(|m| m >= REQUIRED_RUNTIME_MAJOR).unwrap_or(false);
    CsharpLsStatus {
        found: existing.is_some(),
        source: existing.as_ref().map(|(_, s)| *s),
        path: existing
            .as_ref()
            .map(|(launch, _)| launch.path().to_string_lossy().into_owned()),
        dotnet,
        can_install,
        required_runtime_major: REQUIRED_RUNTIME_MAJOR,
    }
}

/// Provision csharp-ls, or return the copy that already exists.
#[tauri::command]
pub async fn csharp_ls_install(
    app: AppHandle,
    state: tauri::State<'_, CsharpLsState>,
) -> Result<String, InstallError> {
    // Serialized so two windows cannot unpack into the same directory.
    let _guard = state.0.lock().await;
    if let Some((launch, _)) = resolve_existing() {
        return Ok(launch.path().to_string_lossy().into_owned());
    }
    let path = install(&app).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim `dotnet --list-runtimes` from a .NET 10 macOS install.
    const RUNTIMES_NET10: &str = "\
Microsoft.AspNetCore.App 10.0.4 [/usr/local/share/dotnet/shared/Microsoft.AspNetCore.App]
Microsoft.NETCore.App 10.0.4 [/usr/local/share/dotnet/shared/Microsoft.NETCore.App]
";

    /// A machine that can unpack the tool but cannot run it.
    const RUNTIMES_NET8_ONLY: &str = "\
Microsoft.AspNetCore.App 8.0.11 [/usr/share/dotnet/shared/Microsoft.AspNetCore.App]
Microsoft.NETCore.App 8.0.11 [/usr/share/dotnet/shared/Microsoft.NETCore.App]
";

    /// Windows adds a third family; only NETCore.App may be counted.
    const RUNTIMES_WINDOWS_MIXED: &str = "\
Microsoft.AspNetCore.App 10.0.4 [C:\\Program Files\\dotnet\\shared\\Microsoft.AspNetCore.App]
Microsoft.NETCore.App 8.0.11 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]
Microsoft.WindowsDesktop.App 10.0.4 [C:\\Program Files\\dotnet\\shared\\Microsoft.WindowsDesktop.App]
";

    const SDKS_NET10: &str = "10.0.200 [/usr/local/share/dotnet/sdk]\n";

    /// Verbatim `tools/net10.0/any/DotnetToolSettings.xml` from the package.
    const TOOL_SETTINGS_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<DotNetCliTool Version="1">
  <Commands>
    <Command Name="csharp-ls" EntryPoint="CSharpLanguageServer.dll" Runner="dotnet" />
  </Commands>
</DotNetCliTool>"#;

    #[test]
    fn reads_the_runtime_major_from_real_output() {
        assert_eq!(parse_max_runtime_major(RUNTIMES_NET10), Some(10));
        assert_eq!(parse_max_runtime_major(RUNTIMES_NET8_ONLY), Some(8));
    }

    #[test]
    fn counts_several_netcore_lines_by_their_maximum() {
        let side_by_side = format!("{RUNTIMES_NET8_ONLY}{RUNTIMES_NET10}");
        assert_eq!(parse_max_runtime_major(&side_by_side), Some(10));
    }

    /// The bug this guards: ASP.NET Core and Windows Desktop ship their own
    /// version lines. Counting those reports .NET 10 on a box whose
    /// NETCore.App runtime is 8, and the tool then fails to launch.
    #[test]
    fn ignores_runtime_families_the_tool_cannot_use() {
        assert_eq!(parse_max_runtime_major(RUNTIMES_WINDOWS_MIXED), Some(8));
    }

    #[test]
    fn survives_empty_and_malformed_runtime_output() {
        assert_eq!(parse_max_runtime_major(""), None);
        assert_eq!(parse_max_runtime_major("command not found"), None);
        assert_eq!(parse_max_runtime_major("Microsoft.NETCore.App\n"), None);
        assert_eq!(parse_max_runtime_major("Microsoft.NETCore.App x.y.z [/p]"), None);
    }

    #[test]
    fn detects_an_sdk_from_real_output() {
        assert!(parse_has_sdk(SDKS_NET10));
        assert!(parse_has_sdk("8.0.404 [/usr/share/dotnet/sdk]\n10.0.200 [/usr/share/dotnet/sdk]\n"));
    }

    /// A runtime-only install prints nothing here, which is exactly the case
    /// that must not be mistaken for "ready".
    #[test]
    fn reports_no_sdk_for_runtime_only_machines() {
        assert!(!parse_has_sdk(""));
        assert!(!parse_has_sdk("\n\n"));
        assert!(!parse_has_sdk("No SDKs were found.\n"));
    }

    #[test]
    fn accepts_the_pinned_version_banner() {
        assert!(version_output_matches("csharp-ls, 0.22.0.0\n"));
    }

    #[test]
    fn rejects_a_different_version() {
        assert!(!version_output_matches("csharp-ls, 0.21.0.0\n"));
        assert!(!version_output_matches(""));
        assert!(!version_output_matches("csharp-ls"));
    }

    // ── Entry point ─────────────────────────────────────────────

    /// The package names its own entry assembly. Reading it beats hardcoding
    /// `CSharpLanguageServer.dll`, which is not derivable from the package id
    /// and would break silently on a rename.
    #[test]
    fn reads_the_entry_point_the_package_declares() {
        assert_eq!(
            parse_entry_point(TOOL_SETTINGS_XML).as_deref(),
            Some("CSharpLanguageServer.dll"),
        );
    }

    #[test]
    fn refuses_an_entry_point_that_is_missing_or_a_path() {
        assert_eq!(parse_entry_point("<DotNetCliTool />"), None);
        assert_eq!(parse_entry_point(r#"EntryPoint="""#), None);
        assert_eq!(parse_entry_point(r#"EntryPoint="../evil.dll""#), None);
        assert_eq!(parse_entry_point(r#"EntryPoint="sub/evil.dll""#), None);
    }

    /// An install only counts as present if the entry assembly is really on
    /// disk — otherwise a half-deleted directory resolves as a usable server
    /// and every C# start fails instead of reinstalling.
    #[test]
    fn an_install_without_its_entry_point_does_not_resolve() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(entry_point_in(dir.path()).is_none(), "empty dir");

        std::fs::write(dir.path().join(TOOL_SETTINGS), TOOL_SETTINGS_XML).expect("settings");
        assert!(entry_point_in(dir.path()).is_none(), "manifest but no assembly");

        std::fs::write(dir.path().join("CSharpLanguageServer.dll"), b"x").expect("dll");
        assert_eq!(entry_point_in(dir.path()), Some(dir.path().join("CSharpLanguageServer.dll")));
    }

    // ── Housekeeping ────────────────────────────────────────────

    #[test]
    fn sweeps_staging_directories_left_by_an_interrupted_install() {
        let root = tempfile::tempdir().expect("tempdir");
        let stale = root.path().join(format!("{CSHARP_LS_VERSION}.tmp-999"));
        std::fs::create_dir_all(stale.join("nested")).expect("stale dir");
        let keep = version_dir(root.path());
        std::fs::create_dir_all(&keep).expect("real dir");

        sweep_stale_staging(root.path());

        assert!(!stale.exists(), "staging leftovers should be removed");
        assert!(keep.exists(), "a finished install must not be swept");
    }

    /// The upgrade rule: the old version is only removed once the new one is
    /// in place, so a failed bump can never leave a user with no server.
    #[test]
    fn old_versions_are_swept_but_the_pinned_one_is_kept() {
        let root = tempfile::tempdir().expect("tempdir");
        let old = root.path().join("0.1.0");
        let current = version_dir(root.path());
        std::fs::create_dir_all(&old).expect("old dir");
        std::fs::create_dir_all(&current).expect("current dir");

        sweep_old_versions(root.path());

        assert!(!old.exists());
        assert!(current.exists());
    }

    #[test]
    fn collapsed_output_prefers_stderr_and_stays_short() {
        assert_eq!(collapse_output(b"boom", b"noise"), "boom");
        assert_eq!(collapse_output(b"  ", b"fallback"), "fallback");
        assert_eq!(collapse_output(b"", b""), "no output");
        let many = b"a\nb\nc\nd\ne\nf";
        assert_eq!(collapse_output(many, b""), "a b c d");
    }

    // ── End-to-end ──────────────────────────────────────────────
    //
    // These unpack the real bundled package and run what comes out of it.
    // Everything that can go wrong with this feature is environmental — a
    // package that did not ship, a payload laid out differently, a tool that
    // unpacks but cannot launch — and none of it is visible in a diff or
    // catchable by a mocked test.
    //
    // Set `UNITYIDE_CSHARP_LS_E2E=required` to turn a skip into a failure.

    fn e2e_required() -> bool {
        std::env::var("UNITYIDE_CSHARP_LS_E2E").as_deref() == Ok("required")
    }

    /// Returns `None` (after reporting) when the machine cannot run the check.
    fn e2e_prerequisites() -> Option<(PathBuf, PathBuf)> {
        let nupkg = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(PACKAGE_ID)
            .join(nupkg_file_name());

        let missing = if find_dotnet_dir().is_none() {
            Some("no dotnet on this machine")
        } else if !nupkg.is_file() {
            Some("the bundled package is not vendored — run `bun run prepare:csharp-ls`")
        } else {
            None
        };

        if let Some(reason) = missing {
            // Loud, because a skip is not a pass.
            eprintln!("SKIPPED csharp-ls install e2e: {reason}");
            assert!(!e2e_required(), "UNITYIDE_CSHARP_LS_E2E=required but {reason}");
            return None;
        }
        Some((find_dotnet_dir().expect("checked above"), nupkg))
    }

    /// The whole feature in one test: unpack the shipped package and start
    /// what came out. A pass here means an offline user gets a working C#
    /// server with no NuGet, no network and no SDK tooling involved in
    /// getting it onto disk.
    #[tokio::test]
    async fn unpacks_the_bundled_package_and_the_result_runs() {
        let Some((dotnet_dir, nupkg)) = e2e_prerequisites() else { return };
        let root = tempfile::tempdir().expect("tempdir");

        let dll = install_into(&dotnet_dir, root.path(), &nupkg, |_, _| {})
            .await
            .expect("unpack the bundled package");

        assert!(dll.is_file(), "entry assembly should exist at {}", dll.display());
        assert!(dll.starts_with(version_dir(root.path())));

        // Not "a file exists" — it starts, and it is the version we pinned.
        verify_server(&dll, &dotnet_dir).await.expect("installed server should run");

        // The staging directory must not survive a successful unpack.
        let leftovers: Vec<_> = std::fs::read_dir(root.path())
            .expect("read root")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");
    }

    /// Only the tool payload is unpacked, flattened. Packaging metadata
    /// (`_rels/`, the nuspec) is not part of a working install, and a
    /// non-flattened layout would leave the entry point unfindable.
    #[tokio::test]
    async fn unpacks_the_tool_payload_and_nothing_else() {
        let Some((_, nupkg)) = e2e_prerequisites() else { return };
        let dest = tempfile::tempdir().expect("tempdir");

        let files = extract_tool(&nupkg, dest.path()).expect("extract");
        assert!(files > 100, "expected the full payload, got {files} files");

        assert!(dest.path().join(TOOL_SETTINGS).is_file());
        assert!(dest.path().join("CSharpLanguageServer.dll").is_file());
        assert!(dest.path().join("CSharpLanguageServer.runtimeconfig.json").is_file());
        assert!(!dest.path().join("_rels").exists(), "packaging metadata must not be unpacked");
        assert!(!dest.path().join("tools").exists(), "the payload must be flattened");
    }

    /// A file that is not a package must fail cleanly, leaving nothing a later
    /// run could mistake for a working install.
    #[tokio::test]
    async fn a_corrupt_package_leaves_nothing_behind() {
        let Some((dotnet_dir, _)) = e2e_prerequisites() else { return };
        let root = tempfile::tempdir().expect("tempdir");
        let bogus = tempfile::tempdir().expect("tempdir");
        let bogus_pkg = bogus.path().join(nupkg_file_name());
        std::fs::write(&bogus_pkg, b"not a zip archive").expect("write");

        let err = install_into(&dotnet_dir, root.path(), &bogus_pkg, |_, _| {})
            .await
            .expect_err("a corrupt package cannot install");

        assert_eq!(err.code, "install-failed");
        assert!(!version_dir(root.path()).exists());
        let entries: Vec<_> = std::fs::read_dir(root.path())
            .expect("read root")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(entries.is_empty(), "failed install left: {entries:?}");
    }
}
