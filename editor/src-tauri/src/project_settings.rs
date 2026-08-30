//! Readers for the four `ProjectSettings/` assets the editor needs.
//!
//! Nothing read these before: `unity_index::collect_files` walks only `Assets/`
//! and `Packages/`, and the csproj generator hardcoded its define list. That is
//! why `#if MY_FLAG` blocks were analyzed as dead code and why nothing could
//! validate a tag, layer, scene or input-axis string literal.
//!
//! **Deliberately hand-rolled, not `unity_yaml::parse_asset`.** That parser's
//! `collect_simple_properties` caps at 64 properties and drops any value
//! containing `fileID` or starting with `{`/`[`/`-`, because its output is a
//! bounded UI payload. Every shape below is a sequence — `layers:`, `m_Scenes:`,
//! `m_Axes:` — so it would drop exactly the data this module exists to read.
//!
//! **Degrades, never errors.** A Unity project whose Asset Serialization mode
//! is not Force Text stores these as binary. A missing or unparseable file
//! yields an empty section, so a binary project loses the inspections rather
//! than failing to open.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

/// One entry of `EditorBuildSettings.asset`'s `m_Scenes` list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildScene {
    /// Project-relative, e.g. `Assets/Scenes/SampleScene.unity`.
    pub path: String,
    pub enabled: bool,
    pub guid: String,
}

impl BuildScene {
    /// The name Unity accepts in `SceneManager.LoadScene("...")` — the file
    /// stem, with no directory and no `.unity` extension.
    pub fn short_name(&self) -> &str {
        let after_slash = self.path.rsplit('/').next().unwrap_or(&self.path);
        after_slash.strip_suffix(".unity").unwrap_or(after_slash)
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsSnapshot {
    /// Scripting define symbols keyed by Unity's build-target-group name.
    pub scripting_defines: HashMap<String, Vec<String>>,
    pub tags: Vec<String>,
    /// Index is the layer id. Unity reserves 8 builtin slots and leaves unused
    /// entries blank, so the blanks are preserved rather than filtered — layer
    /// 5 must stay layer 5.
    pub layers: Vec<String>,
    pub scenes: Vec<BuildScene>,
    pub input_axes: Vec<String>,
    /// False when `EditorSettings.asset` says the project is not Force Text.
    pub serialization_is_text: bool,
}

impl ProjectSettingsSnapshot {
    /// Defines for the desktop player, which is what the generated csproj
    /// compiles against. Falls back to any single group when `Standalone` is
    /// absent, so a mobile-only project still gets its defines.
    pub fn standalone_defines(&self) -> Vec<String> {
        if let Some(d) = self.scripting_defines.get("Standalone") {
            return d.clone();
        }
        let mut keys: Vec<&String> = self.scripting_defines.keys().collect();
        keys.sort(); // deterministic pick, not HashMap iteration order
        keys.first()
            .and_then(|k| self.scripting_defines.get(*k))
            .cloned()
            .unwrap_or_default()
    }

    /// Layer names that are actually defined, with their ids.
    pub fn named_layers(&self) -> Vec<(usize, &str)> {
        self.layers
            .iter()
            .enumerate()
            .filter(|(_, n)| !n.trim().is_empty())
            .map(|(i, n)| (i, n.as_str()))
            .collect()
    }
}

/// Read a settings file, returning `None` for missing or binary-serialized
/// assets. Unity's text assets always begin with the `%YAML` directive.
fn read_text_asset(dir: &Path, name: &str) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(name)).ok()?;
    if !text.starts_with("%YAML") {
        return None;
    }
    Some(text)
}

/// Indentation width of a line, in spaces.
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Collect a block-sequence of scalars, e.g.
///
/// ```text
///   layers:
///   - Default
///   - TransparentFX
/// ```
///
/// Entries are returned verbatim (minus the `- `), including empty ones, so a
/// caller can rely on positional meaning.
fn parse_scalar_sequence(text: &str, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_block = false;
    let mut key_indent = 0usize;

    for line in text.lines() {
        let trimmed = line.trim_end();
        if !in_block {
            let t = trimmed.trim_start();
            if t == format!("{key}:") {
                in_block = true;
                key_indent = indent_of(trimmed);
            } else if t.starts_with(&format!("{key}:")) {
                // Inline form — `tags: []` means an empty sequence.
                return Vec::new();
            }
            continue;
        }

        let t = trimmed.trim_start();
        if let Some(item) = t.strip_prefix("- ") {
            out.push(item.trim().to_string());
        } else if t == "-" {
            out.push(String::new());
        } else if trimmed.trim().is_empty() {
            continue;
        } else if indent_of(trimmed) <= key_indent {
            break; // dedent ends the block
        }
    }
    out
}

/// Parse `scriptingDefineSymbols`, which is a mapping of build-target-group to
/// a semicolon-separated string. The inline `{}` form means "none defined".
pub fn parse_scripting_defines(text: &str) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    let mut in_block = false;
    let mut key_indent = 0usize;

    for line in text.lines() {
        let trimmed = line.trim_end();
        let t = trimmed.trim_start();
        if !in_block {
            if t == "scriptingDefineSymbols:" {
                in_block = true;
                key_indent = indent_of(trimmed);
            }
            continue;
        }

        if t.is_empty() {
            continue;
        }
        if indent_of(trimmed) <= key_indent {
            break;
        }
        let Some((group, value)) = t.split_once(':') else {
            continue;
        };
        let defines: Vec<String> = value
            .trim()
            .split(';')
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect();
        // A group present but empty is still meaningful — it means "this
        // platform defines nothing", which is different from absent.
        out.insert(group.trim().to_string(), defines);
    }
    out
}

/// Parse `EditorBuildSettings.asset`'s `m_Scenes` list.
pub fn parse_build_scenes(text: &str) -> Vec<BuildScene> {
    let mut out = Vec::new();
    let mut in_block = false;
    let mut key_indent = 0usize;
    let mut cur: Option<(bool, String, String)> = None;

    let flush = |cur: &mut Option<(bool, String, String)>, out: &mut Vec<BuildScene>| {
        if let Some((enabled, path, guid)) = cur.take() {
            if !path.is_empty() {
                out.push(BuildScene { path, enabled, guid });
            }
        }
    };

    for line in text.lines() {
        let trimmed = line.trim_end();
        let t = trimmed.trim_start();
        if !in_block {
            if t == "m_Scenes:" {
                in_block = true;
                key_indent = indent_of(trimmed);
            } else if t.starts_with("m_Scenes:") {
                return Vec::new(); // inline `m_Scenes: []`
            }
            continue;
        }

        if t.is_empty() {
            continue;
        }
        if indent_of(trimmed) <= key_indent && !t.starts_with('-') {
            break;
        }

        let body = t.strip_prefix("- ").map(|rest| {
            flush(&mut cur, &mut out);
            cur = Some((false, String::new(), String::new()));
            rest
        });
        let field = body.unwrap_or(t);

        if let Some(entry) = cur.as_mut() {
            if let Some(v) = field.strip_prefix("enabled:") {
                entry.0 = v.trim() == "1";
            } else if let Some(v) = field.strip_prefix("path:") {
                entry.1 = v.trim().to_string();
            } else if let Some(v) = field.strip_prefix("guid:") {
                entry.2 = v.trim().to_string();
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// Parse `InputManager.asset`'s axis names. Duplicates are preserved in Unity
/// (two axes may share a name for keyboard/joystick pairs) but deduped here —
/// callers only ever ask "does this name exist".
pub fn parse_input_axes(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(v) = t.strip_prefix("m_Name:") {
            let name = v.trim().to_string();
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// True unless `EditorSettings.asset` explicitly selects a non-text mode.
/// `m_SerializationMode: 2` is Force Text; 0 (Mixed) and 1 (Force Binary) are
/// not. A missing file is treated as text, matching Unity's modern default.
pub fn parse_serialization_is_text(text: &str) -> bool {
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(v) = t.strip_prefix("m_SerializationMode:") {
            return v.trim() == "2";
        }
    }
    true
}

/// Read every settings asset under `<workspace>/ProjectSettings`.
pub fn read_project_settings(workspace: &Path) -> ProjectSettingsSnapshot {
    let dir = workspace.join("ProjectSettings");
    let mut snap = ProjectSettingsSnapshot {
        serialization_is_text: true,
        ..Default::default()
    };

    if let Some(text) = read_text_asset(&dir, "ProjectSettings.asset") {
        snap.scripting_defines = parse_scripting_defines(&text);
    }
    if let Some(text) = read_text_asset(&dir, "TagManager.asset") {
        snap.tags = parse_scalar_sequence(&text, "tags");
        snap.layers = parse_scalar_sequence(&text, "layers");
    }
    if let Some(text) = read_text_asset(&dir, "EditorBuildSettings.asset") {
        snap.scenes = parse_build_scenes(&text);
    }
    if let Some(text) = read_text_asset(&dir, "InputManager.asset") {
        snap.input_axes = parse_input_axes(&text);
    }
    if let Some(text) = read_text_asset(&dir, "EditorSettings.asset") {
        snap.serialization_is_text = parse_serialization_is_text(&text);
    }
    snap
}

/// Frontend entry point. Returns an empty snapshot for a non-Unity folder
/// rather than an error, so callers need no `isUnityProject` guard.
#[tauri::command]
pub fn unity_project_settings(workspace_path: String) -> ProjectSettingsSnapshot {
    read_project_settings(Path::new(&workspace_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAG_MANAGER: &str = r#"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!78 &1
TagManager:
  serializedVersion: 2
  tags:
  - Player
  - Enemy
  layers:
  - Default
  - TransparentFX
  - Ignore Raycast
  - 
  - Water
"#;

    #[test]
    fn reads_tags_and_layers_preserving_blank_layer_slots() {
        let tags = parse_scalar_sequence(TAG_MANAGER, "tags");
        assert_eq!(tags, vec!["Player", "Enemy"]);

        let layers = parse_scalar_sequence(TAG_MANAGER, "layers");
        // Layer 3 is blank and MUST stay in place — filtering it would
        // renumber Water from 4 to 3 and every layer check after it would be
        // wrong.
        assert_eq!(layers.len(), 5);
        assert_eq!(layers[0], "Default");
        assert_eq!(layers[3], "");
        assert_eq!(layers[4], "Water");
    }

    #[test]
    fn inline_empty_sequence_yields_no_entries() {
        let text = "%YAML 1.1\nTagManager:\n  tags: []\n  layers:\n  - Default\n";
        assert!(parse_scalar_sequence(text, "tags").is_empty());
        assert_eq!(parse_scalar_sequence(text, "layers"), vec!["Default"]);
    }

    #[test]
    fn named_layers_reports_ids_not_positions() {
        let snap = ProjectSettingsSnapshot {
            layers: parse_scalar_sequence(TAG_MANAGER, "layers"),
            ..Default::default()
        };
        assert_eq!(
            snap.named_layers(),
            vec![(0, "Default"), (1, "TransparentFX"), (2, "Ignore Raycast"), (4, "Water")]
        );
    }

    #[test]
    fn empty_scripting_define_map_is_not_an_error() {
        let text = "%YAML 1.1\nPlayerSettings:\n  scriptingDefineSymbols: {}\n  other: 1\n";
        assert!(parse_scripting_defines(text).is_empty());
    }

    #[test]
    fn splits_semicolon_separated_defines_per_build_target_group() {
        let text = r#"%YAML 1.1
PlayerSettings:
  scriptingDefineSymbols:
    Standalone: FEATURE_A;FEATURE_B
    Android: MOBILE
  additionalCompilerArguments: {}
"#;
        let map = parse_scripting_defines(text);
        assert_eq!(map.get("Standalone").unwrap(), &vec!["FEATURE_A", "FEATURE_B"]);
        assert_eq!(map.get("Android").unwrap(), &vec!["MOBILE"]);
        // The dedented sibling key must not be swallowed into the block.
        assert!(!map.contains_key("additionalCompilerArguments"));
    }

    #[test]
    fn standalone_defines_falls_back_to_a_deterministic_group() {
        let mut defines = HashMap::new();
        defines.insert("Android".to_string(), vec!["MOBILE".to_string()]);
        defines.insert("iOS".to_string(), vec!["APPLE".to_string()]);
        let snap = ProjectSettingsSnapshot { scripting_defines: defines, ..Default::default() };
        // Sorted key order, so this is stable across runs rather than
        // whichever key the HashMap happens to yield first.
        assert_eq!(snap.standalone_defines(), vec!["MOBILE"]);
    }

    #[test]
    fn parses_build_scenes_with_enabled_flag_and_guid() {
        let text = r#"%YAML 1.1
EditorBuildSettings:
  m_Scenes:
  - enabled: 1
    path: Assets/Scenes/SampleScene.unity
    guid: 99c9720ab356a0642a771bea13969a05
  - enabled: 0
    path: Assets/Scenes/Menu.unity
    guid: aaaa720ab356a0642a771bea13969a05
  m_configObjects: {}
"#;
        let scenes = parse_build_scenes(text);
        assert_eq!(scenes.len(), 2);
        assert!(scenes[0].enabled);
        assert_eq!(scenes[0].short_name(), "SampleScene");
        assert!(!scenes[1].enabled);
        assert_eq!(scenes[1].short_name(), "Menu");
        assert_eq!(scenes[1].guid, "aaaa720ab356a0642a771bea13969a05");
    }

    #[test]
    fn parses_input_axes_and_dedupes_repeated_names() {
        let text = r#"%YAML 1.1
InputManager:
  m_Axes:
  - serializedVersion: 3
    m_Name: Horizontal
    negativeButton: left
  - serializedVersion: 3
    m_Name: Horizontal
    negativeButton: joystick
  - serializedVersion: 3
    m_Name: Jump
"#;
        assert_eq!(parse_input_axes(text), vec!["Horizontal", "Jump"]);
    }

    #[test]
    fn serialization_mode_two_is_force_text_everything_else_is_not() {
        assert!(parse_serialization_is_text("m_SerializationMode: 2\n"));
        assert!(!parse_serialization_is_text("m_SerializationMode: 1\n"));
        assert!(!parse_serialization_is_text("m_SerializationMode: 0\n"));
        // Absent key => assume text, matching Unity's modern default.
        assert!(parse_serialization_is_text("EditorSettings:\n  other: 1\n"));
    }

    /// Opt-in live check against a real Unity project, matching the
    /// `UNITYIDE_SMOKE_UNITY_PROJECT` convention in `unity.rs`. Hand-written
    /// fixtures prove the parser handles the shapes we *expect*; only a real
    /// project proves we guessed the shapes right.
    #[test]
    fn smoke_reads_a_real_projects_settings() {
        let Ok(project) = std::env::var("UNITYIDE_SMOKE_UNITY_PROJECT") else {
            eprintln!("SKIPPED smoke_reads_a_real_projects_settings — no UNITYIDE_SMOKE_UNITY_PROJECT");
            return;
        };
        let root = Path::new(&project);
        if !root.join("ProjectSettings").is_dir() {
            eprintln!("SKIPPED smoke_reads_a_real_projects_settings — not a Unity project");
            return;
        }

        let snap = read_project_settings(root);
        eprintln!(
            "  live: {} layers ({} named), {} tags, {} scenes, {} axes, defines={:?}, forceText={}",
            snap.layers.len(),
            snap.named_layers().len(),
            snap.tags.len(),
            snap.scenes.len(),
            snap.input_axes.len(),
            snap.scripting_defines.keys().collect::<Vec<_>>(),
            snap.serialization_is_text,
        );

        // Every Unity project has these builtin layers at these exact ids, so
        // a parser that silently returned nothing cannot pass.
        assert!(snap.layers.len() >= 5, "expected Unity's builtin layer slots");
        assert_eq!(snap.layers[0], "Default");
        assert_eq!(snap.layers[1], "TransparentFX");
        // And the default input axes.
        assert!(
            snap.input_axes.iter().any(|a| a == "Horizontal"),
            "expected the builtin Horizontal axis, got {:?}",
            snap.input_axes,
        );
    }

    #[test]
    fn binary_and_missing_assets_degrade_to_an_empty_snapshot() {
        let dir = std::env::temp_dir().join(format!("ps_test_{}", std::process::id()));
        let settings = dir.join("ProjectSettings");
        std::fs::create_dir_all(&settings).unwrap();
        // No %YAML header => binary-serialized project.
        std::fs::write(settings.join("TagManager.asset"), b"\x00\x01binary").unwrap();

        let snap = read_project_settings(&dir);
        assert!(snap.tags.is_empty());
        assert!(snap.layers.is_empty());
        assert!(snap.scenes.is_empty());
        assert!(snap.serialization_is_text, "missing EditorSettings means text");

        std::fs::remove_dir_all(&dir).ok();
    }
}
