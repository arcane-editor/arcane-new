// ── Byte-exact ScriptableObject field editing ───────────────────────────────
//
// Changing one field of a Unity `.asset` must leave every other byte of the
// file untouched — line endings, trailing whitespace, a missing final newline,
// the `%YAML`/`%TAG` preamble, key order, and every field our parsers do not
// model. Unity re-serialises assets itself, so any byte we move shows up as a
// spurious diff for the whole team, and anything we drop is lost data.
//
// The only way to guarantee that is to never rebuild the file from a model.
// This module locates the exact byte range of ONE value and splices a
// replacement into the original text. Everything outside that range is then
// preserved for free, by construction rather than by care.
//
// `UnityAssetModel` is unusable for this: `collect_simple_properties` drops any
// value starting `{`, `[` or `-`, drops anything containing `fileID`, and caps
// at 64 keys — precisely the object references, colours, vectors and lists a
// ScriptableObject is made of. And there is no YAML crate in this project on
// purpose: Unity's `!u!` local tags choke conforming parsers, and every real
// emitter reorders keys and renormalises quoting, losing on every clause above
// simultaneously.

use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::unity_yaml::split_document_spans;

// ── Value shapes ────────────────────────────────────────────────────────────

/// How an inline (same-line) value is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InlineKind {
    Scalar,
    SingleQuoted,
    DoubleQuoted,
    /// `{fileID: 0}` / `{r: 1, g: 0.5, b: 0, a: 1}`
    InlineMap,
    /// `[]`
    InlineSeq,
    /// `key:` with nothing after it.
    Empty,
}

/// How a block (following-lines) value is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    /// `- item` lines.
    Sequence,
    /// More-indented `key: value` lines.
    Mapping,
}

/// Why a located value will not be rewritten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpaqueReason {
    /// `key: |`, `key: |-`, `key: >`, `key: >2-`
    BlockScalar,
    /// `key: &anchor …` / `key: *alias`
    AnchorOrAlias,
    /// A `#` outside quotes and braces — rewriting could eat a comment.
    PossibleComment,
    /// A tab appears in the line's indentation; column maths is unreliable.
    TabIndent,
    /// Unbalanced `{`, `[` or quote on the value line.
    Unbalanced,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueSpan {
    /// Value on the key's own line. `span` excludes surrounding whitespace, so
    /// trailing spaces on the line survive a rewrite. May be zero-length.
    Inline {
        span: Range<usize>,
        kind: InlineKind,
        /// True when there is no space after the `:` yet, so a writer must add one.
        needs_space_before: bool,
    },
    /// Value on following, more-indented lines. `span` ends at the last
    /// NON-BLANK continuation line, so a blank separator before the next
    /// document stays outside and survives.
    Block { span: Range<usize>, kind: BlockKind },
    /// Located, but refused for editing.
    Opaque { span: Range<usize>, reason: OpaqueReason },
}

/// One top-level `key: …` entry of a Unity document, with byte spans.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    pub key_span: Range<usize>,
    pub value: ValueSpan,
    /// Line start of the key .. end of the last line's CONTENT (terminator
    /// excluded). Insertion anchors off the end of this.
    pub entry_span: Range<usize>,
    /// Leading-space count of the key's line.
    pub indent: usize,
    /// Terminator ending this entry's last line: "\r\n", "\n", or "" at EOF.
    pub terminator: &'static str,
}

// ── Rejections ──────────────────────────────────────────────────────────────

/// Why an edit was refused.
///
/// A serialisable enum rather than `Err(String)` so the inspector can mark the
/// one bad field instead of parsing a sentence — and so adding a reason is a
/// compile error at the call site rather than a silently-unhandled message.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditRejection {
    DocumentNotFound { file_id: String },
    KeyNotFound { path: String },
    /// The same top-level key appears more than once. Editing the first would
    /// be silent data loss, so refuse rather than guess.
    AmbiguousKey { path: String, count: usize },
    UnsupportedValue { path: String, reason: OpaqueReason },
    /// A block sequence/mapping cannot be replaced by a scalar.
    UnsupportedShape { path: String },
    MapMemberNotFound { path: String, member: String },
    UnsupportedPath { path: String, reason: String },
    /// Optimistic concurrency, at field granularity.
    ValueMismatch { path: String, expected: String, actual: String },
    /// The proposed value is not safe to splice in verbatim.
    IllegalValue { path: String, reason: String },
    OverlappingEdits { path: String, other: String },
    AlreadyPresent { path: String },
}

// ── Line helpers ────────────────────────────────────────────────────────────

/// Byte range of the line containing `start`, plus its terminator.
struct Line {
    /// Content, terminator excluded.
    content: Range<usize>,
    terminator: &'static str,
}

/// Split a byte range into lines, keeping absolute offsets.
fn lines_of(content: &str, range: Range<usize>) -> Vec<Line> {
    let mut out = Vec::new();
    let mut i = range.start;
    while i < range.end {
        let rel = content[i..range.end].find('\n');
        match rel {
            Some(nl) => {
                let line_end = i + nl;
                let (content_end, terminator) =
                    if line_end > i && content.as_bytes()[line_end - 1] == b'\r' {
                        (line_end - 1, "\r\n")
                    } else {
                        (line_end, "\n")
                    };
                out.push(Line { content: i..content_end, terminator });
                i = line_end + 1;
            }
            None => {
                out.push(Line { content: i..range.end, terminator: "" });
                break;
            }
        }
    }
    out
}

/// Leading-space count, and whether a tab appeared in the indentation.
fn indent_of(s: &str) -> (usize, bool) {
    let mut n = 0;
    let mut tab = false;
    for c in s.chars() {
        if c == ' ' {
            n += 1;
        } else if c == '\t' {
            tab = true;
            n += 1;
        } else {
            break;
        }
    }
    (n, tab)
}

fn is_blank(s: &str) -> bool {
    s.trim().is_empty()
}

// ── Inline value classification ─────────────────────────────────────────────

/// Balanced-delimiter and comment scan over a value.
///
/// Refusing here is cheap and always safe; a false accept writes corruption.
fn classify_inline(value: &str) -> Result<InlineKind, OpaqueReason> {
    let v = value.trim();
    if v.is_empty() {
        return Ok(InlineKind::Empty);
    }
    let first = v.as_bytes()[0];
    if first == b'|' || first == b'>' {
        return Err(OpaqueReason::BlockScalar);
    }
    if first == b'&' || first == b'*' {
        return Err(OpaqueReason::AnchorOrAlias);
    }

    let mut in_single = false;
    let mut in_double = false;
    let mut brace = 0i32;
    let mut bracket = 0i32;
    let mut prev_escape = false;

    for c in v.chars() {
        if in_double {
            if prev_escape {
                prev_escape = false;
            } else if c == '\\' {
                prev_escape = true;
            } else if c == '"' {
                in_double = false;
            }
            continue;
        }
        if in_single {
            // YAML escapes a single quote by doubling it; treating the pair as
            // close-then-open lands in the same state, so no special case.
            if c == '\'' {
                in_single = false;
            }
            continue;
        }
        match c {
            '\'' => in_single = true,
            '"' => in_double = true,
            '{' => brace += 1,
            '}' => brace -= 1,
            '[' => bracket += 1,
            ']' => bracket -= 1,
            '#' => return Err(OpaqueReason::PossibleComment),
            _ => {}
        }
        if brace < 0 || bracket < 0 {
            return Err(OpaqueReason::Unbalanced);
        }
    }

    if in_single || in_double || brace != 0 || bracket != 0 {
        return Err(OpaqueReason::Unbalanced);
    }

    Ok(match first {
        b'{' => InlineKind::InlineMap,
        b'[' => InlineKind::InlineSeq,
        b'\'' => InlineKind::SingleQuoted,
        b'"' => InlineKind::DoubleQuoted,
        _ => InlineKind::Scalar,
    })
}

// ── Entry scanning ──────────────────────────────────────────────────────────

/// Match `key:` at the start of a line's content, returning (key, offset after colon).
fn match_key(line: &str) -> Option<(String, usize)> {
    let trimmed = line.trim_start();
    let lead = line.len() - trimmed.len();
    let mut chars = trimmed.char_indices();
    let (_, first) = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let mut end = first.len_utf8();
    for (i, c) in chars {
        if c.is_ascii_alphanumeric() || c == '_' {
            end = i + c.len_utf8();
        } else {
            break;
        }
    }
    if trimmed.as_bytes().get(end) != Some(&b':') {
        return None;
    }
    Some((trimmed[..end].to_string(), lead + end + 1))
}

/// Scan every top-level entry of one document body.
///
/// This walks the WHOLE body sequentially rather than searching for a key, and
/// that is the point: a block value consumes its own continuation lines as it
/// is scanned, so a nested `    damage: 999` can never be mistaken for the
/// top-level `damage: 12`. A "find the key" implementation cannot make that
/// guarantee, and would also miss duplicate keys and key order — both of which
/// fall out of a sequential scan for free.
pub fn scan_entries(content: &str, body: Range<usize>) -> Vec<Entry> {
    let lines = lines_of(content, body);

    // Unity documents are a single root mapping (`MonoBehaviour:`) whose entries
    // sit one level in. Detect that level rather than assuming two spaces.
    let mut base_indent: Option<usize> = None;
    for line in &lines {
        let text = &content[line.content.clone()];
        if is_blank(text) {
            continue;
        }
        let (indent, _) = indent_of(text);
        if indent == 0 {
            continue; // the root mapping line itself
        }
        if match_key(text).is_some() {
            base_indent = Some(indent);
            break;
        }
    }
    let base = match base_indent {
        Some(b) => b,
        None => return Vec::new(),
    };

    let mut entries: Vec<Entry> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let line = &lines[i];
        let text = &content[line.content.clone()];
        if is_blank(text) {
            i += 1;
            continue;
        }
        let (indent, has_tab) = indent_of(text);
        if indent != base {
            i += 1;
            continue;
        }
        let (key, after_colon_rel) = match match_key(text) {
            Some(k) => k,
            None => {
                i += 1;
                continue;
            }
        };

        let line_start = line.content.start;
        let key_start = line_start + indent;
        let key_span = key_start..key_start + key.len();
        let after_colon = line_start + after_colon_rel;
        let rest = &content[after_colon..line.content.end];

        // Gather continuation lines: anything more indented, or a `- ` item at
        // the same indent (YAML's block-sequence-under-a-key form).
        let mut last_content_line = i;
        let mut j = i + 1;
        let mut saw_continuation = false;
        let mut block_kind = BlockKind::Mapping;
        while j < lines.len() {
            let next = &lines[j];
            let next_text = &content[next.content.clone()];
            if is_blank(next_text) {
                j += 1;
                continue;
            }
            let (next_indent, _) = indent_of(next_text);
            let is_seq_item = next_indent == base && next_text.trim_start().starts_with('-');
            if next_indent > base || is_seq_item {
                if !saw_continuation {
                    block_kind = if is_seq_item { BlockKind::Sequence } else { BlockKind::Mapping };
                }
                saw_continuation = true;
                last_content_line = j;
                j += 1;
                continue;
            }
            break;
        }

        let entry_end = lines[last_content_line].content.end;
        let terminator = lines[last_content_line].terminator;

        let value = if has_tab {
            ValueSpan::Opaque { span: after_colon..line.content.end, reason: OpaqueReason::TabIndent }
        } else if rest.trim().is_empty() && saw_continuation {
            ValueSpan::Block {
                span: lines[i + 1].content.start..entry_end,
                kind: block_kind,
            }
        } else {
            match classify_inline(rest) {
                Ok(kind) => {
                    let lead_ws = rest.len() - rest.trim_start().len();
                    let start = after_colon + lead_ws;
                    let end = start + rest.trim().len();
                    ValueSpan::Inline {
                        span: start..end,
                        kind,
                        needs_space_before: lead_ws == 0,
                    }
                }
                Err(reason) => ValueSpan::Opaque {
                    span: after_colon..line.content.end,
                    reason,
                },
            }
        };

        entries.push(Entry {
            key,
            key_span,
            value,
            entry_span: line_start..entry_end,
            indent,
            terminator,
        });

        i = if saw_continuation { last_content_line + 1 } else { i + 1 };
    }

    entries
}

// ── Paths ───────────────────────────────────────────────────────────────────

/// Which part of an entry an edit addresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldPath {
    /// The whole value: `damage`.
    Whole(String),
    /// One member of an inline map: `tint.g`, `icon.guid`.
    MapMember { key: String, member: String },
}

/// Parse an edit path.
///
/// Unity's own `data.Array.data[0]` propertyPath syntax is deliberately
/// REFUSED rather than half-supported: array element editing needs
/// insert/remove/reorder semantics, and a partial implementation here would
/// look like it worked.
pub fn parse_field_path(path: &str) -> Result<FieldPath, EditRejection> {
    if path.is_empty() {
        return Err(EditRejection::UnsupportedPath {
            path: path.to_string(),
            reason: "empty path".into(),
        });
    }
    if path.contains('[') || path.contains(']') {
        return Err(EditRejection::UnsupportedPath {
            path: path.to_string(),
            reason: "array element paths are not supported yet".into(),
        });
    }
    let parts: Vec<&str> = path.split('.').collect();
    match parts.len() {
        1 => Ok(FieldPath::Whole(parts[0].to_string())),
        2 => Ok(FieldPath::MapMember {
            key: parts[0].to_string(),
            member: parts[1].to_string(),
        }),
        _ => Err(EditRejection::UnsupportedPath {
            path: path.to_string(),
            reason: "only one level of nesting is supported".into(),
        }),
    }
}

/// A resolved edit site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Byte range to replace.
    pub span: Range<usize>,
    /// Current text in that range.
    pub current: String,
    /// True when a space must precede the written value.
    pub needs_space_before: bool,
}

/// Find `member:` inside an inline map, returning the span of just its value.
fn locate_map_member(
    content: &str,
    map_span: Range<usize>,
    member: &str,
) -> Option<Range<usize>> {
    let text = &content[map_span.clone()];
    // Walk at depth 1 inside the outer braces, honouring nesting and quotes.
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0usize;
    let mut token_start: Option<usize> = None;

    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_double {
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if in_single {
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        match c {
            '"' => in_double = true,
            '\'' => in_single = true,
            '{' | '[' => {
                depth += 1;
                token_start = None;
            }
            '}' | ']' => depth -= 1,
            ',' if depth == 1 => token_start = None,
            _ => {}
        }
        if depth == 1 && token_start.is_none() && (c.is_ascii_alphanumeric() || c == '_') {
            token_start = Some(i);
        }
        if depth == 1 && c == ':' {
            if let Some(start) = token_start.take() {
                if &text[start..i] == member {
                    // Value runs to the next depth-1 comma or the closing brace.
                    let mut k = i + 1;
                    let mut d = depth;
                    let mut s = false;
                    let mut dq = false;
                    while k < bytes.len() {
                        let cc = bytes[k] as char;
                        if dq {
                            if cc == '"' {
                                dq = false;
                            }
                            k += 1;
                            continue;
                        }
                        if s {
                            if cc == '\'' {
                                s = false;
                            }
                            k += 1;
                            continue;
                        }
                        match cc {
                            '"' => dq = true,
                            '\'' => s = true,
                            '{' | '[' => d += 1,
                            '}' | ']' => {
                                d -= 1;
                                if d < 1 {
                                    break;
                                }
                            }
                            ',' if d == 1 => break,
                            _ => {}
                        }
                        k += 1;
                    }
                    let raw = &text[i + 1..k];
                    let lead = raw.len() - raw.trim_start().len();
                    let value_start = map_span.start + i + 1 + lead;
                    let value_end = value_start + raw.trim().len();
                    return Some(value_start..value_end);
                }
            }
        }
        i += 1;
    }
    None
}

/// Resolve a path against a scanned document.
pub fn resolve_target(
    content: &str,
    entries: &[Entry],
    path: &FieldPath,
) -> Result<Target, EditRejection> {
    let (key, member) = match path {
        FieldPath::Whole(k) => (k.as_str(), None),
        FieldPath::MapMember { key, member } => (key.as_str(), Some(member.as_str())),
    };
    let path_str = match path {
        FieldPath::Whole(k) => k.clone(),
        FieldPath::MapMember { key, member } => format!("{key}.{member}"),
    };

    let matches: Vec<&Entry> = entries.iter().filter(|e| e.key == key).collect();
    if matches.is_empty() {
        return Err(EditRejection::KeyNotFound { path: path_str });
    }
    if matches.len() > 1 {
        // Guessing which duplicate the user meant is silent data loss.
        return Err(EditRejection::AmbiguousKey { path: path_str, count: matches.len() });
    }
    let entry = matches[0];

    match (&entry.value, member) {
        (ValueSpan::Opaque { reason, .. }, _) => Err(EditRejection::UnsupportedValue {
            path: path_str,
            reason: *reason,
        }),
        (ValueSpan::Block { .. }, _) => Err(EditRejection::UnsupportedShape { path: path_str }),
        (ValueSpan::Inline { span, kind, needs_space_before }, None) => Ok(Target {
            span: span.clone(),
            current: content[span.clone()].to_string(),
            needs_space_before: *needs_space_before && *kind == InlineKind::Empty,
        }),
        (ValueSpan::Inline { span, kind, .. }, Some(m)) => {
            if *kind != InlineKind::InlineMap {
                return Err(EditRejection::UnsupportedPath {
                    path: path_str,
                    reason: "member path on a value that is not an inline map".into(),
                });
            }
            match locate_map_member(content, span.clone(), m) {
                Some(r) => Ok(Target {
                    span: r.clone(),
                    current: content[r].to_string(),
                    needs_space_before: false,
                }),
                None => Err(EditRejection::MapMemberNotFound {
                    path: path_str,
                    member: m.to_string(),
                }),
            }
        }
    }
}

// ── Value validation and encoding ───────────────────────────────────────────

/// Reject a replacement value that could not be spliced in safely.
///
/// The single most important safety net here: without it, a UI bug that hands
/// over a multi-line string turns one field edit into a structurally broken
/// asset, and Unity's loader will simply drop everything after the break.
pub fn validate_raw_value(path: &str, value: &str) -> Result<(), EditRejection> {
    let bad = |reason: &str| {
        Err(EditRejection::IllegalValue {
            path: path.to_string(),
            reason: reason.to_string(),
        })
    };
    if value.contains('\n') || value.contains('\r') {
        return bad("value contains a line break");
    }
    if value != value.trim() {
        return bad("value has leading or trailing whitespace");
    }
    if value.is_empty() {
        return Ok(());
    }
    match classify_inline(value) {
        Ok(_) => Ok(()),
        Err(OpaqueReason::PossibleComment) => bad("value contains a '#' comment marker"),
        Err(OpaqueReason::BlockScalar) => bad("value starts with a block-scalar indicator"),
        Err(OpaqueReason::AnchorOrAlias) => bad("value starts with an anchor or alias marker"),
        Err(OpaqueReason::Unbalanced) => bad("value has unbalanced quotes or brackets"),
        Err(OpaqueReason::TabIndent) => bad("value contains a tab"),
    }
}

/// Encode a logical string the way Unity writes one.
///
/// Plain when it is unambiguous, single-quoted (with `'` doubled) otherwise.
/// Exists in Rust rather than TS so the rule is covered by the same tests as
/// the writer that depends on it.
pub fn encode_yaml_string(value: &str) -> String {
    let needs_quotes = value.is_empty()
        || value != value.trim()
        || value.contains(['\'', '"', ':', '#', ',', '{', '}', '[', ']', '\n', '\r', '\t'])
        || matches!(
            value.as_bytes()[0],
            b'|' | b'>' | b'&' | b'*' | b'!' | b'%' | b'@' | b'`' | b'-' | b'?'
        )
        || value.eq_ignore_ascii_case("yes")
        || value.eq_ignore_ascii_case("no")
        || value.eq_ignore_ascii_case("true")
        || value.eq_ignore_ascii_case("false")
        || value.eq_ignore_ascii_case("null")
        || value.eq_ignore_ascii_case("~")
        || value.parse::<f64>().is_ok();

    if !needs_quotes {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "''"))
}

// ── Document lookup ─────────────────────────────────────────────────────────

/// Body span of the document with the given `&fileID` anchor.
///
/// The anchor is always explicit, never "the only document": the same payload
/// has to work for a MonoBehaviour inside a prefab, and an implicit rule would
/// silently pick the wrong document on a multi-document `.asset`.
pub fn document_body(content: &str, file_id: &str) -> Option<Range<usize>> {
    split_document_spans(content)
        .1
        .into_iter()
        .find(|d| d.file_id == file_id)
        .map(|d| d.body)
}

/// The first MonoBehaviour (classId 114) document, which is what a
/// ScriptableObject `.asset` holds.
pub fn primary_document(content: &str) -> Option<(String, Range<usize>)> {
    split_document_spans(content)
        .1
        .into_iter()
        .find(|d| d.class_id == "114")
        .map(|d| (d.file_id, d.body))
}

// ── Reading: a lossless, span-derived snapshot ──────────────────────────────

/// Wire tag for a value's shape, so the inspector can pick a control without
/// re-parsing YAML in TypeScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    Scalar,
    Quoted,
    InlineMap,
    InlineSeq,
    Empty,
    Block,
    Opaque,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldValue {
    pub key: String,
    /// Verbatim value text — exactly the bytes on disk, quotes included.
    pub raw: String,
    pub kind: ValueKind,
    /// False when this module refuses to rewrite the value.
    pub editable: bool,
    /// Why it is not editable, when it is not.
    pub reason: Option<OpaqueReason>,
    /// Members of an inline map, in file order, so a Vector3/Color widget can
    /// bind each component without parsing braces in the frontend.
    pub members: Vec<FieldMember>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldMember {
    pub name: String,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSnapshot {
    pub document_file_id: String,
    pub class_id: String,
    /// The `m_Script` guid, i.e. which C# class this asset is an instance of.
    pub script_guid: Option<String>,
    pub fields: Vec<FieldValue>,
    /// Content hash at read time, echoed back on write as a concurrency token.
    pub sha1: String,
}

/// SHA-1 of the file's bytes, hex encoded.
fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Member names and values of an inline map, in file order.
fn map_members(content: &str, span: Range<usize>) -> Vec<FieldMember> {
    let text = &content[span.clone()];
    let mut out = Vec::new();
    // Reuse the single-member locator so read and write agree on where a
    // member's bytes are.
    let mut seen = std::collections::HashSet::new();
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut token: Option<usize> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '{' | '[' => {
                depth += 1;
                token = None;
            }
            '}' | ']' => depth -= 1,
            ',' if depth == 1 => token = None,
            _ => {}
        }
        if depth == 1 && token.is_none() && (c.is_ascii_alphanumeric() || c == '_') {
            token = Some(i);
        }
        if depth == 1 && c == ':' {
            if let Some(start) = token.take() {
                let name = text[start..i].to_string();
                if seen.insert(name.clone()) {
                    if let Some(r) = locate_map_member(content, span.clone(), &name) {
                        out.push(FieldMember { name, raw: content[r].to_string() });
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// Build the snapshot for one document.
pub fn snapshot(content: &str, file_id: Option<&str>) -> Result<AssetSnapshot, String> {
    let (doc_file_id, body, class_id) = match file_id {
        Some(id) => {
            let (_, docs) = split_document_spans(content);
            let d = docs
                .into_iter()
                .find(|d| d.file_id == id)
                .ok_or_else(|| format!("no document with fileID {id}"))?;
            (d.file_id, d.body, d.class_id)
        }
        None => {
            let (_, docs) = split_document_spans(content);
            let d = docs
                .into_iter()
                .find(|d| d.class_id == "114")
                .ok_or_else(|| "no MonoBehaviour document in this asset".to_string())?;
            (d.file_id, d.body, d.class_id)
        }
    };

    let entries = scan_entries(content, body);
    let script_guid = crate::unity_yaml::extract_guid_refs(content).into_iter().next();

    let fields = entries
        .iter()
        .map(|e| {
            let (raw, kind, editable, reason) = match &e.value {
                ValueSpan::Inline { span, kind, .. } => {
                    let k = match kind {
                        InlineKind::Scalar => ValueKind::Scalar,
                        InlineKind::SingleQuoted | InlineKind::DoubleQuoted => ValueKind::Quoted,
                        InlineKind::InlineMap => ValueKind::InlineMap,
                        InlineKind::InlineSeq => ValueKind::InlineSeq,
                        InlineKind::Empty => ValueKind::Empty,
                    };
                    (content[span.clone()].to_string(), k, true, None)
                }
                ValueSpan::Block { span, .. } => {
                    (content[span.clone()].to_string(), ValueKind::Block, false, None)
                }
                ValueSpan::Opaque { span, reason } => (
                    content[span.clone()].to_string(),
                    ValueKind::Opaque,
                    false,
                    Some(*reason),
                ),
            };
            let members = match &e.value {
                ValueSpan::Inline { span, kind: InlineKind::InlineMap, .. } => {
                    map_members(content, span.clone())
                }
                _ => Vec::new(),
            };
            FieldValue { key: e.key.clone(), raw, kind, editable, reason, members }
        })
        .collect();

    Ok(AssetSnapshot {
        document_file_id: doc_file_id,
        class_id,
        script_guid,
        fields,
        sha1: sha1_hex(content.as_bytes()),
    })
}

// ── Writing: plan, then splice ──────────────────────────────────────────────

/// Outcome of applying a batch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEditResult {
    pub written: bool,
    /// True when every edit was a no-op, so the file was left alone entirely.
    pub unchanged: bool,
    pub rejections: Vec<EditRejection>,
    /// Hash after the write, to feed back as the next call's `expectedSha1`.
    pub sha1: String,
    /// The written path in this app's canonical spelling.
    pub path: String,
}

/// Resolve and splice a batch of edits into `content`.
///
/// All-or-nothing: every edit is resolved first and EVERY rejection collected
/// (not just the first, so the inspector can flag all the bad fields at once).
/// If any fails, nothing is written.
pub fn apply_edits_to_text(
    content: &str,
    edits: &[AssetEdit],
) -> Result<String, Vec<EditRejection>> {
    let mut rejections = Vec::new();
    let mut planned: Vec<(Range<usize>, String, String)> = Vec::new();

    // Scan each touched document once.
    let mut scanned: std::collections::HashMap<String, Vec<Entry>> =
        std::collections::HashMap::new();

    for edit in edits {
        let entries = match scanned.get(&edit.file_id) {
            Some(e) => e,
            None => {
                let body = match document_body(content, &edit.file_id) {
                    Some(b) => b,
                    None => {
                        rejections.push(EditRejection::DocumentNotFound {
                            file_id: edit.file_id.clone(),
                        });
                        continue;
                    }
                };
                scanned.insert(edit.file_id.clone(), scan_entries(content, body));
                scanned.get(&edit.file_id).expect("just inserted")
            }
        };

        let path = match parse_field_path(&edit.path) {
            Ok(p) => p,
            Err(r) => {
                rejections.push(r);
                continue;
            }
        };

        if edit.remove {
            let key = match &path {
                FieldPath::Whole(k) => k.clone(),
                FieldPath::MapMember { .. } => {
                    rejections.push(EditRejection::UnsupportedPath {
                        path: edit.path.clone(),
                        reason: "cannot remove one member of an inline map".into(),
                    });
                    continue;
                }
            };
            let matches: Vec<&Entry> = entries.iter().filter(|e| e.key == key).collect();
            if matches.is_empty() {
                rejections.push(EditRejection::KeyNotFound { path: edit.path.clone() });
                continue;
            }
            if matches.len() > 1 {
                rejections.push(EditRejection::AmbiguousKey {
                    path: edit.path.clone(),
                    count: matches.len(),
                });
                continue;
            }
            if let Some(expected) = &edit.expected {
                let current = match &matches[0].value {
                    ValueSpan::Inline { span, .. } => content[span.clone()].to_string(),
                    ValueSpan::Block { span, .. } => content[span.clone()].to_string(),
                    ValueSpan::Opaque { span, .. } => content[span.clone()].to_string(),
                };
                if &current != expected {
                    rejections.push(EditRejection::ValueMismatch {
                        path: edit.path.clone(),
                        expected: expected.clone(),
                        actual: current,
                    });
                    continue;
                }
            }
            planned.push((removal_span(content, matches[0]), String::new(), edit.path.clone()));
            continue;
        }
        let target = match resolve_target(content, entries, &path) {
            Ok(t) => t,
            Err(EditRejection::KeyNotFound { path: p }) => {
                // Not there yet — insert it, if the caller said where.
                let key = match &path {
                    FieldPath::Whole(k) => k.clone(),
                    // A member path needs its parent map to exist first.
                    FieldPath::MapMember { .. } => {
                        rejections.push(EditRejection::KeyNotFound { path: p });
                        continue;
                    }
                };
                if let Err(r) = validate_raw_value(&edit.path, &edit.value) {
                    rejections.push(r);
                    continue;
                }
                match plan_insertion(entries, &key, &edit.value, &edit.if_missing) {
                    Some((span, text)) => {
                        planned.push((span, text, edit.path.clone()));
                        continue;
                    }
                    None => {
                        rejections.push(EditRejection::KeyNotFound { path: p });
                        continue;
                    }
                }
            }
            Err(r) => {
                rejections.push(r);
                continue;
            }
        };
        if let Some(expected) = &edit.expected {
            if &target.current != expected {
                rejections.push(EditRejection::ValueMismatch {
                    path: edit.path.clone(),
                    expected: expected.clone(),
                    actual: target.current.clone(),
                });
                continue;
            }
        }
        if let Err(r) = validate_raw_value(&edit.path, &edit.value) {
            rejections.push(r);
            continue;
        }

        let replacement = if target.needs_space_before {
            format!(" {}", edit.value)
        } else {
            edit.value.clone()
        };
        planned.push((target.span, replacement, edit.path.clone()));
    }

    if !rejections.is_empty() {
        return Err(rejections);
    }

    // A rename is "insert the new key, remove the old one", and the natural
    // anchor for the insertion is the key being removed — so the insertion
    // point lands INSIDE the removal span. That is not a conflict, it is
    // "the new line takes the old line's place", so merge the pair into one
    // replacement rather than making every caller dodge the overlap.
    let mut merged: Vec<usize> = Vec::new();
    for i in 0..planned.len() {
        let (ins_span, ins_text, _) = &planned[i];
        if ins_span.start != ins_span.end {
            continue; // not an insertion
        }
        let point = ins_span.start;
        let host = planned.iter().position(|(span, text, _)| {
            text.is_empty() && span.start != span.end && point > span.start && point <= span.end
        });
        if let Some(h) = host {
            // Rebuild the line to match the REMOVED span's own shape. A normal
            // entry is `line + terminator`, but the last entry of a file with
            // no trailing newline is `preceding-newline + line` — assuming the
            // first form there moved the newline to the wrong end and joined
            // two keys onto one line.
            let removed = &content[planned[h].0.clone()];
            let lead = if removed.starts_with("\r\n") {
                "\r\n"
            } else if removed.starts_with('\n') {
                "\n"
            } else {
                ""
            };
            let tail = if removed.len() > lead.len() {
                if removed.ends_with("\r\n") {
                    "\r\n"
                } else if removed.ends_with('\n') {
                    "\n"
                } else {
                    ""
                }
            } else {
                ""
            };
            // Strip whichever terminator `plan_insertion` prefixed; the shape
            // above decides where it goes.
            let text = ins_text.clone();
            let body = text
                .strip_prefix("\r\n")
                .or_else(|| text.strip_prefix('\n'))
                .unwrap_or(text.as_str());
            planned[h].1 = format!("{lead}{body}{tail}");
            merged.push(i);
        }
    }
    // Drop the merged insertions, highest index first so the rest stay valid.
    merged.sort_unstable_by(|a, b| b.cmp(a));
    for i in merged {
        planned.remove(i);
    }

    // Overlapping spans mean two edits fight over the same bytes — which also
    // catches the same key being edited twice in one batch.
    let mut sorted: Vec<usize> = (0..planned.len()).collect();
    sorted.sort_by_key(|&i| planned[i].0.start);
    for w in sorted.windows(2) {
        let (a, b) = (&planned[w[0]], &planned[w[1]]);
        if a.0.end > b.0.start && a.0.start != a.0.end {
            return Err(vec![EditRejection::OverlappingEdits {
                path: a.2.clone(),
                other: b.2.clone(),
            }]);
        }
    }

    // Splice DESCENDING by offset: applying front-to-back invalidates every
    // span after the first.
    let mut out = content.to_string();
    let mut order: Vec<usize> = (0..planned.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(planned[i].0.start));
    for i in order {
        let (span, replacement, _) = &planned[i];
        out.replace_range(span.clone(), replacement);
    }
    Ok(out)
}

/// What to do when the key is not in the asset yet.
///
/// A field added to the C# class after the asset was authored simply is not in
/// the file; Unity supplies the default at load. Writing it means INSERTING a
/// line, which needs an anchor — and Rust does not parse C#, so the frontend
/// (which already has the schema) names the previously declared serialized
/// field. That keeps the file in Unity's own serialization order.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum IfMissing {
    #[default]
    Reject,
    /// Insert directly after this sibling key; falls back to the end of the
    /// document when the anchor itself is absent.
    InsertAfter { anchor: String },
    /// Append after the document's last top-level entry.
    InsertAtEnd,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEdit {
    /// `&fileID` anchor of the document to edit.
    pub file_id: String,
    /// `damage`, or `tint.g` for one member of an inline map.
    pub path: String,
    /// The exact bytes to write.
    pub value: String,
    /// Refuse unless the current on-disk value is byte-equal to this.
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub if_missing: IfMissing,
    /// Delete the key outright instead of writing a value.
    ///
    /// Needed because a field rename is insert-new + delete-old, and both must
    /// land in the same atomic write or a crash between them loses the value.
    #[serde(default)]
    pub remove: bool,
}

/// Byte range to cut when removing an entry: the whole entry plus its line
/// terminator, so no blank line is left behind.
///
/// At EOF the entry has no terminator, so the PRECEDING newline is consumed
/// instead — otherwise deleting the last key would leave a dangling blank line
/// and change the file's trailing-newline shape.
fn removal_span(content: &str, entry: &Entry) -> Range<usize> {
    if !entry.terminator.is_empty() {
        return entry.entry_span.start..entry.entry_span.end + entry.terminator.len();
    }
    let mut start = entry.entry_span.start;
    let bytes = content.as_bytes();
    if start > 0 && bytes[start - 1] == b'\n' {
        start -= 1;
        if start > 0 && bytes[start - 1] == b'\r' {
            start -= 1;
        }
    }
    start..entry.entry_span.end
}

/// Where and what to insert for a key that is not in the document yet.
///
/// Returned as a zero-length span plus text, so insertion joins the same
/// descending-splice pass as every replacement and needs no separate path.
fn plan_insertion(
    entries: &[Entry],
    key: &str,
    value: &str,
    if_missing: &IfMissing,
) -> Option<(Range<usize>, String)> {
    if entries.is_empty() {
        return None;
    }
    let anchor = match if_missing {
        IfMissing::Reject => return None,
        IfMissing::InsertAfter { anchor } => entries
            .iter()
            .find(|e| &e.key == anchor)
            .or_else(|| entries.last())?,
        IfMissing::InsertAtEnd => entries.last()?,
    };

    // Copy the anchor's indent and terminator verbatim: that is what makes the
    // inserted line correct in a CRLF file with no special-casing.
    let indent = " ".repeat(anchor.indent);
    // At EOF the anchor has no terminator. Using "\n" there puts the new line
    // last and leaves the file still ending without a trailing newline.
    let terminator = if anchor.terminator.is_empty() { "\n" } else { anchor.terminator };
    let at = anchor.entry_span.end;
    Some((at..at, format!("{terminator}{indent}{key}: {value}")))
}

// ── Project-wide ScriptableObject inventory ─────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoInstanceRef {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoTypeGroup {
    /// `.meta` guid of the C# script these assets instance.
    pub script_guid: String,
    /// Absolute path of the script, when the index can resolve it.
    pub script_path: Option<String>,
    /// Class name. Unity requires the file stem to match the class name for a
    /// script to be assignable, so the stem is the class name in practice.
    pub type_name: String,
    pub instances: Vec<SoInstanceRef>,
}

/// True when a script path is the user's own code rather than a package's.
///
/// The index walks only `Assets/` and `Packages/`; a registry package lives in
/// `Library/PackageCache`, which is not walked. So a guid that resolves is
/// project-local by construction — this check is belt-and-braces, and documents
/// the intent if the indexed roots ever change.
fn is_project_script(workspace: &str, script_path: &str) -> bool {
    let ws = workspace.trim_end_matches('/');
    let rel = script_path.strip_prefix(ws).unwrap_or(script_path);
    let rel = rel.trim_start_matches('/');
    (rel.starts_with("Assets/") || rel.starts_with("Packages/"))
        && !rel.contains("/PackageCache/")
        && script_path.to_lowercase().ends_with(".cs")
}

/// Every ScriptableObject type in the project that has at least one asset.
///
/// Derived from the GUID index rather than a fresh walk: `path_to_guid` already
/// knows every asset with a `.meta`, so this reads only the `.asset` files and
/// resolves each one's `m_Script` guid back to its script.
///
/// Types with no instances are absent by construction. That is the right
/// default for a browser — a `[CreateAssetMenu]` class nobody has instanced yet
/// has nothing to browse — and it keeps the cost proportional to assets on disk
/// rather than to scripts in the project.
///
/// Types whose script is NOT the user's own code are also absent. A Unity
/// project is full of `.asset` files owned by packages — input actions, TMP
/// settings, render-pipeline assets — whose `m_Script` points into
/// `Library/PackageCache` and therefore never resolves. Listing those as
/// `guid 2ec4…` is noise: they are not the user's data model, and they are not
/// editable as one.
#[tauri::command(async)]
pub fn unity_scriptable_object_types(workspace_path: String) -> Result<Vec<SoTypeGroup>, String> {
    let state = crate::unity_index::get_or_build(&workspace_path);

    let mut by_script: std::collections::HashMap<String, Vec<SoInstanceRef>> =
        std::collections::HashMap::new();

    for asset_path in state.path_to_guid.keys() {
        if !asset_path.to_lowercase().ends_with(".asset") {
            continue;
        }
        let content = match std::fs::read_to_string(asset_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Only a MonoBehaviour document carries an m_Script guid; a settings
        // asset (classId 1001 and friends) has none and is skipped.
        let script_guid = match script_guid_of(&content) {
            Some(g) => g,
            None => continue,
        };
        let name = std::path::Path::new(asset_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| asset_path.clone());
        by_script
            .entry(script_guid)
            .or_default()
            .push(SoInstanceRef { path: asset_path.clone(), name });
    }

    let mut groups: Vec<SoTypeGroup> = by_script
        .into_iter()
        .filter_map(|(script_guid, mut instances)| {
            // Unresolvable => the script lives in a package, not this project.
            let script_path = state.guid_to_path.get(&script_guid)?.clone();
            if !is_project_script(&workspace_path, &script_path) {
                return None;
            }
            instances.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            let type_name = std::path::Path::new(&script_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())?;
            Some(SoTypeGroup {
                script_guid,
                script_path: Some(script_path),
                type_name,
                instances,
            })
        })
        .collect();

    groups.sort_by(|a, b| a.type_name.to_lowercase().cmp(&b.type_name.to_lowercase()));
    Ok(groups)
}

/// The `m_Script` guid of the first MonoBehaviour document, if any.
fn script_guid_of(content: &str) -> Option<String> {
    let (_, docs) = split_document_spans(content);
    let doc = docs.iter().find(|d| d.class_id == "114")?;
    let body = content.get(doc.body.clone())?;
    let idx = body.find("m_Script:")?;
    let rest = &body[idx..];
    let end = rest.find('\n').unwrap_or(rest.len());
    let line = &rest[..end];
    let g = line.find("guid:")? + "guid:".len();
    let tail = line[g..].trim_start();
    let hex: String = tail.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() == 32 {
        Some(hex)
    } else {
        None
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Serialises asset writes within this process.
///
/// Two windows can have the same asset open. Asset edits are rare and tiny, so
/// serialising them costs nothing and closes the in-process race entirely;
/// cross-process (Unity re-serialising) is covered by `expected_sha1` plus the
/// atomicity of the rename.
static ASSET_WRITE_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

fn write_lock() -> &'static std::sync::Mutex<()> {
    ASSET_WRITE_LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// Read one document's fields, losslessly, with a concurrency token.
#[tauri::command(async)]
pub fn unity_asset_read_fields(
    path: String,
    file_id: Option<String>,
) -> Result<AssetSnapshot, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    snapshot(&content, file_id.as_deref())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSnapshotAt {
    pub path: String,
    pub snapshot: AssetSnapshot,
}

/// Read many assets in one call, for whole-type analysis (schema drift).
///
/// One command rather than N round trips: the drift report reads every instance
/// of a type, and doing that as one invoke per asset makes a 40-weapon project
/// forty IPC hops. Unreadable or non-ScriptableObject files are skipped rather
/// than failing the batch — a broken asset should not hide the other 39.
#[tauri::command(async)]
pub fn unity_asset_read_many(paths: Vec<String>) -> Vec<AssetSnapshotAt> {
    paths
        .into_iter()
        .filter_map(|path| {
            let content = std::fs::read_to_string(&path).ok()?;
            let snapshot = snapshot(&content, None).ok()?;
            Some(AssetSnapshotAt { path, snapshot })
        })
        .collect()
}

/// Apply field edits atomically and byte-exactly.
#[tauri::command(async)]
pub fn unity_asset_apply_edits(
    path: String,
    edits: Vec<AssetEdit>,
    expected_sha1: Option<String>,
) -> Result<AssetEditResult, String> {
    let _guard = crate::sync_util::lock_recover(write_lock());

    let original = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let ui_path = crate::path_util::to_ui_path(&path);

    // Guard the real hazard: Unity re-serialised the asset while the inspector
    // was showing a stale copy.
    if let Some(expected) = &expected_sha1 {
        let actual = sha1_hex(original.as_bytes());
        if &actual != expected {
            return Err(format!(
                "{ui_path} changed on disk since it was read — reload before saving"
            ));
        }
    }

    let updated = match apply_edits_to_text(&original, &edits) {
        Ok(text) => text,
        Err(rejections) => {
            return Ok(AssetEditResult {
                written: false,
                unchanged: false,
                rejections,
                sha1: sha1_hex(original.as_bytes()),
                path: ui_path,
            })
        }
    };

    // A no-op batch must not touch the file at all: no mtime bump, no watcher
    // event, no Unity reimport.
    if updated == original {
        return Ok(AssetEditResult {
            written: false,
            unchanged: true,
            rejections: Vec::new(),
            sha1: sha1_hex(original.as_bytes()),
            path: ui_path,
        });
    }

    crate::fs_atomic::write_atomic(std::path::Path::new(&path), updated.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(AssetEditResult {
        written: true,
        unchanged: false,
        rejections: Vec::new(),
        sha1: sha1_hex(updated.as_bytes()),
        path: ui_path,
    })
}

#[cfg(test)]
mod tests;
