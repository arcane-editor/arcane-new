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
    /// Like `separator`, but with byte-exact end offsets. See `separator_spans`.
    separator_spans: Regex,
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
        // The offset-preserving twin of `separator`.
        //
        // `separator` ends with `\s*$`, and `\s` matches `\n`: the match end
        // therefore walks PAST blank lines after the header and swallows the
        // newline at EOF, so its end offsets cannot be used to reassemble the
        // file. `[^\S\r\n]*` is horizontal whitespace only, so a match can
        // never cross a line, and the optional `\r` pulls a CRLF's carriage
        // return into the header so every body starts at its own `\n`.
        //
        // The ` stripped` marker is CAPTURED here (group 3) rather than merely
        // tolerated, because a writer has to be able to reproduce the header.
        separator_spans: Regex::new(r"(?m)^--- !u!(\d+) &(\d+)( stripped)?[^\S\r\n]*\r?$")
            .expect("separator_spans regex"),
    })
}

// ── Document splitting ──────────────────────────────────────────────────────

struct RawDoc<'a> {
    class_id: String,
    file_id: String,
    content: &'a str,
}

/// Byte spans of one Unity YAML document inside its source text.
///
/// `header` and `body` are contiguous and, together with the file preamble,
/// tile the input EXACTLY: concatenating them reproduces it byte for byte. That
/// property is what the whole byte-exact editing path rests on, and
/// `document_spans_tile_every_fixture` asserts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentSpan {
    pub class_id: String,
    pub file_id: String,
    /// True when the header carried the ` stripped` marker (prefab variants).
    pub stripped: bool,
    /// The header line WITHOUT its terminating `\n`. Includes any trailing
    /// horizontal whitespace and the `\r` of a CRLF line ending.
    pub header: std::ops::Range<usize>,
    /// From the header's line terminator (inclusive) to the next header's
    /// start, or EOF. A body therefore normally begins with its own newline.
    pub body: std::ops::Range<usize>,
}

/// Split `content` into `(preamble, documents)` without losing a byte.
///
/// `preamble` is `0 .. first header start` — the `%YAML 1.1` / `%TAG !u!` lines
/// plus any byte-order mark. When there is no header at all the preamble is the
/// whole input and the document list is empty. This is exactly the text that
/// `split_documents` throws away, and that a writer must preserve.
pub fn split_document_spans(
    content: &str,
) -> (std::ops::Range<usize>, Vec<DocumentSpan>) {
    let re = &regexes().separator_spans;
    let mut headers: Vec<(String, String, bool, usize, usize)> = Vec::new();
    for caps in re.captures_iter(content) {
        let whole = match caps.get(0) {
            Some(m) => m,
            None => continue,
        };
        headers.push((
            caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
            caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default(),
            caps.get(3).is_some(),
            whole.start(),
            whole.end(),
        ));
    }

    let preamble = 0..headers.first().map(|h| h.3).unwrap_or(content.len());

    let mut docs = Vec::with_capacity(headers.len());
    for i in 0..headers.len() {
        let (class_id, file_id, stripped, start, header_end) = &headers[i];
        let body_end = headers
            .get(i + 1)
            .map(|(_, _, _, next_start, _)| *next_start)
            .unwrap_or(content.len());
        docs.push(DocumentSpan {
            class_id: class_id.clone(),
            file_id: file_id.clone(),
            stripped: *stripped,
            header: *start..*header_end,
            body: *header_end..body_end,
        });
    }
    (preamble, docs)
}

/// Split a Unity asset into its constituent documents. Content for a document
/// runs from just after its header line to the start of the next header (or
/// EOF). Mirrors the TS `splitDocuments` algorithm.
fn split_documents(content: &str) -> Vec<RawDoc<'_>> {
    // Built on the span splitter so there is one notion of where a document
    // starts. The only observable difference from the old implementation is
    // that a body now KEEPS any blank lines directly after its header instead
    // of eating one — every consumer of a body is line-oriented and
    // blank-line-tolerant, and the diff engine never compares bodies verbatim.
    split_document_spans(content)
        .1
        .into_iter()
        .map(|span| RawDoc {
            class_id: span.class_id,
            file_id: span.file_id,
            content: content.get(span.body).unwrap_or(""),
        })
        .collect()
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

/// Parse a Unity asset into structured documents *plus* each document's raw
/// body slice (the text from just after its header line to the next header,
/// verbatim). `parse_asset` throws the body away once `properties` is
/// extracted; the diff engine (`unity_diff.rs`) needs the raw text too, so it
/// can pull richer values (inline maps, multi-line blocks) that
/// `collect_simple_properties` intentionally skips. Reuses the same
/// `split_documents`/`parse_document` internals as `parse_asset` — same
/// document set, same leniency, never panics.
/// One entry of a `UnityEvent`'s persistent (Inspector-wired) call list.
///
/// This is the wiring the C# compiler cannot see: a button's OnClick pointing
/// at `MenuController.OnStartPressed` is a string in a prefab, so renaming or
/// deleting that method breaks the button silently, with no error anywhere.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentCall {
    /// The method invoked, e.g. `OnStartPressed`.
    pub method_name: String,
    /// `fileID` of the target component. 0 when the target is another asset.
    pub target_file_id: i64,
    /// Set when the target lives in a different asset.
    pub target_guid: Option<String>,
    /// `Type, Assembly` as Unity stored it, when present.
    pub target_type: Option<String>,
}

/// Extract every persistent call from one document body.
///
/// Hand-rolled rather than routed through `collect_simple_properties`, which
/// drops any value containing `fileID` and caps at 64 properties — it would
/// discard exactly these fields. The parser is positional: `m_MethodName`,
/// `m_Target` and `m_TargetAssemblyTypeName` all belong to the same list item,
/// so a new `- m_Target:` starts a new call.
pub fn extract_persistent_calls(body: &str) -> Vec<PersistentCall> {
    let mut out: Vec<PersistentCall> = Vec::new();
    let mut cur: Option<PersistentCall> = None;

    let flush = |cur: &mut Option<PersistentCall>, out: &mut Vec<PersistentCall>| {
        if let Some(call) = cur.take() {
            // A call with no method name is an empty Inspector slot, not a
            // usage — reporting it would show phantom references.
            if !call.method_name.is_empty() {
                out.push(call);
            }
        }
    };

    for line in body.lines() {
        let trimmed = line.trim_start();
        let is_item = trimmed.starts_with("- ");
        let field = trimmed.strip_prefix("- ").unwrap_or(trimmed);

        if is_item && field.starts_with("m_Target:") {
            flush(&mut cur, &mut out);
            cur = Some(PersistentCall {
                method_name: String::new(),
                target_file_id: 0,
                target_guid: None,
                target_type: None,
            });
        }

        let Some(call) = cur.as_mut() else { continue };

        if let Some(rest) = field.strip_prefix("m_Target:") {
            if let Some(id) = capture_i64(rest, "fileID:") {
                call.target_file_id = id;
            }
            call.target_guid = capture_guid(rest);
        } else if let Some(rest) = field.strip_prefix("m_MethodName:") {
            call.method_name = rest.trim().to_string();
        } else if let Some(rest) = field.strip_prefix("m_TargetAssemblyTypeName:") {
            let v = rest.trim();
            if !v.is_empty() {
                call.target_type = Some(v.to_string());
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// Read `key: <int>` out of an inline `{...}` map.
fn capture_i64(text: &str, key: &str) -> Option<i64> {
    let idx = text.find(key)? + key.len();
    let rest = text[idx..].trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '-'))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// Read a 32-char hex `guid:` out of an inline `{...}` map.
fn capture_guid(text: &str) -> Option<String> {
    let idx = text.find("guid:")? + "guid:".len();
    let rest = text[idx..].trim_start();
    let g: String = rest.chars().take(32).collect();
    if g.len() == 32 && g.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(g)
    } else {
        None
    }
}

pub fn parse_asset_with_bodies(content: &str) -> Vec<(UnityYamlDocument, String)> {
    split_documents(content)
        .iter()
        .map(|raw| (parse_document(raw), raw.content.to_string()))
        .collect()
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
    // ── Byte-exactness of the span splitter ────────────────────────────────
    //
    // P1 (tiling): preamble ++ Σ(header ++ body) reproduces the input exactly.
    // Every editing guarantee downstream is a corollary of this, so it is
    // asserted over every fixture in all three line-ending flavours.
    //
    // CRLF and no-trailing-newline variants are SYNTHESIZED rather than
    // committed: the repo root's `.gitattributes` says `* text=auto eol=lf`, so
    // a committed CRLF fixture is normalised in the index and checked out as
    // LF — the test would pass forever without ever seeing a `\r`.

    use super::*;

    fn crlf(s: &str) -> String {
        s.replace("\r\n", "\n").replace('\n', "\r\n")
    }

    fn no_final_newline(s: &str) -> String {
        s.trim_end_matches(['\n', '\r']).to_string()
    }

    fn fixture(dir: &str, name: &str) -> String {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(dir);
        std::fs::read_to_string(base.join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"))
    }

    fn all_fixtures() -> Vec<(String, String)> {
        vec![
            ("Weapon.asset".into(), fixture("unity-yaml", "Weapon.asset")),
            ("WeaponSubAssets.asset".into(), fixture("unity-yaml", "WeaponSubAssets.asset")),
            ("TwoObjects.unity".into(), fixture("unity-yaml", "TwoObjects.unity")),
            ("ScriptedPrefab.prefab".into(), fixture("unity-yaml", "ScriptedPrefab.prefab")),
            ("EventWiring.prefab".into(), fixture("unity-yaml", "EventWiring.prefab")),
            ("SampleScene.before.unity".into(), fixture("unity-diff", "SampleScene.before.unity")),
            ("SampleScene.after.unity".into(), fixture("unity-diff", "SampleScene.after.unity")),
        ]
    }

    /// P1 — the spans tile the input with no gaps, overlaps or lost bytes.
    fn assert_tiles(label: &str, content: &str) {
        let (preamble, docs) = split_document_spans(content);
        assert_eq!(preamble.start, 0, "{label}: preamble must start at 0");

        let mut rebuilt = String::with_capacity(content.len());
        rebuilt.push_str(&content[preamble.clone()]);
        let mut cursor = preamble.end;
        for (i, d) in docs.iter().enumerate() {
            assert_eq!(d.header.start, cursor, "{label}: gap before header {i}");
            assert_eq!(d.body.start, d.header.end, "{label}: header/body not contiguous at {i}");
            rebuilt.push_str(&content[d.header.clone()]);
            rebuilt.push_str(&content[d.body.clone()]);
            cursor = d.body.end;
        }
        assert_eq!(cursor, content.len(), "{label}: trailing bytes lost");
        assert_eq!(
            rebuilt.as_bytes(),
            content.as_bytes(),
            "{label}: spans do not reassemble the input"
        );
    }

    #[test]
    fn document_spans_tile_every_fixture() {
        for (name, content) in all_fixtures() {
            assert_tiles(&format!("{name} (lf)"), &content);
            assert_tiles(&format!("{name} (crlf)"), &crlf(&content));
            assert_tiles(&format!("{name} (no final nl)"), &no_final_newline(&content));
            assert_tiles(
                &format!("{name} (crlf, no final nl)"),
                &no_final_newline(&crlf(&content)),
            );
        }
    }

    #[test]
    fn blank_lines_after_a_header_belong_to_the_body() {
        // The old `\s*$` separator was greedy across newlines and ate one.
        let src = "--- !u!1 &100\n\n\nGameObject:\n";
        let (_, docs) = split_document_spans(src);
        assert_eq!(docs.len(), 1);
        assert_eq!(&src[docs[0].header.clone()], "--- !u!1 &100");
        assert_eq!(&src[docs[0].body.clone()], "\n\n\nGameObject:\n");
    }

    #[test]
    fn eof_newline_after_a_header_is_not_swallowed() {
        let src = "--- !u!1 &100\n";
        let (_, docs) = split_document_spans(src);
        assert_eq!(&src[docs[0].header.clone()], "--- !u!1 &100");
        assert_eq!(&src[docs[0].body.clone()], "\n");
    }

    #[test]
    fn crlf_header_keeps_its_cr_and_the_body_starts_at_the_lf() {
        let src = "--- !u!1 &100\r\nGameObject:\r\n";
        let (_, docs) = split_document_spans(src);
        assert_eq!(&src[docs[0].header.clone()], "--- !u!1 &100\r");
        assert_eq!(&src[docs[0].body.clone()], "\nGameObject:\r\n");
    }

    #[test]
    fn stripped_marker_is_captured_not_just_tolerated() {
        let src = "--- !u!4 &400 stripped\nTransform:\n";
        let (_, docs) = split_document_spans(src);
        assert!(docs[0].stripped, "a writer must be able to reproduce the header");
        assert_eq!(docs[0].class_id, "4");
        assert_eq!(docs[0].file_id, "400");
    }

    #[test]
    fn preamble_is_captured_verbatim() {
        let content = fixture("unity-yaml", "Weapon.asset");
        let (preamble, _) = split_document_spans(&content);
        assert_eq!(
            &content[preamble],
            "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n"
        );
    }

    #[test]
    fn a_file_with_no_documents_is_all_preamble() {
        let src = "just some text\nwith no headers\n";
        let (preamble, docs) = split_document_spans(src);
        assert!(docs.is_empty());
        assert_eq!(&src[preamble], src);
    }

    #[test]
    fn span_and_legacy_splitters_agree_on_document_identity() {
        // The refactor must not change WHICH documents are found, only how
        // precisely their bounds are described.
        for (name, content) in all_fixtures() {
            let legacy = split_documents(&content);
            let (_, spans) = split_document_spans(&content);
            assert_eq!(legacy.len(), spans.len(), "{name}: document count changed");
            for (a, b) in legacy.iter().zip(spans.iter()) {
                assert_eq!(a.class_id, b.class_id, "{name}: class_id changed");
                assert_eq!(a.file_id, b.file_id, "{name}: file_id changed");
            }
        }
    }

    #[test]
    fn span_splitter_never_panics_on_garbage() {
        for junk in [
            "",
            "---",
            "--- !u!",
            "--- !u!1",
            "--- !u!1 &",
            "--- !u!1 &100 x",
            "\n\n\n",
            "--- !u!1 &100\n--- !u!1 &100\n",
            "%YAML 1.1\n",
        ] {
            let (preamble, docs) = split_document_spans(junk);
            // Whatever it decides, it must still tile.
            let mut cursor = preamble.end;
            for d in &docs {
                assert_eq!(d.header.start, cursor);
                cursor = d.body.end;
            }
            assert_eq!(cursor, junk.len(), "garbage input {junk:?} lost bytes");
        }
    }

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
    fn extracts_persistent_calls_from_a_real_prefab_fixture() {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/unity-yaml");
        let prefab = std::fs::read_to_string(base.join("EventWiring.prefab"))
            .expect("read EventWiring.prefab fixture");

        let calls: Vec<PersistentCall> = parse_asset_with_bodies(&prefab)
            .iter()
            .flat_map(|(_, body)| extract_persistent_calls(body))
            .collect();

        assert_eq!(calls.len(), 2, "expected two wired calls, got {calls:?}");

        // Same-asset target: addressed by fileID, no guid.
        assert_eq!(calls[0].method_name, "OnStartPressed");
        assert_eq!(calls[0].target_file_id, 103);
        assert_eq!(calls[0].target_guid, None);
        assert_eq!(
            calls[0].target_type.as_deref(),
            Some("MenuController, Assembly-CSharp")
        );

        // Cross-asset target: fileID 0 plus a guid pointing at another asset.
        assert_eq!(calls[1].method_name, "PlayClick");
        assert_eq!(calls[1].target_file_id, 0);
        assert_eq!(calls[1].target_guid.as_deref(), Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    }

    #[test]
    fn empty_call_lists_and_unwired_slots_produce_no_usages() {
        // `m_Calls: []` is an event with nothing wired. Reporting it would put
        // a phantom reference on a method that is not actually used.
        assert!(extract_persistent_calls("  m_OnValueChanged:\n    m_PersistentCalls:\n      m_Calls: []\n").is_empty());

        // A target with no method selected is an empty Inspector slot.
        let unwired = "      - m_Target: {fileID: 55}\n        m_MethodName: \n        m_Mode: 0\n";
        assert!(extract_persistent_calls(unwired).is_empty());
    }

    #[test]
    fn each_list_item_starts_a_new_call() {
        let body = "      - m_Target: {fileID: 1}\n        m_MethodName: A\n      - m_Target: {fileID: 2}\n        m_MethodName: B\n";
        let calls = extract_persistent_calls(body);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].method_name, "A");
        assert_eq!(calls[0].target_file_id, 1);
        assert_eq!(calls[1].method_name, "B");
        assert_eq!(calls[1].target_file_id, 2);
    }

    #[test]
    fn persistent_call_extraction_never_panics_on_malformed_input() {
        for junk in ["", "- m_Target:", "m_MethodName:", "- m_Target: {fileID: }", "\u{0}\u{1}"] {
            let _ = extract_persistent_calls(junk);
        }
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
    fn parse_asset_with_bodies_matches_parse_asset_and_keeps_raw_bodies() {
        let pairs = parse_asset_with_bodies(TWO_GO_SCENE);
        let model = parse_asset(TWO_GO_SCENE);
        assert_eq!(pairs.len(), model.documents.len());
        for (i, (doc, _body)) in pairs.iter().enumerate() {
            assert_eq!(doc, &model.documents[i]);
        }
        // The Transform body slice should contain its raw, un-simplified line.
        let (_, transform_body) = pairs
            .iter()
            .find(|(d, _)| d.file_id == "400")
            .expect("transform doc present");
        assert!(transform_body.contains("m_Father: {fileID: 0}"));
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
