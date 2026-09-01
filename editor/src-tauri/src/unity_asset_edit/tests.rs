// Locator tests. The scanner is the load-bearing half of byte-exact editing:
// if it points at the wrong bytes, every guarantee above it is void.

use super::*;

fn fixture(name: &str) -> String {
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/unity-yaml");
    std::fs::read_to_string(base.join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"))
}

fn weapon() -> String {
    fixture("Weapon.asset")
}

fn entries_of(content: &str) -> Vec<Entry> {
    let (file_id, body) = primary_document(content).expect("a MonoBehaviour document");
    assert_eq!(file_id, "11400000");
    scan_entries(content, body)
}

fn entry<'a>(entries: &'a [Entry], key: &str) -> &'a Entry {
    entries.iter().find(|e| e.key == key).unwrap_or_else(|| panic!("no entry {key}"))
}

fn value_text<'a>(content: &'a str, e: &Entry) -> &'a str {
    match &e.value {
        ValueSpan::Inline { span, .. } => &content[span.clone()],
        ValueSpan::Block { span, .. } => &content[span.clone()],
        ValueSpan::Opaque { span, .. } => &content[span.clone()],
    }
}

fn crlf(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn no_final_newline(s: &str) -> String {
    s.trim_end_matches(['\n', '\r']).to_string()
}

// ── Scanning ────────────────────────────────────────────────────────────────

#[test]
fn finds_every_top_level_key_in_order() {
    let c = weapon();
    let keys: Vec<String> = entries_of(&c).into_iter().map(|e| e.key).collect();
    assert_eq!(
        keys,
        vec![
            "m_ObjectHideFlags",
            "m_CorrespondingSourceObject",
            "m_PrefabInstance",
            "m_GameObject",
            "m_Enabled",
            "m_EditorHideFlags",
            "m_Script",
            "m_Name",
            "m_EditorClassIdentifier",
            "displayName",
            "damage",
            "attackSpeed",
            "quotedName",
            "rarity",
            "dropsAmmo",
            "tint",
            "icon",
            "tags",
            "resistances",
            "nested",
            "trailingSpaces",
        ]
    );
}

#[test]
fn locates_a_plain_scalar() {
    let c = weapon();
    let e = entries_of(&c);
    assert_eq!(value_text(&c, entry(&e, "damage")), "12");
    assert_eq!(value_text(&c, entry(&e, "attackSpeed")), "1.35");
}

#[test]
fn nested_line_is_not_mistaken_for_a_top_level_key() {
    // `nested:` contains `    damage: 999`. A "find the key" locator would hit
    // it; a sequential scan consumes it as part of the block value.
    let c = weapon();
    let e = entries_of(&c);
    assert_eq!(value_text(&c, entry(&e, "damage")), "12");
    assert_eq!(e.iter().filter(|x| x.key == "damage").count(), 1);
}

#[test]
fn locates_an_inline_map_verbatim() {
    let c = weapon();
    let e = entries_of(&c);
    assert_eq!(
        value_text(&c, entry(&e, "tint")),
        "{r: 1, g: 0.5, b: 0, a: 1}"
    );
    assert!(value_text(&c, entry(&e, "icon")).starts_with("{fileID: 21300000, guid: "));
}

#[test]
fn locates_a_single_quoted_value_including_its_quotes() {
    let c = weapon();
    let e = entries_of(&c);
    let q = entry(&e, "quotedName");
    assert_eq!(value_text(&c, q), "'Sword ''of'' Truth'");
    assert!(matches!(
        q.value,
        ValueSpan::Inline { kind: InlineKind::SingleQuoted, .. }
    ));
}

#[test]
fn an_empty_value_is_a_zero_length_span() {
    let c = weapon();
    let e = entries_of(&c);
    let ec = entry(&e, "m_EditorClassIdentifier");
    match &ec.value {
        ValueSpan::Inline { span, kind, .. } => {
            assert_eq!(*kind, InlineKind::Empty);
            assert_eq!(span.start, span.end, "an empty value has no bytes");
        }
        other => panic!("expected an empty inline value, got {other:?}"),
    }
}

#[test]
fn trailing_spaces_stay_outside_the_value_span() {
    // `trailingSpaces: 7   ` — the spaces must survive a rewrite untouched.
    let c = weapon();
    let e = entries_of(&c);
    assert_eq!(value_text(&c, entry(&e, "trailingSpaces")), "7");
}

#[test]
fn locates_an_empty_inline_sequence() {
    let c = weapon();
    let e = entries_of(&c);
    let tags = entry(&e, "tags");
    assert_eq!(value_text(&c, tags), "[]");
    assert!(matches!(
        tags.value,
        ValueSpan::Inline { kind: InlineKind::InlineSeq, .. }
    ));
}

#[test]
fn a_block_sequence_spans_its_items_only() {
    let c = weapon();
    let e = entries_of(&c);
    let r = entry(&e, "resistances");
    match &r.value {
        ValueSpan::Block { span, kind } => {
            assert_eq!(*kind, BlockKind::Sequence);
            assert_eq!(&c[span.clone()], "  - fire\n  - ice");
        }
        other => panic!("expected a block sequence, got {other:?}"),
    }
}

#[test]
fn a_block_mapping_spans_its_nested_lines() {
    let c = weapon();
    let e = entries_of(&c);
    match &entry(&e, "nested").value {
        ValueSpan::Block { span, kind } => {
            assert_eq!(*kind, BlockKind::Mapping);
            assert_eq!(&c[span.clone()], "    label: inner\n    damage: 999");
        }
        other => panic!("expected a block mapping, got {other:?}"),
    }
}

#[test]
fn scans_a_crlf_document_identically() {
    let c = crlf(&weapon());
    let e = entries_of(&c);
    assert_eq!(value_text(&c, entry(&e, "damage")), "12");
    assert_eq!(entry(&e, "damage").terminator, "\r\n");
}

#[test]
fn scans_a_file_with_no_trailing_newline() {
    let c = no_final_newline(&weapon());
    let e = entries_of(&c);
    let last = e.last().unwrap();
    assert_eq!(last.key, "trailingSpaces");
    assert_eq!(last.terminator, "", "the last line has no terminator");
}

#[test]
fn finds_entries_in_each_document_of_a_multi_document_asset() {
    let c = fixture("WeaponSubAssets.asset");
    for (file_id, expected) in [("11400000", "1"), ("11400002", "2")] {
        let body = document_body(&c, file_id).expect("document");
        let e = scan_entries(&c, body);
        assert_eq!(value_text(&c, entry(&e, "damage")), expected);
    }
}

#[test]
fn scanning_never_panics_on_garbage() {
    for junk in [
        "",
        "---",
        "--- !u!114 &1\n",
        "--- !u!114 &1\nMonoBehaviour:\n",
        "--- !u!114 &1\nMonoBehaviour:\n  a\n",
        "--- !u!114 &1\nMonoBehaviour:\n  a: {unclosed\n",
        "--- !u!114 &1\nMonoBehaviour:\n\t tabbed: 1\n",
        "--- !u!114 &1\nMonoBehaviour:\n  : 1\n",
    ] {
        let (_, docs) = crate::unity_yaml::split_document_spans(junk);
        for d in docs {
            let _ = scan_entries(junk, d.body);
        }
    }
}

// ── Refusals ────────────────────────────────────────────────────────────────

fn scan_snippet(body: &str) -> (String, Vec<Entry>) {
    let content = format!("--- !u!114 &1\nMonoBehaviour:\n{body}");
    let (_, docs) = crate::unity_yaml::split_document_spans(&content);
    let entries = scan_entries(&content, docs[0].body.clone());
    (content, entries)
}

#[test]
fn refuses_a_block_scalar() {
    for marker in ["|", "|-", ">", ">2-"] {
        let (c, e) = scan_snippet(&format!("  note: {marker}\n    text\n"));
        let _ = c;
        assert!(
            matches!(
                entry(&e, "note").value,
                ValueSpan::Opaque { reason: OpaqueReason::BlockScalar, .. }
            ),
            "marker {marker} should be refused"
        );
    }
}

#[test]
fn refuses_an_anchor_or_alias() {
    let (_, e) = scan_snippet("  a: &anchor 1\n  b: *anchor\n");
    for key in ["a", "b"] {
        assert!(matches!(
            entry(&e, key).value,
            ValueSpan::Opaque { reason: OpaqueReason::AnchorOrAlias, .. }
        ));
    }
}

#[test]
fn refuses_a_value_containing_a_comment_marker() {
    let (_, e) = scan_snippet("  a: 1 # why\n");
    assert!(matches!(
        entry(&e, "a").value,
        ValueSpan::Opaque { reason: OpaqueReason::PossibleComment, .. }
    ));
}

#[test]
fn refuses_an_unbalanced_value() {
    let (_, e) = scan_snippet("  a: {fileID: 0\n");
    assert!(matches!(
        entry(&e, "a").value,
        ValueSpan::Opaque { reason: OpaqueReason::Unbalanced, .. }
    ));
}

#[test]
fn a_hash_inside_quotes_is_not_a_comment() {
    let (c, e) = scan_snippet("  a: '#ff8800'\n");
    assert_eq!(value_text(&c, entry(&e, "a")), "'#ff8800'");
}

// ── Path resolution ─────────────────────────────────────────────────────────

#[test]
fn parses_paths() {
    assert_eq!(parse_field_path("damage").unwrap(), FieldPath::Whole("damage".into()));
    assert_eq!(
        parse_field_path("tint.g").unwrap(),
        FieldPath::MapMember { key: "tint".into(), member: "g".into() }
    );
}

#[test]
fn refuses_array_and_deep_paths() {
    assert!(matches!(
        parse_field_path("data.Array.data[0]"),
        Err(EditRejection::UnsupportedPath { .. })
    ));
    assert!(matches!(
        parse_field_path("a.b.c"),
        Err(EditRejection::UnsupportedPath { .. })
    ));
    assert!(matches!(parse_field_path(""), Err(EditRejection::UnsupportedPath { .. })));
}

#[test]
fn resolves_a_scalar_target() {
    let c = weapon();
    let e = entries_of(&c);
    let t = resolve_target(&c, &e, &parse_field_path("damage").unwrap()).unwrap();
    assert_eq!(t.current, "12");
    assert_eq!(&c[t.span], "12");
}

#[test]
fn resolves_an_inline_map_member() {
    let c = weapon();
    let e = entries_of(&c);
    let g = resolve_target(&c, &e, &parse_field_path("tint.g").unwrap()).unwrap();
    assert_eq!(g.current, "0.5");
    let a = resolve_target(&c, &e, &parse_field_path("tint.a").unwrap()).unwrap();
    assert_eq!(a.current, "1");
    let f = resolve_target(&c, &e, &parse_field_path("icon.fileID").unwrap()).unwrap();
    assert_eq!(f.current, "21300000");
    let guid = resolve_target(&c, &e, &parse_field_path("icon.guid").unwrap()).unwrap();
    assert_eq!(guid.current.len(), 32);
}

#[test]
fn rejects_an_unknown_key_or_member() {
    let c = weapon();
    let e = entries_of(&c);
    assert!(matches!(
        resolve_target(&c, &e, &parse_field_path("nope").unwrap()),
        Err(EditRejection::KeyNotFound { .. })
    ));
    assert!(matches!(
        resolve_target(&c, &e, &parse_field_path("tint.z").unwrap()),
        Err(EditRejection::MapMemberNotFound { .. })
    ));
}

#[test]
fn rejects_a_member_path_on_a_non_map() {
    let c = weapon();
    let e = entries_of(&c);
    assert!(matches!(
        resolve_target(&c, &e, &parse_field_path("damage.x").unwrap()),
        Err(EditRejection::UnsupportedPath { .. })
    ));
}

#[test]
fn rejects_a_block_value_as_a_scalar_target() {
    let c = weapon();
    let e = entries_of(&c);
    assert!(matches!(
        resolve_target(&c, &e, &parse_field_path("resistances").unwrap()),
        Err(EditRejection::UnsupportedShape { .. })
    ));
}

#[test]
fn refuses_a_duplicate_top_level_key() {
    let (c, e) = scan_snippet("  damage: 1\n  damage: 2\n");
    match resolve_target(&c, &e, &parse_field_path("damage").unwrap()) {
        Err(EditRejection::AmbiguousKey { count, .. }) => assert_eq!(count, 2),
        other => panic!("expected AmbiguousKey, got {other:?}"),
    }
}

// ── Validation and encoding ─────────────────────────────────────────────────

#[test]
fn validate_rejects_unsafe_values() {
    for bad in [
        "a\nb", "a\r", "{unclosed", "'unclosed", " lead", "trail ",
        "has # comment", "| block", "&anchor", "*alias",
    ] {
        assert!(
            validate_raw_value("f", bad).is_err(),
            "{bad:?} should be rejected"
        );
    }
}

#[test]
fn validate_accepts_ordinary_values() {
    for good in ["12", "1.35", "-3", "0", "", "{fileID: 0}", "[]", "'quoted'", "Iron Sword"] {
        assert!(
            validate_raw_value("f", good).is_ok(),
            "{good:?} should be accepted"
        );
    }
}

#[test]
fn yaml_string_encoding_matches_unity() {
    assert_eq!(encode_yaml_string("plain"), "plain");
    assert_eq!(encode_yaml_string("Iron Sword"), "Iron Sword");
    assert_eq!(encode_yaml_string(""), "''");
    assert_eq!(encode_yaml_string("Sword 'of' Truth"), "'Sword ''of'' Truth'");
    assert_eq!(encode_yaml_string(" lead"), "' lead'");
    assert_eq!(encode_yaml_string("trail "), "'trail '");
    assert_eq!(encode_yaml_string("yes"), "'yes'");
    assert_eq!(encode_yaml_string("123"), "'123'");
    assert_eq!(encode_yaml_string("#hash"), "'#hash'");
    assert_eq!(encode_yaml_string("a: b"), "'a: b'");
    assert_eq!(encode_yaml_string("[x]"), "'[x]'");
}

#[test]
fn an_encoded_string_always_passes_validation() {
    for s in ["", "plain", "Sword 'of' Truth", "#hash", "a: b", "yes", " lead"] {
        let encoded = encode_yaml_string(s);
        assert!(
            validate_raw_value("f", &encoded).is_ok(),
            "encode({s:?}) = {encoded:?} must be writable"
        );
    }
}

// ── Byte exactness ──────────────────────────────────────────────────────────
//
// P2: everything OUTSIDE the edited span is bit-identical. Stronger than "the
// file still parses" and stronger than any diff-based check — it forbids any
// byte from moving, which covers CRLF, trailing whitespace, a missing final
// newline, the preamble and key order all at once.

fn assert_only_span_changed(old: &[u8], new: &[u8], span: Range<usize>, new_len: usize) {
    assert_eq!(&old[..span.start], &new[..span.start], "prefix changed");
    assert_eq!(
        &old[span.end..],
        &new[span.start + new_len..],
        "suffix changed"
    );
    assert_eq!(new.len(), old.len() - (span.end - span.start) + new_len);
}

fn edit(file_id: &str, path: &str, value: &str) -> AssetEdit {
    AssetEdit {
        file_id: file_id.into(),
        path: path.into(),
        value: value.into(),
        expected: None,
    }
}

fn flavours(base: &str) -> Vec<(&'static str, String)> {
    vec![
        ("lf", base.to_string()),
        ("crlf", crlf(base)),
        ("no-final-nl", no_final_newline(base)),
        ("crlf-no-final-nl", no_final_newline(&crlf(base))),
    ]
}

#[test]
fn no_op_edit_round_trips_byte_identically() {
    // The headline property: set every editable field to the value it already
    // has, in every line-ending flavour, and get the input back byte for byte.
    for name in ["Weapon.asset", "WeaponSubAssets.asset"] {
        let base = fixture(name);
        for (flavour, content) in flavours(&base) {
            let (_, docs) = crate::unity_yaml::split_document_spans(&content);
            let mut edits = Vec::new();
            for doc in &docs {
                for e in scan_entries(&content, doc.body.clone()) {
                    if let ValueSpan::Inline { span, .. } = &e.value {
                        edits.push(edit(&doc.file_id, &e.key, &content[span.clone()]));
                    }
                }
            }
            assert!(!edits.is_empty(), "{name}/{flavour}: nothing to edit");
            let out = apply_edits_to_text(&content, &edits)
                .unwrap_or_else(|r| panic!("{name}/{flavour}: rejected {r:?}"));
            assert_eq!(
                out.as_bytes(),
                content.as_bytes(),
                "{name}/{flavour}: a no-op edit changed the bytes"
            );
        }
    }
}

#[test]
fn single_field_edit_changes_only_that_substring() {
    for (flavour, content) in flavours(&weapon()) {
        let e = entries_of(&content);
        let span = match &entry(&e, "damage").value {
            ValueSpan::Inline { span, .. } => span.clone(),
            other => panic!("{flavour}: {other:?}"),
        };
        let out = apply_edits_to_text(&content, &[edit("11400000", "damage", "999")]).unwrap();
        assert_only_span_changed(content.as_bytes(), out.as_bytes(), span, 3);
        assert!(out.contains("damage: 999"), "{flavour}");
    }
}

#[test]
fn a_crlf_file_gains_no_lone_line_feed() {
    let content = crlf(&weapon());
    let out = apply_edits_to_text(&content, &[edit("11400000", "damage", "42")]).unwrap();
    let crlf_count = out.matches("\r\n").count();
    let lf_count = out.matches('\n').count();
    assert_eq!(crlf_count, lf_count, "a lone \\n appeared in a CRLF file");
}

#[test]
fn a_file_without_a_trailing_newline_still_has_none() {
    let content = no_final_newline(&weapon());
    let out = apply_edits_to_text(&content, &[edit("11400000", "damage", "42")]).unwrap();
    assert!(!out.ends_with('\n'));
}

#[test]
fn the_preamble_survives_a_field_edit() {
    let content = crlf(&weapon());
    let out = apply_edits_to_text(&content, &[edit("11400000", "damage", "42")]).unwrap();
    assert!(out.starts_with("%YAML 1.1\r\n%TAG !u! tag:unity3d.com,2011:\r\n"));
}

#[test]
fn top_level_key_order_is_unchanged() {
    let content = weapon();
    let before: Vec<String> = entries_of(&content).into_iter().map(|e| e.key).collect();
    let out = apply_edits_to_text(&content, &[edit("11400000", "damage", "42")]).unwrap();
    let after: Vec<String> = entries_of(&out).into_iter().map(|e| e.key).collect();
    assert_eq!(before, after);
}

#[test]
fn every_field_the_old_parsers_discard_survives() {
    // The direct assertion that nothing `collect_simple_properties` would have
    // dropped — object refs, inline maps, lists, block values — got lost.
    let content = weapon();
    let out = apply_edits_to_text(&content, &[edit("11400000", "damage", "42")]).unwrap();

    let pairs = |s: &str| -> Vec<(String, String)> {
        entries_of(s)
            .iter()
            .map(|e| (e.key.clone(), value_text(s, e).to_string()))
            .collect()
    };
    let before = pairs(&content);
    let after = pairs(&out);
    assert_eq!(before.len(), after.len(), "a field appeared or vanished");
    let differing: Vec<_> = before
        .iter()
        .zip(after.iter())
        .filter(|(a, b)| a != b)
        .collect();
    assert_eq!(differing.len(), 1, "exactly one field should differ: {differing:?}");
    assert_eq!(differing[0].0 .0, "damage");
}

#[test]
fn edits_an_inline_map_member_without_disturbing_its_siblings() {
    let content = weapon();
    let out = apply_edits_to_text(&content, &[edit("11400000", "tint.g", "0.75")]).unwrap();
    assert!(out.contains("tint: {r: 1, g: 0.75, b: 0, a: 1}"), "got: {out}");
}

#[test]
fn preserves_odd_spacing_inside_an_inline_map() {
    let (content, _) = scan_snippet("  v: {x: 0,y:1, z : 2}\n");
    let out = apply_edits_to_text(&content, &[edit("1", "v.y", "9")]).unwrap();
    assert!(out.contains("{x: 0,y:9, z : 2}"), "got: {out}");
}

#[test]
fn writes_into_an_empty_value_with_a_leading_space() {
    let content = weapon();
    let out =
        apply_edits_to_text(&content, &[edit("11400000", "m_EditorClassIdentifier", "Thing")])
            .unwrap();
    assert!(out.contains("m_EditorClassIdentifier: Thing"), "got a bad splice");
}

#[test]
fn applies_multiple_edits_in_one_pass() {
    let content = weapon();
    let out = apply_edits_to_text(
        &content,
        &[
            edit("11400000", "damage", "1"),
            edit("11400000", "attackSpeed", "2"),
            edit("11400000", "rarity", "3"),
        ],
    )
    .unwrap();
    assert!(out.contains("damage: 1"));
    assert!(out.contains("attackSpeed: 2"));
    assert!(out.contains("rarity: 3"));
    // Everything else is untouched.
    assert!(out.contains("quotedName: 'Sword ''of'' Truth'"));
    assert!(out.contains("trailingSpaces: 7   "));
}

#[test]
fn edits_the_right_document_in_a_multi_document_asset() {
    let content = fixture("WeaponSubAssets.asset");
    let out = apply_edits_to_text(&content, &[edit("11400002", "damage", "77")]).unwrap();
    assert!(out.contains("m_Name: Root\n  damage: 1"), "first doc changed");
    assert!(out.contains("m_Name: SubAsset\n  damage: 77"));
}

#[test]
fn one_bad_edit_rejects_the_whole_batch() {
    let content = weapon();
    let err = apply_edits_to_text(
        &content,
        &[
            edit("11400000", "damage", "1"),
            edit("11400000", "nope", "2"),
        ],
    )
    .unwrap_err();
    assert!(matches!(err[0], EditRejection::KeyNotFound { .. }));
}

#[test]
fn collects_every_rejection_not_just_the_first() {
    // So the inspector can flag all the bad fields at once.
    let content = weapon();
    let err = apply_edits_to_text(
        &content,
        &[
            edit("11400000", "nope", "2"),
            edit("11400000", "alsoNope", "3"),
            edit("11400000", "damage", "line\nbreak"),
        ],
    )
    .unwrap_err();
    assert_eq!(err.len(), 3, "got {err:?}");
}

#[test]
fn rejects_two_edits_that_fight_over_the_same_bytes() {
    let content = weapon();
    let err = apply_edits_to_text(
        &content,
        &[edit("11400000", "damage", "1"), edit("11400000", "damage", "2")],
    )
    .unwrap_err();
    assert!(matches!(err[0], EditRejection::OverlappingEdits { .. }), "got {err:?}");
}

#[test]
fn rejects_an_unknown_document() {
    let content = weapon();
    let err = apply_edits_to_text(&content, &[edit("999", "damage", "1")]).unwrap_err();
    assert!(matches!(err[0], EditRejection::DocumentNotFound { .. }));
}

#[test]
fn expected_value_mismatch_rejects_the_edit() {
    let content = weapon();
    let mut e = edit("11400000", "damage", "42");
    e.expected = Some("999".into()); // on-disk value is 12
    let err = apply_edits_to_text(&content, &[e]).unwrap_err();
    match &err[0] {
        EditRejection::ValueMismatch { expected, actual, .. } => {
            assert_eq!(expected, "999");
            assert_eq!(actual, "12");
        }
        other => panic!("expected ValueMismatch, got {other:?}"),
    }
}

#[test]
fn expected_value_match_allows_the_edit() {
    let content = weapon();
    let mut e = edit("11400000", "damage", "42");
    e.expected = Some("12".into());
    let out = apply_edits_to_text(&content, &[e]).unwrap();
    assert!(out.contains("damage: 42"));
}

#[test]
fn applying_no_edits_returns_the_input_unchanged() {
    let content = weapon();
    assert_eq!(apply_edits_to_text(&content, &[]).unwrap(), content);
}

// ── Snapshot ────────────────────────────────────────────────────────────────

#[test]
fn snapshot_reports_every_field_losslessly() {
    let content = weapon();
    let snap = snapshot(&content, None).unwrap();
    assert_eq!(snap.document_file_id, "11400000");
    assert_eq!(snap.class_id, "114");
    assert_eq!(snap.script_guid.as_deref(), Some("a1b2c3d4e5f60718293a4b5c6d7e8f90"));

    let f = |k: &str| snap.fields.iter().find(|f| f.key == k).unwrap();
    // The values the old parsers dropped are all present.
    assert_eq!(f("icon").kind, ValueKind::InlineMap);
    assert_eq!(f("tags").raw, "[]");
    assert_eq!(f("resistances").kind, ValueKind::Block);
    assert_eq!(f("m_EditorClassIdentifier").kind, ValueKind::Empty);
    assert!(snap.fields.len() > 8, "the 8-field skim cap must not apply here");
}

#[test]
fn snapshot_breaks_an_inline_map_into_members() {
    let content = weapon();
    let snap = snapshot(&content, None).unwrap();
    let tint = snap.fields.iter().find(|f| f.key == "tint").unwrap();
    assert_eq!(
        tint.members.iter().map(|m| (m.name.as_str(), m.raw.as_str())).collect::<Vec<_>>(),
        vec![("r", "1"), ("g", "0.5"), ("b", "0"), ("a", "1")]
    );
}

#[test]
fn snapshot_marks_unwritable_values_not_editable() {
    let content = weapon();
    let snap = snapshot(&content, None).unwrap();
    let f = |k: &str| snap.fields.iter().find(|f| f.key == k).unwrap();
    assert!(!f("resistances").editable);
    assert!(!f("nested").editable);
    assert!(f("damage").editable);
}

#[test]
fn snapshot_hash_changes_with_the_content() {
    let a = snapshot(&weapon(), None).unwrap();
    let edited = apply_edits_to_text(&weapon(), &[edit("11400000", "damage", "42")]).unwrap();
    let b = snapshot(&edited, None).unwrap();
    assert_ne!(a.sha1, b.sha1);
    assert_eq!(a.sha1.len(), 40);
}

#[test]
fn snapshot_errors_when_there_is_no_monobehaviour_document() {
    assert!(snapshot("%YAML 1.1\n", None).is_err());
}

// ── The wire contract ───────────────────────────────────────────────────────

#[test]
fn wire_payload_from_the_frontend_deserializes() {
    // `check-invoke-args.mjs` only validates TOP-LEVEL invoke arguments — it
    // cannot see inside `edits`, so a `fileId` -> `file_id` drift would pass CI
    // silently and fail at runtime. This literal is copied from the TS call
    // site in asset-fields-client.ts and is the only thing that catches it.
    let json = r#"[
      { "fileId": "11400000", "path": "damage", "value": "42", "expected": "12" },
      { "fileId": "11400000", "path": "tint.g", "value": "0.75" }
    ]"#;
    let edits: Vec<AssetEdit> = serde_json::from_str(json).expect("wire payload must deserialize");
    assert_eq!(edits.len(), 2);
    assert_eq!(edits[0].file_id, "11400000");
    assert_eq!(edits[0].expected.as_deref(), Some("12"));
    assert_eq!(edits[1].expected, None, "expected is optional");
}

// ── End to end, on disk ─────────────────────────────────────────────────────

#[test]
fn apply_edits_end_to_end_is_byte_exact_on_disk() {
    for (flavour, content) in flavours(&weapon()) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Weapon.asset");
        std::fs::write(&path, content.as_bytes()).unwrap();

        let e = entries_of(&content);
        let span = match &entry(&e, "damage").value {
            ValueSpan::Inline { span, .. } => span.clone(),
            other => panic!("{flavour}: {other:?}"),
        };

        let result = unity_asset_apply_edits(
            path.to_string_lossy().to_string(),
            vec![edit("11400000", "damage", "999")],
            None,
        )
        .unwrap();
        assert!(result.written, "{flavour}");
        assert!(result.rejections.is_empty(), "{flavour}: {:?}", result.rejections);

        let after = std::fs::read(&path).unwrap();
        assert_only_span_changed(content.as_bytes(), &after, span, 3);
    }
}

#[test]
fn a_no_op_write_leaves_the_file_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Weapon.asset");
    let content = weapon();
    std::fs::write(&path, content.as_bytes()).unwrap();
    let before_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();

    let result = unity_asset_apply_edits(
        path.to_string_lossy().to_string(),
        vec![edit("11400000", "damage", "12")], // already 12
        None,
    )
    .unwrap();

    assert!(result.unchanged);
    assert!(!result.written);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        before_mtime,
        "a no-op must not touch the file — it would trigger a Unity reimport"
    );
}

#[test]
fn a_rejected_batch_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Weapon.asset");
    let content = weapon();
    std::fs::write(&path, content.as_bytes()).unwrap();

    let result = unity_asset_apply_edits(
        path.to_string_lossy().to_string(),
        vec![edit("11400000", "damage", "1"), edit("11400000", "nope", "2")],
        None,
    )
    .unwrap();

    assert!(!result.written);
    assert!(!result.rejections.is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes());
}

#[test]
fn a_stale_hash_refuses_the_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Weapon.asset");
    let content = weapon();
    std::fs::write(&path, content.as_bytes()).unwrap();

    let err = unity_asset_apply_edits(
        path.to_string_lossy().to_string(),
        vec![edit("11400000", "damage", "1")],
        Some("0000000000000000000000000000000000000000".into()),
    )
    .unwrap_err();
    assert!(err.contains("changed on disk"), "got: {err}");
    assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes());
}

#[test]
fn the_returned_hash_is_accepted_by_the_next_call() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Weapon.asset");
    std::fs::write(&path, weapon().as_bytes()).unwrap();
    let p = path.to_string_lossy().to_string();

    let first = unity_asset_apply_edits(p.clone(), vec![edit("11400000", "damage", "1")], None)
        .unwrap();
    let second = unity_asset_apply_edits(
        p.clone(),
        vec![edit("11400000", "damage", "2")],
        Some(first.sha1.clone()),
    )
    .unwrap();
    assert!(second.written);

    let snap = unity_asset_read_fields(p, None).unwrap();
    assert_eq!(snap.sha1, second.sha1, "read and write must agree on the hash");
}

#[test]
fn reading_a_missing_file_errors_without_creating_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Nope.asset");
    assert!(unity_asset_read_fields(path.to_string_lossy().to_string(), None).is_err());
    assert!(!path.exists());
}
