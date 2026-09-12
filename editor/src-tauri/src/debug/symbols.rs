//! Turning `file:line` into something the runtime can break on.
//!
//! **No PDB is ever parsed here.** The runtime already read the symbols; it
//! will hand over the line table for any method via `METHOD_GET_DEBUG_INFO`.
//! Reimplementing portable-PDB parsing to learn something the debuggee already
//! knows would be a second source of truth that can drift from the first.
//!
//! Two ways to find the types that live in a source file, and the order matters:
//!
//! 1. **`watch_source_files` — the primary path.** Register a `TYPE_LOAD` event
//!    filtered by source file. Verified against a live agent: filtering on
//!    `["Fixture.cs"]` delivered exactly the two types declared there, out of
//!    ~41 loaded during startup. Because Unity unloads and reloads
//!    `Assembly-CSharp` on every script recompile and on entering Play Mode,
//!    this fires again after each domain reload — so breakpoints re-bind
//!    themselves, which is the behaviour a Unity developer expects and which
//!    the old sidecar never had.
//!
//! 2. **`types_for_source_file` — the catch-up scan.** Finds types that loaded
//!    *before* we attached. It walks every loaded assembly's debug info, and on
//!    a Unity editor with ~200 assemblies it stalls for many seconds — it is
//!    the command that hung, timed out, and led to a dropped socket that killed
//!    a running editor. So it is never issued from a request path, always
//!    carries a deadline, and its failure is not fatal.
//!
//! The filter matches on **base name** while `METHOD_GET_DEBUG_INFO` reports an
//! absolute native path, so both spellings are in play at once; `paths.rs`
//! reconciles them.

use std::time::Duration;

use super::conn::{Conn, ConnError};
use super::paths;
use super::protocol::{self, DebugInfo};
use super::wire::{Reader, Writer};

/// Where a breakpoint actually lands in the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Location {
    pub method: u32,
    pub il_offset: u32,
    /// The line execution will really stop at, which may be below the one the
    /// user clicked. The editor is told, so the marker moves to match.
    pub line: u32,
}

/// Ceiling for the catch-up scan. Generous, because a cold Unity editor really
/// is slow here — but finite, because the alternative is a wedged session.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(20);

/// Ask the runtime to announce every type declared in these files as it loads.
///
/// `files` may be full paths; only their base names go on the wire, because
/// that is what the modifier matches.
pub async fn watch_source_files(conn: &Conn, files: &[String]) -> Result<u32, ConnError> {
    let mut names: Vec<&str> = Vec::new();
    for file in files {
        let name = paths::file_name(file);
        if name.is_empty() || names.iter().any(|seen| paths::same_file(seen, name)) {
            // Two files sharing a base name are one filter: the modifier cannot
            // tell them apart, so sending it twice only adds work.
            continue;
        }
        names.push(name);
    }

    let mut w = Writer::new();
    w.byte(protocol::EVENT_TYPE_LOAD)
        .byte(protocol::SUSPEND_NONE)
        // The modifier count is a BYTE. Sending it as an int makes the agent
        // read a zero here, apply no filter at all, and then parse the rest of
        // this body as garbage — which is how it ends up dereferencing a bogus
        // id and killing the process. Unit tests cannot catch this: they assert
        // whatever the client encodes. The end-to-end harness caught it.
        .byte(1)
        .byte(protocol::MOD_SOURCE_FILE_ONLY)
        .int(names.len() as i32);
    for name in &names {
        w.string(name);
    }

    let reply = conn
        .request(
            protocol::CMD_SET_EVENT_REQUEST,
            protocol::CMD_EVENT_REQUEST_SET,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_EVENT_REQUEST,
            command: protocol::CMD_EVENT_REQUEST_SET,
            error: reply.error,
        });
    }
    Ok(Reader::new(&reply.body).int()? as u32)
}

/// Types already loaded that were declared in `path`.
pub async fn types_for_source_file(
    conn: &Conn,
    path: &str,
    timeout: Duration,
) -> Result<Vec<u32>, ConnError> {
    let found = scan_once(conn, path, timeout).await?;
    if !found.is_empty() {
        return Ok(found);
    }
    // Whether the agent matches this command on a full path or a base name was
    // never pinned down on the wire — the one live attempt stalled before it
    // answered. The `SOURCE_FILE_ONLY` modifier is base-name based, so try that
    // spelling too rather than assume either.
    let base = paths::file_name(path);
    if base.is_empty() || base == path {
        return Ok(found);
    }
    scan_once(conn, base, timeout).await
}

async fn scan_once(conn: &Conn, name: &str, timeout: Duration) -> Result<Vec<u32>, ConnError> {
    let mut w = Writer::new();
    w.string(name).byte(1); // ignore_case
    let reply = conn
        .request_within(
            protocol::CMD_SET_VM,
            protocol::CMD_VM_GET_TYPES_FOR_SOURCE_FILE,
            w.into_bytes(),
            timeout,
        )
        .await?;
    if !reply.is_ok() {
        return Ok(Vec::new());
    }
    read_ids(&reply.body)
}

/// Decode a `count` followed by that many ids.
fn read_ids(body: &[u8]) -> Result<Vec<u32>, ConnError> {
    let mut r = Reader::new(body);
    let count = r.int()?.max(0);
    let mut ids = Vec::with_capacity(count as usize);
    for _ in 0..count {
        // Bounds-checked: a short body errors here rather than yielding a zero
        // that would later be sent back as an id and kill the runtime.
        ids.push(r.id()?);
    }
    Ok(ids)
}

/// Find the method and IL offset for `editor_path:line` inside `type_id`.
pub async fn locate_in_type(
    conn: &Conn,
    type_id: u32,
    editor_path: &str,
    line: u32,
) -> Result<Option<Location>, ConnError> {
    locate_in_types(conn, &[type_id], editor_path, line).await
}

/// Find the best binding for `editor_path:line` across several types.
///
/// One source file compiles to many types — a class plus its nested types, the
/// state machines behind its iterators and async methods, and any other class
/// declared alongside it. They must be ranked **together**, not first-wins.
///
/// Against a real runtime, resolving against whichever type loaded first bound
/// a breakpoint on line 15 to line 21 — the `Main` of the *other* class in the
/// file — because sliding to "the next executable line" happily crossed into
/// it. So containment ranks ahead of proximity: a method whose line span
/// brackets the requested line always beats one that merely starts after it.
pub async fn locate_in_types(
    conn: &Conn,
    type_ids: &[u32],
    editor_path: &str,
    line: u32,
) -> Result<Option<Location>, ConnError> {
    // (does not contain, resolved line, il offset) — lowest wins.
    let mut best: Option<((bool, u32, u32), Location)> = None;

    for &type_id in type_ids {
        let mut w = Writer::new();
        w.id(type_id);
        let reply = conn
            .request(
                protocol::CMD_SET_TYPE,
                protocol::CMD_TYPE_GET_METHODS,
                w.into_bytes(),
            )
            .await?;
        if !reply.is_ok() {
            continue;
        }

        for method in read_ids(&reply.body)? {
            let Some(info) = debug_info(conn, method).await? else {
                continue;
            };
            if !paths::same_source_file(&info.source_file, editor_path) {
                continue;
            }
            let (Some(line_hit), Some(il_offset)) = (
                protocol::resolved_line(&info, line),
                protocol::il_offset_for_line(&info, line),
            ) else {
                continue;
            };

            let visible = info
                .sequence_points
                .iter()
                .filter(|sp| sp.line != protocol::HIDDEN_LINE)
                .map(|sp| sp.line);
            let contains = match (visible.clone().min(), visible.max()) {
                (Some(lo), Some(hi)) => lo <= line && line <= hi,
                _ => false,
            };

            let rank = (!contains, line_hit, il_offset);
            let candidate = Location {
                method,
                il_offset,
                line: line_hit,
            };
            let better = match &best {
                None => true,
                Some((current, _)) => rank < *current,
            };
            if better {
                best = Some((rank, candidate));
            }
        }
    }
    Ok(best.map(|(_, location)| location))
}

/// Arm a breakpoint at `at`. Returns the event request id used to clear it.
pub async fn arm_breakpoint(conn: &Conn, at: Location) -> Result<u32, ConnError> {
    let mut w = Writer::new();
    w.byte(protocol::EVENT_BREAKPOINT)
        .byte(protocol::SUSPEND_ALL)
        .byte(1) // modifier count: a byte, not an int
        .byte(protocol::MOD_LOCATION_ONLY)
        .id(at.method)
        // Eight bytes. Four would leave the agent reading the next packet's
        // bytes as the high half of this offset.
        .long(at.il_offset as i64);

    let reply = conn
        .request(
            protocol::CMD_SET_EVENT_REQUEST,
            protocol::CMD_EVENT_REQUEST_SET,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_EVENT_REQUEST,
            command: protocol::CMD_EVENT_REQUEST_SET,
            error: reply.error,
        });
    }
    Ok(Reader::new(&reply.body).int()? as u32)
}

/// Break when an exception is thrown.
///
/// `exception_type` of 0 means any exception. `caught` covers exceptions that
/// a `catch` will handle — noisy in Unity, where the engine throws and catches
/// routinely, which is why it is off by default.
///
/// The modifier grew fields over successive protocol revisions and this client
/// negotiates 2.58, so all of them are present: the type, the two flags, a
/// subclass flag from 2.25, and two filtering flags from 2.54. Sending fewer
/// leaves the agent reading the next packet as part of this modifier.
pub async fn arm_exception_breakpoint(
    conn: &Conn,
    exception_type: u32,
    caught: bool,
    uncaught: bool,
) -> Result<u32, ConnError> {
    let mut w = Writer::new();
    w.byte(protocol::EVENT_EXCEPTION)
        .byte(protocol::SUSPEND_ALL)
        .byte(1) // modifier count: a byte, not an int
        .byte(protocol::MOD_EXCEPTION_ONLY)
        .id(exception_type)
        .byte(u8::from(caught))
        .byte(u8::from(uncaught))
        // Subclasses of the named type count too; filtering to an exact type
        // would miss every derived exception the user cares about.
        .byte(1)
        .byte(0) // not_filtered_feature
        .byte(0); // everything_else

    let reply = conn
        .request(
            protocol::CMD_SET_EVENT_REQUEST,
            protocol::CMD_EVENT_REQUEST_SET,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_EVENT_REQUEST,
            command: protocol::CMD_EVENT_REQUEST_SET,
            error: reply.error,
        });
    }
    Ok(Reader::new(&reply.body).int()? as u32)
}

/// Remove a previously registered event request.
pub async fn clear_event_request(
    conn: &Conn,
    event_kind: u8,
    request_id: u32,
) -> Result<(), ConnError> {
    let mut w = Writer::new();
    w.byte(event_kind).int(request_id as i32);
    // A failure code here is not worth surfacing: the usual cause is that the
    // request is already gone (a domain reload dropped it), which is the state
    // the caller wanted anyway.
    conn.request(
        protocol::CMD_SET_EVENT_REQUEST,
        protocol::CMD_EVENT_REQUEST_CLEAR,
        w.into_bytes(),
    )
    .await?;
    Ok(())
}

/// Resolve `editor_path:line` inside one specific method.
///
/// Used for "set next statement", where the runtime can only move the pointer
/// within the method already executing. Resolving across the whole type would
/// offer targets the jump would then be refused for.
pub async fn locate_in_method(
    conn: &Conn,
    method: u32,
    editor_path: &str,
    line: u32,
) -> Result<Option<Location>, ConnError> {
    let Some(info) = debug_info(conn, method).await? else {
        return Ok(None);
    };
    if !paths::same_source_file(&info.source_file, editor_path) {
        return Ok(None);
    }
    let (Some(line_hit), Some(il_offset)) = (
        protocol::resolved_line(&info, line),
        protocol::il_offset_for_line(&info, line),
    ) else {
        return Ok(None);
    };
    Ok(Some(Location {
        method,
        il_offset,
        line: line_hit,
    }))
}

/// A method's name, for a call-stack label.
pub async fn method_name(conn: &Conn, method: u32) -> Result<String, ConnError> {
    let mut w = Writer::new();
    w.id(method);
    let reply = conn
        .request(
            protocol::CMD_SET_METHOD,
            protocol::CMD_METHOD_GET_NAME,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Ok(String::new());
    }
    Ok(Reader::new(&reply.body).string()?)
}

/// Where a frame stopped, as a source file and line.
///
/// The inverse of binding: given an IL offset, find the sequence point that
/// covers it — the *last* one at or before the offset, since a statement spans
/// several instructions.
pub async fn source_position(
    conn: &Conn,
    method: u32,
    il_offset: u32,
) -> Result<Option<(String, u32)>, ConnError> {
    let Some(info) = debug_info(conn, method).await? else {
        return Ok(None);
    };
    let line = info
        .sequence_points
        .iter()
        .filter(|sp| sp.line != protocol::HIDDEN_LINE && sp.il_offset <= il_offset)
        .max_by_key(|sp| sp.il_offset)
        .map(|sp| sp.line);
    Ok(line.map(|line| (info.source_file.clone(), line)))
}

/// Fetch and decode one method's line table.
async fn debug_info(conn: &Conn, method: u32) -> Result<Option<DebugInfo>, ConnError> {
    let mut w = Writer::new();
    w.id(method);
    let reply = conn
        .request(
            protocol::CMD_SET_METHOD,
            protocol::CMD_METHOD_GET_DEBUG_INFO,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        // Abstract, extern and compiler-generated methods have no line table.
        // That is ordinary, not an error.
        return Ok(None);
    }
    // A decode failure *is* propagated: it means the layout in `protocol.rs`
    // no longer matches the runtime, which is exactly the drift that must not
    // pass silently.
    Ok(Some(protocol::decode_debug_info(&reply.body)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::fake_agent::{debug_info_body, id_list_body, FakeAgent};
    use tokio::sync::mpsc;

    const PLAYER_SRC: &str = r"C:\build\Game\Assets\Scripts\Player.cs";
    const ENEMY_SRC: &str = r"C:\build\Game\Assets\Scripts\Enemy.cs";

    /// `Player.Tick`, exactly as captured: line 15 sits at IL offset 8.
    fn tick_points() -> Vec<(i32, i32, i32)> {
        vec![(0, 13, 32), (1, 14, 9), (8, 15, 9), (17, 16, 9), (29, 17, 5)]
    }

    async fn connect(agent: &FakeAgent) -> Conn {
        Conn::connect(agent.addr).await.expect("connect")
    }

    /// Captures every request body the client sends, so a test can assert on
    /// the exact bytes that go to the agent.
    fn recorder() -> (
        mpsc::UnboundedSender<(u8, u8, Vec<u8>)>,
        mpsc::UnboundedReceiver<(u8, u8, Vec<u8>)>,
    ) {
        mpsc::unbounded_channel()
    }

    /// The primary breakpoint path. The base name is what the modifier matches
    /// — sending the full path here silently yields no types at all.
    #[tokio::test]
    async fn watch_source_files_filters_type_load_by_base_name() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, {
                let mut w = Writer::new();
                w.int(7);
                w.into_bytes()
            }))
        });
        let conn = connect(&agent).await;

        let id = watch_source_files(&conn, &[PLAYER_SRC.to_string()])
            .await
            .unwrap();
        assert_eq!(id, 7, "the event request id comes back for later clearing");

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (
                protocol::CMD_SET_EVENT_REQUEST,
                protocol::CMD_EVENT_REQUEST_SET
            )
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.byte().unwrap(), protocol::EVENT_TYPE_LOAD);
        assert_eq!(
            r.byte().unwrap(),
            protocol::SUSPEND_NONE,
            "watching type loads must not suspend the editor"
        );
        assert_eq!(r.byte().unwrap(), 1, "one modifier, as a byte");
        assert_eq!(r.byte().unwrap(), protocol::MOD_SOURCE_FILE_ONLY);
        assert_eq!(r.int().unwrap(), 1, "one source file");
        assert_eq!(r.string().unwrap(), "Player.cs", "base name, not full path");
        assert!(r.is_empty());
    }

    #[tokio::test]
    async fn watch_source_files_sends_each_base_name_once() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, id_list_body(&[])))
        });
        let conn = connect(&agent).await;

        // Two different files that share a base name collapse to one filter,
        // because the filter cannot tell them apart anyway.
        let _ = watch_source_files(
            &conn,
            &[
                r"C:\a\Utils.cs".to_string(),
                r"C:\b\Utils.cs".to_string(),
                PLAYER_SRC.to_string(),
            ],
        )
        .await;

        let (_, _, body) = seen.recv().await.unwrap();
        let mut r = Reader::new(&body);
        r.byte().unwrap(); // event kind
        r.byte().unwrap(); // suspend policy
        r.byte().unwrap(); // modifier count
        r.byte().unwrap(); // modifier kind
        assert_eq!(r.int().unwrap(), 2, "Utils.cs deduplicated");
    }

    #[tokio::test]
    async fn locate_in_type_finds_the_method_and_il_offset_for_a_line() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| match (cs, cmd) {
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_METHODS) => {
                Some((0, id_list_body(&[41, 42])))
            }
            (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_DEBUG_INFO) => {
                Some((0, debug_info_body(PLAYER_SRC, &tick_points())))
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        let found = locate_in_type(&conn, 2, "C:/build/Game/Assets/Scripts/Player.cs", 15)
            .await
            .unwrap()
            .expect("line 15 is in this type");
        assert_eq!(found.il_offset, 8);
        assert_eq!(found.line, 15);
        assert_eq!(found.method, 41, "the first method that covers the line");
    }

    /// A partial class spans files. Binding into the wrong half stops execution
    /// somewhere the user never clicked.
    #[tokio::test]
    async fn locate_in_type_ignores_methods_declared_in_another_file() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, body| match (cs, cmd) {
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_METHODS) => {
                Some((0, id_list_body(&[41, 42])))
            }
            (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_DEBUG_INFO) => {
                let method = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                let source = if method == 41 { ENEMY_SRC } else { PLAYER_SRC };
                Some((0, debug_info_body(source, &tick_points())))
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        let found = locate_in_type(&conn, 2, "C:/build/Game/Assets/Scripts/Player.cs", 15)
            .await
            .unwrap()
            .expect("the Player.cs half covers line 15");
        assert_eq!(found.method, 42, "the Enemy.cs method must be skipped");
    }

    #[tokio::test]
    async fn locate_in_type_slides_to_the_next_executable_line() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| match (cs, cmd) {
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_METHODS) => {
                Some((0, id_list_body(&[41])))
            }
            (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_DEBUG_INFO) => {
                Some((0, debug_info_body(PLAYER_SRC, &tick_points())))
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        // Line 12 is the blank line above the method.
        let found = locate_in_type(&conn, 2, PLAYER_SRC, 12).await.unwrap().unwrap();
        assert_eq!(found.line, 13, "the editor is told where it really stopped");
        assert_eq!(found.il_offset, 0);
    }

    /// Regression, found by the end-to-end harness against a real Mono runtime:
    /// resolving against whichever type loaded first bound a breakpoint on
    /// line 15 to line 21 — `Main`, in the other class in the same file —
    /// because sliding to "the next executable line" crossed into it.
    #[tokio::test]
    async fn locate_in_types_prefers_the_method_that_contains_the_line() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, body| match (cs, cmd) {
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_METHODS) => {
                let type_id = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                // Type 1 is the class declared *below* the one we want.
                Some((0, id_list_body(if type_id == 1 { &[51] } else { &[41] })))
            }
            (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_DEBUG_INFO) => {
                let method = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                let points: Vec<(i32, i32, i32)> = if method == 51 {
                    // `Fixture.Main`, lines 21..27 — entirely below line 15.
                    vec![(0, 21, 5), (7, 22, 9), (20, 23, 9), (44, 27, 5)]
                } else {
                    tick_points()
                };
                Some((0, debug_info_body(PLAYER_SRC, &points)))
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        // Type 1 first, so a first-wins implementation picks the wrong one.
        let found = locate_in_types(&conn, &[1, 2], PLAYER_SRC, 15)
            .await
            .unwrap()
            .expect("line 15 is inside Tick");
        assert_eq!(found.method, 41, "must not slide into the next class");
        assert_eq!(found.line, 15);
        assert_eq!(found.il_offset, 8);
    }

    #[tokio::test]
    async fn locate_in_type_returns_none_when_no_method_covers_the_line() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| match (cs, cmd) {
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_METHODS) => {
                Some((0, id_list_body(&[41])))
            }
            (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_DEBUG_INFO) => {
                Some((0, debug_info_body(PLAYER_SRC, &tick_points())))
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        assert_eq!(
            locate_in_type(&conn, 2, PLAYER_SRC, 900).await.unwrap(),
            None
        );
    }

    /// Compiler-generated and abstract methods have no line table. The agent
    /// answers with an error code, which must skip the method rather than fail
    /// the whole lookup.
    #[tokio::test]
    async fn a_method_without_debug_info_is_skipped_not_fatal() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, body| match (cs, cmd) {
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_METHODS) => {
                Some((0, id_list_body(&[41, 42])))
            }
            (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_DEBUG_INFO) => {
                let method = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                if method == 41 {
                    Some((100, Vec::new())) // ERR_INVALID_ARGUMENT
                } else {
                    Some((0, debug_info_body(PLAYER_SRC, &tick_points())))
                }
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        let found = locate_in_type(&conn, 2, PLAYER_SRC, 15).await.unwrap().unwrap();
        assert_eq!(found.method, 42);
    }

    /// The IL offset goes on the wire as an eight-byte long. Sending four bytes
    /// leaves the agent reading the following bytes as part of the offset.
    #[tokio::test]
    async fn arm_breakpoint_sends_location_only_with_an_eight_byte_il_offset() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, {
                let mut w = Writer::new();
                w.int(9);
                w.into_bytes()
            }))
        });
        let conn = connect(&agent).await;

        let id = arm_breakpoint(
            &conn,
            Location {
                method: 42,
                il_offset: 8,
                line: 15,
            },
        )
        .await
        .unwrap();
        assert_eq!(id, 9);

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (
                protocol::CMD_SET_EVENT_REQUEST,
                protocol::CMD_EVENT_REQUEST_SET
            )
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.byte().unwrap(), protocol::EVENT_BREAKPOINT);
        assert_eq!(
            r.byte().unwrap(),
            protocol::SUSPEND_ALL,
            "hitting a breakpoint stops the whole VM, not one thread"
        );
        assert_eq!(r.byte().unwrap(), 1, "modifier count is a byte");
        assert_eq!(r.byte().unwrap(), protocol::MOD_LOCATION_ONLY);
        assert_eq!(r.id().unwrap(), 42);
        assert_eq!(r.long().unwrap(), 8, "il offset is a long");
        assert!(r.is_empty());
    }

    #[tokio::test]
    async fn arm_exception_breakpoint_sends_every_field_of_the_modifier() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            let mut w = Writer::new();
            w.int(12);
            Some((0, w.into_bytes()))
        });
        let conn = connect(&agent).await;

        let id = arm_exception_breakpoint(&conn, 0, false, true).await.unwrap();
        assert_eq!(id, 12);

        let (_, _, body) = seen.recv().await.unwrap();
        let mut r = Reader::new(&body);
        assert_eq!(r.byte().unwrap(), protocol::EVENT_EXCEPTION);
        assert_eq!(r.byte().unwrap(), protocol::SUSPEND_ALL);
        assert_eq!(r.byte().unwrap(), 1, "modifier count is a byte");
        assert_eq!(r.byte().unwrap(), protocol::MOD_EXCEPTION_ONLY);
        assert_eq!(r.id().unwrap(), 0, "0 means any exception type");
        assert_eq!(r.byte().unwrap(), 0, "caught");
        assert_eq!(r.byte().unwrap(), 1, "uncaught");
        assert_eq!(r.byte().unwrap(), 1, "include subclasses");
        assert_eq!(r.byte().unwrap(), 0);
        assert_eq!(r.byte().unwrap(), 0);
        assert!(
            r.is_empty(),
            "a short modifier leaves the agent reading the next packet"
        );
    }

    #[tokio::test]
    async fn clear_event_request_names_the_kind_and_the_id() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, Vec::new()))
        });
        let conn = connect(&agent).await;

        clear_event_request(&conn, protocol::EVENT_BREAKPOINT, 9)
            .await
            .unwrap();
        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (
                protocol::CMD_SET_EVENT_REQUEST,
                protocol::CMD_EVENT_REQUEST_CLEAR
            )
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.byte().unwrap(), protocol::EVENT_BREAKPOINT);
        assert_eq!(r.int().unwrap(), 9);
    }

    /// A statement covers several instructions, so the position of an offset
    /// is the last sequence point at or before it — not the nearest one after,
    /// which would report the following line.
    #[tokio::test]
    async fn source_position_reports_the_statement_containing_the_offset() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_DEBUG_INFO) {
                Some((0, debug_info_body(PLAYER_SRC, &tick_points())))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;

        // IL 8 is the start of line 15; IL 12 is still inside it.
        assert_eq!(
            source_position(&conn, 41, 8).await.unwrap(),
            Some((PLAYER_SRC.to_string(), 15))
        );
        assert_eq!(
            source_position(&conn, 41, 12).await.unwrap(),
            Some((PLAYER_SRC.to_string(), 15)),
            "mid-statement still reports the statement's line"
        );
        assert_eq!(
            source_position(&conn, 41, 17).await.unwrap(),
            Some((PLAYER_SRC.to_string(), 16))
        );
    }

    #[tokio::test]
    async fn a_method_without_a_line_table_has_no_source_position() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|_, _, _| Some((100, Vec::new())));
        let conn = connect(&agent).await;
        assert_eq!(source_position(&conn, 41, 0).await.unwrap(), None);
    }

    #[tokio::test]
    async fn method_name_reads_the_string() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_METHOD, protocol::CMD_METHOD_GET_NAME) {
                let mut w = Writer::new();
                w.string("Tick");
                Some((0, w.into_bytes()))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(method_name(&conn, 41).await.unwrap(), "Tick");
    }

    #[tokio::test]
    async fn types_for_source_file_returns_the_ids_the_agent_reports() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| match (cs, cmd) {
            (protocol::CMD_SET_VM, protocol::CMD_VM_GET_TYPES_FOR_SOURCE_FILE) => {
                Some((0, id_list_body(&[2, 3])))
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        assert_eq!(
            types_for_source_file(&conn, PLAYER_SRC, Duration::from_secs(2))
                .await
                .unwrap(),
            vec![2, 3]
        );
    }

    /// Whether the agent matches this command on a full path or a base name was
    /// never pinned down on the wire, so the client tries the path it was given
    /// and falls back rather than assuming.
    #[tokio::test]
    async fn types_for_source_file_retries_with_the_base_name() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, body| match (cs, cmd) {
            (protocol::CMD_SET_VM, protocol::CMD_VM_GET_TYPES_FOR_SOURCE_FILE) => {
                let mut r = Reader::new(body);
                let asked = r.string().unwrap();
                if asked == "Player.cs" {
                    Some((0, id_list_body(&[2])))
                } else {
                    Some((0, id_list_body(&[])))
                }
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        assert_eq!(
            types_for_source_file(&conn, PLAYER_SRC, Duration::from_secs(2))
                .await
                .unwrap(),
            vec![2]
        );
    }

    /// The command that hung against a real Unity editor. It must give up, and
    /// giving up must not take the connection with it — dropping a socket with
    /// this reply in flight is what killed the editor.
    #[tokio::test]
    async fn a_stalled_scan_times_out_and_leaves_the_connection_usable() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| match (cs, cmd) {
            (protocol::CMD_SET_VM, protocol::CMD_VM_GET_TYPES_FOR_SOURCE_FILE) => None,
            (protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_METHODS) => {
                Some((0, id_list_body(&[41])))
            }
            _ => Some((0, Vec::new())),
        });
        let conn = connect(&agent).await;

        let scan = types_for_source_file(&conn, PLAYER_SRC, Duration::from_millis(80)).await;
        assert!(
            matches!(scan, Err(ConnError::Timeout { .. })),
            "expected a timeout, got {:?}",
            scan
        );
        assert!(!conn.is_closed(), "the scan must not close the socket");

        // And the session keeps working afterwards.
        let mut w = Writer::new();
        w.id(2);
        let reply = conn
            .request(
                protocol::CMD_SET_TYPE,
                protocol::CMD_TYPE_GET_METHODS,
                w.into_bytes(),
            )
            .await
            .expect("connection still usable");
        assert!(reply.is_ok());
    }
}
