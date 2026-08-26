//! Unity Test Framework integration (F-8).
//!
//! Two responsibilities, both usable without a running Editor:
//!   1. `unity_tests_discover` — source-analysis discovery of EditMode/PlayMode
//!      tests (`[Test]` / `[UnityTest]` / `[TestCase]`) grouped by owning test
//!      assembly (asmdefs referencing `nunit.framework` or marked
//!      `optionalUnityReferences: ["TestAssemblies"]`). Pure file scan.
//!   2. `unity_tests_run_headless` — fall back to `Unity -batchmode -runTests`
//!      when the Editor isn't connected, parsing the NUnit3 result XML.
//!
//! When the bridge IS connected, the frontend prefers the live TestRunnerApi
//! path (streaming) over either of these.

use std::path::{Path, PathBuf};

use serde::Serialize;
use walkdir::WalkDir;

use crate::asmdef;

const SKIP_DIRS: &[&str] = &["Library", "Temp", "obj", "Logs", ".git", "node_modules"];

// ── Discovery data model (camelCase to match the frontend) ───────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TestNode {
    /// Stable id: `assembly::fixtureFqn::method`.
    pub id: String,
    /// Method name.
    pub name: String,
    /// Owning fixture (class) FQN.
    pub fixture: String,
    /// Owning assembly name.
    pub assembly: String,
    /// "EditMode" | "PlayMode" (a hint from the asmdef; the real run is authoritative).
    pub mode: String,
    pub file_path: String,
    /// 1-based line of the test method.
    pub line: u32,
    /// NUnit full name (`Namespace.Class.Method`) — used as the run filter + result key.
    pub full_name: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TestFixtureDTO {
    pub fqn: String,
    pub file_path: String,
    pub tests: Vec<TestNode>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TestAssemblyDTO {
    pub name: String,
    pub mode: String,
    pub root_folder: String,
    pub fixtures: Vec<TestFixtureDTO>,
}

// ── Discovery ────────────────────────────────────────────────────────────────

fn is_test_assembly(node: &asmdef::AsmdefNode) -> bool {
    let refs_test = node.references.iter().any(|r| {
        let l = r.to_ascii_lowercase();
        l.contains("nunit.framework")
            || l.contains("unityengine.testrunner")
            || l.contains("unityeditor.testrunner")
    });
    let opt_test = node
        .optional_unity_references
        .iter()
        .any(|r| r.eq_ignore_ascii_case("TestAssemblies"));
    refs_test || opt_test
}

/// Of all asmdef roots, the longest that is an ancestor of `path` (i.e. the
/// assembly that actually owns the file). Used to skip files that belong to a
/// nested asmdef when walking a parent test assembly.
fn owning_root<'a>(path: &Path, roots: &'a [String]) -> Option<&'a str> {
    // Normalized so both sides of the prefix match use one spelling: `roots`
    // are `AsmdefNode::root_folder` values (normalized at the source), while
    // `path` comes off a `WalkDir`, which on Windows appends `\` separators to
    // whatever it was seeded with. A mixed comparison would stop a *nested*
    // asmdef root from ever matching, so its files would be attributed to the
    // parent assembly.
    let p = crate::path_util::to_ui_path(path);
    roots
        .iter()
        .filter(|r| p.starts_with(r.as_str()))
        .max_by_key(|r| r.len())
        .map(|r| r.as_str())
}

/// One discovered test occurrence within a file.
struct RawTest {
    namespace: String,
    class: String,
    method: String,
    line: u32,
}

/// Heuristic source scan for test methods. Not a parser — accepts some
/// false positives; the authoritative pass/fail comes from the runner.
fn scan_file(content: &str) -> Vec<RawTest> {
    // Lazily-compiled regexes (kept local; called per test assembly).
    let ns_re = regex::Regex::new(r"^\s*namespace\s+([A-Za-z_][\w.]*)").unwrap();
    let class_re = regex::Regex::new(r"\bclass\s+([A-Za-z_]\w*)").unwrap();
    let attr_re = regex::Regex::new(r"\[\s*(Test|UnityTest|TestCase)\b").unwrap();
    let method_re = regex::Regex::new(
        r"^\s*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal|static|virtual|override|sealed|async|\s)+(?:IEnumerator|void|Task|UniTask|[\w<>,.\[\]]+)\s+([A-Za-z_]\w*)\s*\(",
    )
    .unwrap();

    let mut out = Vec::new();
    let mut namespace = String::new();
    let mut class = String::new();
    let mut pending_attr = false;

    for (i, line) in content.lines().enumerate() {
        if let Some(c) = ns_re.captures(line) {
            namespace = c[1].to_string();
        }
        if let Some(c) = class_re.captures(line) {
            class = c[1].to_string();
        }
        if attr_re.is_match(line) {
            pending_attr = true;
            // An attribute line can also carry the method on it; fall through.
        }
        if pending_attr {
            if let Some(c) = method_re.captures(line) {
                out.push(RawTest {
                    namespace: namespace.clone(),
                    class: class.clone(),
                    method: c[1].to_string(),
                    line: (i + 1) as u32,
                });
                pending_attr = false;
            }
        }
    }
    out
}

fn collect_cs_files(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            !e.file_type().is_dir()
                || e.file_name()
                    .to_str()
                    .map(|n| !SKIP_DIRS.contains(&n))
                    .unwrap_or(true)
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("cs"))
        .collect()
}

/// Discover tests across the project's test assemblies. Pure file scan — no Unity.
pub fn discover(workspace: &Path) -> Vec<TestAssemblyDTO> {
    let graph = asmdef::build_graph(workspace);
    let all_roots: Vec<String> = graph.iter().map(|n| n.root_folder.clone()).collect();

    let mut out = Vec::new();
    for node in graph.iter().filter(|n| is_test_assembly(n)) {
        let mode = if node.is_editor_only { "EditMode" } else { "PlayMode" };
        let root = PathBuf::from(&node.root_folder);

        // class FQN -> (file_path, Vec<TestNode>)
        let mut fixtures: std::collections::BTreeMap<String, (String, Vec<TestNode>)> =
            std::collections::BTreeMap::new();

        for file in collect_cs_files(&root) {
            // Skip files owned by a nested asmdef.
            if owning_root(&file, &all_roots) != Some(node.root_folder.as_str()) {
                continue;
            }
            let content = match std::fs::read_to_string(&file) {
                Ok(c) => c,
                Err(_) => continue,
            };
            // Normalized (see `path_util`): `TestNode.file_path` is opened by
            // the test panel, split on '/' for its display name, and compared
            // against the editor's own path in the test CodeLens.
            let file_path = crate::path_util::to_ui_path(&file);
            for raw in scan_file(&content) {
                let fqn = if raw.namespace.is_empty() {
                    raw.class.clone()
                } else {
                    format!("{}.{}", raw.namespace, raw.class)
                };
                let full_name = format!("{}.{}", fqn, raw.method);
                let test = TestNode {
                    id: format!("{}::{}::{}", node.name, fqn, raw.method),
                    name: raw.method.clone(),
                    fixture: fqn.clone(),
                    assembly: node.name.clone(),
                    mode: mode.to_string(),
                    file_path: file_path.clone(),
                    line: raw.line,
                    full_name,
                };
                fixtures
                    .entry(fqn)
                    .or_insert_with(|| (file_path.clone(), Vec::new()))
                    .1
                    .push(test);
            }
        }

        if fixtures.is_empty() {
            continue;
        }
        out.push(TestAssemblyDTO {
            name: node.name.clone(),
            mode: mode.to_string(),
            root_folder: node.root_folder.clone(),
            fixtures: fixtures
                .into_iter()
                .map(|(fqn, (file_path, tests))| TestFixtureDTO {
                    fqn,
                    file_path,
                    tests,
                })
                .collect(),
        });
    }
    out
}

#[tauri::command]
pub fn unity_tests_discover(workspace_path: String) -> Result<Vec<TestAssemblyDTO>, String> {
    Ok(discover(Path::new(&workspace_path)))
}

// ── Headless run (`Unity -batchmode -runTests`) + NUnit XML parse ────────────

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessTestResult {
    pub full_name: String,
    /// "Passed" | "Failed" | "Skipped" | "Inconclusive"
    pub status: String,
    pub duration_ms: u64,
    pub message: String,
    pub stack_trace: String,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TestRunSummaryDTO {
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub duration_ms: u64,
    pub results: Vec<HeadlessTestResult>,
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("{}=\"", name);
    let start = tag.find(&key)? + key.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn inner_tag<'a>(block: &'a str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let s = block.find(&open)?;
    let after_open = block[s..].find('>')? + s + 1;
    let close = format!("</{}>", tag);
    let e = block[after_open..].find(&close)? + after_open;
    let mut text = block[after_open..e].trim().to_string();
    // Strip a CDATA wrapper if present.
    if let Some(rest) = text.strip_prefix("<![CDATA[") {
        if let Some(stripped) = rest.strip_suffix("]]>") {
            text = stripped.to_string();
        }
    }
    Some(unescape_xml(&text))
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Parse an NUnit3 `<test-run>` results document into a flat summary.
pub fn parse_nunit_xml(xml: &str) -> TestRunSummaryDTO {
    let mut summary = TestRunSummaryDTO::default();
    let mut idx = 0;
    while let Some(rel) = xml[idx..].find("<test-case") {
        let start = idx + rel;
        // The element ends at the next "</test-case>" (with children) or "/>".
        let tag_end = match xml[start..].find('>') {
            Some(e) => start + e + 1,
            None => break,
        };
        let header = &xml[start..tag_end];
        let self_closing = header.trim_end().ends_with("/>");
        let block_end = if self_closing {
            tag_end
        } else {
            match xml[start..].find("</test-case>") {
                Some(e) => start + e + "</test-case>".len(),
                None => tag_end,
            }
        };
        let block = &xml[start..block_end];

        let full_name = attr(header, "fullname")
            .or_else(|| attr(header, "name"))
            .unwrap_or("")
            .to_string();
        let status = attr(header, "result").unwrap_or("Inconclusive").to_string();
        let duration_ms = attr(header, "duration")
            .and_then(|d| d.parse::<f64>().ok())
            .map(|s| (s * 1000.0) as u64)
            .unwrap_or(0);

        let (message, stack_trace) = if !self_closing {
            (
                inner_tag(block, "message").unwrap_or_default(),
                inner_tag(block, "stack-trace").unwrap_or_default(),
            )
        } else {
            (String::new(), String::new())
        };

        match status.as_str() {
            "Passed" => summary.passed += 1,
            "Failed" => summary.failed += 1,
            "Skipped" => summary.skipped += 1,
            _ => {}
        }
        summary.duration_ms += duration_ms;
        summary.results.push(HeadlessTestResult {
            full_name: unescape_xml(&full_name),
            status,
            duration_ms,
            message,
            stack_trace,
        });

        idx = block_end;
    }
    summary
}

/// Resolve the Unity editor *executable* from the install path (platform-aware).
fn editor_executable(install_path: &str) -> PathBuf {
    let p = Path::new(install_path);
    if cfg!(target_os = "macos") && install_path.ends_with(".app") {
        p.join("Contents/MacOS/Unity")
    } else {
        p.to_path_buf()
    }
}

/// Run tests headlessly via `Unity -batchmode -runTests`. Requires the Editor to
/// be CLOSED on this project (Unity locks the project). Long-running.
#[tauri::command]
pub fn unity_tests_run_headless(
    workspace_path: String,
    unity_version: String,
    mode: String,
    filter: Option<String>,
) -> Result<TestRunSummaryDTO, String> {
    let install = crate::unity::resolve_unity_editor(unity_version)?
        .ok_or_else(|| "Unity editor install not found for this version".to_string())?;
    let exe = editor_executable(&install.path);

    let results_path = Path::new(&workspace_path)
        .join("Library/UnityIDE")
        .join("test-results.xml");
    if let Some(parent) = results_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_path = Path::new(&workspace_path).join("Library/UnityIDE/test-run.log");

    let test_platform = if mode.eq_ignore_ascii_case("PlayMode") {
        "PlayMode"
    } else {
        "EditMode"
    };

    let mut cmd = crate::process_util::command(&exe);
    cmd.args([
        "-batchmode",
        "-runTests",
        "-projectPath",
        &workspace_path,
        "-testPlatform",
        test_platform,
        "-testResults",
        results_path.to_string_lossy().as_ref(),
        "-logFile",
        log_path.to_string_lossy().as_ref(),
    ]);
    if let Some(f) = filter.as_ref().filter(|f| !f.is_empty()) {
        cmd.args(["-testFilter", f]);
    }

    let status = cmd
        .status()
        .map_err(|e| format!("failed to launch Unity: {e}"))?;

    let xml = std::fs::read_to_string(&results_path).map_err(|e| {
        format!(
            "Unity exited ({:?}) but no results XML was produced ({e}). See {}",
            status.code(),
            log_path.to_string_lossy()
        )
    })?;
    Ok(parse_nunit_xml(&xml))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    #[test]
    fn discovers_tests_in_test_assembly() {
        let tmp = std::env::temp_dir().join(format!("unityide-tests-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let asm_dir = tmp.join("Assets/Tests");
        write(
            &tmp,
            "Assets/Tests/Tests.asmdef",
            r#"{"name":"Game.Tests","references":["nunit.framework"],"includePlatforms":["Editor"]}"#,
        );
        write(
            &tmp,
            "Assets/Tests/MyTests.cs",
            "namespace Game.Tests {\n  public class MyTests {\n    [Test]\n    public void Adds() { }\n    [UnityTest]\n    public IEnumerator Waits() { yield return null; }\n    public void NotATest() { }\n  }\n}\n",
        );

        let result = discover(&tmp);
        let _ = asm_dir;
        assert_eq!(result.len(), 1, "one test assembly");
        let asm = &result[0];
        assert_eq!(asm.name, "Game.Tests");
        assert_eq!(asm.mode, "EditMode");
        assert_eq!(asm.fixtures.len(), 1);
        let fx = &asm.fixtures[0];
        assert_eq!(fx.fqn, "Game.Tests.MyTests");
        let names: Vec<&str> = fx.tests.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"Adds"), "found [Test]");
        assert!(names.contains(&"Waits"), "found [UnityTest]");
        assert!(!names.contains(&"NotATest"), "plain method excluded");
        let adds = fx.tests.iter().find(|t| t.name == "Adds").unwrap();
        assert_eq!(adds.full_name, "Game.Tests.MyTests.Adds");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn non_test_assembly_ignored() {
        let tmp = std::env::temp_dir().join(format!("unityide-tests2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        write(
            &tmp,
            "Assets/Game/Game.asmdef",
            r#"{"name":"Game.Runtime","references":[]}"#,
        );
        write(
            &tmp,
            "Assets/Game/Player.cs",
            "public class Player { [Test] public void X() {} }\n",
        );
        // Even though Player.cs has a [Test], its assembly isn't a test assembly.
        assert!(discover(&tmp).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parses_nunit_xml() {
        let xml = r#"<?xml version="1.0"?>
<test-run>
  <test-suite>
    <test-case name="Adds" fullname="Game.Tests.MyTests.Adds" result="Passed" duration="0.012" />
    <test-case name="Fails" fullname="Game.Tests.MyTests.Fails" result="Failed" duration="0.5">
      <failure>
        <message><![CDATA[Expected 2 but was 3]]></message>
        <stack-trace>at MyTests.Fails () [0x0001]</stack-trace>
      </failure>
    </test-case>
    <test-case name="Skips" fullname="Game.Tests.MyTests.Skips" result="Skipped" duration="0" />
  </test-suite>
</test-run>"#;
        let s = parse_nunit_xml(xml);
        assert_eq!(s.passed, 1);
        assert_eq!(s.failed, 1);
        assert_eq!(s.skipped, 1);
        assert_eq!(s.results.len(), 3);
        let fail = s.results.iter().find(|r| r.status == "Failed").unwrap();
        assert_eq!(fail.full_name, "Game.Tests.MyTests.Fails");
        assert_eq!(fail.message, "Expected 2 but was 3");
        assert!(fail.stack_trace.contains("MyTests.Fails"));
        assert_eq!(fail.duration_ms, 500);
    }
}
