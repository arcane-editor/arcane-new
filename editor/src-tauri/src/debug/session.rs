//! Threads, frames, locals and stepping.
//!
//! Stateless helpers over a `Conn`. The stop/resume bookkeeping lives in the
//! DAP router, which owns the handle tables whose lifetimes DAP defines; this
//! module is just the vocabulary for asking the runtime questions.
//!
//! Layouts here were read off Mono 6.13.0 stopped at a real breakpoint, not
//! recalled. The frame reply, for instance:
//!
//! ```text
//! 00 00 00 02                       two frames
//! 00 00 00 01  00 00 00 04  00 00 00 08  01     id=1 method=4 il=8 flags=1
//! 00 00 00 02  00 00 00 02  00 00 00 19  00     id=2 method=2 il=25 flags=0
//! ```
//!
//! — frame 0 sitting at exactly the IL offset the breakpoint was armed on.

use super::conn::{Conn, ConnError};
use super::protocol;
use super::values::{self, Value};
use super::wire::{Reader, Writer};

/// `THREAD` command numbers.
const CMD_THREAD_GET_FRAME_INFO: u8 = 1;
const CMD_THREAD_GET_NAME: u8 = 2;

/// `STACK_FRAME` command numbers.
const CMD_STACK_FRAME_GET_VALUES: u8 = 1;
const CMD_STACK_FRAME_GET_THIS: u8 = 2;
const CMD_STACK_FRAME_SET_VALUES: u8 = 3;

const CMD_THREAD_SET_IP: u8 = 7;

/// `METHOD_GET_LOCALS_INFO`.
const CMD_METHOD_GET_LOCALS_INFO: u8 = 5;

/// Steps are always by source line.
///
/// The protocol also offers instruction-level stepping, but nothing in this
/// editor exposes it — there is no disassembly view to step through. The
/// constant is inlined rather than kept as a two-variant enum whose other
/// variant nothing constructs.
const STEP_SIZE_LINE: i32 = 1;

/// How a step treats calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepDepth {
    Into = 0,
    Over = 1,
    Out = 2,
}

/// Code a step should pass straight through.
///
/// Without these, stepping into a line lands in a static constructor, a
/// property accessor marked `[DebuggerStepThrough]`, or Unity's own engine
/// code — all of which the user has to step back out of. Together they are what
/// other debuggers call "step into my code".
pub mod step_filter {
    pub const STATIC_CTOR: i32 = 1;
    pub const DEBUGGER_HIDDEN: i32 = 2;
    pub const DEBUGGER_STEP_THROUGH: i32 = 4;
    pub const DEBUGGER_NON_USER_CODE: i32 = 8;

    /// Everything a user would consider "not my code".
    pub const MY_CODE_ONLY: i32 =
        STATIC_CTOR | DEBUGGER_HIDDEN | DEBUGGER_STEP_THROUGH | DEBUGGER_NON_USER_CODE;
}

/// One stack frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub id: u32,
    pub method: u32,
    pub il_offset: u32,
    pub flags: u8,
}

/// One local variable's declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Local {
    pub name: String,
    pub type_id: u32,
    pub live_start: u32,
    pub live_end: u32,
}

impl Local {
    /// True when this local is in scope at `il_offset`.
    ///
    /// The compiler reuses slots, so a local declared inside a branch holds
    /// unrelated memory outside its range. Showing it there is worse than
    /// hiding it: the value looks real.
    pub fn is_live_at(&self, il_offset: u32) -> bool {
        // A zero-width range means the compiler recorded no scope, in which
        // case the local is live for the whole method.
        self.live_start == self.live_end
            || (il_offset >= self.live_start && il_offset < self.live_end)
    }
}

/// Every managed thread the runtime knows about.
pub async fn all_threads(conn: &Conn) -> Result<Vec<u32>, ConnError> {
    let reply = conn
        .request(protocol::CMD_SET_VM, protocol::CMD_VM_ALL_THREADS, Vec::new())
        .await?;
    Ok(protocol::decode_id_list(&reply.body)?)
}

/// A thread's name. Unity's main thread reports an empty name, so callers
/// should substitute something readable.
pub async fn thread_name(conn: &Conn, thread: u32) -> Result<String, ConnError> {
    let mut w = Writer::new();
    w.id(thread);
    let reply = conn
        .request(protocol::CMD_SET_THREAD, CMD_THREAD_GET_NAME, w.into_bytes())
        .await?;
    if !reply.is_ok() {
        return Ok(String::new());
    }
    Ok(Reader::new(&reply.body).string()?)
}

/// The call stack of a suspended thread, innermost first.
pub async fn frames(conn: &Conn, thread: u32) -> Result<Vec<Frame>, ConnError> {
    let mut w = Writer::new();
    w.id(thread).int(0).int(-1); // from the innermost frame, all of them
    let reply = conn
        .request(
            protocol::CMD_SET_THREAD,
            CMD_THREAD_GET_FRAME_INFO,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        // A thread that resumed between the stop and this call is ordinary.
        return Ok(Vec::new());
    }

    let mut r = Reader::new(&reply.body);
    let count = r.int()?.max(0);
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        out.push(Frame {
            id: r.int()? as u32,
            method: r.id()?,
            il_offset: r.int()? as u32,
            flags: r.byte()?,
        });
    }
    Ok(out)
}

/// A method's local variable declarations.
pub async fn locals_info(conn: &Conn, method: u32) -> Result<Vec<Local>, ConnError> {
    let mut w = Writer::new();
    w.id(method);
    let reply = conn
        .request(
            protocol::CMD_SET_METHOD,
            CMD_METHOD_GET_LOCALS_INFO,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Ok(Vec::new());
    }

    // Captured layout: a leading id list (empty for every method observed),
    // then a count, then that many type ids, then that many names, then that
    // many live ranges. The leading list is read and skipped rather than
    // assumed to be empty.
    let mut r = Reader::new(&reply.body);
    let leading = r.int()?.max(0);
    for _ in 0..leading {
        r.id()?;
    }
    let count = r.int()?.max(0) as usize;
    let mut type_ids = Vec::with_capacity(count);
    for _ in 0..count {
        type_ids.push(r.id()?);
    }
    let mut names = Vec::with_capacity(count);
    for _ in 0..count {
        names.push(r.string()?);
    }
    let mut locals = Vec::with_capacity(count);
    for i in 0..count {
        locals.push(Local {
            name: names[i].clone(),
            type_id: type_ids[i],
            live_start: r.int()? as u32,
            live_end: r.int()? as u32,
        });
    }
    Ok(locals)
}

/// Read values out of a frame.
///
/// A non-negative position is a local slot; a negative position is the
/// argument at `-position - 1`.
pub async fn frame_values(
    conn: &Conn,
    thread: u32,
    frame: u32,
    positions: &[i32],
) -> Result<Vec<Value>, ConnError> {
    let mut w = Writer::new();
    w.id(thread).int(frame as i32).int(positions.len() as i32);
    for position in positions {
        w.int(*position);
    }
    let reply = conn
        .request(
            protocol::CMD_SET_STACK_FRAME,
            CMD_STACK_FRAME_GET_VALUES,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_STACK_FRAME,
            command: CMD_STACK_FRAME_GET_VALUES,
            error: reply.error,
        });
    }

    let mut r = Reader::new(&reply.body);
    let mut out = Vec::with_capacity(positions.len());
    for _ in positions {
        out.push(values::decode_value(&mut r)?);
    }
    Ok(out)
}

/// Write one value back into a frame slot.
pub async fn set_frame_value(
    conn: &Conn,
    thread: u32,
    frame: u32,
    position: i32,
    encoded: Vec<u8>,
) -> Result<(), ConnError> {
    let mut w = Writer::new();
    w.id(thread)
        .int(frame as i32)
        .int(1)
        .int(position)
        .raw(&encoded);
    let reply = conn
        .request(
            protocol::CMD_SET_STACK_FRAME,
            CMD_STACK_FRAME_SET_VALUES,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_STACK_FRAME,
            command: CMD_STACK_FRAME_SET_VALUES,
            error: reply.error,
        });
    }
    Ok(())
}

/// The `this` reference of a frame. Static methods have none.
pub async fn frame_this(conn: &Conn, thread: u32, frame: u32) -> Result<Value, ConnError> {
    let mut w = Writer::new();
    w.id(thread).int(frame as i32);
    let reply = conn
        .request(
            protocol::CMD_SET_STACK_FRAME,
            CMD_STACK_FRAME_GET_THIS,
            w.into_bytes(),
        )
        .await?;
    if !reply.is_ok() {
        // Static methods have no `this`; that is not an error.
        return Ok(Value::Null);
    }
    Ok(values::decode_value(&mut Reader::new(&reply.body))?)
}

/// Move a suspended thread's instruction pointer within its current method.
///
/// This is "set next statement": skip a call, or go back and run something
/// again with different state. The runtime only allows it inside the same
/// method — jumping across frames would leave the stack describing a call that
/// never happened — and refuses anything else, which surfaces as an agent error
/// rather than a corrupted process.
pub async fn set_instruction_pointer(
    conn: &Conn,
    thread: u32,
    method: u32,
    il_offset: u32,
) -> Result<(), ConnError> {
    let mut w = Writer::new();
    w.id(thread).id(method).long(il_offset as i64);
    let reply = conn
        .request(protocol::CMD_SET_THREAD, CMD_THREAD_SET_IP, w.into_bytes())
        .await?;
    if !reply.is_ok() {
        return Err(ConnError::Agent {
            command_set: protocol::CMD_SET_THREAD,
            command: CMD_THREAD_SET_IP,
            error: reply.error,
        });
    }
    Ok(())
}

pub async fn resume(conn: &Conn) -> Result<(), ConnError> {
    conn.request(protocol::CMD_SET_VM, protocol::CMD_VM_RESUME, Vec::new())
        .await?;
    Ok(())
}

pub async fn suspend(conn: &Conn) -> Result<(), ConnError> {
    conn.request(protocol::CMD_SET_VM, protocol::CMD_VM_SUSPEND, Vec::new())
        .await?;
    Ok(())
}

/// Arm a single step on `thread`. Returns the event request id, which must be
/// cleared once the step lands or the runtime keeps stepping.
pub async fn step(
    conn: &Conn,
    thread: u32,
    depth: StepDepth,
    filter: i32,
) -> Result<u32, ConnError> {
    let mut w = Writer::new();
    w.byte(protocol::EVENT_STEP)
        .byte(protocol::SUSPEND_ALL)
        .byte(1) // modifier count: a byte, not an int
        .byte(protocol::MOD_STEP)
        .id(thread)
        .int(STEP_SIZE_LINE)
        .int(depth as i32)
        // Step filters arrived at protocol 2.16 and this client negotiates
        // 2.58, so the field is always present. Omitting it leaves the agent
        // reading the next packet as part of this modifier.
        .int(filter);

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::fake_agent::{id_list_body, FakeAgent};
    use crate::debug::values::TYPE_I4;
    use tokio::sync::mpsc;

    async fn connect(agent: &FakeAgent) -> Conn {
        Conn::connect(agent.addr).await.expect("connect")
    }

    fn recorder() -> (
        mpsc::UnboundedSender<(u8, u8, Vec<u8>)>,
        mpsc::UnboundedReceiver<(u8, u8, Vec<u8>)>,
    ) {
        mpsc::unbounded_channel()
    }

    /// Captured verbatim from Mono 6.13.0 stopped at the fixture's breakpoint.
    fn captured_frame_info() -> Vec<u8> {
        vec![
            0x00, 0x00, 0x00, 0x02, // two frames
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x08, 0x01,
            0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x19, 0x00,
        ]
    }

    /// Captured verbatim: `Player.Tick` has one local, `before`.
    fn captured_locals_info() -> Vec<u8> {
        vec![
            0x00, 0x00, 0x00, 0x00, // no leading type ids
            0x00, 0x00, 0x00, 0x01, // one local
            0x00, 0x00, 0x00, 0x03, // its type id
            0x00, 0x00, 0x00, 0x06, 0x62, 0x65, 0x66, 0x6f, 0x72, 0x65, // "before"
            0x00, 0x00, 0x00, 0x00, // live from IL 0
            0x00, 0x00, 0x00, 0x1f, // to IL 31
        ]
    }

    #[tokio::test]
    async fn decodes_the_captured_frame_info() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_THREAD, CMD_THREAD_GET_FRAME_INFO) {
                Some((0, captured_frame_info()))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;

        let stack = frames(&conn, 1).await.unwrap();
        assert_eq!(
            stack,
            vec![
                Frame {
                    id: 1,
                    method: 4,
                    il_offset: 8,
                    flags: 1
                },
                Frame {
                    id: 2,
                    method: 2,
                    il_offset: 25,
                    flags: 0
                },
            ]
        );
    }

    #[tokio::test]
    async fn frames_asks_for_the_whole_stack() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, captured_frame_info()))
        });
        let conn = connect(&agent).await;
        frames(&conn, 7).await.unwrap();

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!((cs, cmd), (protocol::CMD_SET_THREAD, CMD_THREAD_GET_FRAME_INFO));
        let mut r = Reader::new(&body);
        assert_eq!(r.id().unwrap(), 7);
        assert_eq!(r.int().unwrap(), 0, "start at the innermost frame");
        assert_eq!(r.int().unwrap(), -1, "-1 means every frame");
    }

    #[tokio::test]
    async fn decodes_the_captured_locals_info() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_METHOD, CMD_METHOD_GET_LOCALS_INFO) {
                Some((0, captured_locals_info()))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;

        assert_eq!(
            locals_info(&conn, 4).await.unwrap(),
            vec![Local {
                name: "before".to_string(),
                type_id: 3,
                live_start: 0,
                live_end: 31,
            }]
        );
    }

    /// Compilers reuse local slots, so a local outside its live range holds
    /// somebody else's memory. Showing it would look like a real value.
    #[test]
    fn a_local_is_hidden_outside_its_live_range() {
        let local = Local {
            name: "tmp".into(),
            type_id: 3,
            live_start: 10,
            live_end: 20,
        };
        assert!(!local.is_live_at(9));
        assert!(local.is_live_at(10));
        assert!(local.is_live_at(19));
        assert!(!local.is_live_at(20));
    }

    #[test]
    fn a_local_with_no_recorded_scope_is_live_throughout() {
        let local = Local {
            name: "x".into(),
            type_id: 3,
            live_start: 0,
            live_end: 0,
        };
        assert!(local.is_live_at(0));
        assert!(local.is_live_at(999));
    }

    #[tokio::test]
    async fn frame_values_asks_for_the_positions_it_was_given() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            // Captured shape: one I4 worth 3.
            Some((0, vec![0x08, 0x00, 0x00, 0x00, 0x03]))
        });
        let conn = connect(&agent).await;

        let values = frame_values(&conn, 1, 1, &[0]).await.unwrap();
        assert_eq!(
            values,
            vec![Value::Int {
                value: 3,
                tag: TYPE_I4
            }]
        );

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (protocol::CMD_SET_STACK_FRAME, CMD_STACK_FRAME_GET_VALUES)
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.id().unwrap(), 1, "thread");
        assert_eq!(r.int().unwrap(), 1, "frame");
        assert_eq!(r.int().unwrap(), 1, "one position");
        assert_eq!(r.int().unwrap(), 0, "local slot 0");
    }

    /// Arguments are addressed with negative positions, which is easy to get
    /// backwards and yields somebody else's slot when you do.
    #[tokio::test]
    async fn arguments_use_negative_positions() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |_, _, body| {
            let _ = tx.send((0, 0, body.to_vec()));
            Some((0, vec![0x08, 0x00, 0x00, 0x00, 0x07]))
        });
        let conn = connect(&agent).await;
        frame_values(&conn, 1, 1, &[-1]).await.unwrap();

        let (_, _, body) = seen.recv().await.unwrap();
        let mut r = Reader::new(&body);
        r.id().unwrap();
        r.int().unwrap();
        r.int().unwrap();
        assert_eq!(r.int().unwrap(), -1, "argument 0 is position -1");
    }

    #[tokio::test]
    async fn frame_this_decodes_the_captured_reference() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_STACK_FRAME, CMD_STACK_FRAME_GET_THIS) {
                Some((0, vec![0x12, 0x00, 0x00, 0x00, 0x02]))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(
            frame_this(&conn, 1, 1).await.unwrap(),
            Value::Object {
                tag: values::TYPE_CLASS,
                id: 2
            }
        );
    }

    #[tokio::test]
    async fn all_threads_decodes_the_id_list() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_VM, protocol::CMD_VM_ALL_THREADS) {
                Some((0, id_list_body(&[1, 5, 9])))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(all_threads(&conn).await.unwrap(), vec![1, 5, 9]);
    }

    #[tokio::test]
    async fn thread_name_decodes_a_string() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|cs, cmd, _| {
            if (cs, cmd) == (protocol::CMD_SET_THREAD, CMD_THREAD_GET_NAME) {
                let mut w = Writer::new();
                w.string("Main Thread");
                Some((0, w.into_bytes()))
            } else {
                Some((0, Vec::new()))
            }
        });
        let conn = connect(&agent).await;
        assert_eq!(thread_name(&conn, 1).await.unwrap(), "Main Thread");
    }

    /// The step modifier carries a filter int at protocol 2.16 and above, and
    /// the modifier count is a byte — the same encoding that killed the runtime
    /// when it was written as an int for breakpoints.
    #[tokio::test]
    async fn step_sends_a_step_modifier_with_a_byte_count() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            let mut w = Writer::new();
            w.int(4);
            Some((0, w.into_bytes()))
        });
        let conn = connect(&agent).await;

        let id = step(&conn, 3, StepDepth::Over, step_filter::MY_CODE_ONLY).await.unwrap();
        assert_eq!(id, 4);

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (
                protocol::CMD_SET_EVENT_REQUEST,
                protocol::CMD_EVENT_REQUEST_SET
            )
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.byte().unwrap(), protocol::EVENT_STEP);
        assert_eq!(r.byte().unwrap(), protocol::SUSPEND_ALL);
        assert_eq!(r.byte().unwrap(), 1, "modifier count is a byte");
        assert_eq!(r.byte().unwrap(), protocol::MOD_STEP);
        assert_eq!(r.id().unwrap(), 3, "thread");
        assert_eq!(r.int().unwrap(), STEP_SIZE_LINE, "steps are by line");
        assert_eq!(r.int().unwrap(), StepDepth::Over as i32);
        assert_eq!(
            r.int().unwrap(),
            step_filter::MY_CODE_ONLY,
            "steps skip compiler-generated and hidden code"
        );
        assert!(r.is_empty());
    }

    /// The IL offset is a long here, as it is for a breakpoint location.
    #[tokio::test]
    async fn set_instruction_pointer_names_the_thread_method_and_offset() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, Vec::new()))
        });
        let conn = connect(&agent).await;

        set_instruction_pointer(&conn, 1, 4, 17).await.unwrap();

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!((cs, cmd), (protocol::CMD_SET_THREAD, CMD_THREAD_SET_IP));
        let mut r = Reader::new(&body);
        assert_eq!(r.id().unwrap(), 1, "thread");
        assert_eq!(r.id().unwrap(), 4, "method");
        assert_eq!(r.long().unwrap(), 17, "il offset is a long");
        assert!(r.is_empty());
    }

    /// The runtime refuses a jump it cannot make. That refusal has to reach the
    /// caller: pretending it worked would leave the UI showing an execution
    /// pointer somewhere the thread is not.
    #[tokio::test]
    async fn a_refused_jump_is_reported() {
        let mut agent = FakeAgent::start().await;
        agent.respond_with(|_, _, _| Some((100, Vec::new())));
        let conn = connect(&agent).await;
        assert!(matches!(
            set_instruction_pointer(&conn, 1, 4, 17).await,
            Err(ConnError::Agent { .. })
        ));
    }

    #[tokio::test]
    async fn set_frame_value_addresses_one_slot() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, body| {
            let _ = tx.send((cs, cmd, body.to_vec()));
            Some((0, Vec::new()))
        });
        let conn = connect(&agent).await;

        let mut encoded = Writer::new();
        encoded.byte(TYPE_I4).int(99);
        set_frame_value(&conn, 1, 1, 0, encoded.into_bytes())
            .await
            .unwrap();

        let (cs, cmd, body) = seen.recv().await.unwrap();
        assert_eq!(
            (cs, cmd),
            (protocol::CMD_SET_STACK_FRAME, CMD_STACK_FRAME_SET_VALUES)
        );
        let mut r = Reader::new(&body);
        assert_eq!(r.id().unwrap(), 1);
        assert_eq!(r.int().unwrap(), 1);
        assert_eq!(r.int().unwrap(), 1, "one value");
        assert_eq!(r.int().unwrap(), 0, "slot 0");
        assert_eq!(r.byte().unwrap(), TYPE_I4);
        assert_eq!(r.int().unwrap(), 99);
    }

    #[tokio::test]
    async fn resume_sends_vm_resume() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, _| {
            let _ = tx.send((cs, cmd, Vec::new()));
            Some((0, Vec::new()))
        });
        let conn = connect(&agent).await;
        resume(&conn).await.unwrap();
        let (cs, cmd, _) = seen.recv().await.unwrap();
        assert_eq!((cs, cmd), (protocol::CMD_SET_VM, protocol::CMD_VM_RESUME));
    }

    #[tokio::test]
    async fn suspend_sends_vm_suspend() {
        let mut agent = FakeAgent::start().await;
        let (tx, mut seen) = recorder();
        agent.respond_with(move |cs, cmd, _| {
            let _ = tx.send((cs, cmd, Vec::new()));
            Some((0, Vec::new()))
        });
        let conn = connect(&agent).await;
        suspend(&conn).await.unwrap();
        let (cs, cmd, _) = seen.recv().await.unwrap();
        assert_eq!((cs, cmd), (protocol::CMD_SET_VM, protocol::CMD_VM_SUSPEND));
    }
}
