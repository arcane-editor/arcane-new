//! Assembly-definition (`.asmdef` / `.asmref`) graph for Unity projects.
//!
//! Unity compiles C# into assemblies defined by `.asmdef` files. Each file's
//! folder subtree (minus nested asmdefs) becomes one assembly. `.asmref` files
//! attach their folder to an assembly defined elsewhere. Files with no governing
//! asmdef fall into Unity's implicit predefined assemblies (`Assembly-CSharp`,
//! `Assembly-CSharp-Editor`, and the `-firstpass` variants).
//!
//! This module parses every asmdef/asmref under `Assets/` and `Packages/`,
//! resolves `GUID:<hex>` references through the meta-file GUID map, and exposes
//! `resolve_owning_assembly` implementing Unity's predefined-assembly rules.

use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use walkdir::WalkDir;

/// A single assembly definition node in the project graph.
#[derive(Debug, Serialize, Clone)]
pub struct AsmdefNode {
    /// Assembly name (e.g. `Game.Core`). Falls back to the file stem.
    pub name: String,
    /// Absolute path of the directory containing the `.asmdef`.
    pub root_folder: String,
    /// Referenced assembly names, with `GUID:` references already resolved.
    pub references: Vec<String>,
    /// `defineConstraints` array (e.g. `["UNITY_INCLUDE_TESTS"]`).
    pub define_constraints: Vec<String>,
    /// `includePlatforms` array (empty = all platforms).
    pub include_platforms: Vec<String>,
    /// `rootNamespace` if specified (Unity 2020.2+).
    pub root_namespace: Option<String>,
    /// True when the assembly only compiles for the Editor platform.
    pub is_editor_only: bool,
    /// `optionalUnityReferences` (older Unity test-assembly marker, e.g.
    /// `["TestAssemblies"]`). Newer projects use a direct nunit.framework ref.
    pub optional_unity_references: Vec<String>,
}

/// Directories never worth scanning for asmdefs.
const SKIP_DIRS: &[&str] = &["Library", "Temp", "obj", "Logs", ".git", "node_modules"];

/// Predefined-assembly top-level folder names that compile into the
/// `*-firstpass` assemblies (compiled before the rest of user code).
const FIRSTPASS_TOP_DIRS: &[&str] = &["Plugins", "Standard Assets", "Pro Standard Assets"];

fn array_of_strings(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Read the GUID out of a sibling `.meta` file (`Foo.asmdef` → `Foo.asmdef.meta`).
fn read_meta_guid(asset_path: &Path, guid_re: &Regex) -> Option<String> {
    let meta = PathBuf::from(format!("{}.meta", asset_path.to_string_lossy()));
    let content = std::fs::read_to_string(&meta).ok()?;
    guid_re
        .captures(&content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Walk `root` collecting every `.asmdef` / `.asmref` file path.
fn collect_asmdef_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return out;
    }
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                if SKIP_DIRS.contains(&name.as_ref()) {
                    return false;
                }
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path
            .extension()
            .map_or(false, |e| e == "asmdef" || e == "asmref")
        {
            out.push(path.to_path_buf());
        }
    }
    out
}

/// Build the asmdef graph for a workspace. Scans `Assets/` and `Packages/`.
pub fn build_graph(workspace: &Path) -> Vec<AsmdefNode> {
    let guid_re = match Regex::new(r"guid:\s*([0-9a-f]{32})") {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut files = collect_asmdef_files(&workspace.join("Assets"));
    files.extend(collect_asmdef_files(&workspace.join("Packages")));

    // First pass: map each asmdef's own meta-GUID → assembly name, so
    // `GUID:<hex>` references in other asmdefs can be resolved to names.
    let mut guid_to_name: HashMap<String, String> = HashMap::new();
    for path in &files {
        if path.extension().map_or(false, |e| e == "asmdef") {
            if let Some(name) = asmdef_name(path) {
                if let Some(guid) = read_meta_guid(path, &guid_re) {
                    guid_to_name.insert(guid, name);
                }
            }
        }
    }

    let resolve_ref = |raw: &str| -> String {
        if let Some(hex) = raw.strip_prefix("GUID:") {
            guid_to_name
                .get(hex)
                .cloned()
                .unwrap_or_else(|| raw.to_string())
        } else {
            raw.to_string()
        }
    };

    let mut nodes = Vec::new();
    for path in &files {
        // Only `.asmdef` files create assemblies; `.asmref` extends an existing
        // one (handled by resolve_owning_assembly's nearest-ancestor walk).
        if !path.extension().map_or(false, |e| e == "asmdef") {
            continue;
        }
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let json: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::Value::Null);

        let name = json
            .get("name")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| path.file_stem().and_then(|s| s.to_str()).map(String::from))
            .unwrap_or_default();

        let references = array_of_strings(json.get("references"))
            .iter()
            .map(|r| resolve_ref(r))
            .collect();

        let include_platforms = array_of_strings(json.get("includePlatforms"));
        let is_editor_only =
            include_platforms.len() == 1 && include_platforms[0] == "Editor";

        nodes.push(AsmdefNode {
            name,
            root_folder: path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            references,
            define_constraints: array_of_strings(json.get("defineConstraints")),
            include_platforms,
            root_namespace: json
                .get("rootNamespace")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
            is_editor_only,
            optional_unity_references: array_of_strings(json.get("optionalUnityReferences")),
        });
    }
    nodes
}

/// Read the `name` field of an asmdef, falling back to the file stem.
fn asmdef_name(path: &Path) -> Option<String> {
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(name) = json.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        }
    }
    path.file_stem().and_then(|s| s.to_str()).map(String::from)
}

/// Read the `reference` field of an `.asmref` (single name or `GUID:` ref).
fn asmref_reference(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("reference")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Resolve the assembly that owns `file_path` using Unity's rules:
///   1. Nearest ancestor directory containing a `.asmdef` (or `.asmref`).
///   2. Otherwise the predefined assemblies based on `Editor/` and firstpass folders.
pub fn resolve_owning_assembly(workspace: &Path, file_path: &Path) -> String {
    let guid_re = Regex::new(r"guid:\s*([0-9a-f]{32})").ok();

    // Walk up from the file's directory toward the workspace root.
    let start = file_path.parent().unwrap_or(file_path);
    let mut dir = Some(start);
    while let Some(current) = dir {
        // Look for an asmdef or asmref directly in this directory.
        if let Ok(read) = std::fs::read_dir(current) {
            let mut asmdef_here: Option<PathBuf> = None;
            let mut asmref_here: Option<PathBuf> = None;
            for entry in read.flatten() {
                let p = entry.path();
                match p.extension().and_then(|e| e.to_str()) {
                    Some("asmdef") => asmdef_here = Some(p),
                    Some("asmref") => asmref_here = Some(p),
                    _ => {}
                }
            }
            if let Some(p) = asmdef_here {
                if let Some(name) = asmdef_name(&p) {
                    return name;
                }
            }
            if let Some(p) = asmref_here {
                if let Some(raw) = asmref_reference(&p) {
                    // .asmref references the target by name or GUID.
                    if let Some(hex) = raw.strip_prefix("GUID:") {
                        if let Some(re) = &guid_re {
                            if let Some(name) = name_for_guid(workspace, hex, re) {
                                return name;
                            }
                        }
                        return raw;
                    }
                    return raw;
                }
            }
        }

        if current == workspace {
            break;
        }
        dir = current.parent();
    }

    // No governing asmdef — fall into predefined assemblies.
    predefined_assembly(workspace, file_path)
}

/// Find the assembly name whose asmdef has the given meta GUID.
fn name_for_guid(workspace: &Path, hex: &str, guid_re: &Regex) -> Option<String> {
    let mut files = collect_asmdef_files(&workspace.join("Assets"));
    files.extend(collect_asmdef_files(&workspace.join("Packages")));
    for path in files {
        if path.extension().map_or(false, |e| e == "asmdef") {
            if let Some(g) = read_meta_guid(&path, guid_re) {
                if g == hex {
                    return asmdef_name(&path);
                }
            }
        }
    }
    None
}

/// Compute the predefined assembly for a file with no governing asmdef.
fn predefined_assembly(workspace: &Path, file_path: &Path) -> String {
    // Path segments relative to Assets/ (only meaningful under Assets).
    let assets = workspace.join("Assets");
    let rel = file_path.strip_prefix(&assets).ok();

    let segments: Vec<String> = rel
        .map(|r| {
            r.components()
                .filter_map(|c| c.as_os_str().to_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Editor: any path segment named "Editor" (case-insensitive).
    let is_editor = segments
        .iter()
        .any(|s| s.eq_ignore_ascii_case("Editor"));

    // Firstpass: the top-level folder under Assets is a special folder.
    let is_firstpass = segments
        .first()
        .map(|first| FIRSTPASS_TOP_DIRS.iter().any(|d| d == first))
        .unwrap_or(false);

    match (is_editor, is_firstpass) {
        (true, true) => "Assembly-CSharp-Editor-firstpass".to_string(),
        (true, false) => "Assembly-CSharp-Editor".to_string(),
        (false, true) => "Assembly-CSharp-firstpass".to_string(),
        (false, false) => "Assembly-CSharp".to_string(),
    }
}

// ── Cached graph (last-built, keyed by workspace) ───────────────────────────

struct GraphCache {
    workspace: String,
    nodes: Vec<AsmdefNode>,
}

fn graph_cache() -> &'static Mutex<Option<GraphCache>> {
    static CACHE: OnceLock<Mutex<Option<GraphCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn asmdef_build_graph(workspace_path: String) -> Result<Vec<AsmdefNode>, String> {
    let nodes = build_graph(Path::new(&workspace_path));
    if let Ok(mut cache) = graph_cache().lock() {
        *cache = Some(GraphCache {
            workspace: workspace_path,
            nodes: nodes.clone(),
        });
    }
    Ok(nodes)
}

#[tauri::command]
pub fn asmdef_graph_get(workspace_path: String) -> Result<Vec<AsmdefNode>, String> {
    if let Ok(cache) = graph_cache().lock() {
        if let Some(c) = cache.as_ref() {
            if c.workspace == workspace_path {
                return Ok(c.nodes.clone());
            }
        }
    }
    // Cache miss — build fresh (and populate the cache).
    asmdef_build_graph(workspace_path)
}

#[tauri::command]
pub fn asmdef_owning_assembly(
    workspace_path: String,
    file_path: String,
) -> Result<String, String> {
    Ok(resolve_owning_assembly(
        Path::new(&workspace_path),
        Path::new(&file_path),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn temp_dir(suffix: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!("asmdef_test_{}_{}", std::process::id(), suffix));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn owning_assembly_from_asmdef() {
        let ws = temp_dir("asmdef_owned");
        let core = ws.join("Assets/Game/Core");
        write(&core.join("Game.Core.asmdef"), r#"{"name":"Game.Core"}"#);
        let file = core.join("Player.cs");
        write(&file, "class Player {}");

        assert_eq!(
            resolve_owning_assembly(&ws, &file),
            "Game.Core"
        );
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn owning_assembly_editor_folder() {
        let ws = temp_dir("asmdef_editor");
        let file = ws.join("Assets/Scripts/Editor/MyInspector.cs");
        write(&file, "class MyInspector {}");

        assert_eq!(
            resolve_owning_assembly(&ws, &file),
            "Assembly-CSharp-Editor"
        );
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn owning_assembly_plugins_firstpass() {
        let ws = temp_dir("asmdef_firstpass");
        let file = ws.join("Assets/Plugins/Vendor/Lib.cs");
        write(&file, "class Lib {}");

        assert_eq!(
            resolve_owning_assembly(&ws, &file),
            "Assembly-CSharp-firstpass"
        );
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn owning_assembly_editor_in_plugins_firstpass() {
        let ws = temp_dir("asmdef_editor_firstpass");
        let file = ws.join("Assets/Plugins/Vendor/Editor/Tool.cs");
        write(&file, "class Tool {}");

        assert_eq!(
            resolve_owning_assembly(&ws, &file),
            "Assembly-CSharp-Editor-firstpass"
        );
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn owning_assembly_default() {
        let ws = temp_dir("asmdef_default");
        let file = ws.join("Assets/Scripts/Gameplay/Enemy.cs");
        write(&file, "class Enemy {}");

        assert_eq!(resolve_owning_assembly(&ws, &file), "Assembly-CSharp");
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn nearest_asmdef_wins_over_ancestor() {
        let ws = temp_dir("asmdef_nearest");
        write(
            &ws.join("Assets/Game/Game.asmdef"),
            r#"{"name":"Game"}"#,
        );
        let sub = ws.join("Assets/Game/Combat");
        write(&sub.join("Game.Combat.asmdef"), r#"{"name":"Game.Combat"}"#);
        let file = sub.join("Sword.cs");
        write(&file, "class Sword {}");

        assert_eq!(resolve_owning_assembly(&ws, &file), "Game.Combat");
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn graph_resolves_guid_reference() {
        let ws = temp_dir("asmdef_guid_ref");
        // Assembly B with a known meta GUID.
        write(&ws.join("Assets/B/B.asmdef"), r#"{"name":"B.Runtime"}"#);
        write(
            &ws.join("Assets/B/B.asmdef.meta"),
            "fileFormatVersion: 2\nguid: 1111111111111111aaaaaaaaaaaaaaaa\n",
        );
        // Assembly A references B by GUID.
        write(
            &ws.join("Assets/A/A.asmdef"),
            r#"{"name":"A.Runtime","references":["GUID:1111111111111111aaaaaaaaaaaaaaaa"]}"#,
        );

        let graph = build_graph(&ws);
        let a = graph
            .iter()
            .find(|n| n.name == "A.Runtime")
            .expect("A in graph");
        assert_eq!(a.references, vec!["B.Runtime".to_string()]);
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn graph_marks_editor_only() {
        let ws = temp_dir("asmdef_editor_only");
        write(
            &ws.join("Assets/Tools/Tools.asmdef"),
            r#"{"name":"Tools","includePlatforms":["Editor"]}"#,
        );
        let graph = build_graph(&ws);
        let node = graph.iter().find(|n| n.name == "Tools").unwrap();
        assert!(node.is_editor_only);
        fs::remove_dir_all(&ws).ok();
    }
}
