//! End-to-end checks against a real Mono debugger agent.
//!
//! Unity ships a complete Mono runtime and C# compiler beside the editor
//! (`Editor/Data/MonoBleedingEdge/`), so this harness compiles its own fixture
//! and runs it under that exact runtime. Two consequences, both deliberate:
//!
//! * **It never touches a Unity editor the developer is using.** Attaching a
//!   half-finished client to a live editor is how one got killed during this
//!   work. There is no code path here that discovers a running editor.
//! * **It exercises the same runtime Unity does** — Mono 6.13.0, wire protocol
//!   2.58 — so a layout that passes here is the layout Unity speaks.
//!
//! This is also the only kind of test that can catch an encoding mistake. A
//! unit test asserts whatever the client encodes, so when the modifier count
//! was written as an int instead of a byte, every unit test agreed with the
//! bug. The runtime did not: it died.
//!
//! A skip is not a pass. When no Unity install is found this prints a loud
//! SKIPPED, and `UNITYIDE_DEBUGGER_E2E=required` turns that into a failure.

#![cfg(test)]

use std::io::Write;
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

/// Set to `required` to make a missing Unity install fail rather than skip.
pub const REQUIRE_ENV: &str = "UNITYIDE_DEBUGGER_E2E";
/// Point the harness at a Mono runtime directly, bypassing Unity discovery.
pub const MONO_ENV: &str = "UNITYIDE_DEBUGGER_MONO";

/// A compiled, running debuggee with its debugger agent listening.
pub struct Debuggee {
    pub addr: SocketAddr,
    child: Child,
    _dir: tempfile::TempDir,
}

impl Drop for Debuggee {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The Mono runtime and C# compiler shipped with a Unity install.
fn unity_mono() -> Option<(PathBuf, PathBuf)> {
    if let Some(mono) = std::env::var_os(MONO_ENV) {
        let mono = PathBuf::from(mono);
        let mcs = mono
            .parent()?
            .parent()?
            .join("lib")
            .join("mono")
            .join("4.5")
            .join("mcs.exe");
        return mono.is_file().then_some((mono, mcs));
    }

    let exe = if cfg!(windows) { "mono.exe" } else { "mono" };
    for root in hub_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        // Newest first, so the harness tracks the most recent editor installed.
        versions.sort();
        versions.reverse();
        for version in versions {
            // macOS nests the runtime inside the app bundle; every other
            // platform puts it under `Editor/Data`.
            for data in [
                version.join("Editor").join("Data"),
                version.join("Unity.app").join("Contents"),
                version
                    .join("Unity.app")
                    .join("Contents")
                    .join("Resources")
                    .join("Scripting"),
            ] {
                let bin = data.join("MonoBleedingEdge").join("bin").join(exe);
                let mcs = data
                    .join("MonoBleedingEdge")
                    .join("lib")
                    .join("mono")
                    .join("4.5")
                    .join("mcs.exe");
                if bin.is_file() && mcs.is_file() {
                    return Some((bin, mcs));
                }
            }
        }
    }
    None
}

fn hub_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        roots.push(PathBuf::from(r"C:\Program Files\Unity\Hub\Editor"));
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications/Unity/Hub/Editor"));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("Unity").join("Hub").join("Editor"));
        }
    }
    roots
}

/// Announce that the check did not run. Loud on purpose: a quiet skip reads
/// exactly like a pass, which is how a dead debugger stays invisible.
pub fn skip(reason: &str) {
    eprintln!("\n  SKIPPED  Unity debugger end-to-end check — {}", reason);
    eprintln!("           This check did NOT run. It is not evidence of anything.\n");
    assert!(
        std::env::var(REQUIRE_ENV).as_deref() != Ok("required"),
        "{}=required but the check could not run: {}",
        REQUIRE_ENV,
        reason
    );
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

impl Debuggee {
    /// Compile `source` with Unity's C# compiler and run it under Unity's Mono
    /// with a debugger agent, suspended until a debugger attaches.
    ///
    /// `None` when no Unity install is present — the caller should `skip`.
    pub fn launch(source: &str) -> Option<Debuggee> {
        let (mono, mcs) = unity_mono()?;
        let dir = tempfile::tempdir().ok()?;
        let cs = dir.path().join("Fixture.cs");
        let exe = dir.path().join("Fixture.exe");
        std::fs::File::create(&cs)
            .ok()?
            .write_all(source.as_bytes())
            .ok()?;

        let compiled = crate::process_util::command(&mono)
            .arg(&mcs)
            .arg("-debug")
            .arg(format!("-out:{}", exe.display()))
            .arg(&cs)
            .current_dir(dir.path())
            .output()
            .ok()?;
        assert!(
            compiled.status.success(),
            "fixture failed to compile with Unity's mcs:\n{}",
            String::from_utf8_lossy(&compiled.stderr)
        );

        let port = free_port();
        let child = crate::process_util::command(&mono)
            .arg(format!(
                "--debugger-agent=transport=dt_socket,server=y,address=127.0.0.1:{},suspend=y",
                port
            ))
            .arg(&exe)
            .current_dir(dir.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;

        Some(Debuggee {
            addr: format!("127.0.0.1:{}", port).parse().unwrap(),
            child,
            _dir: dir,
        })
    }

    /// Attach, retrying until the agent is listening.
    ///
    /// Deliberately not preceded by a "is the port open yet?" probe. The agent
    /// accepts exactly **one** debugger connection: a probe that connects and
    /// hangs up consumes it, and the real attach is then refused. The first
    /// version of this harness did precisely that and could never connect.
    /// A refused connect costs nothing, so retrying the real thing is both
    /// simpler and correct.
    pub async fn attach(&self) -> crate::debug::conn::Conn {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut last = String::new();
        while Instant::now() < deadline {
            match crate::debug::conn::Conn::connect(self.addr).await {
                Ok(conn) => return conn,
                Err(e) => {
                    last = e.to_string();
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
        }
        panic!("debuggee never accepted a debugger connection: {}", last);
    }

    /// True while the debuggee is still running.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// The fixture every e2e test drives. Line numbers are load-bearing.
pub const FIXTURE: &str = r#"using System;
using System.Threading;

public class Player {
    public string Name;
    public int Score; public Pair Data = new Pair { X = 1.5f, Y = 7 }; public int[] Samples = new int[] { 4, 5 };

    public Player(string name, int score) {
        Name = name;
        Score = score;
    }

    public int Tick(int delta) {
        string tag = null;
        int before = Score;
        Score = before + delta;
        return Score + (tag == null ? 0 : 1);
    }

    public void Boom() {
        try {
            throw new InvalidOperationException("expected by the harness");
        } catch (InvalidOperationException) {
        }
    }
}

public class Fixture {
    public static void Main() {
        var p = new Player("Ada", 3);
        for (int i = 0; i < 600; i++) {
            p.Tick(i % 5);
            p.Boom();
            Thread.Sleep(50);
        }
    }
}
public struct Pair { public float X; public int Y; }
"#;

/// The line in `FIXTURE` holding `Score = before + delta;`.
///
/// Both locals are assigned by then, so the frame has real values to read —
/// including `tag`, which is null and exercises the null encoding.
pub const BREAKPOINT_LINE: u32 = 16;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::conn::Conn;
    use crate::debug::session::{self, StepDepth};
    use crate::debug::values::{summarize, Value};
    use crate::debug::{objects, protocol, symbols};
    use tokio::sync::broadcast::error::RecvError;

    async fn next_composite(
        events: &mut tokio::sync::broadcast::Receiver<protocol::Composite>,
        within: Duration,
    ) -> Option<protocol::Composite> {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(250), events.recv()).await {
                Ok(Ok(c)) => return Some(c),
                Ok(Err(RecvError::Lagged(_))) => continue,
                Ok(Err(RecvError::Closed)) => return None,
                Err(_) => continue,
            }
        }
        None
    }

    async fn wait_for(
        events: &mut tokio::sync::broadcast::Receiver<protocol::Composite>,
        kind: u8,
        within: Duration,
    ) -> Option<protocol::Event> {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            let Some(composite) = next_composite(events, Duration::from_secs(2)).await else {
                continue;
            };
            if let Some(event) = composite.events.iter().find(|e| e.kind == kind) {
                return Some(*event);
            }
        }
        None
    }

    /// Attach, bind `BREAKPOINT_LINE`, arm it, and stop on it.
    async fn stop_at_breakpoint(
        debuggee: &Debuggee,
    ) -> (
        Conn,
        tokio::sync::broadcast::Receiver<protocol::Composite>,
        symbols::Location,
        protocol::Event,
    ) {
        let conn = debuggee.attach().await;
        let mut events = conn.subscribe();

        symbols::watch_source_files(&conn, &["Fixture.cs".to_string()])
            .await
            .expect("watch source files");
        session::resume(&conn).await.expect("resume");

        // Collect every type declared in the file before ranking them. Binding
        // against the first to arrive picks whichever class loaded first, which
        // is how a breakpoint once landed in a different class entirely.
        let mut type_ids: Vec<u32> = Vec::new();
        let settle = Instant::now() + Duration::from_secs(10);
        while Instant::now() < settle && type_ids.len() < 2 {
            let Some(composite) = next_composite(&mut events, Duration::from_secs(2)).await else {
                continue;
            };
            for event in composite.events {
                if event.kind == protocol::EVENT_TYPE_LOAD {
                    if let Some(id) = event.subject {
                        type_ids.push(id);
                    }
                }
            }
        }
        assert!(
            !type_ids.is_empty(),
            "the source-file filter should have announced the fixture's types"
        );

        let location = symbols::locate_in_types(&conn, &type_ids, "Fixture.cs", BREAKPOINT_LINE)
            .await
            .expect("locate")
            .expect("the breakpoint line should bind to a method");
        assert_eq!(
            location.line, BREAKPOINT_LINE,
            "an executable line must not slide"
        );

        symbols::arm_breakpoint(&conn, location)
            .await
            .expect("arm breakpoint");

        let hit = wait_for(
            &mut events,
            protocol::EVENT_BREAKPOINT,
            Duration::from_secs(20),
        )
        .await
        .expect("the breakpoint should be hit");
        (conn, events, location, hit)
    }

    #[tokio::test]
    async fn writes_locals_arrays_and_nested_struct_fields() {
        use crate::debug::assignment::{replacement, Location as Write};
        let Some(mut debuggee) = Debuggee::launch(FIXTURE) else {
            skip("no Unity install found");
            return;
        };
        let (conn, _events, _, hit) = stop_at_breakpoint(&debuggee).await;
        let frame = session::frames(&conn, hit.thread).await.unwrap()[0];
        let locals = session::locals_info(&conn, frame.method).await.unwrap();
        let slot = locals.iter().position(|l| l.name == "before").unwrap();
        let local = Write::Local {
            thread: hit.thread,
            frame: frame.id,
            slot: slot as i32,
        };
        let old = local.read(&conn).await.unwrap();
        local
            .write(&conn, replacement(&old, "42").unwrap())
            .await
            .unwrap();
        assert_eq!(summarize(&local.read(&conn).await.unwrap()), "42");
        let object = session::frame_this(&conn, hit.thread, frame.id)
            .await
            .unwrap()
            .object_id()
            .unwrap();
        let type_id = objects::object_type(&conn, object).await.unwrap();
        let fields = objects::all_instance_fields(&conn, type_id).await.unwrap();
        let field = |name: &str| fields.iter().find(|f| f.name == name).unwrap().id;
        let data = Write::Field {
            object,
            field: field("Data"),
        };
        let x = Write::Nested {
            parent: Box::new(data.clone()),
            index: 0,
        };
        let y = Write::Nested {
            parent: Box::new(data.clone()),
            index: 1,
        };
        y.write(
            &conn,
            replacement(&y.read(&conn).await.unwrap(), "99").unwrap(),
        )
        .await
        .unwrap();
        x.write(
            &conn,
            replacement(&x.read(&conn).await.unwrap(), "2.5f").unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            summarize(&y.read(&conn).await.unwrap()),
            "99",
            "a sibling edit survives nested struct writeback"
        );
        assert_eq!(x.read(&conn).await.unwrap(), Value::Single(2.5));
        let array = Write::Field {
            object,
            field: field("Samples"),
        }
        .read(&conn)
        .await
        .unwrap()
        .object_id()
        .unwrap();
        let element = Write::Element { array, index: 1 };
        element
            .write(
                &conn,
                replacement(&element.read(&conn).await.unwrap(), "88").unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(summarize(&element.read(&conn).await.unwrap()), "88");
        conn.dispose().await;
        assert!(debuggee.is_alive());
    }

    /// The whole Phase 1 loop against a real runtime: attach, watch the source
    /// file, bind `file:line` to a method and IL offset, stop on it, and read
    /// the frame — then detach cleanly and leave the process running.
    #[tokio::test]
    async fn a_breakpoint_binds_hits_and_exposes_the_frame() {
        let Some(mut debuggee) = Debuggee::launch(FIXTURE) else {
            skip("no Unity install found (set UNITYIDE_DEBUGGER_MONO to override)");
            return;
        };
        let (conn, _events, location, hit) = stop_at_breakpoint(&debuggee).await;

        let stack = session::frames(&conn, hit.thread).await.expect("frames");
        assert!(
            stack.len() >= 2,
            "Tick is called from Main, got {:?}",
            stack
        );
        let frame = stack[0];
        assert_eq!(
            frame.method, location.method,
            "the innermost frame is the method the breakpoint bound to"
        );
        assert_eq!(
            frame.il_offset, location.il_offset,
            "and it is stopped exactly where the breakpoint was armed"
        );

        // `this` is the Player instance — a live reference, not null.
        let this = session::frame_this(&conn, hit.thread, frame.id)
            .await
            .expect("this");
        assert!(
            this.object_id().is_some(),
            "Tick is an instance method, so `this` is a real object: {:?}",
            this
        );

        let locals = session::locals_info(&conn, frame.method)
            .await
            .expect("locals info");
        let names: Vec<&str> = locals.iter().map(|l| l.name.as_str()).collect();
        assert!(
            names.contains(&"before") && names.contains(&"tag"),
            "expected the fixture's locals, got {:?}",
            names
        );

        let positions: Vec<i32> = locals
            .iter()
            .enumerate()
            .filter(|(_, l)| l.is_live_at(frame.il_offset))
            .map(|(i, _)| i as i32)
            .collect();
        assert!(!positions.is_empty(), "some local must be live at the stop");
        let read = session::frame_values(&conn, hit.thread, frame.id, &positions)
            .await
            .expect("frame values");

        let mut saw_before = false;
        let mut saw_tag = false;
        for (slot, value) in positions.iter().zip(read.iter()) {
            match locals[*slot as usize].name.as_str() {
                // `before` holds Score from before this tick — a real int the
                // fixture actually computed.
                "before" => {
                    saw_before = true;
                    assert!(
                        matches!(value, Value::Int { value: v, .. } if *v >= 3),
                        "`before` should be the score so far, got {:?}",
                        value
                    );
                }
                // Confirms the null encoding end to end, whichever tag the
                // runtime picks for it.
                "tag" => {
                    saw_tag = true;
                    assert_eq!(
                        summarize(value),
                        "null",
                        "`tag` is initialised to null, got {:?}",
                        value
                    );
                }
                _ => {}
            }
        }
        assert!(
            saw_before && saw_tag,
            "both locals should be live at line 16"
        );

        // Expand `this` one level, the way the variables pane does: runtime
        // type, its declared fields, their values, and the characters behind a
        // string reference.
        let object = this.object_id().expect("this is a reference");
        let type_id = objects::object_type(&conn, object)
            .await
            .expect("object type");
        assert_eq!(
            objects::type_name(&conn, type_id).await.expect("type name"),
            "Player"
        );

        // The type hierarchy, which destroyed-object detection walks up to
        // reach `m_CachedPtr` on `UnityEngine.Object`. The parent id is decoded
        // by position out of TYPE_GET_INFO, so it is checked against a type
        // whose base is known rather than trusted.
        let info = objects::type_info(&conn, type_id).await.expect("type info");
        let parent = info.parent.expect("Player derives from something");
        assert_eq!(
            objects::type_name(&conn, parent)
                .await
                .expect("parent name"),
            "System.Object",
            "the parent id decoded out of TYPE_GET_INFO must be the real base type"
        );

        let fields = objects::type_fields(&conn, type_id).await.expect("fields");
        let instance: Vec<&objects::Field> =
            fields.iter().filter(|f| f.is_instance_field()).collect();
        let field_names: Vec<&str> = instance.iter().map(|f| f.display_name()).collect();
        assert!(
            field_names.contains(&"Name") && field_names.contains(&"Score"),
            "expected Player's fields, got {:?}",
            field_names
        );

        let ids: Vec<u32> = instance.iter().map(|f| f.id).collect();
        let field_values = objects::object_values(&conn, object, &ids)
            .await
            .expect("field values");
        assert_eq!(field_values.len(), instance.len());

        let mut checked_name = false;
        for (field, value) in instance.iter().zip(field_values.iter()) {
            match field.display_name() {
                "Name" => {
                    checked_name = true;
                    let text = objects::string_value(&conn, value.object_id().unwrap_or(0))
                        .await
                        .expect("string contents");
                    assert_eq!(text, "Ada", "the fixture constructs Player(\"Ada\", 3)");
                }
                "Score" => assert!(
                    matches!(value, Value::Int { .. }),
                    "Score is an int, got {:?}",
                    value
                ),
                _ => {}
            }
        }
        assert!(checked_name, "Player.Name should have been readable");

        session::resume(&conn).await.ok();
        conn.dispose().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            debuggee.is_alive(),
            "a clean VM_DISPOSE must leave the debuggee running"
        );
    }

    /// An exception breakpoint stops on a throw.
    ///
    /// The `EXCEPTION_ONLY` modifier grew fields across protocol revisions, and
    /// sending the wrong number of them leaves the agent reading the following
    /// packet as part of this one — the failure mode that killed a live editor.
    /// This is the check that the field count is right.
    #[tokio::test]
    async fn an_exception_breakpoint_stops_on_a_throw() {
        let Some(mut debuggee) = Debuggee::launch(FIXTURE) else {
            skip("no Unity install found (set UNITYIDE_DEBUGGER_MONO to override)");
            return;
        };
        let conn = debuggee.attach().await;
        let mut events = conn.subscribe();

        let request = symbols::arm_exception_breakpoint(&conn, 0, true, true)
            .await
            .expect("arm exception breakpoint");
        session::resume(&conn).await.expect("resume");

        let hit = wait_for(
            &mut events,
            protocol::EVENT_EXCEPTION,
            Duration::from_secs(20),
        )
        .await
        .expect("the fixture throws every iteration, so this should stop");

        let stack = session::frames(&conn, hit.thread).await.expect("frames");
        assert!(
            !stack.is_empty(),
            "the stack must be readable where the exception was raised"
        );

        symbols::clear_event_request(&conn, protocol::EVENT_EXCEPTION, request)
            .await
            .ok();
        session::resume(&conn).await.ok();
        conn.dispose().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            debuggee.is_alive(),
            "a well-formed exception request must leave the runtime healthy"
        );
    }

    /// Set next statement: move the instruction pointer within the method.
    ///
    /// `THREAD_SET_IP` is the one command here that changes execution rather
    /// than observing it, so it is proved against a real runtime rather than
    /// trusted — including that the runtime is still healthy afterwards.
    #[tokio::test]
    async fn setting_the_instruction_pointer_moves_execution() {
        let Some(mut debuggee) = Debuggee::launch(FIXTURE) else {
            skip("no Unity install found (set UNITYIDE_DEBUGGER_MONO to override)");
            return;
        };
        let (conn, _events, location, hit) = stop_at_breakpoint(&debuggee).await;

        let before = session::frames(&conn, hit.thread).await.expect("frames")[0];
        assert_eq!(before.il_offset, location.il_offset);

        // Jump back one line, to `int before = Score;`.
        let target = symbols::locate_in_method(&conn, before.method, "Fixture.cs", 15)
            .await
            .expect("locate")
            .expect("line 15 is in the same method");
        assert!(
            target.il_offset < before.il_offset,
            "line 15 comes before line 16"
        );

        session::set_instruction_pointer(&conn, hit.thread, before.method, target.il_offset)
            .await
            .expect("the runtime should allow a jump inside the same method");

        let after = session::frames(&conn, hit.thread).await.expect("frames");
        assert_eq!(
            after[0].il_offset, target.il_offset,
            "the frame should now report the new position"
        );
        assert_eq!(after[0].method, before.method, "still the same method");

        session::resume(&conn).await.ok();
        conn.dispose().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            debuggee.is_alive(),
            "moving the instruction pointer must leave the runtime healthy"
        );
    }

    /// Stepping over a line lands further on, in the same method.
    #[tokio::test]
    async fn stepping_over_a_line_moves_to_the_next_one() {
        let Some(debuggee) = Debuggee::launch(FIXTURE) else {
            skip("no Unity install found (set UNITYIDE_DEBUGGER_MONO to override)");
            return;
        };
        let (conn, mut events, location, hit) = stop_at_breakpoint(&debuggee).await;

        let before = session::frames(&conn, hit.thread).await.expect("frames")[0];
        assert_eq!(before.il_offset, location.il_offset);

        let request = session::step(
            &conn,
            hit.thread,
            StepDepth::Over,
            session::step_filter::MY_CODE_ONLY,
        )
        .await
        .expect("arm step");
        session::resume(&conn).await.expect("resume into the step");

        let stepped = wait_for(&mut events, protocol::EVENT_STEP, Duration::from_secs(15))
            .await
            .expect("the step should land");
        symbols::clear_event_request(&conn, protocol::EVENT_STEP, request)
            .await
            .expect("clear the step request");

        let after = session::frames(&conn, stepped.thread)
            .await
            .expect("frames");
        assert!(!after.is_empty(), "the stack is readable after a step");
        assert_eq!(
            after[0].method, before.method,
            "stepping over stays in the same method"
        );
        assert!(
            after[0].il_offset > before.il_offset,
            "the step moved forward: {} -> {}",
            before.il_offset,
            after[0].il_offset
        );

        session::resume(&conn).await.ok();
        conn.dispose().await;
    }
}
