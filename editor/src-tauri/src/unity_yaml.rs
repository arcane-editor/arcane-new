//! Lenient parser for Unity's YAML-ish scene / prefab / asset format.
//!
//! Unity serialises scenes, prefabs and `.asset` files as multi-document YAML
//! with non-standard headers: each document begins with
//! `--- !u!<classId> &<fileId>` (optionally followed by ` stripped`). The
//! `!u!<n>` local tag chokes vanilla YAML parsers, so we deliberately avoid a
//! real YAML library and instead scan lines with a handful of regexes.
//!
//! References between objects appear as `{fileID: 123}` (same file) or
//! `{fileID: 123, guid: <32hex>, type: 2}` (cross-asset). A MonoBehaviour
//! (classId 114) carries `m_Script: {fileID: 11500000, guid: <hex>, type: 3}`
//! identifying the backing C# script asset.
//!
//! The parser must NEVER panic on malformed input — every fallible step returns
//! a partial result and parsing continues.

use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::OnceLock;

// ── Class-ID → type-name table ──────────────────────────────────────────────

/// Map a Unity class id (the `!u!<n>` number) to a human-readable type name.
/// Unknown ids fall back to `Unknown(<id>)`.
pub fn class_name(class_id: &str) -> String {
    let name = match class_id {
        "1" => "GameObject",
        "2" => "Component",
        "4" => "Transform",
        "20" => "Camera",
        "23" => "MeshRenderer",
        "33" => "MeshFilter",
        "50" => "Rigidbody2D",
        "54" => "Rigidbody",
        "58" => "CircleCollider2D",
        "61" => "BoxCollider2D",
        "65" => "BoxCollider",
        "82" => "AudioSource",
        "95" => "Animator",
        "108" => "Light",
        "114" => "MonoBehaviour",
        "120" => "LineRenderer",
        "136" => "CapsuleCollider",
        "199" => "ParticleSystem",
        "212" => "SpriteRenderer",
        "222" => "Canvas",
        "223" => "CanvasGroup",
        "224" => "RectTransform",
        "225" => "CanvasRenderer",
        "226" => "Text",
        _ => return format!("Unknown({})", class_id),
    };
    name.to_string()
}

// ── Serializable model ──────────────────────────────────────────────────────

/// One YAML document inside a Unity asset file.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnityYamlDocument {
    /// The `!u!<n>` class id, as a string (e.g. "1", "114").
    pub class_id: String,
    /// The `&<n>` anchor / fileID identifying this document within the file.
    pub file_id: String,
    /// Human-readable type name resolved from `class_id`.
    pub type_name: String,
    /// For MonoBehaviours (classId 114): the `m_Script` guid, if present.
    pub script_guid: Option<String>,
    /// Top-level simple `key: value` scalar pairs (m_Name, m_TagString, …).
    pub properties: Vec<(String, String)>,
    /// For GameObjects: the referenced component fileIDs (`- component: {fileID}`).
    pub component_file_ids: Vec<String>,
    /// For components: their owning GameObject (`m_GameObject: {fileID}`).
    pub game_object_file_id: Option<String>,
    /// For Transforms: their parent transform (`m_Father: {fileID}`).
    pub father_file_id: Option<String>,
}

/// A component reference attached to a scene GameObject.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneComponentRef {
    pub file_id: String,
    pub class_id: String,
    pub type_name: String,
    pub script_guid: Option<String>,
}

/// A GameObject node in the reconstructed scene hierarchy.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneGameObject {
    pub file_id: String,
    pub name: String,
    pub tag: String,
    pub layer: i64,
    pub is_active: bool,
    pub components: Vec<SceneComponentRef>,
    pub children: Vec<SceneGameObject>,
}

/// Full parse result for a Unity asset file.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnityAssetModel {
    pub documents: Vec<UnityYamlDocument>,
    /// Root GameObjects (those whose transform has no parent). Children nest.
    pub game_objects: Vec<SceneGameObject>,
}

// ── Regex cache ─────────────────────────────────────────────────────────────

struct Regexes {
    /// Document separator: `--- !u!<classId> &<fileId>` (optionally ` stripped`).
    separator: Regex,
    /// `m_Script: { ... guid: <hex> ... }`.
    script_guid: Regex,
    /// `- component: {fileID: N}`.
    component: Regex,
    /// `m_GameObject: {fileID: N}`.
    game_object: Regex,
    /// `m_Father: {fileID: N}`.
    father: Regex,
    /// Any `guid: <32hex>` reference anywhere in a file.
    any_guid: Regex,
    /// A top-level `key: value` scalar pair (two-space indent or none).
    simple_field: Regex,
}

fn regexes() -> &'static Regexes {
    static RE: OnceLock<Regexes> = OnceLock::new();
    RE.get_or_init(|| Regexes {
        // The `(?m)` flag makes `^` match at every line start. The trailing
        // ` stripped` marker (prefab variants) is tolerated but not captured.
        separator: Regex::new(r"(?m)^--- !u!(\d+) &(\d+)(?: stripped)?\s*$")
            .expect("separator regex"),
        script_guid: Regex::new(r"m_Script:\s*\{[^}]*guid:\s*([0-9a-f]{32})")
            .expect("script_guid regex"),
        component: Regex::new(r"-\s*component:\s*\{fileID:\s*(\d+)\}")
            .expect("component regex"),
        game_object: Regex::new(r"m_GameObject:\s*\{fileID:\s*(\d+)\}")
            .expect("game_object regex"),
        father: Regex::new(r"m_Father:\s*\{fileID:\s*(-?\d+)\}").expect("father regex"),
        any_guid: Regex::new(r"guid:\s*([0-9a-f]{32})").expect("any_guid regex"),
        // Top-level scalar: 0–2 leading spaces, an identifier key, then a value
        // that is NOT an inline map/list (skip `{...}` and `- ...` blocks).
        simple_field: Regex::new(r"^ {0,2}([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$")
            .expect("simple_field regex"),
    })
}

// ── Document splitting ──────────────────────────────────────────────────────

struct RawDoc<'a> {
    class_id: String,
    file_id: String,
    content: &'a str,
}

/// Split a Unity asset into its constituent documents. Content for a document
/// runs from just after its header line to the start of the next header (or
/// EOF). Mirrors the TS `splitDocuments` algorithm.
fn split_documents(content: &str) -> Vec<RawDoc<'_>> {
    let re = &regexes().separator;
    let mut headers: Vec<(String, String, usize, usize)> = Vec::new();
    for caps in re.captures_iter(content) {
        // capture 0 spans the whole header line.
        let whole = match caps.get(0) {
            Some(m) => m,
            None => continue,
        };
        let class_id = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let file_id = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
        headers.push((class_id, file_id, whole.start(), whole.end()));
    }

    let mut docs = Vec::with_capacity(headers.len());
    for i in 0..headers.len() {
        let (class_id, file_id, _start, body_start) = &headers[i];
        let body_end = headers
            .get(i + 1)
            .map(|(_, _, next_start, _)| *next_start)
            .unwrap_or(content.len());
        // body_start points at the header-line end (the `\n` is just after the
        // regex match because `$` matched end-of-line). slice from there.
        let body = content.get(*body_start..body_end).unwrap_or("");
        docs.push(RawDoc {
            class_id: class_id.clone(),
            file_id: file_id.clone(),
            content: body,
        });
    }
    docs
}

/// Pull the first capture-group-1 match for `re` out of `content`.
fn first_capture(re: &Regex, content: &str) -> Option<String> {
    re.captures(content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

// ── Per-document parsing ────────────────────────────────────────────────────

fn parse_document(raw: &RawDoc<'_>) -> UnityYamlDocument {
    let res = regexes();
    let class_id = raw.class_id.clone();
    let type_name = class_name(&class_id);

    let script_guid = if class_id == "114" {
        first_capture(&res.script_guid, raw.content)
    } else {
        None
    };

    let component_file_ids: Vec<String> = if class_id == "1" {
        res.component
            .captures_iter(raw.content)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
            .collect()
    } else {
        Vec::new()
    };

    // Components carry m_GameObject; only meaningful for non-GameObject docs.
    let game_object_file_id = if class_id != "1" {
        first_capture(&res.game_object, raw.content)
    } else {
        None
    };

    // Transforms (4 / 224) carry m_Father; a fileID of 0 means "no parent".
    let father_file_id = if class_id == "4" || class_id == "224" {
        first_capture(&res.father, raw.content).filter(|f| f != "0")
    } else {
        None
    };

    let properties = collect_simple_properties(raw.content, &res.simple_field);

    UnityYamlDocument {
        class_id,
        file_id: raw.file_id.clone(),
        type_name,
        script_guid,
        properties,
        component_file_ids,
        game_object_file_id,
        father_file_id,
    }
}

/// Collect top-level scalar `key: value` pairs, skipping inline maps/lists and
/// fileID references. Keeps the doc model small and frontend-friendly.
fn collect_simple_properties(content: &str, simple_field: &Regex) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in content.lines() {
        let caps = match simple_field.captures(line) {
            Some(c) => c,
            None => continue,
        };
        let key = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let value = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        if key.is_empty() {
            continue;
        }
        // Skip nested maps / fileID refs / empty list markers — we only want
        // plain scalars (m_Name, m_TagString, m_Layer, m_IsActive, …).
        if value.starts_with('{') || value.starts_with('[') || value.starts_with('-') {
            continue;
        }
        if value.contains("fileID") {
            continue;
        }
        out.push((key.to_string(), value.to_string()));
        // Cap to keep payloads bounded for pathological files.
        if out.len() >= 64 {
            break;
        }
    }
    out
}

// ── Hierarchy reconstruction ────────────────────────────────────────────────

fn build_hierarchy(docs: &[UnityYamlDocument]) -> Vec<SceneGameObject> {
    // Index every document by fileId for component resolution.
    let doc_by_file: HashMap<&str, &UnityYamlDocument> =
        docs.iter().map(|d| (d.file_id.as_str(), d)).collect();

    // Build flat GameObjects (classId 1) with their resolved components.
    let mut game_objects: HashMap<String, SceneGameObject> = HashMap::new();
    for doc in docs.iter().filter(|d| d.class_id == "1") {
        let name = doc
            .properties
            .iter()
            .find(|(k, _)| k == "m_Name")
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| "Unnamed".to_string());
        let tag = doc
            .properties
            .iter()
            .find(|(k, _)| k == "m_TagString")
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| "Untagged".to_string());
        let layer = doc
            .properties
            .iter()
            .find(|(k, _)| k == "m_Layer")
            .and_then(|(_, v)| v.parse::<i64>().ok())
            .unwrap_or(0);
        // m_IsActive: 1 = active, 0 = inactive (absent → active).
        let is_active = doc
            .properties
            .iter()
            .find(|(k, _)| k == "m_IsActive")
            .map(|(_, v)| v != "0")
            .unwrap_or(true);

        let components: Vec<SceneComponentRef> = doc
            .component_file_ids
            .iter()
            .filter_map(|cid| doc_by_file.get(cid.as_str()))
            .map(|c| SceneComponentRef {
                file_id: c.file_id.clone(),
                class_id: c.class_id.clone(),
                type_name: c.type_name.clone(),
                script_guid: c.script_guid.clone(),
            })
            .collect();

        game_objects.insert(
            doc.file_id.clone(),
            SceneGameObject {
                file_id: doc.file_id.clone(),
                name,
                tag,
                layer,
                is_active,
                components,
                children: Vec::new(),
            },
        );
    }

    // Map transforms ↔ gameObjects and child→parent via m_Father.
    let mut transform_to_go: HashMap<String, String> = HashMap::new();
    let mut go_to_transform: HashMap<String, String> = HashMap::new();
    let mut parent_of: HashMap<String, String> = HashMap::new(); // transform → parent transform

    for doc in docs.iter().filter(|d| d.class_id == "4" || d.class_id == "224") {
        if let Some(go) = &doc.game_object_file_id {
            transform_to_go.insert(doc.file_id.clone(), go.clone());
            go_to_transform.insert(go.clone(), doc.file_id.clone());
        }
        if let Some(father) = &doc.father_file_id {
            parent_of.insert(doc.file_id.clone(), father.clone());
        }
    }

    // Determine which GameObjects are roots (transform has no parent). Order is
    // taken from document order for determinism.
    let mut child_go_ids: Vec<String> = Vec::new(); // every non-root GO id
    // parent GO id → ordered child GO ids
    let mut children_of: HashMap<String, Vec<String>> = HashMap::new();
    for (transform_id, parent_transform_id) in &parent_of {
        let child_go = transform_to_go.get(transform_id);
        let parent_go = transform_to_go.get(parent_transform_id);
        if let (Some(child_go), Some(parent_go)) = (child_go, parent_go) {
            children_of
                .entry(parent_go.clone())
                .or_default()
                .push(child_go.clone());
            child_go_ids.push(child_go.clone());
        }
    }

    // Recursively assemble. We clone GameObject shells out of the map and nest
    // children; cycle-guard via a visited set so malformed self/loop parents
    // can't recurse forever.
    fn assemble(
        go_id: &str,
        game_objects: &HashMap<String, SceneGameObject>,
        children_of: &HashMap<String, Vec<String>>,
        visited: &mut std::collections::HashSet<String>,
    ) -> Option<SceneGameObject> {
        if !visited.insert(go_id.to_string()) {
            return None; // cycle — bail
        }
        let base = game_objects.get(go_id)?;
        let mut node = SceneGameObject {
            file_id: base.file_id.clone(),
            name: base.name.clone(),
            tag: base.tag.clone(),
            layer: base.layer,
            is_active: base.is_active,
            components: base.components.clone(),
            children: Vec::new(),
        };
        if let Some(kids) = children_of.get(go_id) {
            for kid in kids {
                if let Some(child) = assemble(kid, game_objects, children_of, visited) {
                    node.children.push(child);
                }
            }
        }
        Some(node)
    }

    let child_set: std::collections::HashSet<&str> =
        child_go_ids.iter().map(|s| s.as_str()).collect();

    let mut roots = Vec::new();
    let mut visited = std::collections::HashSet::new();
    // Iterate documents in order so the root list is deterministic.
    for doc in docs.iter().filter(|d| d.class_id == "1") {
        let go_id = doc.file_id.as_str();
        if child_set.contains(go_id) {
            continue; // it's somebody's child
        }
        if let Some(node) = assemble(go_id, &game_objects, &children_of, &mut visited) {
            roots.push(node);
        }
    }

    roots
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Parse a Unity asset's text into a structured model. Never panics — malformed
/// input yields whatever partial model could be recovered (possibly empty).
pub fn parse_asset(content: &str) -> UnityAssetModel {
    let raw_docs = split_documents(content);
    let documents: Vec<UnityYamlDocument> = raw_docs.iter().map(parse_document).collect();
    let game_objects = build_hierarchy(&documents);
    UnityAssetModel {
        documents,
        game_objects,
    }
}

/// Return every distinct 32-hex `guid:` reference found anywhere in `content`.
/// Used to populate the reverse-reference index. Order is first-seen.
pub fn extract_guid_refs(content: &str) -> Vec<String> {
    let re = &regexes().any_guid;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for caps in re.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            let g = m.as_str().to_string();
            if seen.insert(g.clone()) {
                out.push(g);
            }
        }
    }
    out
}

// ── Tauri command ─────────────────────────────────────────────────────────--

#[tauri::command]
pub fn unity_parse_asset(path: String) -> Result<UnityAssetModel, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(parse_asset(&content))
}

// ── Tests ─────────────────────────────────────────────────────────────────--

#[cfg(test)]
mod tests {
    use super::*;

    // A 2-GameObject scene: "Parent" with a child "Child" via Transform m_Father.
    const TWO_GO_SCENE: &str = r#"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: Parent
  m_TagString: Player
  m_Layer: 5
  m_IsActive: 1
  m_Component:
  - component: {fileID: 400}
  - component: {fileID: 2000}
--- !u!4 &400
Transform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
  m_Children:
  - {fileID: 401}
--- !u!23 &2000
MeshRenderer:
  m_GameObject: {fileID: 100}
--- !u!1 &200
GameObject:
  m_Name: Child
  m_TagString: Untagged
  m_Layer: 0
  m_IsActive: 1
  m_Component:
  - component: {fileID: 401}
--- !u!4 &401
Transform:
  m_GameObject: {fileID: 200}
  m_Father: {fileID: 400}
"#;

    #[test]
    fn parses_two_gameobject_hierarchy() {
        let model = parse_asset(TWO_GO_SCENE);
        // Five documents total.
        assert_eq!(model.documents.len(), 5);

        // One root (Parent); Child nests under it.
        assert_eq!(model.game_objects.len(), 1);
        let parent = &model.game_objects[0];
        assert_eq!(parent.name, "Parent");
        assert_eq!(parent.tag, "Player");
        assert_eq!(parent.layer, 5);
        assert!(parent.is_active);

        assert_eq!(parent.children.len(), 1);
        assert_eq!(parent.children[0].name, "Child");

        // Component type names resolved on the parent.
        let type_names: Vec<&str> =
            parent.components.iter().map(|c| c.type_name.as_str()).collect();
        assert!(type_names.contains(&"Transform"));
        assert!(type_names.contains(&"MeshRenderer"));
    }

    // A prefab whose root has a MonoBehaviour with an m_Script guid.
    const PREFAB_WITH_MONO: &str = r#"--- !u!1 &1000
GameObject:
  m_Name: Enemy
  m_Component:
  - component: {fileID: 1400}
  - component: {fileID: 1114}
--- !u!4 &1400
Transform:
  m_GameObject: {fileID: 1000}
  m_Father: {fileID: 0}
--- !u!114 &1114
MonoBehaviour:
  m_GameObject: {fileID: 1000}
  m_Script: {fileID: 11500000, guid: abcdef0123456789abcdef0123456789, type: 3}
  speed: 5
"#;

    #[test]
    fn extracts_monobehaviour_script_guid() {
        let model = parse_asset(PREFAB_WITH_MONO);
        let mono = model
            .documents
            .iter()
            .find(|d| d.class_id == "114")
            .expect("MonoBehaviour doc present");
        assert_eq!(
            mono.script_guid.as_deref(),
            Some("abcdef0123456789abcdef0123456789")
        );
        assert_eq!(mono.type_name, "MonoBehaviour");

        // The component ref on the GameObject should also carry the guid.
        let root = &model.game_objects[0];
        let mono_ref = root
            .components
            .iter()
            .find(|c| c.class_id == "114")
            .expect("mono component ref");
        assert_eq!(
            mono_ref.script_guid.as_deref(),
            Some("abcdef0123456789abcdef0123456789")
        );
    }

    // A .mat-like file referencing several guids (shader + textures).
    const MAT_WITH_GUIDS: &str = r#"--- !u!21 &2100000
Material:
  m_Name: PlayerMaterial
  m_Shader: {fileID: 4800000, guid: 11111111111111111111111111111111, type: 3}
  m_SavedProperties:
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: 22222222222222222222222222222222, type: 3}
    - _BumpMap:
        m_Texture: {fileID: 2800000, guid: 33333333333333333333333333333333, type: 3}
    - _Dup:
        m_Texture: {fileID: 2800000, guid: 11111111111111111111111111111111, type: 3}
"#;

    #[test]
    fn extract_guid_refs_finds_all_distinct() {
        let guids = extract_guid_refs(MAT_WITH_GUIDS);
        assert_eq!(guids.len(), 3, "should dedup the repeated shader guid");
        assert!(guids.contains(&"11111111111111111111111111111111".to_string()));
        assert!(guids.contains(&"22222222222222222222222222222222".to_string()));
        assert!(guids.contains(&"33333333333333333333333333333333".to_string()));
    }

    #[test]
    fn garbage_input_does_not_panic() {
        for junk in [
            "",
            "not yaml at all",
            "--- !u! garbage no anchor",
            "--- !u!1\nmissing anchor",
            "{{{{{{{",
            "--- !u!1 &1\nm_Name: \u{fffd}\n--- !u!4 &",
            "\0\0\0",
        ] {
            let model = parse_asset(junk);
            // No assertion on contents — just must not panic. Most yield empty.
            let _ = model.documents.len();
            let _ = extract_guid_refs(junk);
        }
        // Truly empty model for empty input.
        assert_eq!(parse_asset(""), UnityAssetModel::default());
    }

    #[test]
    fn handles_stripped_marker() {
        let scene = "--- !u!1 &500 stripped\nGameObject:\n  m_Name: Stripped\n";
        let model = parse_asset(scene);
        assert_eq!(model.documents.len(), 1);
        assert_eq!(model.documents[0].file_id, "500");
        assert_eq!(model.documents[0].class_id, "1");
    }

    #[test]
    fn unknown_class_id_falls_back() {
        assert_eq!(class_name("99999"), "Unknown(99999)");
        assert_eq!(class_name("1"), "GameObject");
        assert_eq!(class_name("224"), "RectTransform");
    }

    #[test]
    fn parses_on_disk_fixtures() {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/unity-yaml");

        let scene = std::fs::read_to_string(base.join("TwoObjects.unity"))
            .expect("read TwoObjects.unity fixture");
        let scene_model = parse_asset(&scene);
        assert_eq!(scene_model.game_objects.len(), 1, "one root GameObject");
        assert_eq!(scene_model.game_objects[0].name, "Parent");
        assert_eq!(scene_model.game_objects[0].children[0].name, "Child");

        let prefab = std::fs::read_to_string(base.join("ScriptedPrefab.prefab"))
            .expect("read ScriptedPrefab.prefab fixture");
        let guids = extract_guid_refs(&prefab);
        assert!(guids.contains(&"abcdef0123456789abcdef0123456789".to_string()));
    }
}
