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
            return Some(dir.to_string_lossy().to_string());
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
                return Some(dir.to_string_lossy().to_string());
            }
        }
    }

    None
}

/// Detect if the given workspace is a Unity project.
/// Checks for Assets/ and ProjectSettings/ directories,
/// reads ProjectSettings/ProjectVersion.txt for the Unity version.
/// When the root is NOT a Unity project, scans depth-1 and depth-2 subdirectories
/// for a nested Unity project and returns it in `nested_project_path`.
#[tauri::command]
pub fn detect_unity_project(workspace_path: String) -> Result<UnityProjectInfo, String> {
    let root = Path::new(&workspace_path);

    if is_unity_root(root) {
        let unity_version = read_unity_version(&root.join("ProjectSettings"));
        return Ok(UnityProjectInfo {
            is_unity: true,
            unity_version,
            nested_project_path: None,
        });
    }

    // Root is not Unity — scan for nested project.
    let nested = find_nested_unity_project(root);

    Ok(UnityProjectInfo {
        is_unity: false,
        unity_version: None,
        nested_project_path: nested,
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
        let exe: PathBuf = [
            r"C:\Program Files\Unity\Hub\Editor",
            &version,
            "Editor",
            "Unity.exe",
        ]
        .iter()
        .collect();
        if exe.exists() {
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

/// Recursively copy a directory tree (creating `dst` and parents as needed).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
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
/// as an embedded package (`Packages/com.arcane.editor/`). Unity auto-discovers
/// embedded packages — no manifest.json edit needed. Returns the install path.
#[tauri::command]
pub fn unity_install_bridge(app: AppHandle, workspace_path: String) -> Result<String, String> {
    let src = bridge_source_dir(&app)
        .ok_or_else(|| "Bridge package source not found (resource dir + dev fallback both missing)".to_string())?;
    let dest = Path::new(&workspace_path)
        .join("Packages")
        .join("com.arcane.editor");
    copy_dir_recursive(&src, &dest)
        .map_err(|e| format!("Failed to copy bridge package to {}: {}", dest.display(), e))?;
    Ok(dest.to_string_lossy().to_string())
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

/// Search .csproj files for the Unity reference assemblies framework path.
/// Checks Assembly-CSharp-Editor.csproj first, then Assembly-CSharp.csproj.
/// Returns the directory containing the framework DLLs, if found and it exists on disk.
fn find_unity_framework_path(workspace_path: &Path) -> Option<String> {
    let re = Regex::new(
        r"<HintPath>([^<]*UnityReferenceAssemblies[/\\][^<]*)[/\\][^/\\<]+\.dll</HintPath>",
    )
    .ok()?;

    let candidates = [
        "Assembly-CSharp-Editor.csproj",
        "Assembly-CSharp.csproj",
    ];

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

    None
}

/// Ensure a Directory.Build.props file exists at the workspace root with the
/// Unity framework path override. Returns Ok(true) if the file was created,
/// Ok(false) if it already existed or the framework path couldn't be determined.
fn ensure_build_props(workspace_path: &Path) -> Result<bool, String> {
    let props_path = workspace_path.join("Directory.Build.props");
    if props_path.exists() {
        return Ok(false);
    }

    let framework_path = match find_unity_framework_path(workspace_path) {
        Some(p) => p,
        None => return Ok(false),
    };

    let content = format!(
        "<Project>\n  <PropertyGroup>\n    <FrameworkPathOverride>{}</FrameworkPathOverride>\n  </PropertyGroup>\n</Project>\n",
        framework_path
    );

    fs::write(&props_path, content).map_err(|e| format!("Failed to write Directory.Build.props: {}", e))?;
    Ok(true)
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

/// Generate a self-contained `.arcane.csproj` at the workspace root that
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
fn generate_arcane_csproj(workspace: &Path) -> Result<bool, String> {
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

    // Without inherited refs we have no UnityEngine/netstandard hint paths;
    // bail and let the caller surface the "open in Unity once" hint.
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
    <AssemblyName>arcane</AssemblyName>
    <TargetFrameworkVersion>v4.7.1</TargetFrameworkVersion>
    <LangVersion>9.0</LangVersion>
    <FileAlignment>512</FileAlignment>
    <NoStdLib>false</NoStdLib>
    <OutputPath>Library/IntellisenseBin</OutputPath>
    <DefineConstants>UNITY_EDITOR;UNITY_EDITOR_OSX;UNITY_2022_3_OR_NEWER;UNITY_2021_1_OR_NEWER;UNITY_2020_1_OR_NEWER;UNITY_2019_1_OR_NEWER;UNITY_2018_1_OR_NEWER;UNITY_2017_1_OR_NEWER;UNITY_5_3_OR_NEWER;UNITY_64;UNITY_STANDALONE_OSX;UNITY_STANDALONE;ENABLE_MONO;ENABLE_INPUT_SYSTEM;NETSTANDARD2_1;NET_STANDARD;NET_STANDARD_2_1;CSHARP_7_3_OR_NEWER</DefineConstants>
    <NoWarn>0169;0436;CS0436;CS0162;CS0168</NoWarn>
    <ErrorReport>none</ErrorReport>
    <WarningLevel>0</WarningLevel>
  </PropertyGroup>
  <ItemGroup>
"#);

    let mut sorted: Vec<(&String, &String)> = refs.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    for (name, path) in sorted {
        xml.push_str("    <Reference Include=\"");
        xml.push_str(name);
        xml.push_str("\">\n      <HintPath>");
        xml.push_str(path);
        xml.push_str("</HintPath>\n      <Private>false</Private>\n    </Reference>\n");
    }

    xml.push_str("  </ItemGroup>\n  <ItemGroup>\n");
    xml.push_str("    <Compile Include=\"Assets/**/*.cs\" />\n");
    xml.push_str("  </ItemGroup>\n");
    xml.push_str("  <Import Project=\"$(MSBuildToolsPath)\\Microsoft.CSharp.targets\" />\n");
    xml.push_str("</Project>\n");

    let csproj_path = workspace.join(".arcane.csproj");
    fs::write(&csproj_path, xml)
        .map_err(|e| format!("Failed to write .arcane.csproj: {}", e))?;

    Ok(true)
}

/// Generate a `.arcane.sln` at the workspace root pointing to our
/// self-contained `.arcane.csproj`.
fn generate_solution(workspace_path: &Path) -> Result<Option<String>, String> {
    if !generate_arcane_csproj(workspace_path)? {
        return Ok(None);
    }

    let solution_guid = "{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}";
    let project_name = "arcane";
    let project_guid = deterministic_guid(project_name);

    let mut sln = String::new();
    sln.push_str("Microsoft Visual Studio Solution File, Format Version 12.00\n");
    sln.push_str("# Visual Studio Version 17\n");
    sln.push_str(&format!(
        "Project(\"{}\") = \"{}\", \".arcane.csproj\", \"{}\"\n",
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

    let sln_path = workspace_path.join(".arcane.sln");
    fs::write(&sln_path, &sln)
        .map_err(|e| format!("Failed to write .arcane.sln: {}", e))?;

    Ok(Some(".arcane.sln".to_string()))
}

/// Set up a Unity workspace for LSP usage: generate Directory.Build.props,
/// a self-contained .arcane.csproj, and a .arcane.sln solution file if the
/// workspace is a Unity project. Returns the solution file path on success.
#[tauri::command]
pub fn unity_setup_lsp(workspace_path: String) -> Result<Option<String>, String> {
    let root = Path::new(&workspace_path);
    let assets = root.join("Assets");
    let project_settings = root.join("ProjectSettings");

    if !assets.is_dir() || !project_settings.is_dir() {
        return Ok(None);
    }

    ensure_build_props(root)?;
    generate_solution(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;

    /// Serialises the smoke tests below.
    ///
    /// They operate on a real workspace on disk and both regenerate
    /// `.arcane.csproj` there, so run concurrently — which is cargo's default —
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
        assert_eq!(nested, child.to_string_lossy().to_string());

        fs::remove_dir_all(&dir).ok();
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
        assert_eq!(nested, my_game.to_string_lossy().to_string());

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

    // ─── smoke tests (skipped when real workspace absent) ──────────────────────

    #[test]
    fn smoke_generate_arcane_csproj() {
        let _guard = crate::sync_util::lock_recover(&SMOKE_WORKSPACE);
        let workspace = Path::new("/Users/inno/My project");
        if !workspace.join("Assets").is_dir() {
            return;
        }
        let result = generate_arcane_csproj(workspace).expect("generate ok");
        assert!(result, "csproj should have been generated");

        let csproj_path = workspace.join(".arcane.csproj");
        let content = fs::read_to_string(&csproj_path).expect("read csproj");
        assert!(content.contains("<Compile Include=\"Assets/**/*.cs\""));
        assert!(content.contains("Reference Include=\"UnityEngine\""));
        assert!(content.contains("UnityEngine.dll</HintPath>"));
    }

    #[test]
    fn smoke_generate_full_setup() {
        let _guard = crate::sync_util::lock_recover(&SMOKE_WORKSPACE);
        let workspace_path = "/Users/inno/My project";
        if !Path::new(workspace_path).join("Assets").is_dir() {
            return;
        }
        let sln = unity_setup_lsp(workspace_path.to_string()).expect("setup ok");
        assert_eq!(sln.as_deref(), Some(".arcane.sln"));
        assert!(Path::new(workspace_path).join(".arcane.sln").exists());
        assert!(Path::new(workspace_path).join(".arcane.csproj").exists());
    }
}
