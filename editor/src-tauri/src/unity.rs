use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

#[derive(Debug, Serialize)]
pub struct UnityProjectInfo {
    pub is_unity: bool,
    pub unity_version: Option<String>,
    pub nested_project_path: Option<String>,
    /// Nearest ancestor directory that is a Unity project root, when the
    /// opened folder sits *inside* a Unity project (e.g. `Assets/Scripts`).
    /// `None` when the opened folder is itself a Unity root.
    pub ancestor_project_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct UnityEditorInstall {
    pub path: String,
    pub version: String,
    pub unity_yaml_merge_path: Option<String>,
}

/// Check if the given directory is a Unity project root (has Assets/ + ProjectSettings/).
fn is_unity_root(dir: &Path) -> bool {
    dir.join("Assets").is_dir() && dir.join("ProjectSettings").is_dir()
}

/// Read the Unity version from ProjectSettings/ProjectVersion.txt.
fn read_unity_version(project_settings: &Path) -> Option<String> {
    let version_file = project_settings.join("ProjectVersion.txt");
    if !version_file.exists() {
        return None;
    }
    fs::read_to_string(&version_file)
        .ok()
        .and_then(|content| {
            // Format: m_EditorVersion: 2022.3.10f1
            for line in content.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("m_EditorVersion:") {
                    return Some(rest.trim().to_string());
                }
            }
            None
        })
}

/// Directories to skip when scanning for nested Unity projects.
const SKIP_NESTED_DIRS: &[&str] = &["node_modules", "Library", "Temp", ".git", ".hg", ".svn"];

/// Scan direct children (depth 1) and their children (depth 2) for a Unity project.
/// Returns the path of the first (alphabetical) Unity project found.
fn find_nested_unity_project(root: &Path) -> Option<String> {
    // Collect depth-1 dirs, sorted alphabetically for determinism.
    let mut depth1_dirs: Vec<PathBuf> = match fs::read_dir(root) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().map(|t| t.is_dir()).unwrap_or(false)
            })
            .filter(|e| {
                let name = e.file_name();
                let name_str = name.to_string_lossy();
                !name_str.starts_with('.') && !SKIP_NESTED_DIRS.contains(&name_str.as_ref())
            })
            .map(|e| e.path())
            .collect(),
        Err(_) => return None,
    };
    depth1_dirs.sort();

    // First pass: check depth 1.
    for dir in &depth1_dirs {
        if is_unity_root(dir) {
            return Some(crate::path_util::to_ui_path(dir));
        }
    }

    // Second pass: check depth 2 (children of depth-1 dirs), sorted per parent.
    for parent in &depth1_dirs {
        let mut depth2_dirs: Vec<PathBuf> = match fs::read_dir(parent) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                })
                .filter(|e| {
                    let name = e.file_name();
                    let name_str = name.to_string_lossy();
                    !name_str.starts_with('.') && !SKIP_NESTED_DIRS.contains(&name_str.as_ref())
                })
                .map(|e| e.path())
                .collect(),
            Err(_) => continue,
        };
        depth2_dirs.sort();
        for dir in &depth2_dirs {
            if is_unity_root(dir) {
                return Some(crate::path_util::to_ui_path(dir));
            }
        }
    }

    None
}

/// Cap on how far up the tree to look for an enclosing Unity project. A real
/// project sits 1–3 levels above a script folder; the cap keeps a pathological
/// path from turning project-open into a long syscall loop.
const MAX_ANCESTOR_DEPTH: usize = 12;

/// Nearest ancestor of `dir` that is a Unity project root.
///
/// Excludes `dir` itself — `detect_unity_project` checks that separately and
/// returns early, so this is only ever called for a non-root folder.
fn find_ancestor_unity_project(dir: &Path) -> Option<String> {
    dir.ancestors()
        .skip(1)
        .take(MAX_ANCESTOR_DEPTH)
        .find(|candidate| is_unity_root(candidate))
        .map(crate::path_util::to_ui_path)
}

/// Detect if the given workspace is a Unity project.
/// Checks for Assets/ and ProjectSettings/ directories,
/// reads ProjectSettings/ProjectVersion.txt for the Unity version.
/// When the root is NOT a Unity project, scans depth-1 and depth-2 subdirectories
/// for a nested Unity project (`nested_project_path`) and walks upward, bounded
/// by `MAX_ANCESTOR_DEPTH`, for an enclosing one (`ancestor_project_path`) —
/// covers both "opened the parent of my project" and "opened a subfolder of it".
#[tauri::command]
pub fn detect_unity_project(workspace_path: String) -> Result<UnityProjectInfo, String> {
    let root = Path::new(&workspace_path);

    if is_unity_root(root) {
        let unity_version = read_unity_version(&root.join("ProjectSettings"));
        return Ok(UnityProjectInfo {
            is_unity: true,
            unity_version,
            nested_project_path: None,
            ancestor_project_path: None,
        });
    }

    // Root is not Unity — look both directions. Downward finds a project the
    // user opened the parent of; upward finds one they opened a subfolder of.
    let nested = find_nested_unity_project(root);
    let ancestor = find_ancestor_unity_project(root);

    Ok(UnityProjectInfo {
        is_unity: false,
        unity_version: None,
        nested_project_path: nested,
        ancestor_project_path: ancestor,
    })
}

/// Path to the cached Unity package registry index.
/// Mirrors `settings.rs`: `~/.config/editor/unity-registry.json` (via `dirs::config_dir`).
fn registry_cache_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("editor");
    path.push("unity-registry.json");
    path
}

/// Is the cached registry file present and fresh (< 24h old)?
fn registry_cache_is_fresh(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    match modified.elapsed() {
        Ok(age) => age < std::time::Duration::from_secs(24 * 60 * 60),
        // SystemTime in the future (clock skew) — treat as fresh rather than refetch.
        Err(_) => true,
    }
}

/// Fetch the Unity package registry index, best-effort and never erroring.
///
/// Behavior:
///   1. If `~/.config/editor/unity-registry.json` exists and is < 24h old, return it.
///   2. Otherwise attempt an HTTP fetch from the Unity package registry. The project
///      has NO HTTP client dependency (checked Cargo.toml: no reqwest/ureq/etc.), and
///      we deliberately do NOT add a heavy dependency for a best-effort feature — so
///      this branch currently returns the stale cache if present, else `{}`. The
///      frontend has a static seed list fallback, so an empty payload is fully handled.
///   3. On ANY failure, return `Ok("{}")` so the app is never disrupted.
///
/// If/when an HTTP client is added to the workspace, the fetch can be slotted into the
/// marked branch below and the result written to `registry_cache_path()` with an
/// embedded `_fetchedAt` field.
#[tauri::command]
pub async fn unity_fetch_registry_index() -> Result<String, String> {
    let cache_path = registry_cache_path();

    // 1. Fresh cache → serve it.
    if registry_cache_is_fresh(&cache_path) {
        if let Ok(content) = fs::read_to_string(&cache_path) {
            if !content.trim().is_empty() {
                return Ok(content);
            }
        }
    }

    // 2. Would fetch over HTTP here. No HTTP client in deps (see doc comment) — do not
    //    add one for a best-effort feature. Fall through to stale cache / empty.

    // 3a. Stale-but-present cache is still better than nothing.
    if let Ok(content) = fs::read_to_string(&cache_path) {
        if !content.trim().is_empty() {
            return Ok(content);
        }
    }

    // 3b. Nothing available — frontend seed list takes over.
    Ok("{}".into())
}

/// Build the yaml merge tool path from a Unity editor install path.
fn yaml_merge_path(editor_app_or_exe: &Path) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // editor_app_or_exe is like /Applications/Unity/Hub/Editor/<ver>/Unity.app
        // UnityYAMLMerge is at Unity.app/Contents/Tools/UnityYAMLMerge
        let candidate = editor_app_or_exe.join("Contents").join("Tools").join("UnityYAMLMerge");
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    #[cfg(target_os = "windows")]
    {
        // editor_app_or_exe is Unity.exe; its dir is the Editor dir.
        if let Some(editor_dir) = editor_app_or_exe.parent() {
            let candidate = editor_dir.join("Data").join("Tools").join("UnityYAMLMerge.exe");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(editor_dir) = editor_app_or_exe.parent() {
            let candidate = editor_dir.join("Data").join("Tools").join("UnityYAMLMerge");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Try to resolve a Unity editor install from the Unity Hub `editors-v2.json` on macOS.
/// Handles both array and object shapes, and accepts both `editors.json` variants.
#[cfg(target_os = "macos")]
fn resolve_from_hub_json(version: &str) -> Option<PathBuf> {
    let hub_dir = dirs::home_dir()?
        .join("Library")
        .join("Application Support")
        .join("UnityHub");

    let candidates = ["editors-v2.json", "editors.json"];
    for filename in &candidates {
        let path = hub_dir.join(filename);
        if !path.exists() {
            continue;
        }
        let content = fs::read_to_string(&path).ok()?;
        let v: serde_json::Value = serde_json::from_str(&content).ok()?;

        // Helper: search a JSON object/value for a string field containing the version.
        fn find_location(entry: &serde_json::Value, version: &str) -> Option<PathBuf> {
            // Try common field names for the install location.
            let location_keys = ["location", "path", "executablePath", "installPath"];
            for key in &location_keys {
                if let Some(s) = entry.get(key).and_then(|v| v.as_str()) {
                    if s.contains(version) {
                        return Some(PathBuf::from(s));
                    }
                }
            }
            // Fallback: search all string fields in this entry.
            if let Some(obj) = entry.as_object() {
                for (_k, val) in obj {
                    if let Some(s) = val.as_str() {
                        if s.contains(version) && (s.ends_with(".app") || s.contains("Unity.app")) {
                            return Some(PathBuf::from(s));
                        }
                    }
                }
            }
            None
        }

        match &v {
            serde_json::Value::Array(arr) => {
                for entry in arr {
                    if let Some(p) = find_location(entry, version) {
                        return Some(p);
                    }
                }
            }
            serde_json::Value::Object(map) => {
                // Keys may be version strings; check exact match first, then values.
                if let Some(entry) = map.get(version) {
                    if let Some(p) = find_location(entry, version) {
                        return Some(p);
                    }
                }
                // Search all entries.
                for (_k, entry) in map {
                    if let Some(p) = find_location(entry, version) {
                        return Some(p);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// Read Unity Hub's configured install roots out of a Hub config directory.
///
/// Hub asks for an install location during setup and writes the answer to
/// `secondaryInstallPath.json` (a bare JSON string). A second drive is a very
/// common answer, and the Windows resolver used to probe exactly one
/// hard-coded path — so those users got no `.csproj`, no `.sln`, and silently
/// dead C# IntelliSense with nothing reported anywhere.
///
/// Platform-neutral and directory-parameterised so it is testable on any host.
/// Only called from the Windows resolver, but deliberately not cfg-gated:
/// gating it would make the Windows behaviour untestable from a macOS run,
/// which is the blind spot that let the single-hard-coded-path bug ship.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn hub_roots_from_config_dir(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    let secondary = dir.join("secondaryInstallPath.json");
    if let Ok(text) = fs::read_to_string(&secondary) {
        // The file holds a bare JSON string, e.g. "D:\\Unity\\Hub\\Editor".
        if let Ok(serde_json::Value::String(s)) = serde_json::from_str::<serde_json::Value>(&text) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                roots.push(PathBuf::from(trimmed));
            }
        }
    }

    roots
}

/// Probe a set of Hub install roots for a specific editor version.
///
/// Platform-neutral: the executable layout differs per OS, but the root/version
/// nesting does not, so the Windows path is exercisable from a macOS test run.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn resolve_from_hub_roots(roots: &[PathBuf], version: &str) -> Option<PathBuf> {
    for root in roots {
        let candidate = if cfg!(target_os = "windows") {
            root.join(version).join("Editor").join("Unity.exe")
        } else if cfg!(target_os = "macos") {
            root.join(version).join("Unity.app")
        } else {
            root.join(version).join("Editor").join("Unity")
        };
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Resolve a Unity editor install for the given version string.
/// Returns Ok(None) when not found (not an error).
#[tauri::command]
pub fn resolve_unity_editor(version: String) -> Result<Option<UnityEditorInstall>, String> {
    #[cfg(target_os = "macos")]
    {
        // 1. Try Unity Hub editors-v2.json / editors.json.
        if let Some(hub_path) = resolve_from_hub_json(&version) {
            if hub_path.exists() {
                let yaml_merge = yaml_merge_path(&hub_path);
                return Ok(Some(UnityEditorInstall {
                    path: hub_path.to_string_lossy().to_string(),
                    version: version.clone(),
                    unity_yaml_merge_path: yaml_merge,
                }));
            }
        }

        // 2. Default Hub install path: /Applications/Unity/Hub/Editor/<version>/Unity.app
        let default_app: PathBuf = [
            "/Applications/Unity/Hub/Editor",
            &version,
            "Unity.app",
        ]
        .iter()
        .collect();
        if default_app.exists() {
            let yaml_merge = yaml_merge_path(&default_app);
            return Ok(Some(UnityEditorInstall {
                path: default_app.to_string_lossy().to_string(),
                version: version.clone(),
                unity_yaml_merge_path: yaml_merge,
            }));
        }

        return Ok(None);
    }

    #[cfg(target_os = "windows")]
    {
        // Hub-configured roots FIRST, then the default. Probing only the
        // default is what silently killed IntelliSense for anyone who let Unity
        // Hub install editors anywhere else — which its setup actively invites,
        // and a second drive is the common answer. macOS has had an
        // editors-v2.json fallback (`resolve_from_hub_json`) since day one;
        // Windows had none, so the failure was invisible from a Mac.
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Some(appdata) = std::env::var_os("APPDATA") {
            roots.extend(hub_roots_from_config_dir(
                &PathBuf::from(appdata).join("UnityHub"),
            ));
        }
        roots.push(PathBuf::from(r"C:\Program Files\Unity\Hub\Editor"));

        if let Some(exe) = resolve_from_hub_roots(&roots, &version) {
            let yaml_merge = yaml_merge_path(&exe);
            return Ok(Some(UnityEditorInstall {
                path: exe.to_string_lossy().to_string(),
                version: version.clone(),
                unity_yaml_merge_path: yaml_merge,
            }));
        }
        return Ok(None);
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            let exe = home
                .join("Unity")
                .join("Hub")
                .join("Editor")
                .join(&version)
                .join("Editor")
                .join("Unity");
            if exe.exists() {
                let yaml_merge = yaml_merge_path(&exe);
                return Ok(Some(UnityEditorInstall {
                    path: exe.to_string_lossy().to_string(),
                    version: version.clone(),
                    unity_yaml_merge_path: yaml_merge,
                }));
            }
        }
        return Ok(None);
    }

    #[allow(unreachable_code)]
    Ok(None)
}

// Recursive directory copy lives in `fs_copy`, shared with the explorer's
// drop-to-copy command.
use crate::fs_copy::copy_dir_recursive;

/// Locate the bundled `unity-bridge/` package source. In a packaged build it
/// lives under the Tauri resource dir; in dev it's `<crate>/../unity-bridge`.
fn bridge_source_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("unity-bridge");
        if p.join("package.json").exists() {
            return Some(p);
        }
    }
    // Dev fallback: the repo's unity-bridge/ sits next to src-tauri/.
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("unity-bridge");
    if dev.join("package.json").exists() {
        return Some(dev);
    }
    None
}

/// Install the Arcane Unity bridge package into the project's `Packages/` folder
/// as an embedded package (`Packages/com.unityide.editor/`). Unity auto-discovers
/// embedded packages — no manifest.json edit needed. Returns the install path.
#[tauri::command]
pub fn unity_install_bridge(app: AppHandle, workspace_path: String) -> Result<String, String> {
    let src = bridge_source_dir(&app)
        .ok_or_else(|| "Bridge package source not found (resource dir + dev fallback both missing)".to_string())?;
    let packages = Path::new(&workspace_path).join("Packages");
    let dest = packages.join("com.unityide.editor");
    copy_dir_recursive(&src, &dest)
        .map_err(|e| format!("Failed to copy bridge package to {}: {}", dest.display(), e))?;

    remove_legacy_bridge_package(&packages);

    Ok(dest.to_string_lossy().to_string())
}

/// The embedded package id this bridge shipped under before the rename.
const LEGACY_BRIDGE_PACKAGE: &str = "com.arcane.editor";

/// Remove the pre-rename embedded package once the new one is in place.
///
/// This is not tidiness. The C# files keep their original `.meta` GUIDs across
/// the rename — deliberately, so asmdef references by GUID survive — which
/// means leaving the old directory in place gives Unity two embedded packages
/// declaring the SAME asset GUIDs. Unity reports that as a GUID conflict and
/// picks a winner arbitrarily. On top of that both packages register an
/// `IExternalCodeEditor` and both start a `BridgeClient` against one journal.
///
/// Best-effort: install has already succeeded by this point, and failing the
/// whole command over a leftover directory would be worse than the leftover.
fn remove_legacy_bridge_package(packages_dir: &Path) {
    let legacy = packages_dir.join(LEGACY_BRIDGE_PACKAGE);
    if !legacy.is_dir() {
        return;
    }
    match fs::remove_dir_all(&legacy) {
        Ok(()) => eprintln!("[UnityIDE] removed legacy bridge package {}", legacy.display()),
        Err(e) => eprintln!(
            "[UnityIDE] could not remove legacy bridge package {} — Unity may report \
             duplicate asset GUIDs until it is deleted by hand: {e}",
            legacy.display()
        ),
    }
}

/// Scan all .meta files in a Unity project and extract GUID -> asset path mappings.
#[tauri::command]
pub fn scan_meta_files(workspace_path: String) -> Result<HashMap<String, String>, String> {
    let root = Path::new(&workspace_path);
    let assets = root.join("Assets");

    if !assets.is_dir() {
        return Ok(HashMap::new());
    }

    let skip_dirs = ["Library", "Temp", "obj", "Logs", ".git"];
    let guid_regex = regex::Regex::new(r"guid:\s*([0-9a-f]{32})").map_err(|e| e.to_string())?;

    let mut map = HashMap::new();

    for entry in WalkDir::new(&workspace_path)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                if name.starts_with('.') { return false; }
                if skip_dirs.contains(&name.as_ref()) { return false; }
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let path_str = path.to_string_lossy();
        if !path_str.ends_with(".meta") {
            continue;
        }

        if let Ok(content) = fs::read_to_string(path) {
            if let Some(cap) = guid_regex.captures(&content) {
                if let Some(guid) = cap.get(1) {
                    // Asset path is the meta file path without .meta extension
                    let asset_path = path_str[..path_str.len() - 5].to_string();
                    map.insert(guid.as_str().to_string(), asset_path);
                }
            }
        }
    }

    Ok(map)
}

/// Locate the Unity install's "scripting root" — the directory holding
/// `Managed/`, `NetStandard/` and `UnityReferenceAssemblies/`.
///
/// Unity 6 (6000.x) moved this payload from `<data root>` down to
/// `<data root>/Resources/Scripting`; earlier versions keep it at the data
/// root itself. We probe both and pick whichever actually has `Managed/`,
/// so one code path covers 2019 through 6000+ without version sniffing.
///
/// `install_path` is what `resolve_unity_editor` returns: `Unity.app` on
/// macOS, the `Unity.exe` binary elsewhere.
fn unity_scripting_root(install_path: &Path) -> Option<PathBuf> {
    // Map the install path to the data root that holds the managed payload.
    let data_root: PathBuf = if install_path.extension().map_or(false, |e| e == "app") {
        install_path.join("Contents")
    } else {
        // `<...>/Editor/Unity.exe` → `<...>/Editor/Data`
        install_path.parent()?.join("Data")
    };

    for candidate in [data_root.join("Resources").join("Scripting"), data_root] {
        if candidate.join("Managed").is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// Resolve the Unity install backing `workspace_path` via its
/// ProjectSettings/ProjectVersion.txt, then locate its scripting root.
fn workspace_scripting_root(workspace_path: &Path) -> Option<PathBuf> {
    let version = read_unity_version(&workspace_path.join("ProjectSettings"))?;
    let install = resolve_unity_editor(version).ok()??;
    unity_scripting_root(Path::new(&install.path))
}

/// Collect every reference assembly Roslyn needs straight out of the Unity
/// install: the UnityEngine/UnityEditor modules, the top-level engine and
/// editor assemblies, and the netstandard 2.1 reference + shim facades.
///
/// Returned as (assembly name, absolute dll path). The module directory is
/// walked first so its copies win over the top-level duplicates.
fn unity_install_references(scripting_root: &Path) -> Vec<(String, PathBuf)> {
    let mut refs: Vec<(String, PathBuf)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let push_dll = |path: PathBuf, refs: &mut Vec<(String, PathBuf)>, seen: &mut HashSet<String>| {
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if seen.insert(stem.to_string()) {
                refs.push((stem.to_string(), path));
            }
        }
    };

    let push_dir = |dir: PathBuf, refs: &mut Vec<(String, PathBuf)>, seen: &mut HashSet<String>| {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        // Sort for deterministic output — read_dir order is filesystem-defined.
        let mut dlls: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map_or(false, |e| e == "dll"))
            .collect();
        dlls.sort();
        for dll in dlls {
            push_dll(dll, refs, seen);
        }
    };

    let managed = scripting_root.join("Managed");
    push_dir(managed.join("UnityEngine"), &mut refs, &mut seen);
    push_dir(managed, &mut refs, &mut seen);

    let netstandard = scripting_root.join("NetStandard");
    push_dll(
        netstandard.join("ref").join("2.1.0").join("netstandard.dll"),
        &mut refs,
        &mut seen,
    );
    push_dir(
        netstandard
            .join("compat")
            .join("2.1.0")
            .join("shims")
            .join("netstandard"),
        &mut refs,
        &mut seen,
    );

    // A path we synthesised rather than read from disk may not exist.
    refs.retain(|(_, p)| p.is_file());
    refs
}

/// Search .csproj files for the Unity reference assemblies framework path.
/// Checks Assembly-CSharp-Editor.csproj first, then Assembly-CSharp.csproj.
/// Returns the directory containing the framework DLLs, if found and it exists on disk.
///
/// Falls back to the Unity install's own `UnityReferenceAssemblies` directory
/// when Unity hasn't generated its csprojs — which is the normal state when
/// Arcane is registered as Unity's external script editor, since Unity then
/// stops asking the Visual Studio/Rider packages to generate them.
fn find_unity_framework_path(workspace_path: &Path, scripting_root: Option<&Path>) -> Option<String> {
    let candidates = [
        "Assembly-CSharp-Editor.csproj",
        "Assembly-CSharp.csproj",
    ];

    if let Ok(re) = Regex::new(
        r"<HintPath>([^<]*UnityReferenceAssemblies[/\\][^<]*)[/\\][^/\\<]+\.dll</HintPath>",
    ) {
        for filename in &candidates {
            let csproj = workspace_path.join(filename);
            if let Ok(content) = fs::read_to_string(&csproj) {
                if let Some(caps) = re.captures(&content) {
                    if let Some(dir_match) = caps.get(1) {
                        let dir_path = dir_match.as_str();
                        if Path::new(dir_path).is_dir() {
                            return Some(dir_path.to_string());
                        }
                    }
                }
            }
        }
    }

    let reference_assemblies = scripting_root?.join("UnityReferenceAssemblies");
    // The api directory is version-stamped (`unity-4.8-api`); take whichever
    // `*-api` directory the install ships rather than pinning a name.
    let mut api_dirs: Vec<PathBuf> = fs::read_dir(&reference_assemblies)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map_or(false, |n| n.ends_with("-api"))
        })
        .collect();
    api_dirs.sort();
    api_dirs
        .pop()
        .map(|p| p.to_string_lossy().to_string())
}

/// Escape text for inclusion in an XML element body or attribute value.
/// Project paths routinely contain `&` (e.g. `~/Games/Rock & Roll/`), which
/// makes the generated csproj unparseable if written through verbatim.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Generate a deterministic GUID string from a project name using a simple hash.
fn deterministic_guid(name: &str) -> String {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    let hash = hasher.finish();

    // Format hash bytes into a GUID-like structure: 8-4-4-4-12
    let bytes = hash.to_le_bytes();
    format!(
        "{{{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[0] ^ 0xAB, bytes[1] ^ 0xCD,
        bytes[2] ^ 0xEF, bytes[3] ^ 0x01, bytes[4] ^ 0x23, bytes[5] ^ 0x45, bytes[6] ^ 0x67, bytes[7] ^ 0x89,
    )
}

/// Pull every `<Reference Include="X"><HintPath>Y</HintPath></Reference>`
/// pair out of a csproj file. We reuse the user's existing Unity-generated
/// csproj refs verbatim because Unity already has the correct paths for
/// UnityEngine.* modules, netstandard, mscorlib, and the `NetStandard/compat/2.1.0/shims/netstandard/`
/// facade DLLs that csharp-ls otherwise can't find.
fn extract_references(csproj_content: &str) -> Vec<(String, String)> {
    // Match across whitespace/newlines: <Reference Include="X"> ... <HintPath>Y</HintPath>
    let re = match Regex::new(
        r#"(?s)<Reference\s+Include="([^"]+)"\s*>\s*<HintPath>([^<]+)</HintPath>"#,
    ) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    re.captures_iter(csproj_content)
        .map(|c| (c[1].to_string(), c[2].to_string()))
        .collect()
}

/// Read the assembly name out of a .asmdef file. Falls back to the file stem
/// when the JSON parse fails (matches Unity's default behavior).
fn asmdef_assembly_name(path: &Path) -> Option<String> {
    let name_re = Regex::new(r#""name"\s*:\s*"([^"]+)""#).ok();
    if let (Some(re), Ok(content)) = (name_re, fs::read_to_string(path)) {
        if let Some(caps) = re.captures(&content) {
            if let Some(m) = caps.get(1) {
                return Some(m.as_str().to_string());
            }
        }
    }
    path.file_stem().and_then(|s| s.to_str()).map(String::from)
}

/// Find every assembly definition in Assets/, returning the assembly name and
/// the directory it covers. We use this to know which DLLs in
/// Library/ScriptAssemblies are produced from source we already include.
fn find_asmdef_assemblies(assets: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let skip_dirs = ["Library", "Temp", "obj", "Logs"];

    for entry in WalkDir::new(assets)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() && skip_dirs.contains(&name.as_ref()) {
                return false;
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().map_or(false, |e| e == "asmdef") {
            if let Some(name) = asmdef_assembly_name(path) {
                out.push(name);
            }
        }
    }
    out
}

/// Generate a self-contained `.unityide.csproj` at the workspace root that
/// pulls in every `.cs` file under `Assets/` plus all relevant Unity DLLs.
///
/// Why this exists: Unity's auto-generated `Assembly-CSharp.csproj` often
/// has an empty (or near-empty) `<Compile>` list because it's regenerated
/// only when Unity is open and recompiles. csharp-ls/Roslyn loads that
/// broken project, treats user files as miscellaneous, and returns no
/// hover/completion/diagnostics for symbols defined in UnityEngine. By
/// generating our own complete csproj we get full IntelliSense without
/// depending on Unity to keep its csproj fresh.
///
/// Strategy: inherit every `<Reference Include="X"><HintPath>Y</HintPath>`
/// pair from Unity's existing Assembly-CSharp.csproj and Assembly-CSharp-Editor.csproj —
/// Unity already configured the correct paths for netstandard.dll, mscorlib,
/// the System.* shims under `NetStandard/compat/2.1.0/shims/netstandard/`,
/// and every UnityEngine/UnityEditor module. We then top up with the
/// `Library/ScriptAssemblies/*.dll` outputs from package and asmdef
/// compilation, replacing the ProjectReferences Roslyn can't resolve.
fn generate_ide_csproj(workspace: &Path) -> Result<bool, String> {
    let scripting_root = workspace_scripting_root(workspace);
    generate_ide_csproj_from(workspace, scripting_root.as_deref())
}

/// Body of [`generate_ide_csproj`] with the Unity install injected rather
/// than resolved from the machine.
///
/// The split exists so the "Unity generated no csprojs" case — the one that
/// silently cost every Unity project its C# IntelliSense — can be reproduced
/// hermetically against a fixture install, with no Unity on the box.
fn generate_ide_csproj_from(
    workspace: &Path,
    scripting_root: Option<&Path>,
) -> Result<bool, String> {
    let assets = workspace.join("Assets");
    if !assets.is_dir() {
        return Ok(false);
    }

    // Inherit references from both Unity csprojs so we cover runtime
    // (UnityEngine + netstandard + shims) AND editor (UnityEditor) APIs.
    // First-write-wins on duplicates.
    let mut refs: HashMap<String, String> = HashMap::new();
    for filename in &["Assembly-CSharp.csproj", "Assembly-CSharp-Editor.csproj"] {
        if let Ok(content) = fs::read_to_string(workspace.join(filename)) {
            for (name, path) in extract_references(&content) {
                refs.entry(name).or_insert(path);
            }
        }
    }

    // Unity's csprojs are frequently absent — notably whenever Arcane is the
    // registered external script editor, because Unity then never asks the
    // Visual Studio/Rider packages to generate them. Fill the reference set
    // straight from the Unity install so IntelliSense works cold: with Unity
    // closed, on a fresh clone, before any project files have been generated.
    // Existing entries win, since Unity's own hint paths are authoritative
    // when they are available.
    if let Some(root) = scripting_root {
        for (name, path) in unity_install_references(root) {
            refs.entry(name)
                .or_insert_with(|| path.to_string_lossy().to_string());
        }
    }

    // Neither Unity's csprojs nor a resolvable Unity install: we have no
    // UnityEngine/netstandard hint paths at all, so a generated project would
    // be worse than none. Bail and let the caller surface the hint.
    if refs.is_empty() {
        return Ok(false);
    }

    // Add Library/ScriptAssemblies/*.dll for asmdef + package compiled
    // output, replacing the <ProjectReference> chain that Roslyn fails on.
    // Skip DLLs whose source we already include via Compile, otherwise
    // we get duplicate-symbol confusion.
    let mut skip_dlls: HashSet<String> = HashSet::new();
    skip_dlls.insert("Assembly-CSharp".to_string());
    skip_dlls.insert("Assembly-CSharp-Editor".to_string());
    for name in find_asmdef_assemblies(&assets) {
        skip_dlls.insert(name);
    }

    let script_assemblies = workspace.join("Library").join("ScriptAssemblies");
    if let Ok(read) = fs::read_dir(&script_assemblies) {
        for entry in read.flatten() {
            let p = entry.path();
            if p.extension().map_or(false, |e| e == "dll") {
                if let Some(name) = p.file_stem().and_then(|s| s.to_str()) {
                    if !skip_dlls.contains(name) {
                        refs.entry(name.to_string())
                            .or_insert_with(|| p.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // Editor/standalone defines follow the host OS: hardcoding the macOS pair
    // makes `#if UNITY_EDITOR_WIN` blocks vanish from IntelliSense on Windows.
    let (editor_define, standalone_define) = if cfg!(target_os = "windows") {
        ("UNITY_EDITOR_WIN", "UNITY_STANDALONE_WIN")
    } else if cfg!(target_os = "macos") {
        ("UNITY_EDITOR_OSX", "UNITY_STANDALONE_OSX")
    } else {
        ("UNITY_EDITOR_LINUX", "UNITY_STANDALONE_LINUX")
    };

    // Satisfies MSBuild's `GetReferenceAssemblyPaths` for the
    // `TargetFrameworkVersion` below. Drop it and the project fails to load at
    // all with MSB3644 ("the reference assemblies for .NETFramework,Version=
    // v4.7.1 were not found") on any machine that has only the .NET SDK.
    //
    // It must be paired with `NoStdLib=true` — see the property block below.
    let framework_path = find_unity_framework_path(workspace, scripting_root);

    // `NoStdLib` MUST stay true, and this is the single most load-bearing
    // property in the file.
    //
    // `unity_install_references` supplies a complete .NET Standard 2.1
    // reference set — `NetStandard/ref/2.1.0/netstandard.dll` plus the
    // `compat/2.1.0/shims/netstandard/` facades — so netstandard.dll is the
    // corelib. But `FrameworkPathOverride` above points at Unity's *.NET
    // Framework* reference assemblies (`unity-4.8-api`), because that is what
    // MSBuild needs to resolve `TargetFrameworkVersion`. With `NoStdLib=false`
    // MSBuild also implicitly references `mscorlib` out of that same directory,
    // and the project ends up with two corelibs defining the same types.
    //
    // The result is not a subtle warning. Roslyn cannot decide where
    // `System.Object` and `System.Void` live, and every file in the project
    // reports either:
    //
    //     CS0433: The type 'X' exists in both 'mscorlib' and 'netstandard'
    //     CS0518: Predefined type 'System.Void' is not defined or imported
    //
    // on nearly every line — IntelliSense is effectively dead project-wide,
    // even though completion and hover still answer from the explicitly
    // referenced UnityEngine assemblies and therefore *look* healthy. That gap
    // is why `verify-csharp-intellisense.mjs` now asserts on diagnostics too.
    //
    // `NoStdLib=true` keeps the framework path for MSBuild's bookkeeping while
    // leaving netstandard.dll as the one and only corelib — matching what Unity
    // itself compiles Assembly-CSharp with.
    let mut xml = String::new();
    xml.push_str(r#"<?xml version="1.0" encoding="utf-8"?>
<!-- Auto-generated by Arcane Editor for IntelliSense. Regenerated on every workspace open. -->
<Project ToolsVersion="Current" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration Condition=" '$(Configuration)' == '' ">Debug</Configuration>
    <Platform Condition=" '$(Platform)' == '' ">AnyCPU</Platform>
    <ProjectGuid>{6F2E5C4B-1A3D-4E8F-9C7A-2B5D8E1F4C6A}</ProjectGuid>
    <OutputType>Library</OutputType>
    <RootNamespace></RootNamespace>
    <AssemblyName>unityide</AssemblyName>
    <TargetFrameworkVersion>v4.7.1</TargetFrameworkVersion>
    <LangVersion>9.0</LangVersion>
    <FileAlignment>512</FileAlignment>
    <NoStdLib>true</NoStdLib>
    <OutputPath>Library/IntellisenseBin</OutputPath>
"#);
    if let Some(ref fp) = framework_path {
        xml.push_str("    <FrameworkPathOverride>");
        xml.push_str(&xml_escape(fp));
        xml.push_str("</FrameworkPathOverride>\n");
    }
    xml.push_str(&format!(
        "    <DefineConstants>UNITY_EDITOR;{};UNITY_2022_3_OR_NEWER;UNITY_2021_1_OR_NEWER;UNITY_2020_1_OR_NEWER;UNITY_2019_1_OR_NEWER;UNITY_2018_1_OR_NEWER;UNITY_2017_1_OR_NEWER;UNITY_5_3_OR_NEWER;UNITY_64;{};UNITY_STANDALONE;ENABLE_MONO;ENABLE_INPUT_SYSTEM;NETSTANDARD2_1;NET_STANDARD;NET_STANDARD_2_1;CSHARP_7_3_OR_NEWER</DefineConstants>\n",
        editor_define, standalone_define
    ));
    xml.push_str(
        r#"    <NoWarn>0169;0436;CS0436;CS0162;CS0168</NoWarn>
    <ErrorReport>none</ErrorReport>
    <WarningLevel>0</WarningLevel>
  </PropertyGroup>
  <ItemGroup>
"#,
    );

    let mut sorted: Vec<(&String, &String)> = refs.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    for (name, path) in sorted {
        xml.push_str("    <Reference Include=\"");
        xml.push_str(&xml_escape(name));
        xml.push_str("\">\n      <HintPath>");
        xml.push_str(&xml_escape(path));
        xml.push_str("</HintPath>\n      <Private>false</Private>\n    </Reference>\n");
    }

    xml.push_str("  </ItemGroup>\n  <ItemGroup>\n");
    xml.push_str("    <Compile Include=\"Assets/**/*.cs\" />\n");
    xml.push_str("  </ItemGroup>\n");
    xml.push_str("  <Import Project=\"$(MSBuildToolsPath)\\Microsoft.CSharp.targets\" />\n");
    xml.push_str("</Project>\n");

    let csproj_path = workspace.join(".unityide.csproj");
    fs::write(&csproj_path, xml)
        .map_err(|e| format!("Failed to write .unityide.csproj: {}", e))?;

    remove_legacy_project_files(workspace);

    Ok(true)
}

/// Names these files carried before the rename. Both live at the workspace
/// root — i.e. in the user's Unity project, which the rename does not touch.
const LEGACY_PROJECT_FILES: &[&str] = &[".arcane.csproj", ".arcane.sln"];

/// Delete the pre-rename project pair once the new one has been written.
///
/// Leaving them behind is not cosmetic: Unity and Rider both scan the project
/// root for a `.sln`, and a stale `.arcane.sln` points at a `.arcane.csproj`
/// that nothing regenerates any more. The user gets IntelliSense off a
/// progressively more wrong project file, with no indication which of the two
/// solutions their editor picked.
///
/// Best-effort on purpose: a failure here must not fail project generation,
/// which is the thing IntelliSense actually depends on.
fn remove_legacy_project_files(workspace: &Path) {
    for name in LEGACY_PROJECT_FILES {
        let path = workspace.join(name);
        if path.exists() {
            if let Err(e) = fs::remove_file(&path) {
                eprintln!("[UnityIDE] could not remove legacy {name}: {e}");
            }
        }
    }
}

/// Generate a `.unityide.sln` at the workspace root pointing to our
/// self-contained `.unityide.csproj`.
fn generate_solution(workspace_path: &Path) -> Result<Option<String>, String> {
    if !generate_ide_csproj(workspace_path)? {
        return Ok(None);
    }

    let solution_guid = "{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}";
    let project_name = "unityide";
    let project_guid = deterministic_guid(project_name);

    let mut sln = String::new();
    sln.push_str("Microsoft Visual Studio Solution File, Format Version 12.00\n");
    sln.push_str("# Visual Studio Version 17\n");
    sln.push_str(&format!(
        "Project(\"{}\") = \"{}\", \".unityide.csproj\", \"{}\"\n",
        solution_guid, project_name, project_guid
    ));
    sln.push_str("EndProject\n");
    sln.push_str("Global\n");
    sln.push_str("    GlobalSection(SolutionConfigurationPlatforms) = preSolution\n");
    sln.push_str("        Debug|Any CPU = Debug|Any CPU\n");
    sln.push_str("        Release|Any CPU = Release|Any CPU\n");
    sln.push_str("    EndGlobalSection\n");
    sln.push_str("    GlobalSection(ProjectConfigurationPlatforms) = postSolution\n");
    sln.push_str(&format!(
        "        {}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n",
        project_guid
    ));
    sln.push_str(&format!(
        "        {}.Debug|Any CPU.Build.0 = Debug|Any CPU\n",
        project_guid
    ));
    sln.push_str(&format!(
        "        {}.Release|Any CPU.ActiveCfg = Release|Any CPU\n",
        project_guid
    ));
    sln.push_str(&format!(
        "        {}.Release|Any CPU.Build.0 = Release|Any CPU\n",
        project_guid
    ));
    sln.push_str("    EndGlobalSection\n");
    sln.push_str("EndGlobal\n");

    let sln_path = workspace_path.join(".unityide.sln");
    fs::write(&sln_path, &sln)
        .map_err(|e| format!("Failed to write .unityide.sln: {}", e))?;

    Ok(Some(".unityide.sln".to_string()))
}

/// Set up a Unity workspace for LSP usage: generate a self-contained
/// `.unityide.csproj` and the `.unityide.sln` that points at it, if the workspace
/// is a Unity project. Returns the solution file path on success.
///
/// The generated project carries its own `FrameworkPathOverride`, so this
/// writes nothing outside the two `.unityide.*` files — earlier versions also
/// dropped a `Directory.Build.props` at the workspace root, which every other
/// csproj in the user's project silently inherited.
#[tauri::command]
pub fn unity_setup_lsp(workspace_path: String) -> Result<Option<String>, String> {
    let root = Path::new(&workspace_path);
    let assets = root.join("Assets");
    let project_settings = root.join("ProjectSettings");

    if !assets.is_dir() || !project_settings.is_dir() {
        return Ok(None);
    }

    generate_solution(root)
}

#[cfg(test)]
mod hub_discovery_tests {
    use super::*;

    /// Unity Hub prompts for an install location at setup, and a second drive
    /// is a common answer. Probing only `C:\Program Files\Unity\Hub\Editor`
    /// meant those users got no .csproj, no .sln, and silently dead C#
    /// IntelliSense — no error, nothing in the logs.
    #[test]
    fn a_hub_root_outside_the_default_is_probed() {
        let tmp = tempfile::tempdir().unwrap();
        let version = "6000.0.23f1";

        // Lay out the editor exactly as Hub does on the host we're running on.
        let editor_dir = if cfg!(target_os = "windows") {
            tmp.path().join(version).join("Editor")
        } else if cfg!(target_os = "macos") {
            tmp.path().join(version)
        } else {
            tmp.path().join(version).join("Editor")
        };
        std::fs::create_dir_all(&editor_dir).unwrap();

        let exe_name = if cfg!(target_os = "windows") {
            "Unity.exe"
        } else if cfg!(target_os = "macos") {
            "Unity.app"
        } else {
            "Unity"
        };
        let exe = editor_dir.join(exe_name);
        std::fs::write(&exe, b"").unwrap();

        let found = resolve_from_hub_roots(&[tmp.path().to_path_buf()], version);
        assert_eq!(found, Some(exe));
    }

    #[test]
    fn an_unknown_version_resolves_to_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_from_hub_roots(&[tmp.path().to_path_buf()], "1234.5.6f7"),
            None
        );
    }

    #[test]
    fn secondary_install_path_json_is_read_as_a_root() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("secondaryInstallPath.json"),
            r#""D:\\Unity\\Hub\\Editor""#,
        )
        .unwrap();

        let roots = hub_roots_from_config_dir(tmp.path());
        assert_eq!(roots.len(), 1);
        assert!(roots[0].to_string_lossy().contains("Editor"));
    }

    #[test]
    fn a_missing_or_empty_hub_config_yields_no_roots() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(hub_roots_from_config_dir(tmp.path()).is_empty());

        std::fs::write(tmp.path().join("secondaryInstallPath.json"), r#""""#).unwrap();
        assert!(hub_roots_from_config_dir(tmp.path()).is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;

    /// Serialises the smoke tests below.
    ///
    /// They operate on a real workspace on disk and both regenerate
    /// `.unityide.csproj` there, so run concurrently — which is cargo's default —
    /// one can read the file while the other is rewriting it and see a partial
    /// document. That made the suite intermittently fail with no connection to
    /// whatever change was being tested. Sharing a real file is what makes them
    /// smoke tests; taking a lock is cheaper than making them hermetic.
    static SMOKE_WORKSPACE: Mutex<()> = Mutex::new(());

    /// Create a unique temp directory with the given suffix.
    fn make_temp_dir(suffix: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!("unity_test_{}{}", std::process::id(), suffix));
        fs::create_dir_all(&base).expect("create temp dir");
        base
    }

    /// Create Assets/ + ProjectSettings/ProjectVersion.txt inside `dir`.
    fn make_unity_project(dir: &Path, version: &str) {
        let project_settings = dir.join("ProjectSettings");
        fs::create_dir_all(dir.join("Assets")).unwrap();
        fs::create_dir_all(&project_settings).unwrap();
        fs::write(
            project_settings.join("ProjectVersion.txt"),
            format!("m_EditorVersion: {}\n", version),
        )
        .unwrap();
    }

    // ─── detect_unity_project tests ────────────────────────────────────────────

    #[test]
    fn root_is_unity_project_no_nested() {
        let dir = make_temp_dir("_root_unity");
        make_unity_project(&dir, "2022.3.10f1");

        let result = detect_unity_project(dir.to_string_lossy().to_string()).unwrap();
        assert!(result.is_unity, "should detect root as Unity project");
        assert_eq!(result.unity_version.as_deref(), Some("2022.3.10f1"));
        assert!(result.nested_project_path.is_none(), "no nested path expected");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn root_not_unity_child_is() {
        let dir = make_temp_dir("_child_unity");
        // Create a non-unity root with one child that IS a Unity project.
        let child = dir.join("MyGame");
        make_unity_project(&child, "2021.3.5f1");

        let result = detect_unity_project(dir.to_string_lossy().to_string()).unwrap();
        assert!(!result.is_unity, "root should NOT be Unity");
        assert!(result.unity_version.is_none());
        let nested = result.nested_project_path.expect("should find nested project");
        assert_eq!(nested, crate::path_util::to_ui_path(&child));

        fs::remove_dir_all(&dir).ok();
    }

    // ─── ancestor detection ────────────────────────────────────────────────────

    #[test]
    fn subfolder_reports_enclosing_project_as_ancestor() {
        let dir = make_temp_dir("_ancestor_sub");
        make_unity_project(&dir, "2021.3.45f2");
        let scripts = dir.join("Assets").join("Scripts");
        fs::create_dir_all(&scripts).unwrap();

        let result = detect_unity_project(scripts.to_string_lossy().to_string()).unwrap();
        assert!(!result.is_unity, "a Scripts folder is not itself a Unity root");
        assert_eq!(
            result.ancestor_project_path,
            Some(crate::path_util::to_ui_path(&dir)),
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deeply_nested_subfolder_still_finds_the_project() {
        let dir = make_temp_dir("_ancestor_deep");
        make_unity_project(&dir, "2021.3.45f2");
        let deep = dir.join("Assets").join("A").join("B").join("C");
        fs::create_dir_all(&deep).unwrap();

        let result = detect_unity_project(deep.to_string_lossy().to_string()).unwrap();
        assert_eq!(
            result.ancestor_project_path,
            Some(crate::path_util::to_ui_path(&dir)),
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unity_root_itself_reports_no_ancestor() {
        let dir = make_temp_dir("_ancestor_root");
        make_unity_project(&dir, "2022.3.10f1");

        let result = detect_unity_project(dir.to_string_lossy().to_string()).unwrap();
        assert!(result.is_unity);
        assert!(
            result.ancestor_project_path.is_none(),
            "a Unity root needs no ancestor",
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plain_directory_reports_no_ancestor() {
        let dir = make_temp_dir("_ancestor_none");
        let plain = dir.join("just").join("files");
        fs::create_dir_all(&plain).unwrap();

        let result = detect_unity_project(plain.to_string_lossy().to_string()).unwrap();
        assert!(!result.is_unity);
        assert!(result.ancestor_project_path.is_none());
        assert!(result.nested_project_path.is_none());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ancestor_search_stops_at_the_depth_cap() {
        let dir = make_temp_dir("_ancestor_capped");
        make_unity_project(&dir, "2021.3.45f2");

        // MAX_ANCESTOR_DEPTH is 12, and the walk starts at the parent, so a
        // project 13 levels up must NOT be found.
        let mut deep = dir.clone();
        for i in 0..13 {
            deep = deep.join(format!("l{i}"));
        }
        fs::create_dir_all(&deep).unwrap();

        let result = detect_unity_project(deep.to_string_lossy().to_string()).unwrap();
        assert!(
            result.ancestor_project_path.is_none(),
            "walk must stop at the cap rather than climbing to the filesystem root",
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nearest_ancestor_wins_when_projects_are_stacked() {
        let outer = make_temp_dir("_ancestor_stacked");
        make_unity_project(&outer, "2021.3.45f2");
        let inner = outer.join("Assets").join("Inner");
        make_unity_project(&inner, "2022.3.10f1");
        let leaf = inner.join("Assets").join("Scripts");
        fs::create_dir_all(&leaf).unwrap();

        let result = detect_unity_project(leaf.to_string_lossy().to_string()).unwrap();
        assert_eq!(
            result.ancestor_project_path,
            Some(crate::path_util::to_ui_path(&inner)),
            "the closer project root must win",
        );

        fs::remove_dir_all(&outer).ok();
    }

    #[test]
    fn depth2_nesting() {
        let dir = make_temp_dir("_depth2_unity");
        // repo/games/MyGame is the Unity project.
        let games = dir.join("games");
        let my_game = games.join("MyGame");
        make_unity_project(&my_game, "2023.1.0f1");

        let result = detect_unity_project(dir.to_string_lossy().to_string()).unwrap();
        assert!(!result.is_unity);
        let nested = result.nested_project_path.expect("should find depth-2 project");
        // Compared in UI-path form, like the depth-1 tests above: detection
        // returns `to_ui_path`, which on Windows rewrites \ to /.
        assert_eq!(nested, crate::path_util::to_ui_path(&my_game));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn non_unity_folder_no_detection() {
        let dir = make_temp_dir("_non_unity");
        // Just create a plain directory with some files, no Assets/ or ProjectSettings/.
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("README.md"), "hello").unwrap();

        let result = detect_unity_project(dir.to_string_lossy().to_string()).unwrap();
        assert!(!result.is_unity, "should not detect as Unity");
        assert!(result.unity_version.is_none());
        assert!(result.nested_project_path.is_none(), "no nested project");

        fs::remove_dir_all(&dir).ok();
    }

    // ─── resolve_unity_editor tests ────────────────────────────────────────────

    #[test]
    fn nonexistent_version_returns_none() {
        let result = resolve_unity_editor("9999.9.9f99".to_string());
        assert!(result.is_ok(), "should return Ok, not Err");
        assert!(result.unwrap().is_none(), "nonexistent version should be None");
    }

    // ─── Unity-install reference discovery ─────────────────────────────────────

    /// Build a fake Unity install laid out the way the given generation does.
    /// `unity6` selects the `Contents/Resources/Scripting` layout introduced in
    /// 6000.x; otherwise the payload sits directly under the data root.
    fn make_unity_install(dir: &Path, unity6: bool) -> PathBuf {
        let app = dir.join("Unity.app");
        let data_root = app.join("Contents");
        let scripting = if unity6 {
            data_root.join("Resources").join("Scripting")
        } else {
            data_root.clone()
        };

        let modules = scripting.join("Managed").join("UnityEngine");
        fs::create_dir_all(&modules).unwrap();
        fs::write(modules.join("UnityEngine.CoreModule.dll"), b"x").unwrap();
        fs::write(modules.join("UnityEditor.CoreModule.dll"), b"x").unwrap();

        let managed = scripting.join("Managed");
        fs::write(managed.join("UnityEngine.dll"), b"x").unwrap();
        fs::write(managed.join("UnityEditor.dll"), b"x").unwrap();

        let ns_ref = scripting.join("NetStandard").join("ref").join("2.1.0");
        fs::create_dir_all(&ns_ref).unwrap();
        fs::write(ns_ref.join("netstandard.dll"), b"x").unwrap();

        let shims = scripting
            .join("NetStandard")
            .join("compat")
            .join("2.1.0")
            .join("shims")
            .join("netstandard");
        fs::create_dir_all(&shims).unwrap();
        fs::write(shims.join("System.Runtime.dll"), b"x").unwrap();

        let api = scripting
            .join("UnityReferenceAssemblies")
            .join("unity-4.8-api");
        fs::create_dir_all(&api).unwrap();

        app
    }

    #[test]
    fn scripting_root_found_for_unity6_layout() {
        let dir = make_temp_dir("_scripting_u6");
        let app = make_unity_install(&dir, true);

        let root = unity_scripting_root(&app).expect("scripting root");
        assert!(
            root.ends_with("Contents/Resources/Scripting"),
            "expected the Unity 6 layout, got {:?}",
            root
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scripting_root_found_for_legacy_layout() {
        let dir = make_temp_dir("_scripting_legacy");
        let app = make_unity_install(&dir, false);

        let root = unity_scripting_root(&app).expect("scripting root");
        assert!(
            root.ends_with("Contents"),
            "expected the pre-6000 layout, got {:?}",
            root
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scripting_root_none_without_managed_dir() {
        let dir = make_temp_dir("_scripting_none");
        let app = dir.join("Unity.app");
        fs::create_dir_all(app.join("Contents")).unwrap();

        assert!(unity_scripting_root(&app).is_none());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_references_cover_engine_editor_and_netstandard() {
        let dir = make_temp_dir("_install_refs");
        let app = make_unity_install(&dir, true);
        let root = unity_scripting_root(&app).unwrap();

        let refs = unity_install_references(&root);
        let names: Vec<&str> = refs.iter().map(|(n, _)| n.as_str()).collect();

        for expected in [
            "UnityEngine",
            "UnityEditor",
            "UnityEngine.CoreModule",
            "UnityEditor.CoreModule",
            "netstandard",
            "System.Runtime",
        ] {
            assert!(names.contains(&expected), "missing {} in {:?}", expected, names);
        }

        // Every entry must point at a file that exists — Roslyn silently drops
        // references whose HintPath is dangling, which is exactly the failure
        // mode this generator exists to avoid.
        for (name, path) in &refs {
            assert!(path.is_file(), "{} points at a missing file {:?}", name, path);
        }

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_references_dedupe_module_copies_over_toplevel() {
        let dir = make_temp_dir("_install_dedupe");
        let app = make_unity_install(&dir, true);
        let root = unity_scripting_root(&app).unwrap();

        // Same assembly name in both Managed/ and Managed/UnityEngine/.
        fs::write(
            root.join("Managed").join("UnityEngine").join("UnityEngine.dll"),
            b"x",
        )
        .unwrap();

        let refs = unity_install_references(&root);
        let engine: Vec<_> = refs.iter().filter(|(n, _)| n == "UnityEngine").collect();
        assert_eq!(engine.len(), 1, "UnityEngine must appear exactly once");
        assert!(
            engine[0].1.ends_with("Managed/UnityEngine/UnityEngine.dll"),
            "the module directory copy should win, got {:?}",
            engine[0].1
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// After the package id change, installing the bridge into a project that
    /// already had the old one would leave BOTH embedded packages in place.
    /// The C# files keep their original .meta GUIDs across the rename (on
    /// purpose — asmdef references by GUID depend on it), so two embedded
    /// packages would declare the same asset GUIDs and Unity picks a winner
    /// arbitrarily. Both would also register an IExternalCodeEditor and run a
    /// BridgeClient against the same journal.
    #[test]
    fn installing_the_bridge_removes_the_pre_rename_package() {
        let dir = make_temp_dir("_legacy_bridge_pkg");
        let packages = dir.join("Packages");
        let legacy = packages.join("com.arcane.editor").join("Editor");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("ArcaneEditor.cs"), "// stale").unwrap();
        assert!(packages.join("com.arcane.editor").is_dir());

        remove_legacy_bridge_package(&packages);

        assert!(
            !packages.join("com.arcane.editor").exists(),
            "legacy embedded package must be removed, or Unity sees duplicate asset GUIDs"
        );
    }

    /// Must be a no-op — and specifically must not fail — on the overwhelmingly
    /// common case of a project that never had the old package.
    #[test]
    fn removing_the_legacy_bridge_package_is_a_noop_when_absent() {
        let dir = make_temp_dir("_no_legacy_bridge_pkg");
        let packages = dir.join("Packages");
        fs::create_dir_all(packages.join("com.unityide.editor")).unwrap();

        remove_legacy_bridge_package(&packages);

        assert!(packages.join("com.unityide.editor").is_dir(), "must not touch the current package");
    }

    /// The rename left `.arcane.csproj` / `.arcane.sln` sitting at the root of
    /// every Unity project that had ever been opened — that directory is the
    /// USER'S project, so nothing about renaming the app removes them.
    ///
    /// They cannot simply be ignored: Unity and Rider both scan the project
    /// root for a `.sln`, and the stale one points at a csproj nothing
    /// regenerates. The user then gets IntelliSense off a progressively more
    /// wrong project file with no clue which solution their editor picked.
    #[test]
    fn generating_the_project_removes_the_pre_rename_pair() {
        let dir = make_temp_dir("_legacy_project_files");
        let workspace = dir.join("project");
        make_unity_project(&workspace, "6000.3.5f2");
        fs::write(workspace.join("Assets").join("Player.cs"), "class Player {}").unwrap();

        // The shape every pre-rename install leaves behind.
        fs::write(workspace.join(".arcane.csproj"), "<Project/>").unwrap();
        fs::write(workspace.join(".arcane.sln"), "stale").unwrap();

        let app = make_unity_install(&dir, true);
        let root = unity_scripting_root(&app).unwrap();
        assert!(generate_ide_csproj_from(&workspace, Some(root.as_path())).expect("generate ok"));

        assert!(workspace.join(".unityide.csproj").exists(), "new csproj must be written");
        assert!(
            !workspace.join(".arcane.csproj").exists(),
            "legacy csproj must be removed, or two project files describe the same workspace"
        );
        assert!(
            !workspace.join(".arcane.sln").exists(),
            "legacy sln must be removed, or Unity/Rider may open the stale solution"
        );
    }

    /// The regression test for the outage: Unity has generated **no** csproj
    /// files (the normal state when Arcane is the registered external script
    /// editor), and the generated project must still carry a complete
    /// reference set. Before the fix this produced nothing at all, csharp-ls
    /// launched with no solution, and every completion/hover returned null.
    ///
    /// Hermetic: fixture Unity install, no Unity on the machine required.
    #[test]
    fn csproj_is_complete_without_any_unity_generated_csproj() {
        let dir = make_temp_dir("_no_unity_csproj");
        let workspace = dir.join("project");
        make_unity_project(&workspace, "6000.3.5f2");
        fs::write(workspace.join("Assets").join("Player.cs"), "class Player {}").unwrap();

        let app = make_unity_install(&dir, true);
        let root = unity_scripting_root(&app).unwrap();

        // Precondition: this is the broken-environment shape.
        assert!(!workspace.join("Assembly-CSharp.csproj").exists());
        assert!(!workspace.join("Assembly-CSharp-Editor.csproj").exists());

        let generated =
            generate_ide_csproj_from(&workspace, Some(root.as_path())).expect("generate ok");
        assert!(generated, "must generate even with no Unity csproj present");

        let content = fs::read_to_string(workspace.join(".unityide.csproj")).expect("read csproj");
        for needed in [
            "Reference Include=\"UnityEngine\"",
            "Reference Include=\"UnityEditor\"",
            "Reference Include=\"UnityEngine.CoreModule\"",
            "Reference Include=\"netstandard\"",
            "<FrameworkPathOverride>",
            "<Compile Include=\"Assets/**/*.cs\"",
        ] {
            assert!(content.contains(needed), "generated csproj is missing: {}", needed);
        }

        fs::remove_dir_all(&dir).ok();
    }

    /// The generated project must declare exactly one corelib.
    ///
    /// It supplies a full .NET Standard 2.1 reference set (netstandard.dll plus
    /// the compat shims) while pointing `FrameworkPathOverride` at Unity's .NET
    /// Framework reference assemblies, which MSBuild needs to resolve
    /// `TargetFrameworkVersion`. Those two only coexist because `NoStdLib` is
    /// true; flip it to false and MSBuild implicitly adds `mscorlib` from the
    /// framework path on top of netstandard, giving every file in the project
    /// CS0433 ("exists in both 'mscorlib' and 'netstandard'") or CS0518
    /// ("Predefined type 'System.Void' is not defined") on nearly every line.
    ///
    /// This shipped broken: completion and hover kept answering from the
    /// explicitly referenced UnityEngine assemblies, so IntelliSense looked
    /// alive while diagnostics were entirely garbage.
    #[test]
    fn csproj_declares_netstandard_as_the_only_corelib() {
        let dir = make_temp_dir("_nostdlib");
        let workspace = dir.join("project");
        make_unity_project(&workspace, "6000.3.5f2");
        fs::write(workspace.join("Assets").join("Player.cs"), "class Player {}").unwrap();

        let app = make_unity_install(&dir, true);
        let root = unity_scripting_root(&app).unwrap();

        generate_ide_csproj_from(&workspace, Some(root.as_path())).expect("generate ok");
        let content = fs::read_to_string(workspace.join(".unityide.csproj")).expect("read csproj");

        assert!(
            content.contains("<NoStdLib>true</NoStdLib>"),
            "NoStdLib must be true — with the netstandard reference set AND \
             FrameworkPathOverride both present, false pulls in a second corelib \
             and every file reports CS0433/CS0518"
        );
        assert!(
            !content.contains("<NoStdLib>false</NoStdLib>"),
            "NoStdLib=false is the exact regression this test exists to catch"
        );

        // The pairing is the point: netstandard supplies the corelib, the
        // framework path only satisfies MSBuild's TargetFrameworkVersion lookup
        // (without it the project fails to load at all with MSB3644).
        assert!(
            content.contains("Reference Include=\"netstandard\""),
            "netstandard is the corelib once NoStdLib is true — it must be referenced"
        );
        assert!(
            content.contains("<FrameworkPathOverride>"),
            "FrameworkPathOverride must stay, or MSBuild fails with MSB3644"
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// With neither Unity's csprojs nor a resolvable install there is nothing
    /// to reference, and emitting a project full of dangling HintPaths would
    /// be worse than emitting none — Roslyn would load it and serve garbage.
    #[test]
    fn csproj_is_skipped_when_no_unity_install_resolves() {
        let dir = make_temp_dir("_no_install");
        let workspace = dir.join("project");
        make_unity_project(&workspace, "6000.3.5f2");

        let generated = generate_ide_csproj_from(&workspace, None).expect("generate ok");
        assert!(!generated, "must not generate a reference-less project");
        assert!(!workspace.join(".unityide.csproj").exists());

        fs::remove_dir_all(&dir).ok();
    }

    /// Unity's own hint paths win when present — they are authoritative for
    /// that exact project — while the install still fills every gap.
    #[test]
    fn unity_csproj_references_win_over_install_ones() {
        let dir = make_temp_dir("_ref_precedence");
        let workspace = dir.join("project");
        make_unity_project(&workspace, "6000.3.5f2");

        let vendored = dir.join("vendored");
        fs::create_dir_all(&vendored).unwrap();
        let vendored_engine = vendored.join("UnityEngine.dll");
        fs::write(&vendored_engine, b"x").unwrap();

        fs::write(
            workspace.join("Assembly-CSharp.csproj"),
            format!(
                r#"<Project><ItemGroup><Reference Include="UnityEngine"><HintPath>{}</HintPath></Reference></ItemGroup></Project>"#,
                vendored_engine.display()
            ),
        )
        .unwrap();

        let app = make_unity_install(&dir, true);
        let root = unity_scripting_root(&app).unwrap();
        generate_ide_csproj_from(&workspace, Some(root.as_path())).expect("generate ok");

        let content = fs::read_to_string(workspace.join(".unityide.csproj")).unwrap();
        assert!(
            content.contains(&vendored_engine.to_string_lossy().to_string()),
            "Unity's own UnityEngine hint path should have won"
        );
        // ...and the install still supplies what Unity's csproj never listed.
        assert!(content.contains("Reference Include=\"netstandard\""));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn xml_escape_handles_ampersand_paths() {
        assert_eq!(
            xml_escape("/Users/x/Rock & Roll/<a>"),
            "/Users/x/Rock &amp; Roll/&lt;a&gt;"
        );
    }

    // ─── smoke tests (skipped when real workspace absent) ──────────────────────

    /// Locate a real Unity project to smoke-test against.
    ///
    /// `ARCANE_SMOKE_UNITY_PROJECT` overrides; otherwise we try a couple of
    /// known local projects. These tests are opt-in by nature — but a hardcoded
    /// path that has since been deleted makes them *silently* vacuous, which is
    /// how a total IntelliSense outage stayed green through a full suite.
    fn smoke_workspace() -> Option<PathBuf> {
        if let Ok(p) = env::var("ARCANE_SMOKE_UNITY_PROJECT") {
            let path = PathBuf::from(p);
            return path.join("Assets").is_dir().then_some(path);
        }
        ["/Users/inno/Arcane Demo", "/Users/inno/My project"]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.join("Assets").is_dir())
    }

    #[test]
    fn smoke_generate_ide_csproj() {
        let _guard = crate::sync_util::lock_recover(&SMOKE_WORKSPACE);
        let workspace = match smoke_workspace() {
            Some(w) => w,
            None => return,
        };
        let result = generate_ide_csproj(&workspace).expect("generate ok");
        assert!(result, "csproj should have been generated");

        let content = fs::read_to_string(workspace.join(".unityide.csproj")).expect("read csproj");
        assert!(content.contains("<Compile Include=\"Assets/**/*.cs\""));
        assert!(content.contains("Reference Include=\"UnityEngine\""));
        assert!(content.contains("UnityEngine.dll</HintPath>"));
        // The whole point of the install-derived reference set: these must be
        // present even when Unity has generated no csproj of its own.
        assert!(
            content.contains("Reference Include=\"UnityEditor\""),
            "UnityEditor reference missing — editor-only APIs won't resolve"
        );
        assert!(
            content.contains("Reference Include=\"netstandard\""),
            "netstandard reference missing — the BCL won't resolve"
        );
        assert!(
            content.contains("<FrameworkPathOverride>"),
            "FrameworkPathOverride missing — mscorlib won't resolve"
        );
    }

    /// Every HintPath the generator emits must resolve on disk. Roslyn drops
    /// dangling references without complaint, so a bad path degrades silently
    /// into "no IntelliSense" rather than an error anyone would notice.
    #[test]
    fn smoke_generated_hint_paths_all_exist() {
        let _guard = crate::sync_util::lock_recover(&SMOKE_WORKSPACE);
        let workspace = match smoke_workspace() {
            Some(w) => w,
            None => return,
        };
        generate_ide_csproj(&workspace).expect("generate ok");
        let content = fs::read_to_string(workspace.join(".unityide.csproj")).expect("read csproj");

        let re = Regex::new(r"<HintPath>([^<]+)</HintPath>").unwrap();
        let mut checked = 0;
        for caps in re.captures_iter(&content) {
            let raw = caps.get(1).unwrap().as_str().replace("&amp;", "&");
            assert!(Path::new(&raw).is_file(), "dangling HintPath: {}", raw);
            checked += 1;
        }
        assert!(checked > 50, "expected a full reference set, saw {}", checked);
    }

    #[test]
    fn smoke_generate_full_setup() {
        let _guard = crate::sync_util::lock_recover(&SMOKE_WORKSPACE);
        let workspace = match smoke_workspace() {
            Some(w) => w,
            None => return,
        };
        let sln = unity_setup_lsp(workspace.to_string_lossy().to_string()).expect("setup ok");
        assert_eq!(sln.as_deref(), Some(".unityide.sln"));
        assert!(workspace.join(".unityide.sln").exists());
        assert!(workspace.join(".unityide.csproj").exists());
    }
}
