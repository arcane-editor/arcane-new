// Framing.cs — wire framing for the Arcane bridge.
//
// FRAME = 4-byte BIG-ENDIAN (network order) uint32 length prefix + UTF-8 JSON body.
// Max body 16 MB. One JSON message per frame. This MUST match the Rust IDE side
// (src-tauri/src/unity_ipc.rs), which writes `len.to_be_bytes()` (big-endian)
// and reads `u32::from_be_bytes([b0,b1,b2,b3])`.
//
// Big-endian = most-significant byte first. We write the bytes explicitly as
// ((len>>24)&0xFF, (len>>16)&0xFF, (len>>8)&0xFF, len&0xFF) so the byte order is
// unambiguous regardless of host architecture (IPAddress.HostToNetworkOrder
// would also work, but the explicit form documents intent and avoids the
// signed-int round-trip).

using System;
using System.Collections.Generic;
using System.Text;

namespace Arcane.Bridge
{
    internal static class Framing
    {
        public const int HeaderSize = 4;
        public const uint MaxFrameSize = 16 * 1024 * 1024; // 16 MB, matches the IDE.

        /// <summary>
        /// Encode a UTF-8 JSON string into a length-prefixed frame ready to write
        /// to the socket. Throws if the encoded body exceeds <see cref="MaxFrameSize"/>.
        /// </summary>
        public static byte[] Encode(string json)
        {
            byte[] body = Encoding.UTF8.GetBytes(json ?? "");
            if ((uint)body.Length > MaxFrameSize)
                throw new InvalidOperationExceptionFrameTooLarge(body.Length);

            var frame = new byte[HeaderSize + body.Length];
            uint len = (uint)body.Length;
            // Big-endian: most-significant byte first.
            frame[0] = (byte)((len >> 24) & 0xFF);
            frame[1] = (byte)((len >> 16) & 0xFF);
            frame[2] = (byte)((len >> 8) & 0xFF);
            frame[3] = (byte)(len & 0xFF);
            Buffer.BlockCopy(body, 0, frame, HeaderSize, body.Length);
            return frame;
        }

        /// <summary>Read the big-endian length out of a 4-byte header.</summary>
        public static uint ReadLength(byte[] header, int offset)
        {
            return ((uint)header[offset] << 24)
                 | ((uint)header[offset + 1] << 16)
                 | ((uint)header[offset + 2] << 8)
                 | header[offset + 3];
        }

        // Small named exception so the friendly catch-site can match on it.
        internal sealed class InvalidOperationExceptionFrameTooLarge : Exception
        {
            public InvalidOperationExceptionFrameTooLarge(int size)
                : base($"Arcane bridge: outbound frame {size} bytes exceeds 16 MB cap") { }
        }
    }

    /// <summary>
    /// Streaming frame decoder. Feed it raw bytes as they arrive off the socket
    /// via <see cref="Append"/>, then drain every complete frame with
    /// <see cref="TryDequeue"/>. It accumulates partial frames across reads, so
    /// the caller never has to worry about TCP/stream-style fragmentation.
    ///
    /// Not thread-safe: the read loop owns a single instance on one thread.
    /// </summary>
    internal sealed class FrameReader
    {
        // Ring-ish accumulation buffer. We compact by tracking a read offset and
        // only physically removing consumed bytes when the offset grows large,
        // to avoid O(n^2) memmoves on a busy stream.
        private byte[] _buf = new byte[8192];
        private int _start; // first unconsumed byte
        private int _end;   // one past last valid byte

        public bool Overflowed { get; private set; }

        public void Append(byte[] data, int count)
        {
            EnsureCapacity(count);
            Buffer.BlockCopy(data, 0, _buf, _end, count);
            _end += count;
        }

        /// <summary>
        /// Yield the next complete frame body as a UTF-8 string, or null if no
        /// full frame is buffered yet. A frame whose declared length exceeds the
        /// 16 MB cap sets <see cref="Overflowed"/> and returns null; the caller
        /// should treat that as a protocol error and drop the connection.
        /// </summary>
        public string TryDequeue()
        {
            int avail = _end - _start;
            if (avail < Framing.HeaderSize) { CompactIfNeeded(); return null; }

            uint len = Framing.ReadLength(_buf, _start);
            if (len > Framing.MaxFrameSize)
            {
                Overflowed = true;
                return null;
            }

            int total = Framing.HeaderSize + (int)len;
            if (avail < total) { CompactIfNeeded(); return null; }

            string json = Encoding.UTF8.GetString(_buf, _start + Framing.HeaderSize, (int)len);
            _start += total;
            CompactIfNeeded();
            return json;
        }

        /// <summary>Drain all currently-complete frames in order.</summary>
        public IEnumerable<string> DrainAll()
        {
            while (true)
            {
                string f = TryDequeue();
                if (f == null) yield break;
                yield return f;
            }
        }

        private void EnsureCapacity(int incoming)
        {
            // Make room at the tail; first reclaim any consumed prefix.
            if (_start > 0 && _end - _start + incoming > _buf.Length)
                Compact();

            int needed = _end + incoming;
            if (needed <= _buf.Length) return;

            int newSize = _buf.Length * 2;
            while (newSize < needed) newSize *= 2;
            var bigger = new byte[newSize];
            Buffer.BlockCopy(_buf, _start, bigger, 0, _end - _start);
            _end -= _start;
            _start = 0;
            _buf = bigger;
        }

        private void CompactIfNeeded()
        {
            // Reclaim space once we've consumed a sizable prefix and there is no
            // tail data, or the prefix is more than half the buffer.
            if (_start == _end) { _start = _end = 0; return; }
            if (_start > 0 && _start >= _buf.Length / 2) Compact();
        }

        private void Compact()
        {
            int avail = _end - _start;
            if (avail > 0 && _start > 0)
                Buffer.BlockCopy(_buf, _start, _buf, 0, avail);
            _start = 0;
            _end = avail;
        }
    }
}
