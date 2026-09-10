//! A stand-in Mono debugger agent, over a real TCP socket.
//!
//! Test-only. It speaks the actual handshake and the actual framing, so tests
//! built on it exercise the real reader task, the real correlation table and
//! the real encoders — the only thing faked is the runtime behind them.
//!
//! Two usage styles:
//!
//! * `next()` — take one command at a time and answer it by hand, for tests
//!   about ordering and correlation.
//! * `respond_with()` — hand over a closure that answers everything, for tests
//!   about a multi-step exchange where the intermediate traffic is not the
//!   point.

use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::conn::HANDSHAKE;
use super::protocol;
use super::wire::{self, Header};

/// One command received from the client: `(id, command_set, command, body)`.
pub type Command = (u32, u8, u8, Vec<u8>);

pub struct FakeAgent {
    pub addr: SocketAddr,
    commands: Option<mpsc::UnboundedReceiver<Command>>,
    outbound: mpsc::UnboundedSender<Vec<u8>>,
    pub handshake_reply: Vec<u8>,
}

impl FakeAgent {
    pub async fn start() -> FakeAgent {
        FakeAgent::start_with_handshake(HANDSHAKE.to_vec()).await
    }

    pub async fn start_with_handshake(handshake_reply: Vec<u8>) -> FakeAgent {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (cmd_tx, commands) = mpsc::unbounded_channel();
        let (outbound, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let reply = handshake_reply.clone();

        tokio::spawn(async move {
            let (mut sock, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => return,
            };
            let mut magic = vec![0u8; HANDSHAKE.len()];
            if sock.read_exact(&mut magic).await.is_err() {
                return;
            }
            if sock.write_all(&reply).await.is_err() {
                return;
            }
            let (mut rd, mut wr) = sock.into_split();
            tokio::spawn(async move {
                while let Some(bytes) = out_rx.recv().await {
                    if wr.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            });
            loop {
                let mut header = [0u8; wire::HEADER_LEN];
                if rd.read_exact(&mut header).await.is_err() {
                    break;
                }
                let (id, cs, c, len) = match wire::decode_header(&header) {
                    Ok(Header::Command {
                        id,
                        command_set,
                        command,
                        body_len,
                    }) => (id, command_set, command, body_len),
                    _ => break,
                };
                let mut body = vec![0u8; len];
                if len > 0 && rd.read_exact(&mut body).await.is_err() {
                    break;
                }
                if cmd_tx.send((id, cs, c, body)).is_err() {
                    break;
                }
            }
        });

        FakeAgent {
            addr,
            commands: Some(commands),
            outbound,
            handshake_reply,
        }
    }

    /// The next command the client sends, with a deadline.
    ///
    /// Deliberately not a bare `recv().await`: if the client stalls, an
    /// un-deadlined receive hangs the whole test binary instead of failing,
    /// which is strictly worse than a red test.
    pub async fn next(&mut self) -> Command {
        let rx = self
            .commands
            .as_mut()
            .expect("commands were handed to respond_with");
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for a command from the client")
            .expect("client closed the connection")
    }

    /// Answer every command with `f`, which returns `(error_code, body)`, or
    /// `None` to deliberately never answer — the case that matters, because
    /// `VM_GET_TYPES_FOR_SOURCE_FILE` really does stall on a large project.
    ///
    /// `VM_SET_PROTOCOL_VERSION` is answered automatically so `Conn::connect`
    /// completes without every test having to spell it out.
    pub fn respond_with<F>(&mut self, f: F)
    where
        F: Fn(u8, u8, &[u8]) -> Option<(u16, Vec<u8>)> + Send + 'static,
    {
        let mut rx = self
            .commands
            .take()
            .expect("respond_with can only be installed once");
        let out = self.outbound.clone();
        tokio::spawn(async move {
            while let Some((id, cs, cmd, body)) = rx.recv().await {
                let answer =
                    if cs == protocol::CMD_SET_VM && cmd == protocol::CMD_VM_SET_PROTOCOL_VERSION {
                        Some((0, Vec::new()))
                    } else {
                        f(cs, cmd, &body)
                    };
                let Some((error, reply_body)) = answer else {
                    continue;
                };
                if out.send(encode_reply(id, error, &reply_body)).is_err() {
                    break;
                }
            }
        });
    }

    pub fn reply(&self, id: u32, error: u16, body: Vec<u8>) {
        let _ = self.outbound.send(encode_reply(id, error, &body));
    }

    /// Push an unsolicited event, as the runtime does on connect.
    pub fn event(&self, body: Vec<u8>) {
        let _ = self.outbound.send(wire::encode_command(
            0,
            protocol::CMD_SET_EVENT,
            protocol::CMD_COMPOSITE,
            &body,
        ));
    }
}

fn encode_reply(id: u32, error: u16, body: &[u8]) -> Vec<u8> {
    let length = wire::HEADER_LEN + body.len();
    let mut out = Vec::with_capacity(length);
    out.extend_from_slice(&(length as u32).to_be_bytes());
    out.extend_from_slice(&id.to_be_bytes());
    out.push(wire::FLAG_REPLY);
    out.extend_from_slice(&error.to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// Build a `METHOD_GET_DEBUG_INFO` reply body in the layout captured from
/// Mono 6.13.0: code size, file count, source path, a 16-byte source hash, then
/// six-int sequence points.
pub fn debug_info_body(source: &str, points: &[(i32, i32, i32)]) -> Vec<u8> {
    let mut w = wire::Writer::new();
    w.int(64).int(1).string(source);
    for _ in 0..16 {
        w.byte(0);
    }
    w.int(points.len() as i32);
    for (il, line, column) in points {
        w.int(*il).int(*line).int(0).int(*column).int(-1).int(-1);
    }
    w.into_bytes()
}

/// Build a reply body that is `count` followed by that many ids — the shape of
/// `TYPE_GET_METHODS` and `VM_GET_TYPES_FOR_SOURCE_FILE`.
pub fn id_list_body(ids: &[u32]) -> Vec<u8> {
    let mut w = wire::Writer::new();
    w.int(ids.len() as i32);
    for id in ids {
        w.id(*id);
    }
    w.into_bytes()
}

/// The composite `VM_START` a real agent pushes the instant a debugger connects.
pub fn vm_start_composite() -> Vec<u8> {
    let mut w = wire::Writer::new();
    w.byte(protocol::SUSPEND_NONE).int(1);
    w.byte(protocol::EVENT_VM_START).int(0).id(1).id(1);
    w.into_bytes()
}
