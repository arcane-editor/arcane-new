//! Structured, GameObject-grouped semantic diff for Unity scene / prefab /
//! asset files.
//!
//! `unity_yaml.rs` parses a single asset into documents; this module diffs
//! *two* versions of the same asset and groups the result the way a Unity
//! developer thinks about it — by GameObject, not by raw YAML document.
//!
//! Object identity is the `&fileID` anchor: Unity keeps it stable across
//! saves, so matching old/new documents by `file_id` (rather than position or
//! content) is what makes rename/reparent detection possible.
//!
//! Like `unity_yaml.rs`, every entry point here is lenient: malformed input
//! yields a partial/empty diff, never a panic.

use crate::git;
use crate::unity_index;
use crate::unity_yaml::{self, UnityYamlDocument};
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

// ── Serializable payload ─────────────────────────────────────────────────---

/// One property that differs between old and new (or exists on only one
/// side). `old`/`new` are `None` when the key is entirely absent on that
/// side (added/removed field), not when the value is textually empty.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDiff {
    pub key: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

/// A component add/remove/modify under one GameObject.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentDiff {
    pub file_id: String,
    pub class_id: String,
    /// Resolved script name for MonoBehaviours (via the GUID index), else the
    /// `unity_yaml::class_name` type name (e.g. "BoxCollider").
    pub type_name: String,
    pub script_guid: Option<String>,
    /// "added" | "removed" | "modified".
    pub status: String,
    pub property_diffs: Vec<PropertyDiff>,
}

/// Subtree rollup for a whole GameObject added/removed at once — we summarize
/// rather than emitting an `ObjectDiff` per descendant.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubtreeSummary {
    /// Count of descendant GameObjects (recursive), not including the root.
    pub child_count: usize,
    /// Distinct resolved component type names anywhere in the subtree
    /// (root included), sorted for determinism.
    pub component_types: Vec<String>,
}

/// One GameObject's diff.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDiff {
    pub file_id: String,
    /// Current (new-side) name; for a pure removal this is the old name.
    pub name: String,
    /// "added" | "removed" | "renamed" | "moved" | "modified".
    pub status: String,
    /// Slash-joined name path from the scene root to this object, resolved
    /// from whichever side the object exists on (new preferred).
    pub hierarchy_path: String,
    pub old_name: Option<String>,
    pub new_name: Option<String>,
    pub old_parent_name: Option<String>,
    pub new_parent_name: Option<String>,
    /// GameObject-level field changes (m_Name / m_TagString / m_Layer /
    /// m_IsActive, …) — excludes `m_Component` (see `component_diffs`) and is
    /// empty for pure add/remove (see `subtree_summary` instead).
    pub property_diffs: Vec<PropertyDiff>,
    pub component_diffs: Vec<ComponentDiff>,
    /// Present only for whole-subtree "added"/"removed" statuses.
    pub subtree_summary: Option<SubtreeSummary>,
}

/// A single prefab-instance property override (`m_Modifications` entry) that
/// differs between old and new.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrefabOverrideDiff {
    /// fileID of the owning `PrefabInstance` (classId 1001) document.
    pub prefab_instance_file_id: String,
    pub prefab_asset_name: Option<String>,
    pub prefab_asset_guid: Option<String>,
    pub target_file_id: String,
    pub target_guid: String,
    pub property_path: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    /// "added" | "removed" | "modified".
    pub status: String,
}

/// Exact counts across the *whole* diff, computed before the 500-item cap is
/// applied to `object_diffs` — always accurate even when `truncated`.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub added_objects: usize,
    pub removed_objects: usize,
    pub modified_objects: usize,
    pub moved_objects: usize,
    pub component_changes: usize,
    pub property_changes: usize,
}

/// Full structured diff between two versions of one Unity asset file.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SceneDiff {
    pub object_diffs: Vec<ObjectDiff>,
    pub prefab_override_diffs: Vec<PrefabOverrideDiff>,
    pub summary: DiffSummary,
    /// True when `object_diffs` was capped at 500 entries.
    pub truncated: bool,
}

/// GameObjects beyond this count are summarized rather than listed.
const MAX_OBJECT_DIFFS: usize = 500;

// ── Property extraction (diff-oriented; private to this module) ────────────

/// Extract every top-level `key: value` pair from a document body — the
/// fields directly under a Unity document's single root mapping (e.g. the
/// `m_Name`, `m_LocalPosition`, `m_Modification` lines under `GameObject:` /
/// `Transform:` / `PrefabInstance:`). Unlike
/// `unity_yaml::collect_simple_properties` this is diff-oriented:
///
/// - inline-map values (`m_LocalPosition: {x: 0, y: 1, z: 0}`) are kept
///   verbatim as the raw `{...}` string, not skipped;
/// - a key whose value starts on the *next* line (nested mapping/list, e.g.
///   `m_Modification:`) captures every following more-indented line as one
///   raw-text block, up to the next top-level key or EOF;
/// - no item cap.
///
/// Never panics: unmatched lines are simply skipped.
fn extract_properties(body: &str) -> Vec<(String, String)> {
    static TOP_LEVEL: OnceLock<Regex> = OnceLock::new();
    let re = TOP_LEVEL
        .get_or_init(|| Regex::new(r"^ {2}([A-Za-z_][A-Za-z0-9_]*):(.*)$").expect("top-level regex"));

    let lines: Vec<&str> = body.lines().collect();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let caps = match re.captures(lines[i]) {
            Some(c) => c,
            None => {
                i += 1;
                continue;
            }
        };
        let key = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let rest = caps.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        if key.is_empty() {
            i += 1;
            continue;
        }

        if rest.is_empty() {
            // Block value: gather every following line more-indented than
            // this key, tolerating blank lines, until a dedent or EOF.
            let start = i + 1;
            let mut end = start;
            while end < lines.len() {
                let l = lines[end];
                if l.trim().is_empty() {
                    end += 1;
                    continue;
                }
                let indent = indent_of(l);
                if indent <= 2 {
                    break;
                }
                end += 1;
            }
            out.push((key, lines[start..end].join("\n")));
            i = end;
        } else {
            out.push((key, rest));
            i += 1;
        }
    }
    out
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Look up a key's value in a `(key, value)` list (linear scan; property
/// lists here are small — dozens at most).
fn field(props: &[(String, String)], key: &str) -> Option<String> {
    props.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

/// Diff two raw document bodies' top-level properties. Deterministic order:
/// old-side keys first (in their original order), then any new-only keys.
fn diff_properties(old_body: &str, new_body: &str) -> Vec<PropertyDiff> {
    let old_props = extract_properties(old_body);
    let new_props = extract_properties(new_body);
    let old_map: HashMap<&str, &str> =
        old_props.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let new_map: HashMap<&str, &str> =
        new_props.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

    let mut keys: Vec<&str> = Vec::new();
    let mut seen = HashSet::new();
    for (k, _) in old_props.iter().chain(new_props.iter()) {
        if seen.insert(k.as_str()) {
            keys.push(k.as_str());
        }
    }

    let mut out = Vec::new();
    for k in keys {
        let o = old_map.get(k).copied();
        let n = new_map.get(k).copied();
        match (o, n) {
            (Some(a), Some(b)) if a == b => {}
            (Some(a), Some(b)) => out.push(PropertyDiff {
                key: k.to_string(),
                old: Some(a.to_string()),
                new: Some(b.to_string()),
            }),
            (Some(a), None) => out.push(PropertyDiff {
                key: k.to_string(),
                old: Some(a.to_string()),
                new: None,
            }),
            (None, Some(b)) => out.push(PropertyDiff {
                key: k.to_string(),
                old: None,
                new: Some(b.to_string()),
            }),
            (None, None) => {}
        }
    }
    out
}

// ── One side of the diff (old or new) ───────────────────────────────────---

/// Everything we need about one version of the asset: documents indexed by
/// fileID, raw bodies for property extraction, and the transform↔GameObject
/// maps needed for hierarchy / reparent detection.
struct Side {
    /// Preserves file (document) order — used everywhere iteration order
    /// must be deterministic.
    ordered: Vec<UnityYamlDocument>,
    docs: HashMap<String, UnityYamlDocument>,
    bodies: HashMap<String, String>,
    /// transform fileID → owning GameObject fileID.
    transform_to_go: HashMap<String, String>,
    /// GameObject fileID → its transform's fileID.
    go_to_transform: HashMap<String, String>,
}

impl Side {
    fn build(pairs: Vec<(UnityYamlDocument, String)>) -> Self {
        let mut ordered = Vec::with_capacity(pairs.len());
        let mut docs = HashMap::with_capacity(pairs.len());
        let mut bodies = HashMap::with_capacity(pairs.len());
        let mut transform_to_go = HashMap::new();
        let mut go_to_transform = HashMap::new();

        for (doc, body) in pairs {
            if doc.class_id == "4" || doc.class_id == "224" {
                if let Some(go) = &doc.game_object_file_id {
                    transform_to_go.insert(doc.file_id.clone(), go.clone());
                    go_to_transform.insert(go.clone(), doc.file_id.clone());
                }
            }
            bodies.insert(doc.file_id.clone(), body);
            ordered.push(doc.clone());
            docs.insert(doc.file_id.clone(), doc);
        }

        Side { ordered, docs, bodies, transform_to_go, go_to_transform }
    }

    fn go_ids_in_order(&self) -> Vec<String> {
        self.ordered.iter().filter(|d| d.class_id == "1").map(|d| d.file_id.clone()).collect()
    }

    fn prefab_instance_ids_in_order(&self) -> Vec<String> {
        self.ordered
            .iter()
            .filter(|d| d.class_id == "1001")
            .map(|d| d.file_id.clone())
            .collect()
    }

    fn go_name(&self, go_id: &str) -> Option<String> {
        self.docs
            .get(go_id)
            .map(|d| field(&d.properties, "m_Name").unwrap_or_else(|| "Unnamed".to_string()))
    }

    /// The parent GameObject's fileID, resolved via this GO's transform's
    /// `m_Father`. `None` for roots or when the transform/parent is missing.
    fn parent_go(&self, go_id: &str) -> Option<String> {
        let transform_id = self.go_to_transform.get(go_id)?;
        let transform_doc = self.docs.get(transform_id)?;
        let father_id = transform_doc.father_file_id.as_ref()?;
        self.transform_to_go.get(father_id).cloned()
    }

    /// Slash-joined name path from the scene root down to `go_id`. Cycle-safe
    /// (malformed parent loops just truncate the path).
    fn hierarchy_path(&self, go_id: &str) -> String {
        let mut parts = Vec::new();
        let mut current = Some(go_id.to_string());
        let mut visited = HashSet::new();
        while let Some(id) = current {
            if !visited.insert(id.clone()) {
                break;
            }
            match self.go_name(&id) {
                Some(n) => parts.push(n),
                None => break,
            }
            current = self.parent_go(&id);
        }
        parts.reverse();
        parts.join("/")
    }

    fn component_docs_of(&self, go_id: &str) -> Vec<&UnityYamlDocument> {
        self.docs
            .get(go_id)
            .map(|d| d.component_file_ids.iter().filter_map(|cid| self.docs.get(cid)).collect())
            .unwrap_or_default()
    }

    /// GameObject fileID → its direct child GameObject fileIDs (via each
    /// child's transform's `m_Father`), scoped to this side only.
    fn children_map(&self) -> HashMap<String, Vec<String>> {
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        for go_id in self.go_ids_in_order() {
            if let Some(parent) = self.parent_go(&go_id) {
                out.entry(parent).or_default().push(go_id);
            }
        }
        out
    }
}

/// Resolve a component's display name: the backing script's file stem (via
/// the GUID index) for MonoBehaviours, else `unity_yaml::class_name`.
fn component_display_name(doc: &UnityYamlDocument, guid_to_path: &HashMap<String, String>) -> String {
    if let Some(guid) = &doc.script_guid {
        if let Some(name) = guid_to_path.get(guid).and_then(|p| filename_stem(p)) {
            return name;
        }
    }
    doc.type_name.clone()
}

fn filename_stem(path: &str) -> Option<String> {
    std::path::Path::new(path).file_stem().and_then(|s| s.to_str()).map(|s| s.to_string())
}

fn first_guid(text: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"guid:\s*([0-9a-f]{32})").expect("guid regex"));
    re.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
}

fn first_file_id(text: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"fileID:\s*(-?\d+)").expect("fileID regex"));
    re.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
}

/// Property keys that would otherwise show up as noisy/redundant raw-fileID
/// diffs — their meaning is already surfaced structurally elsewhere.
fn filtered_property_diffs(class_id: &str, mut diffs: Vec<PropertyDiff>) -> Vec<PropertyDiff> {
    if class_id == "4" || class_id == "224" {
        // Reparents are surfaced via ObjectDiff::{old,new}_parent_name.
        diffs.retain(|d| d.key != "m_Father");
    }
    diffs
}

// ── Component-level diff ────────────────────────────────────────────────---

fn diff_components(
    go_id: &str,
    old_side: &Side,
    new_side: &Side,
    guid_to_path: &HashMap<String, String>,
) -> Vec<ComponentDiff> {
    let old_ids = old_side.docs.get(go_id).map(|d| d.component_file_ids.clone()).unwrap_or_default();
    let new_ids = new_side.docs.get(go_id).map(|d| d.component_file_ids.clone()).unwrap_or_default();

    let mut ids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for id in old_ids.into_iter().chain(new_ids) {
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }

    let mut out = Vec::new();
    for cid in ids {
        let old_doc = old_side.docs.get(&cid);
        let new_doc = new_side.docs.get(&cid);
        match (old_doc, new_doc) {
            (None, Some(nd)) => out.push(ComponentDiff {
                file_id: cid,
                class_id: nd.class_id.clone(),
                type_name: component_display_name(nd, guid_to_path),
                script_guid: nd.script_guid.clone(),
                status: "added".to_string(),
                property_diffs: Vec::new(),
            }),
            (Some(od), None) => out.push(ComponentDiff {
                file_id: cid,
                class_id: od.class_id.clone(),
                type_name: component_display_name(od, guid_to_path),
                script_guid: od.script_guid.clone(),
                status: "removed".to_string(),
                property_diffs: Vec::new(),
            }),
            (Some(_od), Some(nd)) => {
                let old_body = old_side.bodies.get(&cid).map(String::as_str).unwrap_or("");
                let new_body = new_side.bodies.get(&cid).map(String::as_str).unwrap_or("");
                let diffs = filtered_property_diffs(&nd.class_id, diff_properties(old_body, new_body));
                if !diffs.is_empty() {
                    out.push(ComponentDiff {
                        file_id: cid,
                        class_id: nd.class_id.clone(),
                        type_name: component_display_name(nd, guid_to_path),
                        script_guid: nd.script_guid.clone(),
                        status: "modified".to_string(),
                        property_diffs: diffs,
                    });
                }
            }
            (None, None) => {}
        }
    }
    out
}

// ── Object-level diff (GameObject present on both sides) ───────────────---

fn build_common_object_diff(
    go_id: &str,
    old_side: &Side,
    new_side: &Side,
    guid_to_path: &HashMap<String, String>,
) -> Option<ObjectDiff> {
    let old_doc = old_side.docs.get(go_id)?;
    let new_doc = new_side.docs.get(go_id)?;

    let old_name = field(&old_doc.properties, "m_Name").unwrap_or_else(|| "Unnamed".to_string());
    let new_name = field(&new_doc.properties, "m_Name").unwrap_or_else(|| "Unnamed".to_string());
    let renamed = old_name != new_name;

    let old_parent = old_side.parent_go(go_id);
    let new_parent = new_side.parent_go(go_id);
    let moved = old_parent != new_parent;

    let component_diffs = diff_components(go_id, old_side, new_side, guid_to_path);

    let old_body = old_side.bodies.get(go_id).map(String::as_str).unwrap_or("");
    let new_body = new_side.bodies.get(go_id).map(String::as_str).unwrap_or("");
    let mut property_diffs = diff_properties(old_body, new_body);
    // m_Component is handled structurally via component_diffs above.
    property_diffs.retain(|d| d.key != "m_Component");

    if !renamed && !moved && component_diffs.is_empty() && property_diffs.is_empty() {
        return None;
    }

    let status = if renamed {
        "renamed"
    } else if moved {
        "moved"
    } else {
        "modified"
    };

    let old_parent_name = if moved { old_parent.and_then(|p| old_side.go_name(&p)) } else { None };
    let new_parent_name = if moved { new_parent.and_then(|p| new_side.go_name(&p)) } else { None };

    Some(ObjectDiff {
        file_id: go_id.to_string(),
        name: new_name.clone(),
        status: status.to_string(),
        hierarchy_path: new_side.hierarchy_path(go_id),
        old_name: if renamed { Some(old_name) } else { None },
        new_name: if renamed { Some(new_name) } else { None },
        old_parent_name,
        new_parent_name,
        property_diffs,
        component_diffs,
        subtree_summary: None,
    })
}

/// Recursively summarize an added/removed GameObject's whole subtree, scoped
/// to `restrict` (the full added/removed id set) so we never wander into
/// GameObjects that existed on both sides.
fn collect_subtree(
    root: &str,
    children: &HashMap<String, Vec<String>>,
    restrict: &HashSet<String>,
    side: &Side,
    guid_to_path: &HashMap<String, String>,
) -> SubtreeSummary {
    let mut count = 0usize;
    let mut types: BTreeSet<String> = BTreeSet::new();
    for c in side.component_docs_of(root) {
        types.insert(component_display_name(c, guid_to_path));
    }

    let mut stack = vec![root.to_string()];
    let mut visited = HashSet::new();
    visited.insert(root.to_string());
    while let Some(cur) = stack.pop() {
        if let Some(kids) = children.get(&cur) {
            for kid in kids {
                if restrict.contains(kid) && visited.insert(kid.clone()) {
                    count += 1;
                    for c in side.component_docs_of(kid) {
                        types.insert(component_display_name(c, guid_to_path));
                    }
                    stack.push(kid.clone());
                }
            }
        }
    }

    SubtreeSummary { child_count: count, component_types: types.into_iter().collect() }
}

fn build_added_or_removed_diff(
    go_id: &str,
    side: &Side,
    status: &str,
    children: &HashMap<String, Vec<String>>,
    restrict: &HashSet<String>,
    guid_to_path: &HashMap<String, String>,
) -> ObjectDiff {
    let name = side.go_name(go_id).unwrap_or_else(|| "Unnamed".to_string());
    let subtree = collect_subtree(go_id, children, restrict, side, guid_to_path);
    ObjectDiff {
        file_id: go_id.to_string(),
        name,
        status: status.to_string(),
        hierarchy_path: side.hierarchy_path(go_id),
        old_name: None,
        new_name: None,
        old_parent_name: None,
        new_parent_name: None,
        property_diffs: Vec::new(),
        component_diffs: Vec::new(),
        subtree_summary: Some(subtree),
    }
}

// ── Prefab instance (classId 1001) modifications ────────────────────────---

struct ModEntry {
    target_file_id: String,
    target_guid: String,
    property_path: String,
    value: String,
}

/// Parse a `m_Modification` raw block's `m_Modifications:` list. Unity aligns
/// each `- target: {...}` item at the same indent as the `m_Modifications:`
/// key itself; continuation fields (`propertyPath`, `value`, …) sit one level
/// deeper. Never panics; malformed/missing input yields an empty list.
fn parse_modifications(block: &str) -> Vec<ModEntry> {
    let mut entries = Vec::new();
    let lines: Vec<&str> = block.lines().collect();
    let start_idx = match lines.iter().position(|l| l.trim_start().starts_with("m_Modifications:")) {
        Some(i) => i,
        None => return entries,
    };
    let base_indent = indent_of(lines[start_idx]);
    let mut i = start_idx + 1;
    let mut current: Option<ModEntry> = None;

    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        let indent = indent_of(line);
        let trimmed = line.trim_start();

        if indent < base_indent {
            break;
        }
        if indent == base_indent {
            let is_target_item = trimmed
                .strip_prefix('-')
                .map(|rest| rest.trim_start().starts_with("target:"))
                .unwrap_or(false);
            if is_target_item {
                if let Some(e) = current.take() {
                    entries.push(e);
                }
                let rest = trimmed.trim_start_matches('-').trim_start();
                let target_rest = rest.strip_prefix("target:").unwrap_or("").trim();
                current = Some(ModEntry {
                    target_file_id: first_file_id(target_rest).unwrap_or_default(),
                    target_guid: first_guid(target_rest).unwrap_or_default(),
                    property_path: String::new(),
                    value: String::new(),
                });
                i += 1;
                continue;
            }
            // A sibling key at the same indent (e.g. m_RemovedComponents:)
            // ends the modifications list.
            break;
        }

        if let Some(entry) = current.as_mut() {
            if let Some(rest) = trimmed.strip_prefix("propertyPath:") {
                entry.property_path = rest.trim().to_string();
            } else if let Some(rest) = trimmed.strip_prefix("value:") {
                entry.value = rest.trim().to_string();
            }
        }
        i += 1;
    }
    if let Some(e) = current.take() {
        entries.push(e);
    }
    entries
}

type ModKey = (String, String, String); // (target_guid, target_file_id, property_path)

fn diff_prefab_instances(
    old_side: &Side,
    new_side: &Side,
    guid_to_path: &HashMap<String, String>,
) -> Vec<PrefabOverrideDiff> {
    let mut ids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for id in old_side
        .prefab_instance_ids_in_order()
        .into_iter()
        .chain(new_side.prefab_instance_ids_in_order())
    {
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }

    let mut out = Vec::new();
    for pf_id in ids {
        let old_body = old_side.bodies.get(&pf_id).map(String::as_str).unwrap_or("");
        let new_body = new_side.bodies.get(&pf_id).map(String::as_str).unwrap_or("");

        let old_props = extract_properties(old_body);
        let new_props = extract_properties(new_body);

        let old_entries = parse_modifications(&field(&old_props, "m_Modification").unwrap_or_default());
        let new_entries = parse_modifications(&field(&new_props, "m_Modification").unwrap_or_default());

        let source_val = field(&new_props, "m_SourcePrefab").or_else(|| field(&old_props, "m_SourcePrefab"));
        let source_guid = source_val.as_deref().and_then(first_guid);
        let asset_name =
            source_guid.as_ref().and_then(|g| guid_to_path.get(g)).and_then(|p| filename_stem(p));

        let mut old_map: HashMap<ModKey, String> = HashMap::new();
        for e in &old_entries {
            old_map.insert(
                (e.target_guid.clone(), e.target_file_id.clone(), e.property_path.clone()),
                e.value.clone(),
            );
        }
        let mut new_map: HashMap<ModKey, String> = HashMap::new();
        for e in &new_entries {
            new_map.insert(
                (e.target_guid.clone(), e.target_file_id.clone(), e.property_path.clone()),
                e.value.clone(),
            );
        }

        let mut keys: Vec<ModKey> = Vec::new();
        let mut seen_keys = HashSet::new();
        for e in old_entries.iter().chain(new_entries.iter()) {
            let k = (e.target_guid.clone(), e.target_file_id.clone(), e.property_path.clone());
            if seen_keys.insert(k.clone()) {
                keys.push(k);
            }
        }

        for key in keys {
            let old_v = old_map.get(&key).cloned();
            let new_v = new_map.get(&key).cloned();
            let status = match (&old_v, &new_v) {
                (None, Some(_)) => "added",
                (Some(_), None) => "removed",
                (Some(a), Some(b)) if a != b => "modified",
                _ => continue,
            };
            let (guid, fid, path) = key;
            out.push(PrefabOverrideDiff {
                prefab_instance_file_id: pf_id.clone(),
                prefab_asset_name: asset_name.clone(),
                prefab_asset_guid: source_guid.clone(),
                target_file_id: fid,
                target_guid: guid,
                property_path: path,
                old_value: old_v,
                new_value: new_v,
                status: status.to_string(),
            });
        }
    }
    out
}

// ── Top-level engine ─────────────────────────────────────────────────────--

/// Diff two versions of one Unity asset file's raw text. Pure/no I/O — the
/// Tauri commands below load `old_content`/`new_content` and `guid_to_path`
/// and call straight into this.
pub fn diff_unity_assets(
    old_content: &str,
    new_content: &str,
    guid_to_path: &HashMap<String, String>,
) -> SceneDiff {
    let old_side = Side::build(unity_yaml::parse_asset_with_bodies(old_content));
    let new_side = Side::build(unity_yaml::parse_asset_with_bodies(new_content));

    let mut go_ids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for id in old_side.go_ids_in_order().into_iter().chain(new_side.go_ids_in_order()) {
        if seen.insert(id.clone()) {
            go_ids.push(id);
        }
    }

    let added_set: HashSet<String> = go_ids
        .iter()
        .filter(|id| !old_side.docs.contains_key(*id) && new_side.docs.contains_key(*id))
        .cloned()
        .collect();
    let removed_set: HashSet<String> = go_ids
        .iter()
        .filter(|id| old_side.docs.contains_key(*id) && !new_side.docs.contains_key(*id))
        .cloned()
        .collect();

    let new_children = new_side.children_map();
    let old_children = old_side.children_map();

    let mut object_diffs: Vec<ObjectDiff> = Vec::new();
    let mut summary = DiffSummary::default();

    for go_id in &go_ids {
        if added_set.contains(go_id) {
            summary.added_objects += 1;
            let is_root = !matches!(new_side.parent_go(go_id), Some(p) if added_set.contains(&p));
            if is_root {
                object_diffs.push(build_added_or_removed_diff(
                    go_id,
                    &new_side,
                    "added",
                    &new_children,
                    &added_set,
                    guid_to_path,
                ));
            }
            continue;
        }
        if removed_set.contains(go_id) {
            summary.removed_objects += 1;
            let is_root = !matches!(old_side.parent_go(go_id), Some(p) if removed_set.contains(&p));
            if is_root {
                object_diffs.push(build_added_or_removed_diff(
                    go_id,
                    &old_side,
                    "removed",
                    &old_children,
                    &removed_set,
                    guid_to_path,
                ));
            }
            continue;
        }

        if let Some(od) = build_common_object_diff(go_id, &old_side, &new_side, guid_to_path) {
            summary.component_changes += od.component_diffs.len();
            let component_level_props: usize =
                od.component_diffs.iter().map(|c| c.property_diffs.len()).sum();
            summary.property_changes += od.property_diffs.len() + component_level_props;
            if od.status == "moved" {
                summary.moved_objects += 1;
            } else {
                summary.modified_objects += 1;
            }
            object_diffs.push(od);
        }
    }

    let prefab_override_diffs = diff_prefab_instances(&old_side, &new_side, guid_to_path);

    let truncated = object_diffs.len() > MAX_OBJECT_DIFFS;
    if truncated {
        object_diffs.truncate(MAX_OBJECT_DIFFS);
    }

    SceneDiff { object_diffs, prefab_override_diffs, summary, truncated }
}

// ── Tauri commands ───────────────────────────────────────────────────────--

/// `git show :<path>` — the index (staged) blob, stage 0. Empty string on any
/// failure (untracked / not staged / no repo), mirroring `git::git_show_head`.
fn show_index(workspace_path: &str, file_path: &str) -> String {
    let output = std::process::Command::new("git")
        .args(["-C", workspace_path, "show", &format!(":{file_path}")])
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => String::new(),
    }
}

/// `git show <rev>:<path>`. Empty string on any failure.
fn show_rev(workspace_path: &str, rev: &str, file_path: &str) -> String {
    let output = std::process::Command::new("git")
        .args(["-C", workspace_path, "show", &format!("{rev}:{file_path}")])
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => String::new(),
    }
}

/// Diff a workspace-relative Unity asset against HEAD.
///
/// `staged`: compares HEAD vs the git index (`git show :<path>`) — cheap via
/// the same `git show` subprocess approach the rest of `git.rs` already uses,
/// so this is fully implemented (not worktree-only). `staged=false` compares
/// HEAD vs the on-disk working tree (empty content for a deleted file).
#[tauri::command]
pub fn unity_scene_diff(
    workspace_path: String,
    file_path: String,
    staged: bool,
) -> Result<SceneDiff, String> {
    let old_content = git::git_show_head(workspace_path.clone(), file_path.clone()).unwrap_or_default();
    let new_content = if staged {
        show_index(&workspace_path, &file_path)
    } else {
        let full_path = std::path::Path::new(&workspace_path).join(&file_path);
        std::fs::read_to_string(&full_path).unwrap_or_default()
    };
    let guid_to_path = unity_index::get_or_build(&workspace_path).guid_to_path;
    Ok(diff_unity_assets(&old_content, &new_content, &guid_to_path))
}

/// Diff a workspace-relative Unity asset between two arbitrary revisions.
#[tauri::command]
pub fn unity_scene_diff_revs(
    workspace_path: String,
    file_path: String,
    old_rev: String,
    new_rev: String,
) -> Result<SceneDiff, String> {
    let old_content = show_rev(&workspace_path, &old_rev, &file_path);
    let new_content = show_rev(&workspace_path, &new_rev, &file_path);
    let guid_to_path = unity_index::get_or_build(&workspace_path).guid_to_path;
    Ok(diff_unity_assets(&old_content, &new_content, &guid_to_path))
}

// ── Tests ─────────────────────────────────────────────────────────────────--

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_guids() -> HashMap<String, String> {
        HashMap::new()
    }

    // A single GameObject "Player" with a Transform + a scripted MonoBehaviour
    // (`speed`). `speed_after` lets tests tweak just that one scalar.
    fn player_scene(speed: i32, tag: &str, layer: i32) -> String {
        format!(
            "--- !u!1 &100\nGameObject:\n  m_Name: Player\n  m_TagString: {tag}\n  m_Layer: {layer}\n  m_IsActive: 1\n  m_Component:\n  - component: {{fileID: 400}}\n  - component: {{fileID: 114}}\n--- !u!4 &400\nTransform:\n  m_GameObject: {{fileID: 100}}\n  m_LocalPosition: {{x: 0, y: 0, z: 0}}\n  m_Father: {{fileID: 0}}\n--- !u!114 &114\nMonoBehaviour:\n  m_GameObject: {{fileID: 100}}\n  m_Script: {{fileID: 11500000, guid: abcdef0123456789abcdef0123456789, type: 3}}\n  speed: {speed}\n"
        )
    }

    #[test]
    fn scalar_property_change_on_a_component() {
        let before = player_scene(5, "Untagged", 0);
        let after = player_scene(7, "Untagged", 0);
        let diff = diff_unity_assets(&before, &after, &empty_guids());

        assert_eq!(diff.object_diffs.len(), 1);
        let od = &diff.object_diffs[0];
        assert_eq!(od.status, "modified");
        assert!(od.property_diffs.is_empty(), "GO-level fields unchanged");
        assert_eq!(od.component_diffs.len(), 1);
        let cd = &od.component_diffs[0];
        assert_eq!(cd.type_name, "MonoBehaviour");
        assert_eq!(cd.status, "modified");
        assert_eq!(
            cd.property_diffs,
            vec![PropertyDiff { key: "speed".into(), old: Some("5".into()), new: Some("7".into()) }]
        );

        assert_eq!(diff.summary.modified_objects, 1);
        assert_eq!(diff.summary.component_changes, 1);
        assert_eq!(diff.summary.property_changes, 1);
        assert_eq!(diff.summary.added_objects, 0);
        assert_eq!(diff.summary.removed_objects, 0);
        assert_eq!(diff.summary.moved_objects, 0);
        assert!(!diff.truncated);
    }

    #[test]
    fn inline_map_change_position() {
        let before = "--- !u!1 &100\nGameObject:\n  m_Name: Player\n  m_Component:\n  - component: {fileID: 400}\n--- !u!4 &400\nTransform:\n  m_GameObject: {fileID: 100}\n  m_LocalPosition: {x: 0, y: 0, z: 0}\n  m_Father: {fileID: 0}\n";
        let after = "--- !u!1 &100\nGameObject:\n  m_Name: Player\n  m_Component:\n  - component: {fileID: 400}\n--- !u!4 &400\nTransform:\n  m_GameObject: {fileID: 100}\n  m_LocalPosition: {x: 1, y: 0, z: 0}\n  m_Father: {fileID: 0}\n";

        let diff = diff_unity_assets(before, after, &empty_guids());
        assert_eq!(diff.object_diffs.len(), 1);
        let cd = &diff.object_diffs[0].component_diffs[0];
        assert_eq!(cd.type_name, "Transform");
        assert_eq!(
            cd.property_diffs,
            vec![PropertyDiff {
                key: "m_LocalPosition".into(),
                old: Some("{x: 0, y: 0, z: 0}".into()),
                new: Some("{x: 1, y: 0, z: 0}".into()),
            }]
        );
    }

    #[test]
    fn add_and_remove_component() {
        let base_go = "--- !u!1 &100\nGameObject:\n  m_Name: Wall\n  m_Component:\n  - component: {fileID: 400}\n{extra}--- !u!4 &400\nTransform:\n  m_GameObject: {fileID: 100}\n  m_Father: {fileID: 0}\n{extra_doc}";

        let before = base_go
            .replace("{extra}", "")
            .replace("{extra_doc}", "");
        let after = base_go
            .replace("{extra}", "")
            .replace("{extra_doc}", "--- !u!65 &500\nBoxCollider:\n  m_GameObject: {fileID: 100}\n");
        // Wire the new component onto the GameObject's component list too.
        let after = after.replace(
            "- component: {fileID: 400}\n",
            "- component: {fileID: 400}\n  - component: {fileID: 500}\n",
        );

        let diff = diff_unity_assets(&before, &after, &empty_guids());
        assert_eq!(diff.object_diffs.len(), 1);
        let od = &diff.object_diffs[0];
        assert_eq!(od.status, "modified");
        assert_eq!(od.component_diffs.len(), 1);
        assert_eq!(od.component_diffs[0].status, "added");
        assert_eq!(od.component_diffs[0].type_name, "BoxCollider");
        assert_eq!(diff.summary.component_changes, 1);

        // And the reverse direction: removing a component.
        let diff_rev = diff_unity_assets(&after, &before, &empty_guids());
        let od_rev = &diff_rev.object_diffs[0];
        assert_eq!(od_rev.component_diffs[0].status, "removed");
        assert_eq!(od_rev.component_diffs[0].type_name, "BoxCollider");
    }

    #[test]
    fn add_and_remove_gameobject_subtree() {
        // Before: just "Root". After: "Root" plus a new child subtree
        // "OldEnemy" (with its own child "EnemyWeapon" and a component).
        let before = "--- !u!1 &1\nGameObject:\n  m_Name: Root\n  m_Component:\n  - component: {fileID: 2}\n--- !u!4 &2\nTransform:\n  m_GameObject: {fileID: 1}\n  m_Father: {fileID: 0}\n";
        let after = "--- !u!1 &1\nGameObject:\n  m_Name: Root\n  m_Component:\n  - component: {fileID: 2}\n--- !u!4 &2\nTransform:\n  m_GameObject: {fileID: 1}\n  m_Father: {fileID: 0}\n--- !u!1 &10\nGameObject:\n  m_Name: OldEnemy\n  m_Component:\n  - component: {fileID: 11}\n  - component: {fileID: 12}\n--- !u!4 &11\nTransform:\n  m_GameObject: {fileID: 10}\n  m_Father: {fileID: 2}\n--- !u!65 &12\nBoxCollider:\n  m_GameObject: {fileID: 10}\n--- !u!1 &20\nGameObject:\n  m_Name: EnemyWeapon\n  m_Component:\n  - component: {fileID: 21}\n--- !u!4 &21\nTransform:\n  m_GameObject: {fileID: 20}\n  m_Father: {fileID: 11}\n";

        let diff = diff_unity_assets(before, after, &empty_guids());

        // Only ONE ObjectDiff for the whole added subtree (its root), not one
        // per descendant.
        let added: Vec<&ObjectDiff> = diff.object_diffs.iter().filter(|d| d.status == "added").collect();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].name, "OldEnemy");
        let subtree = added[0].subtree_summary.as_ref().expect("subtree summary present");
        assert_eq!(subtree.child_count, 1, "EnemyWeapon is the one descendant");
        assert!(subtree.component_types.contains(&"BoxCollider".to_string()));
        assert!(subtree.component_types.contains(&"Transform".to_string()));

        // But the exact summary counts both GameObjects.
        assert_eq!(diff.summary.added_objects, 2);

        // Reverse direction: whole-subtree removal.
        let diff_rev = diff_unity_assets(after, before, &empty_guids());
        assert_eq!(diff_rev.summary.removed_objects, 2);
        let removed: Vec<&ObjectDiff> =
            diff_rev.object_diffs.iter().filter(|d| d.status == "removed").collect();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].name, "OldEnemy");
    }

    #[test]
    fn rename_same_file_id() {
        let before = "--- !u!1 &100\nGameObject:\n  m_Name: Player\n  m_Component:\n  - component: {fileID: 400}\n--- !u!4 &400\nTransform:\n  m_GameObject: {fileID: 100}\n  m_Father: {fileID: 0}\n";
        let after = "--- !u!1 &100\nGameObject:\n  m_Name: Hero\n  m_Component:\n  - component: {fileID: 400}\n--- !u!4 &400\nTransform:\n  m_GameObject: {fileID: 100}\n  m_Father: {fileID: 0}\n";

        let diff = diff_unity_assets(before, after, &empty_guids());
        assert_eq!(diff.object_diffs.len(), 1);
        let od = &diff.object_diffs[0];
        assert_eq!(od.status, "renamed");
        assert_eq!(od.old_name.as_deref(), Some("Player"));
        assert_eq!(od.new_name.as_deref(), Some("Hero"));
        assert_eq!(diff.summary.modified_objects, 1);
        assert_eq!(diff.summary.moved_objects, 0);
    }

    #[test]
    fn reparent_moved_status_and_parent_names() {
        // Two potential parents ("Left", "Right") and a "Mover" that starts
        // under "Left" and ends up under "Right".
        let scene = |father: &str| -> String {
            format!(
                "--- !u!1 &1\nGameObject:\n  m_Name: Left\n  m_Component:\n  - component: {{fileID: 2}}\n--- !u!4 &2\nTransform:\n  m_GameObject: {{fileID: 1}}\n  m_Father: {{fileID: 0}}\n--- !u!1 &3\nGameObject:\n  m_Name: Right\n  m_Component:\n  - component: {{fileID: 4}}\n--- !u!4 &4\nTransform:\n  m_GameObject: {{fileID: 3}}\n  m_Father: {{fileID: 0}}\n--- !u!1 &5\nGameObject:\n  m_Name: Mover\n  m_Component:\n  - component: {{fileID: 6}}\n--- !u!4 &6\nTransform:\n  m_GameObject: {{fileID: 5}}\n  m_Father: {{fileID: {father}}}\n"
            )
        };
        let before = scene("2"); // under Left
        let after = scene("4"); // under Right

        let diff = diff_unity_assets(&before, &after, &empty_guids());
        let mover = diff
            .object_diffs
            .iter()
            .find(|d| d.file_id == "5")
            .expect("Mover diff present");
        assert_eq!(mover.status, "moved");
        assert_eq!(mover.old_parent_name.as_deref(), Some("Left"));
        assert_eq!(mover.new_parent_name.as_deref(), Some("Right"));
        // m_Father is filtered out of the Transform's own property diffs.
        assert!(mover.component_diffs.is_empty());
        assert_eq!(diff.summary.moved_objects, 1);
        assert_eq!(diff.summary.modified_objects, 0);
    }

    #[test]
    fn prefab_override_value_change() {
        let prefab_guid = "abcdef0123456789abcdef0123456789";
        let target_guid = "11111111111111111111111111111111";
        let before = format!(
            "--- !u!1001 &100100000\nPrefabInstance:\n  m_ObjectHideFlags: 0\n  serializedVersion: 2\n  m_Modification:\n    m_TransformParent: {{fileID: 0}}\n    m_Modifications:\n    - target: {{fileID: 400000, guid: {target_guid}, type: 3}}\n      propertyPath: speed\n      value: 5\n      objectReference: {{fileID: 0}}\n    m_RemovedComponents: []\n  m_SourcePrefab: {{fileID: 100100000, guid: {prefab_guid}, type: 3}}\n"
        );
        let after = format!(
            "--- !u!1001 &100100000\nPrefabInstance:\n  m_ObjectHideFlags: 0\n  serializedVersion: 2\n  m_Modification:\n    m_TransformParent: {{fileID: 0}}\n    m_Modifications:\n    - target: {{fileID: 400000, guid: {target_guid}, type: 3}}\n      propertyPath: speed\n      value: 9\n      objectReference: {{fileID: 0}}\n    m_RemovedComponents: []\n  m_SourcePrefab: {{fileID: 100100000, guid: {prefab_guid}, type: 3}}\n"
        );

        let mut guids = HashMap::new();
        guids.insert(prefab_guid.to_string(), "Assets/Prefabs/Enemy.prefab".to_string());

        let diff = diff_unity_assets(&before, &after, &guids);
        assert_eq!(diff.prefab_override_diffs.len(), 1);
        let row = &diff.prefab_override_diffs[0];
        assert_eq!(row.status, "modified");
        assert_eq!(row.property_path, "speed");
        assert_eq!(row.old_value.as_deref(), Some("5"));
        assert_eq!(row.new_value.as_deref(), Some("9"));
        assert_eq!(row.target_guid, target_guid);
        assert_eq!(row.target_file_id, "400000");
        assert_eq!(row.prefab_asset_guid.as_deref(), Some(prefab_guid));
        assert_eq!(row.prefab_asset_name.as_deref(), Some("Enemy"));
    }

    #[test]
    fn identical_files_yield_empty_diff() {
        let content = player_scene(5, "Untagged", 0);
        let diff = diff_unity_assets(&content, &content, &empty_guids());
        assert_eq!(diff, SceneDiff::default());
    }

    #[test]
    fn garbage_input_does_not_panic() {
        let junk_pairs = [
            ("", ""),
            ("not yaml at all", "also not yaml"),
            ("--- !u! garbage no anchor", "--- !u!1\nmissing anchor"),
            ("{{{{{{{", "}}}}}}}"),
            ("--- !u!1 &1\nm_Name: \u{fffd}\n--- !u!4 &", "\0\0\0"),
        ];
        for (old, new) in junk_pairs {
            let diff = diff_unity_assets(old, new, &empty_guids());
            // No assertion beyond "didn't panic" — most yield an empty-ish diff.
            let _ = diff.object_diffs.len();
        }
        assert_eq!(diff_unity_assets("", "", &empty_guids()), SceneDiff::default());
    }

    #[test]
    fn truncates_object_diffs_beyond_cap_but_keeps_exact_summary() {
        let mut before = String::new();
        let mut after = String::new();
        for i in 0..600u32 {
            let fid = 1000 + i * 2;
            let tfid = fid + 1;
            before.push_str(&format!(
                "--- !u!1 &{fid}\nGameObject:\n  m_Name: GO{i}\n  m_TagString: Untagged\n  m_Layer: 0\n  m_IsActive: 1\n  m_Component:\n  - component: {{fileID: {tfid}}}\n--- !u!4 &{tfid}\nTransform:\n  m_GameObject: {{fileID: {fid}}}\n  m_Father: {{fileID: 0}}\n"
            ));
            after.push_str(&format!(
                "--- !u!1 &{fid}\nGameObject:\n  m_Name: GO{i}\n  m_TagString: Untagged\n  m_Layer: 1\n  m_IsActive: 1\n  m_Component:\n  - component: {{fileID: {tfid}}}\n--- !u!4 &{tfid}\nTransform:\n  m_GameObject: {{fileID: {fid}}}\n  m_Father: {{fileID: 0}}\n"
            ));
        }

        let diff = diff_unity_assets(&before, &after, &empty_guids());
        assert_eq!(diff.summary.modified_objects, 600, "exact count regardless of cap");
        assert!(diff.truncated);
        assert_eq!(diff.object_diffs.len(), MAX_OBJECT_DIFFS);
    }
}
