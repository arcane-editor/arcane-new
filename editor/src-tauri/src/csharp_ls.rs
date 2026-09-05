//! Provisioning for the C# language server (`csharp-ls`).
//!
//! **Why this exists.** C# is the whole point of this editor, and until now
//! getting it working required the user to run `dotnet tool install -g
//! csharp-ls` by hand — a step nobody discovers, in a product whose headline
//! feature is C# intelligence. This module makes the editor provision its own
//! copy instead.
//!
//! **The shape of the fix.** A pinned `csharp-ls` nupkg ships inside the app
//! bundle, and on the first C# start we `dotnet tool install` it from that
//! local copy into the app's data dir. The install is offline (the bundled
//! package is the only NuGet source), version-pinned, and never touches the
//! user's global tool store.
//!
//! **What it deliberately does not do.** It never overrides a `csharp-ls` the
//! user already has — [`resolve_existing`] checks their install first and the
//! managed copy last, so nobody's working setup changes underneath them.
//!
//! **The prerequisite that is easy to get wrong.** csharp-ls 0.22.0 is a
//! *framework-dependent* tool targeting `net10.0`, so "has dotnet" is not the
//! requirement — "has the .NET 10 runtime, and an SDK for `dotnet tool`" is.
//! Skipping that check produces the worst failure available: the install
//! succeeds, and then the server dies on launch with a generic host error. So
//! every prerequisite is probed *before* installing and each one gets its own
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

/// The NuGet package id, which is also the shim's file stem.
const PACKAGE_ID: &str = "csharp-ls";

/// Major version of `Microsoft.NETCore.App` the pinned tool needs. Tied to
/// the tool package's target framework: 0.22.0 ships `tools/net10.0/any`, so
/// a machine with only .NET 8 installs it successfully and then cannot run
/// it. Verified by reading the extracted tool store, not assumed.
const REQUIRED_RUNTIME_MAJOR: u32 = 10;

/// `dotnet tool install` unpacks ~106 MB. Generous, because the ceiling here
/// is a slow disk or a first-run NuGet restore, and the cost of being wrong
/// is telling a user their install failed when it was about to finish.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// `dotnet --list-runtimes` and friends are near-instant; anything slower is
/// a hung host, not a slow one.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// First launch of a freshly installed .NET tool pays JIT and assembly-load
/// costs, so this is deliberately not tight.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(90);

/// Escape hatch for users who build csharp-ls themselves or pin their own
/// version. Mirrors `EDITOR_USE_SYSTEM_LSP` in `lsp.rs`.
const PATH_OVERRIDE_ENV: &str = "UNITYIDE_CSHARP_LS_PATH";

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
/// Version-scoped so a future bump installs alongside the old one and can only
/// replace it after the new copy verifies — an app update can never leave a
/// user with no working server.
pub(crate) fn version_dir(root: &Path) -> PathBuf {
    root.join(CSHARP_LS_VERSION)
}

/// The shim `dotnet tool install --tool-path` produces under a given root.
///
/// The installer and the resolver must agree on this path exactly: if they
/// drift, every start installs again and then fails to find what it installed.
/// One function, used by both, is what keeps them from drifting.
pub(crate) fn binary_in(root: &Path) -> PathBuf {
    version_dir(root).join(exe_name(PACKAGE_ID))
}

/// Install directory for the pinned version in the managed location.
pub fn managed_version_dir() -> Option<PathBuf> {
    Some(version_dir(&managed_root()?))
}

/// The managed binary [`resolve_existing`] looks for.
pub fn managed_binary() -> Option<PathBuf> {
    Some(binary_in(&managed_root()?))
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
/// from "nothing exists", and would install a second copy nobody asked for.
fn path_binary() -> Option<PathBuf> {
    let name = exe_name(PACKAGE_ID);
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(&name))
        .find(|p| p.is_file())
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
    /// Installed and owned by this editor.
    Managed,
}

/// Locate an existing csharp-ls, in precedence order.
///
/// The user's own install wins over ours on purpose. Someone who ran
/// `dotnet tool install -g csharp-ls`, or who pinned a build for a reason we
/// cannot see, must not have that silently replaced by an app update.
pub fn resolve_existing() -> Option<(PathBuf, Source)> {
    if let Some(raw) = std::env::var_os(PATH_OVERRIDE_ENV) {
        let p = PathBuf::from(raw);
        if p.is_file() {
            return Some((p, Source::Override));
        }
    }
    if let Some(p) = global_tool_binary() {
        if p.is_file() {
            return Some((p, Source::User));
        }
    }
    if let Some(p) = path_binary() {
        return Some((p, Source::Path));
    }
    if let Some(p) = managed_binary() {
        if p.is_file() {
            return Some((p, Source::Managed));
        }
    }
    None
}

/// Directory holding the bundled nupkg, if it shipped with this build.
///
/// Packaged builds get it from the Tauri resource dir; `cargo`/`tauri dev`
/// from the crate. Returns `None` unless the pinned package is actually
/// present, so a build made without `prepare:csharp-ls` degrades to a network
/// install instead of pointing NuGet at an empty directory.
pub fn bundled_package_dir(app: &AppHandle) -> Option<PathBuf> {
    let pkg = nupkg_file_name();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(PACKAGE_ID));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(PACKAGE_ID),
    );
    candidates.into_iter().find(|dir| dir.join(&pkg).is_file())
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
    /// `dotnet --list-sdks` returned at least one SDK. Required because
    /// `dotnet tool install` is an SDK command — a runtime-only install
    /// cannot perform it.
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

/// True if `csharp-ls --version` reported the pinned version.
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
/// be actionable: "install .NET 10" and "you are offline" are not the same
/// problem, and collapsing them into "install failed" is how a user ends up
/// stuck.
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
/// Two windows, or two `.cs` files opened at once, must not both run
/// `dotnet tool install` into the same directory. The second caller waits,
/// then finds the binary already there and returns it.
#[derive(Default)]
pub struct CsharpLsState(Mutex<()>);

impl CsharpLsState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// XML-escape a value destined for a NuGet config attribute. Install paths
/// come from the user's home directory and can contain `&`.
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A NuGet config naming exactly one package source.
///
/// `<clear/>` is the load-bearing part. Without it the user's own
/// `nuget.config` still applies, and a machine pointed at an unreachable or
/// credential-gated corporate feed fails the restore before it ever consults
/// ours. Clearing first makes the install independent of whatever NuGet
/// configuration the machine already has.
pub(crate) fn nuget_config_xml(source: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="unityide" value="{}" />
  </packageSources>
  <disabledPackageSources>
    <clear />
  </disabledPackageSources>
</configuration>
"#,
        xml_escape(source)
    )
}

/// The public feed, used only when no bundled package shipped.
const NUGET_ORG: &str = "https://api.nuget.org/v3/index.json";

/// argv for the install.
///
/// The source is carried entirely by `--configfile`; `--add-source` would
/// layer a second source on top of the one the config already declares, and
/// the whole point of the generated config is that it is the only source in
/// play.
pub(crate) fn install_args(tool_path: &Path, config_path: &Path) -> Vec<String> {
    vec![
        "tool".into(),
        "install".into(),
        PACKAGE_ID.into(),
        "--version".into(),
        CSHARP_LS_VERSION.into(),
        "--tool-path".into(),
        tool_path.to_string_lossy().into_owned(),
        "--configfile".into(),
        config_path.to_string_lossy().into_owned(),
        "--ignore-failed-sources".into(),
    ]
}

/// Delete leftover `<version>.tmp-<pid>` staging dirs.
///
/// An install killed mid-flight (app quit, crash, power loss) leaves one
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
    let _ = app.emit("csharp-ls-install-progress", serde_json::json!({
        "phase": phase,
        "detail": detail,
    }));
}

/// Install the pinned csharp-ls into the managed directory.
///
/// Returns the path to a binary that has been *run*, not merely written — the
/// verify step is what separates this from an install that reports success and
/// then fails on first use.
pub async fn install(app: &AppHandle) -> Result<PathBuf, InstallError> {
    let root = managed_root().ok_or_else(|| {
        InstallError::new("io", "Could not resolve the application data directory.")
    })?;
    let binary = managed_binary().expect("managed_root resolved");

    // Another caller may have finished while we waited for the lock.
    if binary.is_file() {
        return Ok(binary);
    }

    emit_phase(app, "preflight", "checking .NET");
    let dotnet_dir = preflight().await?;

    // Offline when the package shipped with the app; the public feed only as a
    // fallback for builds made without `prepare:csharp-ls`.
    let bundled = bundled_package_dir(app);
    let source = match &bundled {
        Some(dir) => dir.to_string_lossy().into_owned(),
        None => NUGET_ORG.to_string(),
    };
    emit_phase(
        app,
        "installing",
        if bundled.is_some() { "from bundled package" } else { "from nuget.org" },
    );

    let installed = install_into(&dotnet_dir, &root, &source, |phase, detail| {
        emit_phase(app, phase, detail)
    })
    .await?;

    emit_phase(app, "done", &installed.to_string_lossy());
    Ok(installed)
}

/// Confirm the machine can both install and run the pinned tool.
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
            "Only the .NET runtime is installed, not the SDK. Installing the C# language server \
             needs the SDK — install it from https://dotnet.microsoft.com/download.",
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

/// The install itself, with no dependency on Tauri.
///
/// Split out from [`install`] so the real thing — a genuine
/// `dotnet tool install` from the bundled package, followed by running the
/// binary it produced — can be exercised by a test. Every failure mode this
/// feature has is environmental, and none of them appear in a diff.
pub(crate) async fn install_into(
    dotnet_dir: &Path,
    root: &Path,
    source: &str,
    report: impl Fn(&str, &str),
) -> Result<PathBuf, InstallError> {
    // Stage into a sibling directory, then rename into place.
    //
    // `dotnet tool install` writes progressively, so installing straight into
    // the final path would leave a directory that *looks* installed if the
    // process dies partway. Renaming a finished, verified staging dir means
    // the target either does not exist or works.
    std::fs::create_dir_all(root)
        .map_err(|e| InstallError::new("io", format!("Could not create {}: {e}", root.display())))?;
    sweep_stale_staging(root);

    let target = version_dir(root);
    let staging = root.join(format!("{CSHARP_LS_VERSION}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| {
        InstallError::new("io", format!("Could not create {}: {e}", staging.display()))
    })?;

    let config_path = staging.join("nuget.config");
    if let Err(e) = std::fs::write(&config_path, nuget_config_xml(source)) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(InstallError::new(
            "io",
            format!("Could not write {}: {e}", config_path.display()),
        ));
    }

    let dotnet_exe = dotnet_dir.join(exe_name("dotnet"));
    let mut cmd = async_command(&dotnet_exe);
    cmd.args(install_args(&staging, &config_path))
        .env("DOTNET_ROOT", dotnet_dir)
        .env("DOTNET_HOST_PATH", &dotnet_exe)
        .env("PATH", path_with_prepended(dotnet_dir))
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .env("DOTNET_NOLOGO", "1")
        .kill_on_drop(true);

    // `kill_on_drop` + `timeout` is what bounds a hung NuGet restore: when the
    // timeout fires the future is dropped and the child is killed with it.
    let output = match tokio::time::timeout(INSTALL_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(InstallError::new("install-failed", format!("Could not run dotnet: {e}")));
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(InstallError::new(
                "timeout",
                format!(
                    "Installing the C# language server timed out after {}s.",
                    INSTALL_TIMEOUT.as_secs()
                ),
            ));
        }
    };

    if !output.status.success() {
        let detail = collapse_output(&output.stderr, &output.stdout);
        let _ = std::fs::remove_dir_all(&staging);
        return Err(InstallError::new(
            "install-failed",
            format!("dotnet tool install failed: {detail}"),
        ));
    }

    // Verify by running it.
    //
    // A successful install still fails at runtime if the host cannot start the
    // tool. Catching that here, while we can still report it as an install
    // problem, is the difference between one clear message and a stream of
    // confusing LSP crashes later.
    report("verifying", "starting the server once");
    let staged_binary = staging.join(exe_name(PACKAGE_ID));
    if let Err(e) = verify_binary(&staged_binary, dotnet_dir).await {
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
    Ok(binary_in(root))
}

/// Run the freshly installed binary and confirm it reports the pinned version.
async fn verify_binary(binary: &Path, dotnet_dir: &Path) -> Result<(), InstallError> {
    let mut cmd = async_command(binary);
    cmd.arg("--version")
        .env("DOTNET_ROOT", dotnet_dir)
        .env("DOTNET_HOST_PATH", dotnet_dir.join(exe_name("dotnet")))
        .env("PATH", path_with_prepended(dotnet_dir))
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
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
    let text = if err.trim().is_empty() { String::from_utf8_lossy(stdout).into_owned() } else { err.into_owned() };
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
        path: existing.as_ref().map(|(p, _)| p.to_string_lossy().into_owned()),
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
    // Serialized so two windows cannot install into the same directory.
    let _guard = state.0.lock().await;
    if let Some((path, _)) = resolve_existing() {
        return Ok(path.to_string_lossy().into_owned());
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

    /// A machine that can install the tool but cannot run it.
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
    /// that must not be mistaken for "ready to install".
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

    #[test]
    fn install_args_pin_the_version_and_the_target() {
        let args = install_args(Path::new("/tmp/stage"), Path::new("/tmp/stage/nuget.config"));
        assert_eq!(args[0], "tool");
        assert_eq!(args[1], "install");
        assert_eq!(args[2], "csharp-ls");
        let version_at = args.iter().position(|a| a == "--version").expect("--version");
        assert_eq!(args[version_at + 1], CSHARP_LS_VERSION);
        let tool_path_at = args.iter().position(|a| a == "--tool-path").expect("--tool-path");
        assert_eq!(args[tool_path_at + 1], "/tmp/stage");
        let config_at = args.iter().position(|a| a == "--configfile").expect("--configfile");
        assert_eq!(args[config_at + 1], "/tmp/stage/nuget.config");
    }

    /// `--global` would write into the user's own tool store, which is the
    /// one thing this must never touch.
    #[test]
    fn install_never_targets_the_global_tool_store() {
        let args = install_args(Path::new("/tmp/stage"), Path::new("/tmp/stage/nuget.config"));
        assert!(!args.iter().any(|a| a == "--global" || a == "-g"));
    }

    /// Without `<clear/>` the machine's own nuget.config still applies, and a
    /// corporate feed that is unreachable or credential-gated fails the
    /// restore before ours is ever consulted.
    #[test]
    fn nuget_config_clears_inherited_sources() {
        let xml = nuget_config_xml("/opt/pkgs");
        assert!(xml.contains("<clear />"));
        assert!(xml.contains(r#"value="/opt/pkgs""#));
        assert!(xml.contains("<disabledPackageSources>"));
    }

    #[test]
    fn nuget_config_escapes_paths() {
        let xml = nuget_config_xml("/home/a&b/pkgs");
        assert!(xml.contains("/home/a&amp;b/pkgs"));
        assert!(!xml.contains("a&b"));
    }

    #[test]
    fn managed_layout_is_version_scoped() {
        let dir = managed_version_dir().expect("data dir");
        assert!(dir.ends_with(CSHARP_LS_VERSION));
        let binary = managed_binary().expect("data dir");
        assert_eq!(binary.file_name().unwrap().to_string_lossy(), exe_name("csharp-ls"));
        assert!(binary.starts_with(managed_root().expect("data dir")));
    }

    #[test]
    fn executable_names_carry_the_windows_suffix() {
        if cfg!(target_os = "windows") {
            assert_eq!(exe_name("csharp-ls"), "csharp-ls.exe");
        } else {
            assert_eq!(exe_name("csharp-ls"), "csharp-ls");
        }
    }

    #[test]
    fn nupkg_name_tracks_the_pinned_version() {
        assert_eq!(nupkg_file_name(), format!("csharp-ls.{CSHARP_LS_VERSION}.nupkg"));
    }

    // ── Housekeeping ────────────────────────────────────────────

    #[test]
    fn sweeps_staging_directories_left_by_an_interrupted_install() {
        let root = tempfile::tempdir().expect("tempdir");
        let stale = root.path().join(format!("{CSHARP_LS_VERSION}.tmp-999"));
        std::fs::create_dir_all(stale.join("nested")).expect("stale dir");
        let keep = root.path().join(CSHARP_LS_VERSION);
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
        let current = root.path().join(CSHARP_LS_VERSION);
        std::fs::create_dir_all(&old).expect("old dir");
        std::fs::create_dir_all(&current).expect("current dir");

        sweep_old_versions(root.path());

        assert!(!old.exists());
        assert!(current.exists());
    }

    // ── End-to-end install ──────────────────────────────────────
    //
    // These run the real `dotnet tool install` against the real bundled
    // package. Everything that can go wrong with this feature is
    // environmental — a package that did not ship, a NuGet config that
    // resolves nothing, a tool that installs but cannot launch — and none of
    // it is visible in a diff or catchable by a mocked test.
    //
    // Set `UNITYIDE_CSHARP_LS_E2E=required` to turn a skip into a failure.

    fn e2e_required() -> bool {
        std::env::var("UNITYIDE_CSHARP_LS_E2E").as_deref() == Ok("required")
    }

    /// Returns `None` (after reporting) when the machine cannot run the check.
    fn e2e_prerequisites() -> Option<(PathBuf, PathBuf)> {
        let package_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(PACKAGE_ID);

        let missing = if find_dotnet_dir().is_none() {
            Some("no dotnet on this machine")
        } else if !package_dir.join(nupkg_file_name()).is_file() {
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
        Some((find_dotnet_dir().expect("checked above"), package_dir))
    }

    /// The whole feature in one test: install from the bundled package with
    /// the machine's own NuGet configuration cleared, then run what it
    /// produced. A pass here means an offline user gets a working C# server.
    #[tokio::test]
    async fn installs_the_bundled_package_offline_and_the_result_runs() {
        let Some((dotnet_dir, package_dir)) = e2e_prerequisites() else { return };
        let root = tempfile::tempdir().expect("tempdir");

        let binary = install_into(
            &dotnet_dir,
            root.path(),
            &package_dir.to_string_lossy(),
            |_, _| {},
        )
        .await
        .expect("install from the bundled package");

        assert!(binary.is_file(), "installed binary should exist at {}", binary.display());
        assert!(binary.starts_with(root.path().join(CSHARP_LS_VERSION)));

        // Not "a file exists" — it starts, and it is the version we pinned.
        verify_binary(&binary, &dotnet_dir).await.expect("installed server should run");

        // The staging directory must not survive a successful install.
        let leftovers: Vec<_> = std::fs::read_dir(root.path())
            .expect("read root")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");
    }

    /// A source with no package in it stands in for every way the install can
    /// fail. What matters is that it fails *cleanly*: no half-written version
    /// directory that a later run would mistake for a working install.
    #[tokio::test]
    async fn a_failed_install_leaves_nothing_behind() {
        let Some((dotnet_dir, _)) = e2e_prerequisites() else { return };
        let root = tempfile::tempdir().expect("tempdir");
        let empty_source = tempfile::tempdir().expect("tempdir");

        let err = install_into(
            &dotnet_dir,
            root.path(),
            &empty_source.path().to_string_lossy(),
            |_, _| {},
        )
        .await
        .expect_err("an empty source cannot satisfy the install");

        assert_eq!(err.code, "install-failed");
        assert!(!root.path().join(CSHARP_LS_VERSION).exists());
        let entries: Vec<_> = std::fs::read_dir(root.path())
            .expect("read root")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(entries.is_empty(), "failed install left: {entries:?}");
    }

    #[test]
    fn collapsed_output_prefers_stderr_and_stays_short() {
        assert_eq!(collapse_output(b"boom", b"noise"), "boom");
        assert_eq!(collapse_output(b"  ", b"fallback"), "fallback");
        assert_eq!(collapse_output(b"", b""), "no output");
        let many = b"a\nb\nc\nd\ne\nf";
        assert_eq!(collapse_output(many, b""), "a b c d");
    }
}
