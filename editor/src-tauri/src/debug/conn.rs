//! The debugger socket: handshake, request correlation, event fan-out, and
//! the disconnect discipline the agent demands.
//!
//! Mono's debugger agent is not defensive. A client that mis-parses a reply,
//! sends an id the runtime never handed out, or drops the socket with a reply
//! in flight can take the whole host process down — no error, no reply, just a
//! closed socket and a dead editor. That happened to a running Unity 6 editor
//! during this work. Everything unusual in this module is a rule that came out
//! of reproducing it:
//!
//! 1. **Version first.** `connect` performs the handshake and sends
//!    `VM_SET_PROTOCOL_VERSION` before it returns, so no caller can get a
//!    command in ahead of it.
//! 2. **A timeout never closes the socket.** The pending entry stays; the
//!    reader drains the late reply and discards it. Abandoning a socket with a
//!    reply in flight is exactly what killed the editor.
//! 3. **`VM_DISPOSE` before close, always.** A clean dispose resumes the VM and
//!    leaves the process running — verified: the debuggee ran to completion
//!    after disconnect.
//! 4. **Events are not replies.** The runtime pushes a composite `VM_START` the
//!    instant a debugger connects, before any reply. Correlation is by id and
//!    reply flag only, never by arrival order.
//! 5. **One writer.** A single task owns the write half; requests queue through
//!    a channel. Two tasks writing interleaved packets desynchronises the agent.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, oneshot};

use super::protocol::{self, Composite};
use super::wire::{self, Header, WireError};

/// The magic both ends exchange before any packet.
pub const HANDSHAKE: &[u8] = b"DWP-Handshake";

/// The wire protocol this client speaks. Mono 6.13.0, the runtime Unity 6
/// ships, reports 2.58; every layout in `protocol.rs` was read at this version.
pub const PROTOCOL_MAJOR: i32 = 2;
pub const PROTOCOL_MINOR: i32 = 58;

/// Default ceiling for a single request.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// A reply from the agent. `error` is 0 on success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub error: u16,
    pub body: Vec<u8>,
}

impl Reply {
    /// True when the agent reported success.
    pub fn is_ok(&self) -> bool {
        self.error == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnError {
    Io(String),
    /// The peer did not answer the handshake with the same magic.
    Handshake(String),
    /// No reply within the deadline. The socket is deliberately left open.
    Timeout { command_set: u8, command: u8 },
    /// The reader task ended: the agent went away or the session was disposed.
    Closed,
    Protocol(WireError),
    /// The agent answered, but with a failure code. Carried separately from
    /// `Protocol` because it means the runtime declined a well-formed request
    /// (a stale id, an unloaded type), not that our decoding is wrong.
    Agent {
        command_set: u8,
        command: u8,
        error: u16,
    },
}

impl std::fmt::Display for ConnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnError::Io(e) => write!(f, "debugger socket error: {}", e),
            ConnError::Handshake(e) => write!(f, "debugger handshake failed: {}", e),
            ConnError::Timeout {
                command_set,
                command,
            } => write!(
                f,
                "debugger command {}/{} timed out",
                command_set, command
            ),
            ConnError::Closed => write!(f, "debugger connection closed"),
            ConnError::Protocol(e) => write!(f, "debugger protocol error: {}", e),
            ConnError::Agent {
                command_set,
                command,
                error,
            } => write!(
                f,
                "debugger agent refused command {}/{} with error {}",
                command_set, command, error
            ),
        }
    }
}

impl From<WireError> for ConnError {
    fn from(e: WireError) -> Self {
        ConnError::Protocol(e)
    }
}

type Pending = Arc<Mutex<HashMap<u32, oneshot::Sender<Reply>>>>;

/// A live connection to a Mono debugger agent.
///
/// Cheap to clone: every clone shares one socket, one id sequence and one
/// pending-request table.
#[derive(Clone)]
pub struct Conn {
    out: mpsc::UnboundedSender<Vec<u8>>,
    pending: Pending,
    next_id: Arc<AtomicU32>,
    events: broadcast::Sender<Composite>,
    closed: Arc<AtomicBool>,
}

impl Conn {
    /// Connect, handshake, and negotiate the protocol version.
    ///
    /// Returns only once the agent has acknowledged
    /// `VM_SET_PROTOCOL_VERSION`, so rule 1 holds for every caller.
    pub async fn connect(addr: SocketAddr) -> Result<Conn, ConnError> {
        let stream = TcpStream::connect(addr)
            .await
            .map_err(|e| ConnError::Io(e.to_string()))?;
        let _ = stream.set_nodelay(true);
        let (mut rd, mut wr) = stream.into_split();

        wr.write_all(HANDSHAKE)
            .await
            .map_err(|e| ConnError::Handshake(e.to_string()))?;
        wr.flush()
            .await
            .map_err(|e| ConnError::Handshake(e.to_string()))?;
        let mut magic = vec![0u8; HANDSHAKE.len()];
        rd.read_exact(&mut magic)
            .await
            .map_err(|e| ConnError::Handshake(e.to_string()))?;
        if magic != HANDSHAKE {
            return Err(ConnError::Handshake(format!(
                "peer answered {:?}",
                String::from_utf8_lossy(&magic)
            )));
        }

        let (out, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(256);
        let closed = Arc::new(AtomicBool::new(false));

        // Rule 5: exactly one task writes.
        tokio::spawn(async move {
            while let Some(bytes) = out_rx.recv().await {
                if wr.write_all(&bytes).await.is_err() || wr.flush().await.is_err() {
                    break;
                }
            }
        });

        {
            let pending = pending.clone();
            let events = events.clone();
            let closed = closed.clone();
            tokio::spawn(async move {
                loop {
                    let mut header = [0u8; wire::HEADER_LEN];
                    if rd.read_exact(&mut header).await.is_err() {
                        break;
                    }
                    let parsed = match wire::decode_header(&header) {
                        Ok(h) => h,
                        Err(_) => break,
                    };
                    let body_len = match parsed {
                        Header::Command { body_len, .. } | Header::Reply { body_len, .. } => body_len,
                    };
                    let mut body = vec![0u8; body_len];
                    if body_len > 0 && rd.read_exact(&mut body).await.is_err() {
                        break;
                    }

                    match parsed {
                        // Rule 4: correlation is by id and reply flag only.
                        Header::Reply { id, error, .. } => {
                            super::trace::append(
                                "<-",
                                &format!(
                                    "[{}] {} {}B",
                                    id,
                                    if error == 0 {
                                        "ok".to_string()
                                    } else {
                                        format!("ERROR {}", error)
                                    },
                                    body.len()
                                ),
                            );
                            let waiter = crate::sync_util::lock_recover(&pending).remove(&id);
                            if let Some(tx) = waiter {
                                // Rule 2: a timed-out caller has dropped its
                                // receiver, so this send fails. That is the
                                // drain path — the late reply is consumed and
                                // discarded, and the socket stays healthy.
                                let _ = tx.send(Reply { error, body });
                            }
                        }
                        Header::Command {
                            command_set,
                            command,
                            ..
                        } => {
                            if command_set == protocol::CMD_SET_EVENT
                                && command == protocol::CMD_COMPOSITE
                            {
                                if let Ok(composite) = protocol::decode_composite(&body) {
                                    super::trace::append(
                                        "<-",
                                        &format!(
                                            "event suspend={} kinds={:?}",
                                            composite.suspend_policy,
                                            composite
                                                .events
                                                .iter()
                                                .map(|e| e.kind)
                                                .collect::<Vec<_>>()
                                        ),
                                    );
                                    let _ = events.send(composite);
                                }
                            }
                        }
                    }
                }
                closed.store(true, Ordering::SeqCst);
                // Wake everyone still waiting instead of letting them sit out
                // their full timeout against a socket that is already gone.
                crate::sync_util::lock_recover(&pending).clear();
            });
        }

        let conn = Conn {
            out,
            pending,
            next_id: Arc::new(AtomicU32::new(1)),
            events,
            closed,
        };

        // Rule 1: nothing else can have gone out before this.
        let mut w = wire::Writer::new();
        w.int(PROTOCOL_MAJOR).int(PROTOCOL_MINOR);
        let reply = conn
            .request(
                protocol::CMD_SET_VM,
                protocol::CMD_VM_SET_PROTOCOL_VERSION,
                w.into_bytes(),
            )
            .await?;
        if !reply.is_ok() {
            return Err(ConnError::Handshake(format!(
                "agent rejected protocol {}.{} (error {})",
                PROTOCOL_MAJOR, PROTOCOL_MINOR, reply.error
            )));
        }
        Ok(conn)
    }

    /// Issue a command and wait for its reply, using the default timeout.
    pub async fn request(
        &self,
        command_set: u8,
        command: u8,
        body: Vec<u8>,
    ) -> Result<Reply, ConnError> {
        self.request_within(command_set, command, body, DEFAULT_REQUEST_TIMEOUT)
            .await
    }

    /// Issue a command with an explicit deadline.
    ///
    /// On timeout the pending entry is left in place on purpose: the reply is
    /// still coming, and the reader must be allowed to consume it. Closing the
    /// socket here is what crashes the agent.
    pub async fn request_within(
        &self,
        command_set: u8,
        command: u8,
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<Reply, ConnError> {
        if self.is_closed() {
            return Err(ConnError::Closed);
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        crate::sync_util::lock_recover(&self.pending).insert(id, tx);

        // The reader marks `closed` before it clears the table, so re-checking
        // here catches an insert that landed just after the clear — otherwise
        // that caller would wait out its whole timeout on a dead socket.
        if self.is_closed() {
            crate::sync_util::lock_recover(&self.pending).remove(&id);
            return Err(ConnError::Closed);
        }

        super::trace::append(
            "->",
            &format!(
                "[{}] set={} cmd={} {}B",
                id,
                command_set,
                command,
                body.len()
            ),
        );
        if self
            .out
            .send(wire::encode_command(id, command_set, command, &body))
            .is_err()
        {
            crate::sync_util::lock_recover(&self.pending).remove(&id);
            return Err(ConnError::Closed);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            // The reader dropped our sender: the connection ended.
            Ok(Err(_)) => Err(ConnError::Closed),
            // Rule 2: the pending entry is left in place on purpose so the
            // reader can absorb the late reply. Do not remove it, and above all
            // do not close the socket.
            Err(_) => Err(ConnError::Timeout {
                command_set,
                command,
            }),
        }
    }

    /// Subscribe to composite events pushed by the runtime.
    pub fn subscribe(&self) -> broadcast::Receiver<Composite> {
        self.events.subscribe()
    }

    /// True once the reader task has ended.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Send `VM_DISPOSE`, wait briefly for the acknowledgement, then close.
    ///
    /// The wait matters: disposing detaches the debugger and lets the runtime
    /// continue. Closing the socket without it is the abrupt disconnect that
    /// kills the process.
    pub async fn dispose(&self) {
        // Best effort: if the agent has already gone, there is nothing to
        // detach from and nothing to report.
        let _ = self
            .request_within(
                protocol::CMD_SET_VM,
                protocol::CMD_VM_DISPOSE,
                Vec::new(),
                Duration::from_secs(3),
            )
            .await;
        self.closed.store(true, Ordering::SeqCst);
        // The socket itself closes when the last clone of this `Conn` drops and
        // the writer task's channel ends. The dispose above is what makes that
        // drop safe.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debug::fake_agent::{vm_start_composite, FakeAgent};

    /// Rule 1. If anything reaches the agent before the version is agreed, the
    /// layouts in `protocol.rs` are not the ones in force.
    #[tokio::test]
    async fn connect_negotiates_the_protocol_version_before_anything_else() {
        let mut agent = FakeAgent::start().await;
        let addr = agent.addr;
        let connecting = tokio::spawn(async move { Conn::connect(addr).await });

        let (id, cs, c, body) = agent.next().await;
        assert_eq!(
            (cs, c),
            (protocol::CMD_SET_VM, protocol::CMD_VM_SET_PROTOCOL_VERSION),
            "the very first packet must be VM_SET_PROTOCOL_VERSION"
        );
        let mut r = wire::Reader::new(&body);
        assert_eq!(r.int().unwrap(), PROTOCOL_MAJOR);
        assert_eq!(r.int().unwrap(), PROTOCOL_MINOR);
        agent.reply(id, 0, Vec::new());

        connecting.await.unwrap().expect("connect should succeed");
    }

    #[tokio::test]
    async fn a_peer_that_answers_the_wrong_magic_is_rejected() {
        let agent = FakeAgent::start_with_handshake(b"NOT-A-DEBUGGER".to_vec()).await;
        assert!(!agent.handshake_reply.is_empty());
        match Conn::connect(agent.addr).await {
            Err(ConnError::Handshake(_)) => {}
            other => panic!("expected a handshake error, got {:?}", other.map(|_| ())),
        }
    }

    /// Rule 4, and the exact shape of the live capture: the runtime pushes a
    /// composite `VM_START` before any reply. A client that pairs by arrival
    /// order reads that event as its answer and is desynchronised from there on.
    #[tokio::test]
    async fn an_event_arriving_before_a_reply_is_not_mistaken_for_it() {
        let mut agent = FakeAgent::start().await;
        let addr = agent.addr;
        let connecting = tokio::spawn(async move { Conn::connect(addr).await });
        let (id, _, _, _) = agent.next().await;
        agent.event(vm_start_composite());
        agent.reply(id, 0, Vec::new());
        let conn = connecting.await.unwrap().expect("connect");

        let mut events = conn.subscribe();

        let request = {
            let conn = conn.clone();
            tokio::spawn(async move { conn.request(protocol::CMD_SET_VM, protocol::CMD_VM_VERSION, Vec::new()).await })
        };
        let (id, _, _, _) = agent.next().await;
        agent.event(vm_start_composite());
        agent.reply(id, 0, vec![0xAB]);

        let reply = request.await.unwrap().expect("reply");
        assert_eq!(reply.body, vec![0xAB], "the reply, not the event");

        let composite = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("timed out waiting for the event")
            .expect("event delivered separately");
        assert_eq!(composite.events[0].kind, protocol::EVENT_VM_START);
    }

    #[tokio::test]
    async fn replies_are_matched_by_id_even_when_they_arrive_out_of_order() {
        let mut agent = FakeAgent::start().await;
        let addr = agent.addr;
        let connecting = tokio::spawn(async move { Conn::connect(addr).await });
        let (id, _, _, _) = agent.next().await;
        agent.reply(id, 0, Vec::new());
        let conn = connecting.await.unwrap().unwrap();

        let a = {
            let c = conn.clone();
            tokio::spawn(async move { c.request(protocol::CMD_SET_VM, 1, Vec::new()).await })
        };
        let (id_a, _, _, _) = agent.next().await;
        let b = {
            let c = conn.clone();
            tokio::spawn(async move { c.request(protocol::CMD_SET_VM, 2, Vec::new()).await })
        };
        let (id_b, _, _, _) = agent.next().await;
        assert_ne!(id_a, id_b, "each request needs its own id");

        // Answer the second one first.
        agent.reply(id_b, 0, vec![0xBB]);
        agent.reply(id_a, 0, vec![0xAA]);

        assert_eq!(a.await.unwrap().unwrap().body, vec![0xAA]);
        assert_eq!(b.await.unwrap().unwrap().body, vec![0xBB]);
    }

    #[tokio::test]
    async fn an_agent_error_code_reaches_the_caller_rather_than_failing_the_call() {
        let mut agent = FakeAgent::start().await;
        let addr = agent.addr;
        let connecting = tokio::spawn(async move { Conn::connect(addr).await });
        let (id, _, _, _) = agent.next().await;
        agent.reply(id, 0, Vec::new());
        let conn = connecting.await.unwrap().unwrap();

        let req = {
            let c = conn.clone();
            tokio::spawn(async move { c.request(protocol::CMD_SET_TYPE, protocol::CMD_TYPE_GET_INFO, Vec::new()).await })
        };
        let (id, _, _, _) = agent.next().await;
        agent.reply(id, 2, Vec::new()); // ERR_INVALID_OBJECT

        let reply = req.await.unwrap().expect("a reply, not a transport error");
        assert!(!reply.is_ok());
        assert_eq!(reply.error, 2);
    }

    /// Rule 2, the one that cost a live Unity editor. A slow command must not
    /// take the connection with it.
    #[tokio::test]
    async fn a_timed_out_request_leaves_the_connection_usable() {
        let mut agent = FakeAgent::start().await;
        let addr = agent.addr;
        let connecting = tokio::spawn(async move { Conn::connect(addr).await });
        let (id, _, _, _) = agent.next().await;
        agent.reply(id, 0, Vec::new());
        let conn = connecting.await.unwrap().unwrap();

        // Never answered.
        let slow = conn
            .request_within(
                protocol::CMD_SET_VM,
                protocol::CMD_VM_GET_TYPES_FOR_SOURCE_FILE,
                Vec::new(),
                Duration::from_millis(60),
            )
            .await;
        let (late_id, _, _, _) = agent.next().await;
        assert!(matches!(slow, Err(ConnError::Timeout { .. })));
        assert!(!conn.is_closed(), "a timeout must not close the socket");

        // The late reply arrives and must be absorbed, not treated as the
        // answer to the next request.
        agent.reply(late_id, 0, vec![0x99]);

        let next = {
            let c = conn.clone();
            tokio::spawn(async move { c.request(protocol::CMD_SET_VM, protocol::CMD_VM_VERSION, Vec::new()).await })
        };
        let (id, _, _, _) = agent.next().await;
        agent.reply(id, 0, vec![0x11]);
        assert_eq!(
            next.await.unwrap().unwrap().body,
            vec![0x11],
            "the next request got the stale reply"
        );
    }

    /// Rule 3.
    #[tokio::test]
    async fn dispose_sends_vm_dispose_before_closing() {
        let mut agent = FakeAgent::start().await;
        let addr = agent.addr;
        let connecting = tokio::spawn(async move { Conn::connect(addr).await });
        let (id, _, _, _) = agent.next().await;
        agent.reply(id, 0, Vec::new());
        let conn = connecting.await.unwrap().unwrap();

        let disposing = {
            let c = conn.clone();
            tokio::spawn(async move { c.dispose().await })
        };
        let (id, cs, c, _) = agent.next().await;
        assert_eq!((cs, c), (protocol::CMD_SET_VM, protocol::CMD_VM_DISPOSE));
        agent.reply(id, 0, Vec::new());
        disposing.await.unwrap();
    }

    #[tokio::test]
    async fn a_request_after_the_agent_vanishes_fails_instead_of_hanging() {
        let mut agent = FakeAgent::start().await;
        let addr = agent.addr;
        let connecting = tokio::spawn(async move { Conn::connect(addr).await });
        let (id, _, _, _) = agent.next().await;
        agent.reply(id, 0, Vec::new());
        let conn = connecting.await.unwrap().unwrap();

        drop(agent); // the agent goes away, as a crashed editor would

        let result = conn
            .request_within(
                protocol::CMD_SET_VM,
                protocol::CMD_VM_VERSION,
                Vec::new(),
                Duration::from_secs(5),
            )
            .await;
        assert!(
            matches!(result, Err(ConnError::Closed)),
            "expected Closed, got {:?}",
            result.map(|_| ())
        );
    }
}
