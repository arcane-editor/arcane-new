//! Mono Soft Debugger protocol: command numbers, event shapes, and the two
//! decoders that breakpoint binding depends on.
//!
//! Every constant and every layout here was read off a live Mono 6.13.0 agent
//! (the runtime Unity 6 ships) speaking wire protocol 2.58, not from memory.
//! That matters more than it sounds: **sending the agent an id it did not give
//! us kills the host process outright.** No error, no reply — the socket just
//! closes and the process is gone. It was reproduced four times here, and it
//! is almost certainly what killed a running Unity editor during this work:
//! a reply was mis-parsed, a zero was read where a method id should have been,
//! and the agent dereferenced it.
//!
//! Two rules follow, and they are why this module exists at all:
//!
//! 1. **Never synthesise an id.** Every id sent must have come from a reply we
//!    decoded successfully.
//! 2. **Never index a reply body without a length check.** `wire::Reader`
//!    returns `Err(Truncated)` rather than reading past the end, which is what
//!    turns a protocol surprise into a reported error instead of a dead editor.
//!
//! Command numbers are the other half of the same hazard. `TYPE_GET_METHODS` is
//! command **2**; command 5 is `TYPE_GET_OBJECT`, which answers with a 4-byte
//! object id. Reading that 4-byte reply as a method array is exactly how the
//! zero id above was produced.

// The command table below is deliberately complete rather than grown one
// constant at a time: it is the vocabulary of the protocol, every entry was
// read off a live agent, and a half-table invites exactly the guess-the-number
// mistake that killed the runtime four times here. Consumers arrive over the
// following phases (`symbols.rs`, `session.rs`, `values.rs`).
//
// REMOVE THIS ALLOW once the client is feature-complete, then delete whatever
// is still unused — by then a genuinely unused command means a gap worth
// noticing.
#![allow(dead_code)]

use super::wire::{Reader, WireError};

// ---------------------------------------------------------------------------
// Command sets
// ---------------------------------------------------------------------------

pub const CMD_SET_VM: u8 = 1;
pub const CMD_SET_OBJECT_REF: u8 = 9;
pub const CMD_SET_STRING_REF: u8 = 10;
pub const CMD_SET_THREAD: u8 = 11;
pub const CMD_SET_ARRAY_REF: u8 = 13;
pub const CMD_SET_EVENT_REQUEST: u8 = 15;
pub const CMD_SET_STACK_FRAME: u8 = 16;
pub const CMD_SET_APPDOMAIN: u8 = 20;
pub const CMD_SET_ASSEMBLY: u8 = 21;
pub const CMD_SET_METHOD: u8 = 22;
pub const CMD_SET_TYPE: u8 = 23;
pub const CMD_SET_MODULE: u8 = 24;
pub const CMD_SET_FIELD: u8 = 25;
pub const CMD_SET_EVENT: u8 = 64;

/// The only command the runtime sends on the `EVENT` set: a batch of events
/// sharing one suspend policy.
pub const CMD_COMPOSITE: u8 = 100;

// VM (command set 1)
pub const CMD_VM_VERSION: u8 = 1;
pub const CMD_VM_ALL_THREADS: u8 = 2;
pub const CMD_VM_SUSPEND: u8 = 3;
pub const CMD_VM_RESUME: u8 = 4;
pub const CMD_VM_EXIT: u8 = 5;
pub const CMD_VM_DISPOSE: u8 = 6;
pub const CMD_VM_INVOKE_METHOD: u8 = 7;
pub const CMD_VM_SET_PROTOCOL_VERSION: u8 = 8;
pub const CMD_VM_GET_TYPES_FOR_SOURCE_FILE: u8 = 11;
pub const CMD_VM_GET_TYPES: u8 = 12;

// TYPE (command set 23). Command 5 is GET_OBJECT, not GET_METHODS — see above.
pub const CMD_TYPE_GET_INFO: u8 = 1;
pub const CMD_TYPE_GET_METHODS: u8 = 2;
pub const CMD_TYPE_GET_FIELDS: u8 = 3;
pub const CMD_TYPE_GET_VALUES: u8 = 4;
pub const CMD_TYPE_GET_OBJECT: u8 = 5;
pub const CMD_TYPE_GET_SOURCE_FILES: u8 = 6;

// METHOD (command set 22)
pub const CMD_METHOD_GET_NAME: u8 = 1;
pub const CMD_METHOD_GET_DECLARING_TYPE: u8 = 2;
pub const CMD_METHOD_GET_DEBUG_INFO: u8 = 3;

// EVENT_REQUEST (command set 15)
pub const CMD_EVENT_REQUEST_SET: u8 = 1;
pub const CMD_EVENT_REQUEST_CLEAR: u8 = 2;

// ---------------------------------------------------------------------------
// Events, suspend policies, modifiers
// ---------------------------------------------------------------------------

pub const EVENT_VM_START: u8 = 0;
pub const EVENT_VM_DEATH: u8 = 1;
pub const EVENT_THREAD_START: u8 = 2;
pub const EVENT_THREAD_DEATH: u8 = 3;
pub const EVENT_APPDOMAIN_CREATE: u8 = 4;
pub const EVENT_APPDOMAIN_UNLOAD: u8 = 5;
pub const EVENT_ASSEMBLY_LOAD: u8 = 8;
pub const EVENT_ASSEMBLY_UNLOAD: u8 = 9;
pub const EVENT_BREAKPOINT: u8 = 10;
pub const EVENT_STEP: u8 = 11;
pub const EVENT_TYPE_LOAD: u8 = 12;
pub const EVENT_EXCEPTION: u8 = 13;
pub const EVENT_USER_BREAK: u8 = 15;
pub const EVENT_USER_LOG: u8 = 16;

pub const SUSPEND_NONE: u8 = 0;
pub const SUSPEND_EVENT_THREAD: u8 = 1;
pub const SUSPEND_ALL: u8 = 2;

pub const MOD_COUNT: u8 = 1;
pub const MOD_THREAD_ONLY: u8 = 3;
pub const MOD_LOCATION_ONLY: u8 = 7;
pub const MOD_EXCEPTION_ONLY: u8 = 8;
pub const MOD_STEP: u8 = 10;
pub const MOD_ASSEMBLY_ONLY: u8 = 11;
/// Confirmed live: registering `TYPE_LOAD` with this modifier over
/// `["Fixture.cs"]` delivered exactly the two types declared in that file, out
/// of ~41 loaded during startup. It matches on the **base name**, while
/// `METHOD_GET_DEBUG_INFO` reports a full native path — a mismatch `paths.rs`
/// has to reconcile.
pub const MOD_SOURCE_FILE_ONLY: u8 = 12;
pub const MOD_TYPE_NAME_ONLY: u8 = 13;

/// Portable PDB / mdb marker for a compiler-generated span with no real source
/// position. Binding a breakpoint to one of these puts the stop on a line the
/// user cannot see.
pub const HIDDEN_LINE: u32 = 0x00FE_EFEE;

// ---------------------------------------------------------------------------
// METHOD_GET_DEBUG_INFO
// ---------------------------------------------------------------------------

/// One entry of a method's line table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SequencePoint {
    pub il_offset: u32,
    pub line: u32,
    pub column: u32,
    /// `-1` in the wire format when the symbols carry no end position (mdb
    /// never does; portable PDB usually does). Stored as `Option`.
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
}

/// A method's debug information.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebugInfo {
    pub code_size: u32,
    /// As recorded by the compiler: an absolute native path. On Windows that
    /// means backslashes and a real drive letter.
    pub source_file: String,
    pub sequence_points: Vec<SequencePoint>,
}

/// Decode a `METHOD_GET_DEBUG_INFO` reply body.
///
/// Layout at protocol 2.58, read off the wire:
///
/// ```text
/// int    code_size
/// int    source_file_count (1 for every method observed)
/// string source_file          absolute, native separators
/// byte   hash[16]             source checksum / MVID
/// int    sequence_point_count
/// repeat: int il_offset, int line, int source_index, int column,
///         int end_line, int end_column      (end_* are -1 when absent)
/// ```
pub fn decode_debug_info(body: &[u8]) -> Result<DebugInfo, WireError> {
    let mut r = Reader::new(body);
    let code_size = r.int()? as u32;
    let file_count = r.int()?;

    // Every method observed reported exactly one source file, so the grouping
    // of name-and-hash is inferred rather than seen with n > 1. It is the only
    // grouping the byte accounting allows (4 + 4 + 166 + 16 + 4 + 120 = 314),
    // and `verify:debugger` re-checks the total against a live agent.
    let mut source_file = String::new();
    for i in 0..file_count.max(0) {
        let name = r.string()?;
        for _ in 0..16 {
            r.byte()?; // source checksum / MVID
        }
        if i == 0 {
            source_file = name;
        }
    }

    let count = r.int()?;
    let mut sequence_points = Vec::with_capacity(count.max(0) as usize);
    for _ in 0..count.max(0) {
        let il_offset = r.int()? as u32;
        let line = r.int()? as u32;
        let _source_index = r.int()?;
        let column = r.int()? as u32;
        let end_line = r.int()?;
        let end_column = r.int()?;
        sequence_points.push(SequencePoint {
            il_offset,
            line,
            column,
            end_line: (end_line >= 0).then_some(end_line as u32),
            end_column: (end_column >= 0).then_some(end_column as u32),
        });
    }

    Ok(DebugInfo {
        code_size,
        source_file,
        sequence_points,
    })
}

/// Pick the IL offset a breakpoint on `line` should bind to.
///
/// Prefers an exact line match; failing that, the next executable line below it
/// — which is what every other debugger does when you click a blank line or a
/// comment. Among candidates it takes the lowest IL offset, so the stop lands
/// at the start of the statement rather than mid-expression.
pub fn il_offset_for_line(info: &DebugInfo, line: u32) -> Option<u32> {
    select(info, line).map(|sp| sp.il_offset)
}

/// The line execution would actually stop at for a breakpoint on `line`.
///
/// Always `>= line`. `symbols.rs` uses it to choose between methods: the one
/// that resolves closest to the requested line owns the breakpoint, which is
/// how a line inside one method of a partial class avoids binding into another.
pub fn resolved_line(info: &DebugInfo, line: u32) -> Option<u32> {
    select(info, line).map(|sp| sp.line)
}

fn select(info: &DebugInfo, line: u32) -> Option<&SequencePoint> {
    let visible = || {
        info.sequence_points
            .iter()
            .filter(|sp| sp.line != HIDDEN_LINE)
    };

    if line != HIDDEN_LINE {
        if let Some(sp) = visible()
            .filter(|sp| sp.line == line)
            .min_by_key(|sp| sp.il_offset)
        {
            return Some(sp);
        }
    }

    let next = visible().filter(|sp| sp.line > line).map(|sp| sp.line).min()?;
    visible()
        .filter(|sp| sp.line == next)
        .min_by_key(|sp| sp.il_offset)
}

/// Decode a `count` followed by that many ids — the shape of
/// `TYPE_GET_METHODS`, `VM_ALL_THREADS` and `VM_GET_TYPES_FOR_SOURCE_FILE`.
///
/// Bounds-checked throughout: a short body errors rather than yielding a zero
/// that would later be sent back as an id, which is what kills the runtime.
pub fn decode_id_list(body: &[u8]) -> Result<Vec<u32>, WireError> {
    let mut r = Reader::new(body);
    let count = r.int()?.max(0);
    let mut ids = Vec::with_capacity(count as usize);
    for _ in 0..count {
        ids.push(r.id()?);
    }
    Ok(ids)
}

// ---------------------------------------------------------------------------
// Composite events
// ---------------------------------------------------------------------------

/// One event inside a composite packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Event {
    pub kind: u8,
    pub request_id: u32,
    pub thread: u32,
    /// The id whose meaning depends on `kind`: the loaded type for
    /// `TYPE_LOAD`, the method for `BREAKPOINT`/`STEP`, the appdomain for
    /// `VM_START`. `None` for kinds that carry no trailing id.
    pub subject: Option<u32>,
}

/// A decoded `EVENT`/`COMPOSITE` packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Composite {
    pub suspend_policy: u8,
    pub events: Vec<Event>,
}

/// Decode an `EVENT` command-set `COMPOSITE` packet body.
///
/// ```text
/// byte suspend_policy
/// int  count
/// repeat: byte kind, int request_id, id thread, [id subject]
/// ```
pub fn decode_composite(body: &[u8]) -> Result<Composite, WireError> {
    let mut r = Reader::new(body);
    let suspend_policy = r.byte()?;
    let count = r.int()?;

    let mut events = Vec::with_capacity(count.max(0) as usize);
    for _ in 0..count.max(0) {
        let kind = r.byte()?;
        let request_id = r.int()? as u32;
        let thread = r.id()?;

        let subject = match kind {
            EVENT_VM_START
            | EVENT_TYPE_LOAD
            | EVENT_ASSEMBLY_LOAD
            | EVENT_ASSEMBLY_UNLOAD
            | EVENT_APPDOMAIN_CREATE
            | EVENT_APPDOMAIN_UNLOAD => Some(r.id()?),
            EVENT_THREAD_START | EVENT_THREAD_DEATH => None,
            _ => {
                // The trailing shape of this kind has not been read off a live
                // agent yet, so its width is unknown. Keep the event and stop
                // rather than guess: a wrong width desynchronises the rest of
                // the packet, and a desynchronised parse is how a bogus id gets
                // sent — which kills the runtime outright.
                events.push(Event {
                    kind,
                    request_id,
                    thread,
                    subject: None,
                });
                break;
            }
        };

        events.push(Event {
            kind,
            request_id,
            thread,
            subject,
        });
    }

    Ok(Composite {
        suspend_policy,
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::wire::Writer;

    /// Rebuilds the exact `METHOD_GET_DEBUG_INFO` reply captured from Mono
    /// 6.13.0 for `Player.Tick`, with the real path shortened.
    fn tick_debug_info_body(source: &str) -> Vec<u8> {
        let mut w = Writer::new();
        w.int(31); // code_size
        w.int(1); // source file count
        w.string(source);
        for b in [
            0x3c, 0x94, 0x60, 0xd6, 0x64, 0xe2, 0x55, 0x79, 0x07, 0xa4, 0x6a, 0x5c, 0xa8, 0xb4,
            0xb8, 0x04,
        ] {
            w.byte(b);
        }
        w.int(5);
        for (il, line, col) in [(0, 13, 32), (1, 14, 9), (8, 15, 9), (17, 16, 9), (29, 17, 5)] {
            w.int(il).int(line).int(0).int(col).int(-1).int(-1);
        }
        w.into_bytes()
    }

    #[test]
    fn decodes_the_captured_tick_line_table() {
        let path = r"C:\Users\sd120\scratch\Fixture.cs";
        let info = decode_debug_info(&tick_debug_info_body(path)).unwrap();
        assert_eq!(info.code_size, 31);
        assert_eq!(info.source_file, path);
        assert_eq!(info.sequence_points.len(), 5);
        assert_eq!(
            info.sequence_points[2],
            SequencePoint {
                il_offset: 8,
                line: 15,
                column: 9,
                end_line: None,
                end_column: None,
            }
        );
    }

    /// The whole point of the line table: this is the number sent as the
    /// `LOCATION_ONLY` modifier when arming a breakpoint.
    #[test]
    fn a_breakpoint_on_line_15_binds_to_il_offset_8() {
        let info = decode_debug_info(&tick_debug_info_body("Fixture.cs")).unwrap();
        assert_eq!(il_offset_for_line(&info, 15), Some(8));
    }

    #[test]
    fn a_breakpoint_on_a_blank_line_slides_to_the_next_executable_line() {
        let info = decode_debug_info(&tick_debug_info_body("Fixture.cs")).unwrap();
        // Line 12 is above the method; the first real code is line 13 at IL 0.
        assert_eq!(il_offset_for_line(&info, 12), Some(0));
    }

    #[test]
    fn a_line_past_the_end_of_the_method_does_not_bind() {
        let info = decode_debug_info(&tick_debug_info_body("Fixture.cs")).unwrap();
        assert_eq!(il_offset_for_line(&info, 900), None);
    }

    #[test]
    fn the_lowest_il_offset_wins_when_a_line_has_several() {
        // A `for` line compiles to several sequence points; the stop belongs at
        // the first, not wherever the table happens to list last.
        let mut w = Writer::new();
        w.int(40).int(1).string("Fixture.cs");
        for _ in 0..16 {
            w.byte(0);
        }
        w.int(3);
        for (il, line) in [(22u32, 23u32), (4, 23), (11, 23)] {
            w.int(il as i32).int(line as i32).int(0).int(13).int(-1).int(-1);
        }
        let info = decode_debug_info(&w.into_bytes()).unwrap();
        assert_eq!(il_offset_for_line(&info, 23), Some(4));
    }

    #[test]
    fn compiler_generated_hidden_lines_are_never_breakpoint_targets() {
        let mut w = Writer::new();
        w.int(40).int(1).string("Fixture.cs");
        for _ in 0..16 {
            w.byte(0);
        }
        w.int(2);
        w.int(0).int(HIDDEN_LINE as i32).int(0).int(0).int(-1).int(-1);
        w.int(6).int(30).int(0).int(9).int(-1).int(-1);
        let info = decode_debug_info(&w.into_bytes()).unwrap();
        // Asking for the hidden line itself must not bind to it...
        assert_eq!(il_offset_for_line(&info, HIDDEN_LINE), None);
        // ...and it must not be chosen as the "next line" for an earlier line.
        assert_eq!(il_offset_for_line(&info, 1), Some(6));
    }

    #[test]
    fn end_positions_are_present_when_the_symbols_carry_them() {
        let mut w = Writer::new();
        w.int(10).int(1).string("Fixture.cs");
        for _ in 0..16 {
            w.byte(0);
        }
        w.int(1);
        w.int(0).int(15).int(0).int(9).int(15).int(31);
        let info = decode_debug_info(&w.into_bytes()).unwrap();
        assert_eq!(info.sequence_points[0].end_line, Some(15));
        assert_eq!(info.sequence_points[0].end_column, Some(31));
    }

    /// A short or unexpected body must surface as an error. Reading past the
    /// end here is what produces a bogus id, and a bogus id kills the runtime.
    #[test]
    fn a_truncated_debug_info_body_is_an_error() {
        let full = tick_debug_info_body("Fixture.cs");
        assert!(decode_debug_info(&full[..full.len() - 5]).is_err());
    }

    /// Captured verbatim from Mono 6.13.0: the composite `VM_START` pushed the
    /// instant a debugger connects.
    #[test]
    fn decodes_the_captured_vm_start_composite() {
        let body = [
            0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x01,
        ];
        let c = decode_composite(&body).unwrap();
        assert_eq!(c.suspend_policy, SUSPEND_NONE);
        assert_eq!(
            c.events,
            vec![Event {
                kind: EVENT_VM_START,
                request_id: 0,
                thread: 1,
                subject: Some(1),
            }]
        );
    }

    /// Captured verbatim: a `TYPE_LOAD` for `Player`. The type id lives at byte
    /// 14, after the thread id — reading it at byte 10 yields the thread id and
    /// makes every event look like the same type.
    #[test]
    fn decodes_the_captured_type_load_composite() {
        let body = [
            0x02, 0x00, 0x00, 0x00, 0x01, 0x0c, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x02,
        ];
        let c = decode_composite(&body).unwrap();
        assert_eq!(c.suspend_policy, SUSPEND_ALL);
        assert_eq!(c.events[0].kind, EVENT_TYPE_LOAD);
        assert_eq!(c.events[0].request_id, 1);
        assert_eq!(c.events[0].thread, 1);
        assert_eq!(c.events[0].subject, Some(2), "type id is at byte 14");
    }

    #[test]
    fn decodes_a_composite_carrying_several_events() {
        let mut w = Writer::new();
        w.byte(SUSPEND_ALL).int(2);
        w.byte(EVENT_TYPE_LOAD).int(1).id(7).id(11);
        w.byte(EVENT_TYPE_LOAD).int(1).id(7).id(12);
        let c = decode_composite(&w.into_bytes()).unwrap();
        assert_eq!(c.events.len(), 2);
        assert_eq!(c.events[0].subject, Some(11));
        assert_eq!(c.events[1].subject, Some(12));
    }

    #[test]
    fn a_thread_only_event_has_no_subject() {
        let mut w = Writer::new();
        w.byte(SUSPEND_NONE).int(1);
        w.byte(EVENT_THREAD_START).int(0).id(4);
        let c = decode_composite(&w.into_bytes()).unwrap();
        assert_eq!(c.events[0].thread, 4);
        assert_eq!(c.events[0].subject, None);
    }

    #[test]
    fn a_truncated_composite_is_an_error() {
        assert!(decode_composite(&[0x02, 0x00, 0x00, 0x00, 0x01, 0x0c]).is_err());
    }

    /// Guards the specific mix-up that produced a zero method id and killed the
    /// runtime four times during this work.
    #[test]
    fn type_get_methods_is_command_two_not_five() {
        assert_eq!(CMD_TYPE_GET_METHODS, 2);
        assert_eq!(CMD_TYPE_GET_OBJECT, 5);
    }
}
