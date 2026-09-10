//! Mono Soft Debugger wire format: packet framing and primitive codecs.
//!
//! Every packet begins with an 11-byte header. The `length` field counts the
//! header itself, so a body is `length - 11` bytes:
//!
//! ```text
//! command:  length:u32  id:u32  flags:u8(0)     command_set:u8  command:u8
//! reply:    length:u32  id:u32  flags:u8(0x80)  error:u16
//! ```
//!
//! Replies are matched to requests by `id`. Packets arriving with `flags == 0`
//! are *not* replies — the runtime pushes events (command set `EVENT`) down the
//! same socket, unsolicited. Reading a Unity 6 editor immediately after the
//! handshake yields a composite `VM_START` event before any reply, so a client
//! that assumes "the first packet back is my answer" desynchronises on connect.
//!
//! Ids (objects, types, methods, assemblies, threads…) are 4 bytes, not 8 —
//! confirmed against a live Unity 6 editor, whose 18-byte `VM_START` body only
//! parses as `suspend_policy:u8, count:u32, kind:u8, request:u32, thread:id,
//! domain:id` when ids are 4 bytes wide.
//!
//! This module is pure: no I/O, no async, no protocol semantics. It is the one
//! place that knows byte order, so `conn.rs` can be about the socket and
//! `protocol.rs` about meaning.

use std::fmt;

/// Bytes in a packet header. The `length` field includes these.
pub const HEADER_LEN: usize = 11;

/// `flags` value marking a packet as a reply rather than a command/event.
pub const FLAG_REPLY: u8 = 0x80;

/// A decoded packet header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Header {
    /// A command from either direction. The runtime sends these for events.
    Command {
        id: u32,
        command_set: u8,
        command: u8,
        body_len: usize,
    },
    /// A reply to a command we sent. `error` is 0 on success.
    Reply {
        id: u32,
        error: u16,
        body_len: usize,
    },
}

/// A malformed or truncated packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// Ran off the end of a body while decoding.
    Truncated { need: usize, have: usize },
    /// A header claimed a length smaller than the header itself.
    ShortPacket(usize),
    /// A string field was not valid UTF-8.
    BadUtf8,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WireError::Truncated { need, have } => {
                write!(f, "truncated packet: needed {} bytes, had {}", need, have)
            }
            WireError::ShortPacket(len) => write!(
                f,
                "packet length {} is smaller than the {}-byte header",
                len, HEADER_LEN
            ),
            WireError::BadUtf8 => write!(f, "string field was not valid UTF-8"),
        }
    }
}

impl std::error::Error for WireError {}

/// Frame a command packet: header followed by `body`.
pub fn encode_command(id: u32, command_set: u8, command: u8, body: &[u8]) -> Vec<u8> {
    let length = HEADER_LEN + body.len();
    let mut out = Vec::with_capacity(length);
    out.extend_from_slice(&(length as u32).to_be_bytes());
    out.extend_from_slice(&id.to_be_bytes());
    out.push(0); // flags: a command, not a reply
    out.push(command_set);
    out.push(command);
    out.extend_from_slice(body);
    out
}

/// Decode an 11-byte header. Accepts a longer slice and ignores the remainder.
pub fn decode_header(bytes: &[u8]) -> Result<Header, WireError> {
    if bytes.len() < HEADER_LEN {
        return Err(WireError::Truncated {
            need: HEADER_LEN,
            have: bytes.len(),
        });
    }
    let length = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if length < HEADER_LEN {
        return Err(WireError::ShortPacket(length));
    }
    let id = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let body_len = length - HEADER_LEN;
    if bytes[8] == FLAG_REPLY {
        Ok(Header::Reply {
            id,
            error: u16::from_be_bytes([bytes[9], bytes[10]]),
            body_len,
        })
    } else {
        Ok(Header::Command {
            id,
            command_set: bytes[9],
            command: bytes[10],
            body_len,
        })
    }
}

/// Builds a packet body.
#[derive(Debug, Default, Clone)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn byte(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }

    pub fn int(&mut self, v: i32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn long(&mut self, v: i64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    /// An object/type/method/assembly/thread id. Four bytes.
    pub fn id(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    /// Append bytes that are already encoded, such as a value produced
    /// elsewhere and being written back into a frame.
    pub fn raw(&mut self, bytes: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(bytes);
        self
    }

    /// Length-prefixed UTF-8, no NUL terminator.
    pub fn string(&mut self, s: &str) -> &mut Self {
        let bytes = s.as_bytes();
        self.int(bytes.len() as i32);
        self.buf.extend_from_slice(bytes);
        self
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }
}

/// Reads a packet body.
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    /// Borrow the next `n` bytes, or fail without consuming anything.
    ///
    /// The bounds check happens before any allocation, so a corrupt length
    /// field cannot make this reserve an absurd buffer.
    fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        if self.remaining() < n {
            return Err(WireError::Truncated {
                need: n,
                have: self.remaining(),
            });
        }
        let slice = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    pub fn byte(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }

    pub fn int(&mut self) -> Result<i32, WireError> {
        let b = self.take(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn long(&mut self) -> Result<i64, WireError> {
        let b = self.take(8)?;
        Ok(i64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    pub fn id(&mut self) -> Result<u32, WireError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn string(&mut self) -> Result<String, WireError> {
        // A negative length widens to an enormous `usize`, which `take`
        // rejects as truncated rather than trying to allocate it.
        let len = self.int()? as usize;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| WireError::BadUtf8)
    }

    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_header_round_trips() {
        let packet = encode_command(42, 1, 1, &[]);
        assert_eq!(packet.len(), HEADER_LEN);
        assert_eq!(
            decode_header(&packet).unwrap(),
            Header::Command {
                id: 42,
                command_set: 1,
                command: 1,
                body_len: 0
            }
        );
    }

    #[test]
    fn command_header_counts_the_body_in_its_length() {
        let packet = encode_command(7, 23, 5, &[0xAA, 0xBB, 0xCC]);
        assert_eq!(packet.len(), HEADER_LEN + 3);
        assert_eq!(&packet[0..4], &[0, 0, 0, (HEADER_LEN + 3) as u8]);
        assert_eq!(&packet[HEADER_LEN..], &[0xAA, 0xBB, 0xCC]);
        match decode_header(&packet).unwrap() {
            Header::Command { body_len, .. } => assert_eq!(body_len, 3),
            other => panic!("expected a command, got {:?}", other),
        }
    }

    /// Captured from a live Unity 6000.0.24f1 editor: the composite `VM_START`
    /// the runtime pushes the instant a debugger connects, before any reply.
    /// A client that treats the first packet as its answer desynchronises here.
    #[test]
    fn unsolicited_unity_vm_start_decodes_as_a_command_not_a_reply() {
        let header = [
            0x00, 0x00, 0x00, 0x1d, 0x00, 0x00, 0x00, 0x02, 0x00, 0x40, 0x64,
        ];
        assert_eq!(
            decode_header(&header).unwrap(),
            Header::Command {
                id: 2,
                command_set: 64,
                command: 100,
                body_len: 18
            }
        );
    }

    /// Same capture, body half: ids must be 4 bytes wide or this does not fit.
    #[test]
    fn unity_vm_start_body_parses_with_four_byte_ids() {
        let body = [
            0x00, // suspend_policy = NONE
            0x00, 0x00, 0x00, 0x01, // one event
            0x00, // kind = VM_START
            0x00, 0x00, 0x00, 0x00, // request id 0 (unsolicited)
            0x00, 0x00, 0x00, 0x01, // thread id
            0x00, 0x00, 0x00, 0x01, // domain id
        ];
        let mut r = Reader::new(&body);
        assert_eq!(r.byte().unwrap(), 0);
        assert_eq!(r.int().unwrap(), 1);
        assert_eq!(r.byte().unwrap(), 0);
        assert_eq!(r.int().unwrap(), 0);
        assert_eq!(r.id().unwrap(), 1);
        assert_eq!(r.id().unwrap(), 1);
        assert!(r.is_empty(), "4-byte ids should consume the body exactly");
    }

    #[test]
    fn reply_header_carries_its_error_code() {
        let header = [
            0x00, 0x00, 0x00, 0x0d, 0x00, 0x00, 0x00, 0x2a, FLAG_REPLY, 0x00, 0x64,
        ];
        assert_eq!(
            decode_header(&header).unwrap(),
            Header::Reply {
                id: 42,
                error: 100,
                body_len: 2
            }
        );
    }

    /// Captured from the same editor: the reply body of `VM_VERSION`.
    #[test]
    fn unity_vm_version_reply_body_decodes() {
        let mut body = Vec::new();
        body.extend_from_slice(&[0x00, 0x00, 0x00, 0x26]);
        body.extend_from_slice("mono 6.13.0 (Visual Studio built mono)".as_bytes());
        body.extend_from_slice(&[0x00, 0x00, 0x00, 0x02]); // major
        body.extend_from_slice(&[0x00, 0x00, 0x00, 0x3a]); // minor
        assert_eq!(body.len(), 50);

        let mut r = Reader::new(&body);
        assert_eq!(r.string().unwrap(), "mono 6.13.0 (Visual Studio built mono)");
        assert_eq!(r.int().unwrap(), 2);
        assert_eq!(r.int().unwrap(), 58);
        assert!(r.is_empty());
    }

    #[test]
    fn writer_and_reader_round_trip_every_primitive() {
        let mut w = Writer::new();
        w.byte(0xFE)
            .int(-1234)
            .long(-9_000_000_000)
            .id(0xDEAD_BEEF)
            .string("Assets/Scripts/Player.cs");
        let bytes = w.into_bytes();

        let mut r = Reader::new(&bytes);
        assert_eq!(r.byte().unwrap(), 0xFE);
        assert_eq!(r.int().unwrap(), -1234);
        assert_eq!(r.long().unwrap(), -9_000_000_000);
        assert_eq!(r.id().unwrap(), 0xDEAD_BEEF);
        assert_eq!(r.string().unwrap(), "Assets/Scripts/Player.cs");
        assert!(r.is_empty());
    }

    #[test]
    fn strings_are_length_prefixed_utf8_without_a_terminator() {
        let mut w = Writer::new();
        w.string("hi");
        assert_eq!(w.into_bytes(), vec![0, 0, 0, 2, 0x68, 0x69]);
    }

    #[test]
    fn strings_survive_non_ascii_paths() {
        let mut w = Writer::new();
        w.string("Assets/Scènes/Ünity.cs");
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert_eq!(r.string().unwrap(), "Assets/Scènes/Ünity.cs");
    }

    /// A short read must be an error the session can report, never a panic:
    /// this decodes bytes straight off a socket, and the reader task must not
    /// unwind and drop the connection. Dropping a connection with a reply in
    /// flight is what crashed a live Unity editor's debugger thread.
    #[test]
    fn a_truncated_body_is_an_error_not_a_panic() {
        let mut r = Reader::new(&[0x00, 0x00]);
        assert_eq!(r.int(), Err(WireError::Truncated { need: 4, have: 2 }));
    }

    #[test]
    fn a_string_running_past_the_body_is_an_error() {
        // Claims 9 bytes, supplies 2.
        let mut r = Reader::new(&[0x00, 0x00, 0x00, 0x09, 0x68, 0x69]);
        assert_eq!(r.string(), Err(WireError::Truncated { need: 9, have: 2 }));
    }

    #[test]
    fn invalid_utf8_in_a_string_is_an_error() {
        let mut r = Reader::new(&[0x00, 0x00, 0x00, 0x02, 0xFF, 0xFE]);
        assert_eq!(r.string(), Err(WireError::BadUtf8));
    }

    #[test]
    fn a_header_shorter_than_the_header_is_rejected() {
        let header = [
            0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x01,
        ];
        assert_eq!(decode_header(&header), Err(WireError::ShortPacket(5)));
    }

    #[test]
    fn an_incomplete_header_is_rejected() {
        assert_eq!(
            decode_header(&[0x00, 0x00, 0x00]),
            Err(WireError::Truncated {
                need: HEADER_LEN,
                have: 3
            })
        );
    }
}
