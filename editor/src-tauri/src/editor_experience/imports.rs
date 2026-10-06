use super::{ImportPreview, ImportReportItem, ImportSource, KeyBinding};
use quick_xml::{events::Event, Reader};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SOURCES: usize = 100;
const MAX_SHORTCUTS: usize = 2000;

pub(super) fn read_bounded(path: &Path, limit: u64) -> Result<Option<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Unable to read local preference file".into()),
    };
    if !file
        .metadata()
        .map_err(|_| "Unable to inspect preference file")?
        .is_file()
    {
        return Err("Preference source must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read preference file")?;
    if bytes.len() as u64 > limit {
        return Err("Preference file exceeds import size limit".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Preference file is not UTF-8".into())
}

/// JSONC lexer followed by serde's JSON parser. Comments and trailing commas
/// are legal; JSON5 syntax is not. String bytes and positions remain untouched.
fn jsonc(content: &str) -> Result<Value, String> {
    let content = content.trim_start_matches('\u{feff}');
    let bytes = content.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    let mut string = false;
    while i < bytes.len() {
        if string {
            if bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                string = false;
            }
            i += 1;
            continue;
        }
        if bytes[i] == b'"' {
            string = true;
            i += 1;
            continue;
        }
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                out[i] = b' ';
                i += 1;
            }
        } else if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            out[i] = b' ';
            out[i + 1] = b' ';
            i += 2;
            loop {
                if i + 1 >= bytes.len() {
                    return Err("Unterminated JSONC comment".into());
                }
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    out[i] = b' ';
                    out[i + 1] = b' ';
                    i += 2;
                    break;
                }
                if bytes[i] != b'\n' && bytes[i] != b'\r' {
                    out[i] = b' ';
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    if string {
        return Err("Unterminated JSONC string".into());
    }
    i = 0;
    string = false;
    while i < out.len() {
        if string {
            if out[i] == b'\\' {
                i += 2;
                continue;
            }
            if out[i] == b'"' {
                string = false;
            }
        } else if out[i] == b'"' {
            string = true;
        } else if out[i] == b',' {
            let mut j = i + 1;
            while out.get(j).is_some_and(u8::is_ascii_whitespace) {
                j += 1;
            }
            if matches!(out.get(j), Some(b']' | b'}')) {
                out[i] = b' ';
            }
        }
        i += 1;
    }
    serde_json::from_slice(&out).map_err(|_| "Malformed JSONC preferences".into())
}

#[derive(Debug, Default)]
struct XmlNode {
    name: String,
    attrs: BTreeMap<String, String>,
    children: Vec<XmlNode>,
}

fn xml(content: &str) -> Result<XmlNode, String> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<XmlNode> = vec![XmlNode::default()];
    let mut nodes = 0;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| "Malformed XML preferences")?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                nodes += 1;
                if nodes > 20000 || stack.len() > 64 {
                    return Err("XML preferences exceed complexity limit".into());
                }
                let mut node = XmlNode {
                    name: String::from_utf8_lossy(e.name().as_ref()).into(),
                    ..Default::default()
                };
                for attr in e.attributes() {
                    let attr = attr.map_err(|_| "Malformed XML attributes")?;
                    let value = attr
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|_| "Unsupported XML entity")?
                        .into_owned();
                    node.attrs
                        .insert(String::from_utf8_lossy(attr.key.as_ref()).into(), value);
                }
                if empty {
                    stack.last_mut().unwrap().children.push(node);
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                if stack.len() < 2 {
                    return Err("Malformed XML nesting".into());
                }
                let node = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(node);
            }
            Event::DocType(_) => return Err("XML document types are unsupported".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 || stack[0].children.len() != 1 {
        return Err("Malformed XML document".into());
    }
    Ok(stack.pop().unwrap().children.remove(0))
}

fn clean_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect()
}

fn source(editor: &str, root: &Path, label: String, version: Option<String>) -> ImportSource {
    let path = root.to_string_lossy().into_owned();
    ImportSource {
        id: format!("{editor}:{path}"),
        editor: editor.into(),
        label,
        path,
        recommended: false,
        version,
        profile_path: None,
        settings_path: None,
        keybindings_path: None,
    }
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && !path.contains('\\')
        && !path.contains(':')
}

fn vscode_sources(root: &Path, name: &str) -> Result<Vec<ImportSource>, String> {
    let root = if root.join("User").is_dir() {
        root.join("User")
    } else {
        root.to_path_buf()
    };
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut default = source("vscode", &root, format!("{name} — Default"), None);
    default.settings_path = Some(root.join("settings.json").to_string_lossy().into());
    default.keybindings_path = Some(root.join("keybindings.json").to_string_lossy().into());
    default.recommended = true;
    let mut result = vec![default.clone()];
    // Only the profile metadata fields are extracted. Global state, workspace
    // associations, auth and extension data never enter IPC or the report.
    let metadata_path = resource_path(
        &root,
        root.join("globalStorage/storage.json").to_str(),
        "storage.json",
    );
    let metadata = metadata_path
        .and_then(|p| read_bounded(&p, MAX_SOURCE_BYTES))
        .and_then(|content| content.map(|s| jsonc(&s)).transpose());
    let metadata_unavailable = metadata.is_err();
    if let Ok(Some(metadata)) = metadata {
        if let Some(profiles) = metadata.get("userDataProfiles").and_then(Value::as_array) {
            for profile in profiles.iter().take(MAX_SOURCES - 1) {
                let Some(name) = profile.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let Some(location) = profile.get("location").and_then(Value::as_str) else {
                    continue;
                };
                if !safe_relative(location) {
                    continue;
                }
                let profile_path = root.join("profiles").join(location);
                if !profile_path.is_dir() {
                    continue;
                }
                let canonical = fs::canonicalize(&profile_path)
                    .map_err(|_| "Unable to inspect VS Code profile")?;
                if !canonical.starts_with(
                    fs::canonicalize(root.join("profiles"))
                        .map_err(|_| "Unable to inspect VS Code profiles")?,
                ) {
                    continue;
                }
                let mut item = source(
                    "vscode",
                    &root,
                    format!("VS Code — {}", clean_label(name)),
                    None,
                );
                item.id.push_str(&format!(":profile:{location}"));
                item.profile_path = Some(profile_path.to_string_lossy().into());
                let inherit = |resource: &str| {
                    profile
                        .get("useDefaultFlags")
                        .and_then(|f| f.get(resource))
                        .and_then(Value::as_bool)
                        == Some(true)
                };
                item.settings_path = if inherit("settings") {
                    default.settings_path.clone()
                } else {
                    Some(profile_path.join("settings.json").to_string_lossy().into())
                };
                item.keybindings_path = if inherit("keybindings") {
                    default.keybindings_path.clone()
                } else {
                    Some(
                        profile_path
                            .join("keybindings.json")
                            .to_string_lossy()
                            .into(),
                    )
                };
                result.push(item);
            }
        }
    } else if metadata_unavailable {
        // Named-profile discovery is optional: damaged application metadata
        // must not make Default's independent settings/keybindings unavailable.
        result[0].label.push_str(" (named profiles unavailable)");
    }
    Ok(result)
}

fn version_key(name: &str) -> Vec<u32> {
    name.trim_start_matches("Rider")
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse().ok())
        .collect()
}

fn rider_sources(root: &Path, custom: bool) -> Result<Vec<ImportSource>, String> {
    if custom && root.is_dir() {
        let mut item = source("rider", root, "Rider — Custom settings folder".into(), None);
        item.recommended = true;
        return Ok(vec![item]);
    }
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut versions = vec![];
    for entry in fs::read_dir(root)
        .map_err(|_| "Unable to inspect Rider settings folders")?
        .take(500)
    {
        let entry = entry.map_err(|_| "Unable to inspect Rider settings folder")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("Rider") && !version_key(&name).is_empty() && entry.path().is_dir() {
            versions.push((name, entry.path()));
        }
    }
    versions.sort_by(|a, b| {
        version_key(&b.0)
            .cmp(&version_key(&a.0))
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut result = vec![];
    let mut recommended = false;
    for (name, path) in versions.into_iter().take(MAX_SOURCES) {
        let mut item = source(
            "rider",
            &path,
            format!("Rider {}", clean_label(name.trim_start_matches("Rider"))),
            Some(name.trim_start_matches("Rider").into()),
        );
        let stable = !name.to_ascii_lowercase().contains("eap")
            && !name.to_ascii_lowercase().contains("preview");
        item.recommended = stable && !recommended;
        recommended |= stable;
        result.push(item);
    }
    Ok(result)
}

pub(super) fn discover(editor: &str, custom: Option<&str>) -> Result<Vec<ImportSource>, String> {
    if !["rider", "vscode"].contains(&editor) {
        return Err("Unsupported source editor".into());
    }
    if let Some(custom) = custom {
        let root = Path::new(custom);
        if !root.is_absolute() || !root.is_dir() {
            return Err("Choose an existing editor settings folder".into());
        }
        return if editor == "rider" {
            rider_sources(root, true)
        } else {
            vscode_sources(root, "VS Code")
        };
    }
    #[cfg(target_os = "macos")]
    let base = dirs::home_dir()
        .ok_or("Unable to locate user settings")?
        .join("Library/Application Support");
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or("Unable to locate user settings")?;
    #[cfg(not(any(target_os = "macos", windows)))]
    let base = dirs::config_dir().ok_or("Unable to locate user settings")?;
    if editor == "rider" {
        return rider_sources(&base.join("JetBrains"), false);
    }
    let mut result = vec![];
    for (folder, label) in [("Code", "VS Code"), ("Code - Insiders", "VS Code Insiders")] {
        // A broken secondary installation must not hide the main installation.
        match vscode_sources(&base.join(folder), label) {
            Ok(sources) => result.extend(sources),
            Err(error) if result.is_empty() => return Err(error),
            Err(_) => {}
        }
    }
    if let Some(index) = result.iter().position(|s| s.recommended) {
        for (i, item) in result.iter_mut().enumerate() {
            item.recommended = i == index;
        }
    }
    Ok(result)
}

fn report(preview: &mut ImportPreview, category: &str, label: &str, status: &str, detail: &str) {
    if preview.report.len() < 4000 {
        preview.report.push(ImportReportItem {
            category: category.into(),
            label: label.into(),
            status: status.into(),
            detail: detail.into(),
        });
    }
}

fn add_setting(preview: &mut ImportPreview, key: &str, value: Value, category: &str) {
    preview.settings.insert(key.into(), value);
    report(
        preview,
        category,
        key,
        "imported",
        "Supported local preference",
    );
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    read_bounded(path, MAX_SOURCE_BYTES)?
        .map(|s| jsonc(&s))
        .transpose()
}

fn read_xml(path: &Path) -> Result<Option<XmlNode>, String> {
    read_bounded(path, MAX_SOURCE_BYTES)?
        .map(|s| xml(&s))
        .transpose()
}

fn resource_path(root: &Path, requested: Option<&str>, name: &str) -> Result<PathBuf, String> {
    let path = requested
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(name));
    if path.file_name().and_then(|n| n.to_str()) != Some(name) {
        return Err("Unexpected editor resource".into());
    }
    // Restrict explicit IPC paths to the selected User directory, allowing
    // profile inheritance without following symlinks into unrelated files.
    let root = fs::canonicalize(root).map_err(|_| "Selected source folder no longer exists")?;
    let mut existing = path.parent().ok_or("Invalid resource path")?;
    while !existing.exists() {
        existing = existing.parent().ok_or("Invalid editor resource folder")?;
    }
    let parent = fs::canonicalize(existing).map_err(|_| "Invalid editor resource folder")?;
    if !parent.starts_with(&root) {
        return Err("Editor resource is outside the selected settings folder".into());
    }
    if path.exists()
        && !fs::canonicalize(&path)
            .map_err(|_| "Invalid resource path")?
            .starts_with(&root)
    {
        return Err("Editor resource points outside its settings folder".into());
    }
    Ok(path)
}

fn rooted_xml(root: &Path, relative: &str) -> Result<Option<XmlNode>, String> {
    let path = root.join(relative);
    let path = resource_path(
        root,
        path.to_str(),
        path.file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid XML resource")?,
    )?;
    read_xml(&path)
}

fn valid_font(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 512
            && !s
                .chars()
                .any(|c| c.is_control() || matches!(c, ';' | '{' | '}'))
    })
}

pub(super) fn validate_settings_patch(settings: &Map<String, Value>) -> Result<(), String> {
    for (key, value) in settings {
        let valid = match key.as_str() {
            "editor.fontFamily" | "terminal.fontFamily" => valid_font(value),
            "editor.fontSize" | "terminal.fontSize" => {
                value.as_f64().is_some_and(|n| (8.0..=40.0).contains(&n))
            }
            "editor.lineHeight" => value
                .as_f64()
                .is_some_and(|n| n == 0.0 || (8.0..=100.0).contains(&n)),
            "editor.tabSize" => value.as_u64().is_some_and(|n| [2, 4, 8].contains(&n)),
            "editor.autoSaveDelay" => value.as_u64().is_some_and(|n| (100..=60000).contains(&n)),
            "editor.fontLigatures"
            | "editor.insertSpaces"
            | "editor.detectIndentation"
            | "editor.minimap"
            | "editor.bracketPairColorization"
            | "editor.formatOnSave"
            | "editor.betterComments"
            | "terminal.cursorBlink"
            | "explorer.autoReveal" => value.is_boolean(),
            "editor.wordWrap" => value
                .as_str()
                .is_some_and(|s| ["off", "on", "wordWrapColumn"].contains(&s)),
            "editor.lineNumbers" => value
                .as_str()
                .is_some_and(|s| ["off", "on", "relative"].contains(&s)),
            "editor.renderWhitespace" => value
                .as_str()
                .is_some_and(|s| ["none", "boundary", "selection", "all"].contains(&s)),
            "editor.cursorBlinking" => value
                .as_str()
                .is_some_and(|s| ["blink", "smooth", "phase", "expand", "solid"].contains(&s)),
            "editor.autoSave" => value
                .as_str()
                .is_some_and(|s| ["off", "afterDelay", "onFocusChange"].contains(&s)),
            _ => false,
        };
        if !valid {
            return Err("Editor experience contains an unsupported preference or value".into());
        }
    }
    Ok(())
}

fn mapped_theme(name: &str, rider: bool) -> (&'static str, &'static str) {
    let lower = name.to_ascii_lowercase();
    if lower.contains("dracula") {
        ("dracula", "approximated")
    } else if lower.contains("monokai") {
        ("monokai", "approximated")
    } else if lower.contains("light") || lower.contains("day") {
        (
            if rider { "rider-light" } else { "light-plus" },
            "approximated",
        )
    } else {
        (
            if rider { "rider-dark" } else { "dark-plus" },
            "approximated",
        )
    }
}

fn vscode_settings(preview: &mut ImportPreview, raw: Value) -> Result<(), String> {
    let settings = raw
        .as_object()
        .ok_or("VS Code settings must be an object")?;
    let mut recognized = HashSet::new();
    for (source, target, category, kind) in [
        (
            "editor.fontFamily",
            "editor.fontFamily",
            "appearance",
            "font",
        ),
        (
            "editor.fontSize",
            "editor.fontSize",
            "appearance",
            "fontSize",
        ),
        (
            "editor.fontLigatures",
            "editor.fontLigatures",
            "appearance",
            "bool",
        ),
        (
            "editor.lineHeight",
            "editor.lineHeight",
            "appearance",
            "lineHeight",
        ),
        ("editor.tabSize", "editor.tabSize", "editor", "tabs"),
        (
            "editor.insertSpaces",
            "editor.insertSpaces",
            "editor",
            "bool",
        ),
        (
            "editor.detectIndentation",
            "editor.detectIndentation",
            "editor",
            "bool",
        ),
        ("editor.minimap.enabled", "editor.minimap", "editor", "bool"),
        (
            "editor.bracketPairColorization.enabled",
            "editor.bracketPairColorization",
            "editor",
            "bool",
        ),
        (
            "editor.formatOnSave",
            "editor.formatOnSave",
            "editor",
            "bool",
        ),
        (
            "files.autoSaveDelay",
            "editor.autoSaveDelay",
            "editor",
            "delay",
        ),
        (
            "terminal.integrated.fontFamily",
            "terminal.fontFamily",
            "appearance",
            "font",
        ),
        (
            "terminal.integrated.fontSize",
            "terminal.fontSize",
            "appearance",
            "fontSize",
        ),
        (
            "terminal.integrated.cursorBlinking",
            "terminal.cursorBlink",
            "editor",
            "bool",
        ),
        (
            "explorer.autoReveal",
            "explorer.autoReveal",
            "editor",
            "bool",
        ),
    ] {
        let Some(value) = settings.get(source) else {
            continue;
        };
        recognized.insert(source);
        let valid = match kind {
            "font" => valid_font(value),
            "bool" => value.is_boolean(),
            "fontSize" => value.as_f64().is_some_and(|n| (8.0..=40.0).contains(&n)),
            "lineHeight" => value
                .as_f64()
                .is_some_and(|n| n == 0.0 || (8.0..=100.0).contains(&n)),
            "tabs" => value.as_u64().is_some_and(|n| [2, 4, 8].contains(&n)),
            "delay" => value.as_u64().is_some_and(|n| (100..=60000).contains(&n)),
            _ => false,
        };
        if valid {
            add_setting(preview, target, value.clone(), category);
        } else {
            report(
                preview,
                category,
                target,
                "unsupported",
                "Value is outside UnityIDE's supported preference range",
            );
        }
        if kind == "font" && valid {
            report(preview, "appearance", target, "approximated", "Font availability is checked in the import review; unavailable fonts use the system fallback");
        }
    }
    for (source, target, allowed) in [
        (
            "editor.wordWrap",
            "editor.wordWrap",
            vec!["off", "on", "wordWrapColumn"],
        ),
        (
            "editor.lineNumbers",
            "editor.lineNumbers",
            vec!["off", "on", "relative"],
        ),
        (
            "editor.renderWhitespace",
            "editor.renderWhitespace",
            vec!["none", "boundary", "selection", "all"],
        ),
        (
            "editor.cursorBlinking",
            "editor.cursorBlinking",
            vec!["blink", "smooth", "phase", "expand", "solid"],
        ),
        (
            "files.autoSave",
            "editor.autoSave",
            vec!["off", "afterDelay", "onFocusChange"],
        ),
    ] {
        if let Some(value) = settings.get(source) {
            recognized.insert(source);
            if value.as_str().is_some_and(|s| allowed.contains(&s)) {
                add_setting(preview, target, value.clone(), "editor");
            } else {
                report(
                    preview,
                    "editor",
                    target,
                    "unsupported",
                    "Preference mode has no supported UnityIDE equivalent",
                );
            }
        }
    }
    if let Some(name) = settings.get("workbench.colorTheme").and_then(Value::as_str) {
        recognized.insert("workbench.colorTheme");
        let (id, status) = mapped_theme(name, false);
        preview.theme_id = Some(id.into());
        report(
            preview,
            "appearance",
            "Color theme",
            status,
            "Using the closest built-in UnityIDE theme; custom theme files are not imported",
        );
    }
    let scoped = settings.keys().filter(|key| key.starts_with('[')).count();
    if scoped > 0 {
        report(
            preview,
            "editor",
            "Language settings",
            "unsupported",
            "Language-specific preferences are not imported in this release",
        );
    }
    let unknown = settings
        .keys()
        .filter(|key| !recognized.contains(key.as_str()) && !key.starts_with('['))
        .count();
    if unknown > 0 {
        report(preview, "editor", "Other settings", "unsupported", &format!("{unknown} preferences are outside the supported import list; their values were not imported"));
    }
    Ok(())
}

fn normalize_context(value: Option<&str>) -> Option<Option<String>> {
    match value.map(str::trim) {
        None | Some("") => Some(Some("global".into())),
        Some("editorTextFocus")
        | Some("editorFocus")
        | Some("editorTextFocus && !findWidgetVisible") => Some(Some("editor".into())),
        Some("terminalFocus") => Some(Some("terminal".into())),
        Some("textInputFocus") | Some("inputFocus") => Some(Some("input".into())),
        _ => None,
    }
}

/// Canonical event.code names are shared with the JavaScript dispatcher.
pub(super) fn normalize_stroke(stroke: &str, rider: bool) -> Option<String> {
    let stroke = stroke.to_ascii_lowercase().replace("pressed ", "");
    let parts: Vec<&str> = if rider {
        stroke.split_whitespace().collect()
    } else {
        stroke.split('+').collect()
    };
    let mut modifiers = HashSet::new();
    let mut key = None;
    for part in parts {
        let part = part.trim();
        match part {
            "ctrl" | "control" => {
                modifiers.insert("ctrl");
            }
            "cmd" | "command" | "meta" => {
                modifiers.insert("cmd");
            }
            "alt" | "option" => {
                modifiers.insert("alt");
            }
            "shift" => {
                modifiers.insert("shift");
            }
            "win" | "super" => return None,
            "" => return None,
            _ if key.is_none() => {
                let key_part = if part == "[" || part == "]" {
                    part
                } else {
                    part.trim_start_matches('[').trim_end_matches(']')
                };
                let mapped = match key_part {
                    "left" | "arrowleft" => "left",
                    "right" | "arrowright" => "right",
                    "up" | "arrowup" => "up",
                    "down" | "arrowdown" => "down",
                    "esc" | "escape" => "esc",
                    "return" | "enter" => "enter",
                    "back_space" | "backspace" => "backspace",
                    "page_up" | "pageup" => "pageup",
                    "page_down" | "pagedown" => "pagedown",
                    "space" => "space",
                    "open_bracket" | "[" | "bracketleft" => "bracketleft",
                    "close_bracket" | "]" | "bracketright" => "bracketright",
                    "back_quote" | "`" | "backquote" => "backquote",
                    "minus" | "-" => "minus",
                    "equals" | "=" | "equal" => "equal",
                    "slash" | "/" => "slash",
                    "back_slash" | "backslash" | "\\" => "backslash",
                    "semicolon" | ";" => "semicolon",
                    "quote" | "'" => "quote",
                    "comma" | "," => "comma",
                    "period" | "." => "period",
                    key if key.starts_with("key") && key.len() == 4 => &key[3..],
                    key if key.starts_with("digit") && key.len() == 6 => &key[5..],
                    key => key,
                };
                let valid = mapped.len() == 1 && mapped.chars().all(|c| c.is_ascii_alphanumeric())
                    || [
                        "left",
                        "right",
                        "up",
                        "down",
                        "esc",
                        "enter",
                        "backspace",
                        "pageup",
                        "pagedown",
                        "home",
                        "end",
                        "tab",
                        "space",
                        "delete",
                        "insert",
                        "bracketleft",
                        "bracketright",
                        "backquote",
                        "minus",
                        "equal",
                        "slash",
                        "backslash",
                        "semicolon",
                        "quote",
                        "comma",
                        "period",
                    ]
                    .contains(&mapped)
                    || mapped
                        .strip_prefix('f')
                        .and_then(|n| n.parse::<u8>().ok())
                        .is_some_and(|n| (1..=19).contains(&n));
                if !valid {
                    return None;
                }
                key = Some(mapped);
            }
            _ => return None,
        }
    }
    let key = key?;
    let mut result = vec![];
    for modifier in ["ctrl", "cmd", "alt", "shift"] {
        if modifiers.contains(modifier) {
            result.push(modifier);
        }
    }
    result.push(key);
    Some(result.join("+"))
}

pub(super) fn protected_binding(strokes: &[String]) -> bool {
    strokes.iter().any(|s| {
        [
            "cmd+q",
            "cmd+h",
            "cmd+alt+h",
            "cmd+tab",
            "cmd+shift+tab",
            "alt+tab",
            "alt+shift+tab",
            "alt+f4",
            "ctrl+alt+delete",
            "cmd+c",
            "cmd+x",
            "cmd+v",
            "cmd+a",
            "cmd+z",
            "cmd+shift+z",
            "ctrl+c",
            "ctrl+x",
            "ctrl+v",
            "ctrl+a",
            "ctrl+z",
            "ctrl+shift+z",
            "ctrl+y",
        ]
        .contains(&s.as_str())
    })
}

fn vscode_action(id: &str) -> Option<&'static str> {
    Some(match id {
        "workbench.action.files.save" => "file.save",
        "workbench.action.files.newUntitledFile" => "file.new",
        "workbench.action.closeActiveEditor" => "file.closeTab",
        "workbench.action.closeAllEditors" => "tab.closeAll",
        "workbench.action.closeOtherEditors" => "tab.closeOthers",
        "workbench.action.closeEditorsToTheRight" => "tab.closeToRight",
        "workbench.action.reopenClosedEditor" => "tab.reopenClosed",
        "workbench.action.nextEditor" => "tab.next",
        "workbench.action.previousEditor" => "tab.prev",
        "workbench.action.quickOpen" => "palette.quickOpen",
        "workbench.action.showCommands" => "palette.commands",
        "workbench.action.openSettings" => "settings.open",
        "workbench.action.gotoLine" => "editor.gotoLine",
        "workbench.action.gotoSymbol" => "editor.gotoSymbol",
        "editor.action.formatDocument" => "editor.formatDocument",
        "editor.action.referenceSearch.trigger" => "editor.findUsages",
        "editor.action.quickFix" => "editor.quickFix",
        "editor.action.refactor" => "editor.refactor",
        "editor.action.rename" => "monaco:editor.action.rename",
        "editor.action.revealDefinition" => "monaco:editor.action.revealDefinition",
        "workbench.action.navigateBack" => "nav.back",
        "workbench.action.navigateForward" => "nav.forward",
        "workbench.action.terminal.toggleTerminal" => "terminal.toggle",
        "workbench.action.terminal.new" => "terminal.new",
        "workbench.action.terminal.split" => "terminal.split",
        "workbench.action.toggleSidebarVisibility" => "view.toggleSidebar",
        "workbench.action.togglePanel" => "view.toggleBottomPanel",
        "workbench.view.explorer" => "view.explorer",
        "workbench.view.scm" => "view.sourceControl",
        "workbench.view.debug" => "view.debug",
        "workbench.action.findInFiles" => "search.openTab",
        "workbench.action.zoomIn" => "view.zoomIn",
        "workbench.action.zoomOut" => "view.zoomOut",
        "workbench.action.zoomReset" => "view.zoomReset",
        "editor.debug.action.toggleBreakpoint" => "debug.toggleBreakpoint",
        "workbench.action.debug.continue" => "debug.continue",
        "workbench.action.debug.stepOver" => "debug.stepOver",
        "workbench.action.debug.stepInto" => "debug.stepInto",
        "workbench.action.debug.stepOut" => "debug.stepOut",
        "workbench.action.debug.stop" => "debug.stop",
        "actions.find" => "monaco:actions.find",
        "editor.action.startFindReplaceAction" => "monaco:editor.action.startFindReplaceAction",
        "editor.action.commentLine" => "monaco:editor.action.commentLine",
        "editor.action.blockComment" => "monaco:editor.action.blockComment",
        "editor.action.deleteLines" => "monaco:editor.action.deleteLines",
        "editor.action.copyLinesDownAction" => "monaco:editor.action.copyLinesDownAction",
        "editor.action.copyLinesUpAction" => "monaco:editor.action.copyLinesUpAction",
        "editor.action.moveLinesDownAction" => "monaco:editor.action.moveLinesDownAction",
        "editor.action.moveLinesUpAction" => "monaco:editor.action.moveLinesUpAction",
        "editor.action.addSelectionToNextFindMatch" => {
            "monaco:editor.action.addSelectionToNextFindMatch"
        }
        "editor.action.selectHighlights" => "monaco:editor.action.selectHighlights",
        "editor.action.insertCursorAbove" => "monaco:editor.action.insertCursorAbove",
        "editor.action.insertCursorBelow" => "monaco:editor.action.insertCursorBelow",
        "editor.action.smartSelect.expand" => "monaco:editor.action.smartSelect.expand",
        "editor.action.smartSelect.shrink" => "monaco:editor.action.smartSelect.shrink",
        "editor.action.indentLines" => "monaco:editor.action.indentLines",
        "editor.action.outdentLines" => "monaco:editor.action.outdentLines",
        "editor.fold" => "monaco:editor.fold",
        "editor.unfold" => "monaco:editor.unfold",
        "editor.foldAll" => "monaco:editor.foldAll",
        "editor.unfoldAll" => "monaco:editor.unfoldAll",
        _ => return None,
    })
}

fn add_binding(preview: &mut ImportPreview, binding: KeyBinding) {
    if protected_binding(&binding.strokes) {
        report(
            preview,
            "shortcuts",
            "Protected shortcut",
            "conflicting",
            "Operating-system and standard text-editing shortcuts are preserved",
        );
        return;
    }
    // Rider keymaps do not define VS Code's ordered-rule precedence. Defer
    // reporting until the complete inherited map has resolved, then exclude
    // every action that still shares an ambiguous context/chord.
    if preview.source.editor == "rider" {
        preview.keybindings.push(binding);
        return;
    }
    let conflict = binding.removed != Some(true)
        && preview.keybindings.iter().any(|b| {
            b.removed != Some(true)
                && b.context == binding.context
                && b.strokes == binding.strokes
                && b.command_id != binding.command_id
        });
    if conflict {
        report(
            preview,
            "shortcuts",
            "Shortcut conflict",
            "conflicting",
            "Multiple imported actions share a shortcut; the last rule takes precedence",
        );
    } else {
        report(
            preview,
            "shortcuts",
            &binding.command_id,
            "imported",
            if binding.removed == Some(true) {
                "Mapped default shortcut removal"
            } else {
                "Mapped action and shortcut"
            },
        );
    }
    preview.keybindings.push(binding);
}

fn exclude_rider_conflicts(preview: &mut ImportPreview) {
    let mut assignments: BTreeMap<(Option<String>, Vec<String>), HashSet<String>> = BTreeMap::new();
    for binding in &preview.keybindings {
        if binding.removed != Some(true) {
            assignments
                .entry((binding.context.clone(), binding.strokes.clone()))
                .or_default()
                .insert(binding.command_id.clone());
        }
    }
    let ambiguous: HashSet<_> = assignments
        .iter()
        .filter(|(_, actions)| actions.len() > 1)
        .map(|(chord, _)| chord.clone())
        .collect();
    preview.keybindings.retain(|binding| {
        binding.removed == Some(true)
            || !ambiguous.contains(&(binding.context.clone(), binding.strokes.clone()))
    });
    for ((_, strokes), actions) in assignments {
        if actions.len() > 1 {
            report(
                preview,
                "shortcuts",
                &strokes.join(" "),
                "conflicting",
                "Several Rider actions share this shortcut with no unambiguous priority. All assignments to this shortcut were skipped.",
            );
        }
    }
    for binding in preview.keybindings.clone() {
        report(
            preview,
            "shortcuts",
            &binding.command_id,
            "imported",
            if binding.removed == Some(true) {
                "Mapped default shortcut removal"
            } else {
                "Mapped action and shortcut"
            },
        );
    }
}

fn vscode_bindings(preview: &mut ImportPreview, raw: Value) -> Result<(), String> {
    let bindings = raw
        .as_array()
        .ok_or("VS Code keybindings must be an array")?;
    if bindings.len() > MAX_SHORTCUTS {
        return Err("Too many VS Code shortcuts to import".into());
    }
    for item in bindings {
        let Some(command) = item.get("command").and_then(Value::as_str) else {
            report(
                preview,
                "shortcuts",
                "Shortcut",
                "unsupported",
                "Malformed command rule",
            );
            continue;
        };
        let removed = command.starts_with('-');
        let Some(mapped) = vscode_action(command.trim_start_matches('-')) else {
            report(
                preview,
                "shortcuts",
                "Unmapped action",
                "unsupported",
                "No equivalent UnityIDE action; source command values were not imported",
            );
            continue;
        };
        if item.get("args").is_some()
            || item.get("systemWide").and_then(Value::as_bool) == Some(true)
        {
            report(
                preview,
                "shortcuts",
                mapped,
                "unsupported",
                "Command arguments and system-wide shortcuts are not imported",
            );
            continue;
        }
        let Some(context) = normalize_context(item.get("when").and_then(Value::as_str)) else {
            report(
                preview,
                "shortcuts",
                mapped,
                "unsupported",
                "Context expression has no safe UnityIDE equivalent",
            );
            continue;
        };
        let Some(key) = item.get("key").and_then(Value::as_str) else {
            report(
                preview,
                "shortcuts",
                mapped,
                "unsupported",
                "Shortcut has no key sequence",
            );
            continue;
        };
        let strokes = key
            .split_whitespace()
            .map(|s| normalize_stroke(s, false))
            .collect::<Option<Vec<_>>>();
        let Some(strokes) = strokes.filter(|s| !s.is_empty() && s.len() <= 2) else {
            report(
                preview,
                "shortcuts",
                mapped,
                "unsupported",
                "Unsupported key sequence",
            );
            continue;
        };
        add_binding(
            preview,
            KeyBinding {
                command_id: mapped.into(),
                strokes,
                context,
                removed: if removed { Some(true) } else { None },
            },
        );
    }
    Ok(())
}

fn component<'a>(node: &'a XmlNode, name: &str) -> Option<&'a XmlNode> {
    node.children
        .iter()
        .find(|n| n.name == "component" && n.attrs.get("name").is_some_and(|s| s == name))
}

fn options(node: &XmlNode) -> BTreeMap<&str, &str> {
    node.children
        .iter()
        .filter(|n| n.name == "option")
        .filter_map(|n| {
            Some((
                n.attrs.get("name")?.as_str(),
                n.attrs.get("value")?.as_str(),
            ))
        })
        .collect()
}

fn rider_settings(preview: &mut ImportPreview, root: &Path) -> Result<(), String> {
    let old_editor = rooted_xml(root, "options/editor.xml")?;
    let fonts = rooted_xml(root, "options/editor-font.xml")?;
    if let Some(font) = fonts
        .as_ref()
        .and_then(|n| component(n, "DefaultFont"))
        .or_else(|| {
            old_editor
                .as_ref()
                .and_then(|n| component(n, "DefaultFont"))
        })
    {
        let opts = options(font);
        if let Some(name) = opts.get("FONT_FAMILY") {
            if valid_font(&json!(name)) {
                add_setting(preview, "editor.fontFamily", json!(name), "appearance");
                report(preview, "appearance", "Editor font availability", "approximated", "Rider can use a bundled runtime font; unavailable local fonts use UnityIDE's system fallback");
            }
        }
        let size = opts
            .get("FONT_SIZE_2D")
            .or_else(|| opts.get("FONT_SIZE"))
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| (8.0..=40.0).contains(n));
        if let Some(size) = size {
            add_setting(preview, "editor.fontSize", json!(size), "appearance");
        } else if opts.contains_key("FONT_SIZE_2D") || opts.contains_key("FONT_SIZE") {
            report(
                preview,
                "appearance",
                "Editor font size",
                "unsupported",
                "Rider font size is outside UnityIDE's supported range; supported preferences still import and line spacing uses the default font size",
            );
        }
        if let Some(ligatures) = opts
            .get("USE_LIGATURES")
            .and_then(|s| s.parse::<bool>().ok())
        {
            add_setting(
                preview,
                "editor.fontLigatures",
                json!(ligatures),
                "appearance",
            );
        }
        if let Some(spacing) = opts
            .get("LINE_SPACING")
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| (0.8..=3.0).contains(n))
        {
            // Java and browser font metrics differ: preserve the ratio, report
            // the conversion instead of claiming byte-identical typography.
            let height = (spacing * size.unwrap_or(13.0)).round().clamp(8.0, 100.0);
            preview
                .settings
                .insert("editor.lineHeight".into(), json!(height));
            report(
                preview,
                "appearance",
                "Editor line height",
                "approximated",
                "Converted Rider line-spacing ratio to browser line height",
            );
        }
    }
    if let Some(editor) = old_editor
        .as_ref()
        .and_then(|n| component(n, "EditorSettings"))
    {
        let opts = options(editor);
        if let Some(shown) = opts
            .get("IS_LINE_NUMBERS_SHOWN")
            .and_then(|s| s.parse::<bool>().ok())
        {
            add_setting(
                preview,
                "editor.lineNumbers",
                json!(if shown { "on" } else { "off" }),
                "editor",
            );
        }
        if opts.get("ARE_RELATIVE_LINE_NUMBERS_SHOWN") == Some(&"true")
            && opts.get("IS_LINE_NUMBERS_SHOWN") != Some(&"false")
        {
            add_setting(preview, "editor.lineNumbers", json!("relative"), "editor");
        }
        if let Some(shown) = opts
            .get("IS_WHITESPACES_SHOWN")
            .and_then(|s| s.parse::<bool>().ok())
        {
            let mode = if !shown {
                "none"
            } else if opts.get("IS_INNER_WHITESPACES_SHOWN") == Some(&"false") {
                "boundary"
            } else {
                "all"
            };
            preview
                .settings
                .insert("editor.renderWhitespace".into(), json!(mode));
            report(
                preview,
                "editor",
                "Whitespace rendering",
                "approximated",
                "Rider's separate whitespace flags map to the closest UnityIDE mode",
            );
        }
        if let Some(wraps) = opts.get("USE_SOFT_WRAPS") {
            let enabled = wraps.split(':').any(|s| s == "MAIN_EDITOR");
            if enabled && opts.get("SOFT_WRAP_FILE_MASKS").is_some_and(|m| *m != "*") {
                report(
                    preview,
                    "editor",
                    "Soft wrap file masks",
                    "unsupported",
                    "File-specific wrap scopes are not imported",
                );
            } else {
                add_setting(
                    preview,
                    "editor.wordWrap",
                    json!(if enabled { "on" } else { "off" }),
                    "editor",
                );
            }
        }
        if let Some(blink) = opts
            .get("IS_CARET_BLINKING")
            .and_then(|s| s.parse::<bool>().ok())
        {
            add_setting(
                preview,
                "editor.cursorBlinking",
                json!(if blink { "blink" } else { "solid" }),
                "editor",
            );
        }
    }
    let laf = rooted_xml(root, "options/laf.xml")?;
    let scheme = rooted_xml(root, "options/colors.scheme.xml")?;
    let theme = laf
        .as_ref()
        .and_then(|n| component(n, "LafManager"))
        .and_then(|n| n.children.iter().find(|c| c.name == "laf"))
        .and_then(|n| n.attrs.get("themeId").or_else(|| n.attrs.get("class-name")));
    let color = scheme
        .as_ref()
        .and_then(|n| component(n, "EditorColorsManagerImpl"))
        .and_then(|n| n.children.iter().find(|c| c.name == "global_color_scheme"))
        .and_then(|n| n.attrs.get("name"));
    if let Some(name) = color.or(theme) {
        let (id, status) = mapped_theme(name, true);
        preview.theme_id = Some(id.into());
        report(preview, "appearance", "Rider theme", status, "Using the closest built-in UnityIDE theme; Rider UI layout and custom color-scheme files are not copied");
    }
    report(preview, "editor", "Rider formatting layers", "unsupported", ".DotSettings, code-style schemes and project/language formatting scopes are not imported in this release");
    Ok(())
}

fn rider_action(id: &str) -> Option<&'static str> {
    Some(match id {
        "SaveAll" | "SaveDocument" => "file.save",
        "CloseContent" => "file.closeTab",
        "CloseAllEditors" => "tab.closeAll",
        "ReopenClosedTab" => "tab.reopenClosed",
        "NextTab" => "tab.next",
        "PreviousTab" => "tab.prev",
        "GotoFile" => "palette.quickOpen",
        "GotoAction" => "palette.commands",
        "ShowSettings" => "settings.open",
        "GotoLine" => "editor.gotoLine",
        "FileStructurePopup" => "editor.gotoSymbol",
        "ReformatCode" => "editor.formatDocument",
        "FindUsages" | "ShowUsages" => "editor.findUsages",
        "ShowIntentionActions" => "editor.quickFix",
        "Refactorings.QuickListPopupAction" => "editor.refactor",
        "RenameElement" => "monaco:editor.action.rename",
        "GotoDeclaration" => "monaco:editor.action.revealDefinition",
        "Back" => "nav.back",
        "Forward" => "nav.forward",
        "ActivateTerminalToolWindow" => "terminal.toggle",
        "ActivateProjectToolWindow" => "view.explorer",
        "ActivateVersionControlToolWindow" => "view.sourceControl",
        "ActivateDebugToolWindow" => "view.debug",
        "FindInPath" => "search.openTab",
        "ToggleLineBreakpoint" => "debug.toggleBreakpoint",
        "Resume" => "debug.continue",
        "StepOver" => "debug.stepOver",
        "StepInto" => "debug.stepInto",
        "StepOut" => "debug.stepOut",
        "Stop" => "debug.stop",
        "Pause" => "debug.pause",
        "RunToCursor" => "debug.runToCursor",
        "Find" => "monaco:actions.find",
        "Replace" => "monaco:editor.action.startFindReplaceAction",
        "CommentByLineComment" => "monaco:editor.action.commentLine",
        "CommentByBlockComment" => "monaco:editor.action.blockComment",
        "EditorDeleteLine" => "monaco:editor.action.deleteLines",
        "EditorDuplicate" => "monaco:editor.action.copyLinesDownAction",
        "MoveLineDown" => "monaco:editor.action.moveLinesDownAction",
        "MoveLineUp" => "monaco:editor.action.moveLinesUpAction",
        "SelectNextOccurrence" => "monaco:editor.action.addSelectionToNextFindMatch",
        "SelectAllOccurrences" => "monaco:editor.action.selectHighlights",
        "EditorSelectWord" => "monaco:editor.action.smartSelect.expand",
        "EditorUnSelectWord" => "monaco:editor.action.smartSelect.shrink",
        "EditorIndentSelection" => "monaco:editor.action.indentLines",
        "EditorUnindentSelection" => "monaco:editor.action.outdentLines",
        "CollapseRegion" => "monaco:editor.fold",
        "ExpandRegion" => "monaco:editor.unfold",
        "CollapseAllRegions" => "monaco:editor.foldAll",
        "ExpandAllRegions" => "monaco:editor.unfoldAll",
        _ => return None,
    })
}

fn keymap_family(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    if name.contains("visual studio 2022") {
        Some("visual-studio-2022")
    } else if name.contains("visual studio") || name.contains("visual_studio") {
        Some("visual-studio")
    } else if name.contains("resharper") {
        Some("resharper")
    } else if name.contains("vs code") || name.contains("vscode") {
        Some("vscode")
    } else if [
        "$default",
        "default",
        "mac os x",
        "mac os x 10.5+",
        "macos",
        "intellij idea classic",
        "intellij",
        "intellij (macos)",
        "macos system shortcuts",
    ]
    .contains(&name.as_str())
        || name.contains("intellij")
    {
        Some("intellij")
    } else {
        None
    }
}

fn resolve_rider_map(
    preview: &mut ImportPreview,
    root: &Path,
    name: &str,
    visited: &mut HashSet<String>,
) -> Result<(), String> {
    if visited.len() >= 16 || !visited.insert(name.into()) {
        return Err("Cyclic or deeply nested Rider keymap inheritance".into());
    }
    let mut found = None;
    let directory = root.join("keymaps");
    if directory.is_dir() {
        for entry in fs::read_dir(&directory)
            .map_err(|_| "Unable to inspect Rider keymaps")?
            .take(MAX_SOURCES)
        {
            let path = entry.map_err(|_| "Unable to inspect Rider keymap")?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("xml") {
                continue;
            }
            if let Some(node) = read_xml(&resource_path(
                root,
                Some(&path.to_string_lossy()),
                path.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            )?)? {
                if node.name == "keymap" && node.attrs.get("name").is_some_and(|s| s == name) {
                    found = Some(node);
                    break;
                }
            }
        }
    }
    let Some(node) = found else {
        if let Some(family) = keymap_family(name) {
            preview.keymap = Some(family.into());
        } else {
            report(
                preview,
                "shortcuts",
                "Rider parent keymap",
                "unsupported",
                "Parent keymap is unavailable or is not a supported keymap family",
            );
        }
        return Ok(());
    };
    if let Some(parent) = node.attrs.get("parent") {
        resolve_rider_map(preview, root, parent, visited)?;
    } else if let Some(family) = keymap_family(name) {
        preview.keymap = Some(family.into());
    }
    let actions: Vec<_> = node
        .children
        .iter()
        .filter(|n| n.name == "action")
        .collect();
    if actions.len() > MAX_SHORTCUTS {
        return Err("Too many Rider keymap actions".into());
    }
    for action in actions {
        let Some(mapped) = action.attrs.get("id").and_then(|id| rider_action(id)) else {
            report(
                preview,
                "shortcuts",
                "Unmapped Rider action",
                "unsupported",
                "No equivalent UnityIDE action; source action values were not imported",
            );
            continue;
        };
        let context = Some(
            if mapped.starts_with("monaco:") || mapped.starts_with("editor.") {
                "editor"
            } else {
                "global"
            }
            .into(),
        );
        // Rider deltas replace each action's entire inherited shortcut list.
        preview.keybindings.retain(|b| b.command_id != mapped);
        add_binding(
            preview,
            KeyBinding {
                command_id: mapped.into(),
                strokes: vec![],
                context: context.clone(),
                removed: Some(true),
            },
        );
        for shortcut in &action.children {
            if shortcut.name != "keyboard-shortcut" {
                report(
                    preview,
                    "shortcuts",
                    mapped,
                    "unsupported",
                    "Mouse shortcuts and modifier gestures are not imported",
                );
                continue;
            }
            let first = shortcut
                .attrs
                .get("first-keystroke")
                .and_then(|s| normalize_stroke(s, true));
            let second = shortcut
                .attrs
                .get("second-keystroke")
                .map(|s| normalize_stroke(s, true));
            let Some(first) = first else {
                report(
                    preview,
                    "shortcuts",
                    mapped,
                    "unsupported",
                    "Unsupported Rider keystroke",
                );
                continue;
            };
            let mut strokes = vec![first];
            if let Some(second) = second {
                let Some(second) = second else {
                    report(
                        preview,
                        "shortcuts",
                        mapped,
                        "unsupported",
                        "Unsupported second Rider keystroke",
                    );
                    continue;
                };
                strokes.push(second);
            }
            add_binding(
                preview,
                KeyBinding {
                    command_id: mapped.into(),
                    strokes,
                    context: context.clone(),
                    removed: None,
                },
            );
        }
    }
    Ok(())
}

fn rider_bindings(preview: &mut ImportPreview, root: &Path) -> Result<(), String> {
    let os = if cfg!(target_os = "macos") {
        "mac"
    } else {
        "windows"
    };
    let mut active = None;
    for file in [
        format!("options/{os}/keymap.xml"),
        "options/keymap.xml".into(),
    ] {
        if let Some(node) = rooted_xml(root, &file)? {
            active = component(&node, "KeymapManager")
                .and_then(|n| n.children.iter().find(|c| c.name == "active_keymap"))
                .and_then(|n| n.attrs.get("name"))
                .cloned();
            if active.is_some() {
                break;
            }
        }
    }
    if let Some(active) = active {
        resolve_rider_map(preview, root, &active, &mut HashSet::new())?;
        exclude_rider_conflicts(preview);
    } else {
        preview.keymap = Some(
            if cfg!(target_os = "macos") {
                "intellij"
            } else {
                "visual-studio"
            }
            .into(),
        );
        report(preview, "shortcuts", "Rider keymap", "approximated", "No explicit keymap was saved; using the platform's Rider default. You can change the family before importing.");
    }
    Ok(())
}

pub(super) fn preview(source: ImportSource) -> Result<ImportPreview, String> {
    if !["vscode", "rider"].contains(&source.editor.as_str()) {
        return Err("Unsupported editor source".into());
    }
    let root = PathBuf::from(&source.path);
    if !root.is_absolute() || !root.is_dir() {
        return Err("Selected settings folder no longer exists".into());
    }
    let mut preview = ImportPreview {
        source: source.clone(),
        settings: Map::new(),
        theme_id: None,
        keymap: None,
        keybindings: vec![],
        report: vec![],
    };
    if source.editor == "vscode" {
        let settings = resource_path(&root, source.settings_path.as_deref(), "settings.json")?;
        let keys = resource_path(
            &root,
            source.keybindings_path.as_deref(),
            "keybindings.json",
        )?;
        if let Some(raw) = read_json(&settings)? {
            vscode_settings(&mut preview, raw)?;
        } else {
            report(&mut preview, "editor", "VS Code settings", "unsupported", "No customized settings file was found; the selected experience defaults still apply");
        }
        if let Some(raw) = read_json(&keys)? {
            vscode_bindings(&mut preview, raw)?;
        }
        preview.keymap = Some("vscode".into());
    } else {
        rider_settings(&mut preview, &root)?;
        rider_bindings(&mut preview, &root)?;
    }
    report(&mut preview, "editor", "Extensions, snippets and workspace state", "unsupported", "Only supported local user preferences are imported; extensions, snippets and workspace state stay in the source editor");
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jsonc_preserves_escaped_strings_and_rejects_unfinished_comments() {
        let value = jsonc("{ // comment\n \"url\": \"https://example.test/*x*/\", \"escaped\": \"\\\"//\", \"list\": [1, /* c */ 2,], }").unwrap();
        assert_eq!(value["url"], "https://example.test/*x*/");
        assert_eq!(value["list"], json!([1, 2]));
        assert!(jsonc("{ /* never ends").is_err());
        assert!(jsonc("{ key: 2 }").is_err());
    }
    #[test]
    fn xml_rejects_entities_and_malformed_nesting() {
        assert!(
            xml("<!DOCTYPE keymap [<!ENTITY x SYSTEM 'file:///tmp/secret'>]><keymap/>").is_err()
        );
        assert!(xml("<application><component></application>").is_err());
    }
    #[test]
    fn normalization_and_os_protection() {
        assert_eq!(
            normalize_stroke("control alt pressed L", true),
            Some("ctrl+alt+l".into())
        );
        assert_eq!(
            normalize_stroke("cmd+[Slash]", false),
            Some("cmd+slash".into())
        );
        assert_eq!(
            normalize_stroke("shift+ctrl+f5", false),
            Some("ctrl+shift+f5".into())
        );
        assert!(normalize_stroke("double shift", true).is_none());
        assert!(protected_binding(&["cmd+q".into()]));
    }
    #[test]
    fn named_profiles_resolve_independent_inherited_resources() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("profiles/abc")).unwrap();
        fs::create_dir_all(dir.path().join("globalStorage")).unwrap();
        fs::write(dir.path().join("globalStorage/storage.json"), r#"{"userDataProfiles":[{"name":"Unity","location":"abc","useDefaultFlags":{"settings":true}}],"secret":"never returned"}"#).unwrap();
        let sources = vscode_sources(dir.path(), "VS Code").unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[1].settings_path, sources[0].settings_path);
        assert!(sources[1]
            .keybindings_path
            .as_ref()
            .unwrap()
            .contains("profiles/abc/keybindings.json"));
        assert!(!serde_json::to_string(&sources)
            .unwrap()
            .contains("never returned"));
    }
    #[test]
    fn malformed_profile_metadata_keeps_default_source() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("globalStorage")).unwrap();
        fs::write(dir.path().join("globalStorage/storage.json"), "{broken").unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{"editor.fontSize":15}"#,
        )
        .unwrap();
        let sources = vscode_sources(dir.path(), "VS Code").unwrap();
        assert_eq!(sources.len(), 1);
        let result = preview(sources[0].clone()).unwrap();
        assert_eq!(result.settings["editor.fontSize"], 15);
    }
    #[test]
    fn readonly_guards_are_not_dropped_and_navigation_is_canonical() {
        assert!(normalize_context(Some("editorTextFocus && !editorReadonly")).is_none());
        assert!(normalize_context(Some(
            "editorTextFocus && !editorReadonly && !findWidgetVisible"
        ))
        .is_none());
        assert!(normalize_context(Some("editorTextFocus && !findWidgetVisible")).is_some());
        assert_eq!(normalize_stroke("alt LEFT", true), Some("alt+left".into()));
        assert_eq!(normalize_stroke("escape", false), Some("esc".into()));
        assert!(rider_action("SearchEverywhere").is_none());
    }
    #[test]
    fn profiles_cannot_escape_root_and_source_resources_cannot_escape() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("globalStorage")).unwrap();
        fs::write(
            dir.path().join("globalStorage/storage.json"),
            r#"{"userDataProfiles":[{"name":"Bad","location":"../outside"}]}"#,
        )
        .unwrap();
        assert_eq!(vscode_sources(dir.path(), "VS Code").unwrap().len(), 1);
        let outside = tempfile::tempdir().unwrap();
        assert!(resource_path(
            dir.path(),
            Some(outside.path().join("settings.json").to_str().unwrap()),
            "settings.json"
        )
        .is_err());
    }
    #[test]
    fn rider_versions_recommend_newest_stable() {
        let dir = tempfile::tempdir().unwrap();
        for version in ["Rider2025.3", "Rider2026.1", "Rider2026.2-EAP"] {
            fs::create_dir(dir.path().join(version)).unwrap();
        }
        let sources = rider_sources(dir.path(), false).unwrap();
        assert_eq!(sources[0].version.as_deref(), Some("2026.2-EAP"));
        assert!(!sources[0].recommended);
        assert!(sources[1].recommended);
    }
    #[test]
    fn vscode_import_is_allowlisted_and_contexts_do_not_widen() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("settings.json"), r#"{"editor.fontSize":16,"editor.tabSize":4,"editor.minimap.enabled":false,"workbench.colorTheme":"Light Modern","[csharp]":{"editor.tabSize":8},"auth.token":"TOP_SECRET"}"#).unwrap();
        fs::write(dir.path().join("keybindings.json"), r#"[{"key":"ctrl+k ctrl+s","command":"workbench.action.files.save"},{"key":"ctrl+d","command":"editor.action.deleteLines","when":"editorTextFocus && custom.secret"},{"key":"cmd+q","command":"workbench.action.files.save"},{"key":"ctrl+shift+s","command":"-workbench.action.files.save"}]"#).unwrap();
        let result = preview(source("vscode", dir.path(), "Fixture".into(), None)).unwrap();
        assert_eq!(result.settings["editor.fontSize"], 16);
        assert_eq!(result.settings["editor.tabSize"], 4);
        assert_eq!(result.theme_id.as_deref(), Some("light-plus"));
        assert_eq!(result.keybindings.len(), 2);
        assert_eq!(result.keybindings[0].strokes, vec!["ctrl+k", "ctrl+s"]);
        assert_eq!(result.keybindings[1].removed, Some(true));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("TOP_SECRET"));
        assert!(!serialized.contains("custom.secret"));
    }
    #[test]
    fn rider_custom_parent_overrides_and_removals() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("options/mac")).unwrap();
        fs::create_dir_all(dir.path().join("options/windows")).unwrap();
        fs::create_dir_all(dir.path().join("keymaps")).unwrap();
        let active = "<application><component name=\"KeymapManager\"><active_keymap name=\"Custom\"/></component></application>";
        fs::write(dir.path().join("options/mac/keymap.xml"), active).unwrap();
        fs::write(dir.path().join("options/windows/keymap.xml"), active).unwrap();
        fs::write(dir.path().join("keymaps/parent.xml"), "<keymap name=\"Parent\" parent=\"Visual Studio\"><action id=\"SaveAll\"><keyboard-shortcut first-keystroke=\"control S\"/></action></keymap>").unwrap();
        fs::write(dir.path().join("keymaps/custom.xml"), "<keymap name=\"Custom\" parent=\"Parent\"><action id=\"SaveAll\"/><action id=\"GotoFile\"><keyboard-shortcut first-keystroke=\"control K\" second-keystroke=\"control P\"/></action></keymap>").unwrap();
        let result = preview(source("rider", dir.path(), "Fixture".into(), None)).unwrap();
        assert_eq!(result.keymap.as_deref(), Some("visual-studio"));
        assert_eq!(
            result
                .keybindings
                .iter()
                .filter(|b| b.command_id == "file.save")
                .count(),
            1
        );
        assert_eq!(result.keybindings[0].removed, Some(true));
        assert_eq!(
            result.keybindings.last().unwrap().strokes,
            vec!["ctrl+k", "ctrl+p"]
        );
    }
    #[test]
    fn rider_ambiguous_shortcuts_skip_all_two_or_more_actions() {
        for ids in [
            vec!["SaveAll", "GotoFile"],
            vec!["SaveAll", "GotoFile", "GotoAction"],
        ] {
            let dir = tempfile::tempdir().unwrap();
            fs::create_dir_all(dir.path().join("options")).unwrap();
            fs::create_dir_all(dir.path().join("keymaps")).unwrap();
            fs::write(dir.path().join("options/keymap.xml"), "<application><component name=\"KeymapManager\"><active_keymap name=\"Custom\"/></component></application>").unwrap();
            let mut keymap = String::from("<keymap name=\"Custom\" parent=\"Visual Studio\">");
            for id in &ids {
                keymap.push_str(&format!("<action id=\"{id}\"><keyboard-shortcut first-keystroke=\"control alt K\"/></action>"));
            }
            keymap.push_str("<action id=\"CloseContent\"><keyboard-shortcut first-keystroke=\"control alt L\"/></action></keymap>");
            fs::write(dir.path().join("keymaps/custom.xml"), keymap).unwrap();
            let result = preview(source("rider", dir.path(), "Fixture".into(), None)).unwrap();
            let active: Vec<_> = result
                .keybindings
                .iter()
                .filter(|b| b.removed != Some(true))
                .collect();
            assert_eq!(active.len(), 1);
            assert_eq!(active[0].command_id, "file.closeTab");
            assert!(result
                .keybindings
                .iter()
                .all(|b| b.strokes != ["ctrl+alt+k"]));
            assert_eq!(
                result
                    .report
                    .iter()
                    .filter(|item| item.status == "conflicting")
                    .count(),
                1
            );
            assert!(result.report.iter().any(|item| item
                .detail
                .contains("All assignments to this shortcut were skipped")));
            assert!(!result
                .report
                .iter()
                .any(|item| item.detail.contains("last rule takes precedence")));
            // Whole-action replacement still prevents falling back to a preset
            // chord for an action whose custom shortcut could not be imported.
            assert_eq!(
                result
                    .keybindings
                    .iter()
                    .filter(|b| b.removed == Some(true))
                    .count(),
                ids.len() + 1
            );
        }
    }
    #[test]
    fn rider_conflicts_are_checked_after_child_map_overrides_resolve() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("options")).unwrap();
        fs::create_dir_all(dir.path().join("keymaps")).unwrap();
        fs::write(dir.path().join("options/keymap.xml"), "<application><component name=\"KeymapManager\"><active_keymap name=\"Custom\"/></component></application>").unwrap();
        fs::write(dir.path().join("keymaps/parent.xml"), "<keymap name=\"Parent\" parent=\"Visual Studio\"><action id=\"SaveAll\"><keyboard-shortcut first-keystroke=\"control alt K\"/></action><action id=\"GotoFile\"><keyboard-shortcut first-keystroke=\"control alt K\"/></action></keymap>").unwrap();
        fs::write(dir.path().join("keymaps/custom.xml"), "<keymap name=\"Custom\" parent=\"Parent\"><action id=\"GotoFile\"><keyboard-shortcut first-keystroke=\"control alt L\"/></action></keymap>").unwrap();
        let result = preview(source("rider", dir.path(), "Fixture".into(), None)).unwrap();
        let active: Vec<_> = result
            .keybindings
            .iter()
            .filter(|b| b.removed != Some(true))
            .collect();
        assert_eq!(active.len(), 2);
        assert!(active
            .iter()
            .any(|b| b.command_id == "file.save" && b.strokes == ["ctrl+alt+k"]));
        assert!(active
            .iter()
            .any(|b| b.command_id == "palette.quickOpen" && b.strokes == ["ctrl+alt+l"]));
        assert!(!result
            .report
            .iter()
            .any(|item| item.status == "conflicting"));
    }
    #[test]
    fn vscode_conflicting_rules_retain_ordered_priority() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("keybindings.json"), r#"[{"key":"ctrl+alt+k","command":"workbench.action.files.save"},{"key":"ctrl+alt+k","command":"workbench.action.quickOpen"},{"key":"ctrl+alt+k","command":"workbench.action.showCommands"}]"#).unwrap();
        let result = preview(source("vscode", dir.path(), "Fixture".into(), None)).unwrap();
        assert_eq!(
            result
                .keybindings
                .iter()
                .map(|b| b.command_id.as_str())
                .collect::<Vec<_>>(),
            vec!["file.save", "palette.quickOpen", "palette.commands"]
        );
        assert!(result
            .keybindings
            .iter()
            .all(|b| b.strokes == ["ctrl+alt+k"]));
        assert_eq!(
            result
                .report
                .iter()
                .filter(|item| item.detail.contains("last rule takes precedence"))
                .count(),
            2
        );
    }
    #[test]
    fn bounds_and_missing_files_are_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(read_bounded(&path, 5).unwrap().is_none());
        fs::write(&path, "123456").unwrap();
        assert!(read_bounded(&path, 5).is_err());
        fs::write(&path, "{broken").unwrap();
        assert!(preview(source("vscode", dir.path(), "Fixture".into(), None)).is_err());
    }
    #[test]
    fn rider_editor_preferences_map_with_typography_approximations() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("options")).unwrap();
        fs::write(dir.path().join("options/editor-font.xml"), r#"<application><component name="DefaultFont"><option name="FONT_FAMILY" value="JetBrains Mono"/><option name="FONT_SIZE_2D" value="15"/><option name="LINE_SPACING" value="1.2"/><option name="USE_LIGATURES" value="true"/></component></application>"#).unwrap();
        fs::write(dir.path().join("options/editor.xml"), r#"<application><component name="EditorSettings"><option name="IS_LINE_NUMBERS_SHOWN" value="false"/><option name="USE_SOFT_WRAPS" value="MAIN_EDITOR"/><option name="SOFT_WRAP_FILE_MASKS" value="*"/><option name="IS_WHITESPACES_SHOWN" value="true"/><option name="IS_INNER_WHITESPACES_SHOWN" value="false"/></component></application>"#).unwrap();
        fs::write(dir.path().join("options/laf.xml"), r#"<application><component name="LafManager"><laf themeId="Islands Light"/></component></application>"#).unwrap();
        let result = preview(source("rider", dir.path(), "Fixture".into(), None)).unwrap();
        assert_eq!(result.settings["editor.fontFamily"], "JetBrains Mono");
        assert_eq!(result.settings["editor.fontSize"], 15.0);
        assert_eq!(result.settings["editor.lineHeight"], 18.0);
        assert_eq!(result.settings["editor.fontLigatures"], true);
        assert_eq!(result.settings["editor.lineNumbers"], "off");
        assert_eq!(result.settings["editor.wordWrap"], "on");
        assert_eq!(result.settings["editor.renderWhitespace"], "boundary");
        assert_eq!(result.theme_id.as_deref(), Some("rider-light"));
    }
    #[test]
    fn rider_invalid_font_size_keeps_other_preferences_importable() {
        for size in ["NaN", "60"] {
            let dir = tempfile::tempdir().unwrap();
            fs::create_dir_all(dir.path().join("options")).unwrap();
            fs::write(dir.path().join("options/editor-font.xml"), format!(r#"<application><component name="DefaultFont"><option name="FONT_FAMILY" value="Studio Mono"/><option name="FONT_SIZE_2D" value="{size}"/><option name="LINE_SPACING" value="1.2"/><option name="USE_LIGATURES" value="true"/></component></application>"#)).unwrap();
            let result = preview(source("rider", dir.path(), "Fixture".into(), None)).unwrap();
            assert!(!result.settings.contains_key("editor.fontSize"));
            assert_eq!(result.settings["editor.lineHeight"], 16.0);
            assert_eq!(result.settings["editor.fontFamily"], "Studio Mono");
            assert_eq!(result.settings["editor.fontLigatures"], true);
            assert!(result
                .report
                .iter()
                .any(|item| item.label == "Editor font size" && item.status == "unsupported"));
            validate_settings_patch(&result.settings).unwrap();
        }
    }
    #[test]
    fn rider_hidden_line_numbers_take_precedence_over_saved_relative_mode() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("options")).unwrap();
        fs::write(dir.path().join("options/editor.xml"), r#"<application><component name="EditorSettings"><option name="IS_LINE_NUMBERS_SHOWN" value="false"/><option name="ARE_RELATIVE_LINE_NUMBERS_SHOWN" value="true"/></component></application>"#).unwrap();
        let result = preview(source("rider", dir.path(), "Fixture".into(), None)).unwrap();
        assert_eq!(result.settings["editor.lineNumbers"], "off");
    }
}
