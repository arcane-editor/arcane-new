// Journal.cs — append-only newline-delimited JSON transport primitives.
//
// One message per line, UTF-8, '\n'-terminated. Json.cs escapes \n, \r and every
// control char below 0x20, so a serialized envelope can never contain a raw
// newline — one message is always exactly one line. (ContractTests pins that.)
//
// SINGLE WRITER PER FILE is the invariant the whole design rests on: no
// cross-process locking exists anywhere. Unity owns to-ide.jsonl + to-unity.ack;
// the IDE owns to-unity.jsonl + to-ide.ack.
//
// Only System.IO is used, so this compiles at BOTH Unity API Compatibility
// Levels — which is the entire point of the journal transport. The socket
// transport it replaced needed UnixDomainSocketEndPoint, which does not exist on
// the .NET Framework profile and cannot be shimmed.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace UnityIDE.Bridge
{
    internal static class JournalLimits
    {
        public const int MaxLineBytes = 16 * 1024 * 1024;
        public const long RotateThresholdBytes = 4L * 1024 * 1024;
        public const int MaxReadPerPollBytes = 4 * 1024 * 1024;
        public const int AckIntervalMs = 500;

        /// <summary>
        /// Sidecar holding the journal's truncation epoch: "to-ide.jsonl" → "to-ide.epoch".
        ///
        /// A reader CANNOT detect truncation from file length alone. If the writer
        /// truncates and then rewrites to the same-or-greater length before the
        /// reader's next poll, `length &lt; offset` is false and the reader silently
        /// skips the new content — which is exactly what a session reset does
        /// (truncate, then immediately append a fat connection_init). The epoch is
        /// the length-independent signal that closes that hole. Written by the
        /// journal's single writer, so the one-writer-per-file invariant holds.
        /// </summary>
        public static string EpochPathFor(string journalPath)
        {
            return Path.ChangeExtension(journalPath, ".epoch");
        }

        /// <summary>Read an epoch sidecar. Absent or unreadable means "never truncated" (0).</summary>
        public static long ReadEpoch(string epochPath)
        {
            try
            {
                if (!File.Exists(epochPath)) return 0;
                long v;
                if (!long.TryParse(File.ReadAllText(epochPath).Trim(),
                                   NumberStyles.Integer, CultureInfo.InvariantCulture, out v))
                    return 0;
                return v;
            }
            catch { return 0; }
        }
    }

    /// <summary>
    /// Byte accumulator that yields complete '\n'-terminated lines. Splitting
    /// happens at the BYTE level: UTF-8 continuation bytes are always >= 0x80, so
    /// 0x0A can only ever be a real newline, and byte offsets stay aligned with
    /// the file positions the reader tracks. Splitting a decoded string instead
    /// would desynchronise offsets on any multi-byte character.
    ///
    /// Not thread-safe: one instance per reader, on one thread.
    /// </summary>
    internal sealed class LineBuffer
    {
        private byte[] _buf = new byte[8192];
        private int _start;
        private int _end;

        public int PendingBytes { get { return _end - _start; } }

        public void Clear() { _start = 0; _end = 0; }

        public void Append(byte[] data, int count)
        {
            EnsureCapacity(count);
            Buffer.BlockCopy(data, 0, _buf, _end, count);
            _end += count;
        }

        /// <summary>
        /// Drain every complete line into <paramref name="into"/>.
        /// Returns the number of BYTES consumed (including each '\n').
        /// </summary>
        public int DrainLines(List<string> into)
        {
            int consumed = 0;
            while (true)
            {
                int nl = -1;
                for (int i = _start; i < _end; i++)
                {
                    if (_buf[i] == (byte)'\n') { nl = i; break; }
                }
                if (nl < 0) break;

                int lineLen = nl - _start;
                if (lineLen > 0)
                {
                    // Tolerate a stray '\r' so a CRLF-mangled journal still parses.
                    int trimmed = _buf[nl - 1] == (byte)'\r' ? lineLen - 1 : lineLen;
                    if (trimmed > 0)
                        into.Add(Encoding.UTF8.GetString(_buf, _start, trimmed));
                }
                consumed += lineLen + 1;
                _start = nl + 1;
            }
            CompactIfNeeded();
            return consumed;
        }

        private void EnsureCapacity(int incoming)
        {
            if (_start > 0 && _end - _start + incoming > _buf.Length) Compact();
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
            if (_start == _end) { _start = 0; _end = 0; return; }
            if (_start > 0 && _start >= _buf.Length / 2) Compact();
        }

        private void Compact()
        {
            int avail = _end - _start;
            if (avail > 0 && _start > 0) Buffer.BlockCopy(_buf, _start, _buf, 0, avail);
            _start = 0;
            _end = avail;
        }
    }

    /// <summary>
    /// The append side of one journal. Owns the only write handle to its file.
    /// </summary>
    internal sealed class JournalWriter : IDisposable
    {
        private readonly string _journalPath;
        private readonly string _ackPath;
        private readonly string _epochPath;
        private FileStream _stream;
        private long _epoch;

        public JournalWriter(string journalPath, string ackPath)
        {
            _journalPath = journalPath;
            _ackPath = ackPath;
            _epochPath = JournalLimits.EpochPathFor(journalPath);
        }

        public long Length
        {
            get { try { return _stream != null ? _stream.Length : 0L; } catch { return 0L; } }
        }

        /// <summary>Truncation counter — bumped on every <see cref="Truncate"/>.</summary>
        public long Epoch { get { return _epoch; } }

        /// <summary>Create the directory + file and open the append handle.</summary>
        public bool Open()
        {
            try
            {
                string dir = Path.GetDirectoryName(_journalPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

                // FileShare.ReadWrite is MANDATORY — the peer process reads this
                // file concurrently and the default (FileShare.Read) makes its
                // reads fail with a sharing violation on Windows.
                //
                // FileMode.OpenOrCreate (not Append) because Append forbids
                // seeking, which would break SetLength(0) rotation.
                _stream = new FileStream(_journalPath, FileMode.OpenOrCreate, FileAccess.Write,
                                         FileShare.ReadWrite, 4096, FileOptions.None);
                _stream.Seek(0, SeekOrigin.End);

                // Resume the existing epoch rather than restarting at 0, so a
                // reader that outlived us (or a domain reload) never sees the
                // counter go backwards and mistake it for a fresh journal.
                _epoch = JournalLimits.ReadEpoch(_epochPath);
                return true;
            }
            catch (Exception)
            {
                _stream = null;
                return false;
            }
        }

        /// <summary>
        /// Empty the journal and bump the epoch so the reader detects the reset
        /// even when the rewritten content lands at the same byte length.
        ///
        /// Order matters: truncate FIRST, publish the epoch SECOND, and only then
        /// let the caller append. A reader that polls in between sees an empty
        /// file (length 0 &lt; its offset) and resets — the same outcome by the
        /// other route — so no interleaving loses data.
        /// </summary>
        public void Truncate()
        {
            if (_stream == null) return;
            try
            {
                _stream.SetLength(0);
                _stream.Seek(0, SeekOrigin.Begin);
                _stream.Flush();

                _epoch++;
                File.WriteAllText(_epochPath, _epoch.ToString(CultureInfo.InvariantCulture));
            }
            catch { /* next poll retries */ }
        }

        /// <returns>false when the line exceeds the cap — the caller warns and drops it.</returns>
        public bool Append(string json)
        {
            if (_stream == null || json == null) return false;
            byte[] body = Encoding.UTF8.GetBytes(json);
            if (body.Length + 1 > JournalLimits.MaxLineBytes) return false;
            try
            {
                _stream.Write(body, 0, body.Length);
                _stream.WriteByte((byte)'\n');
                return true;
            }
            catch { return false; }
        }

        /// <summary>
        /// Make bytes visible to the peer process. Never Flush(true) — that fsyncs,
        /// and durability is meaningless for a transport.
        /// </summary>
        public void Flush() { try { if (_stream != null) _stream.Flush(); } catch { } }

        /// <summary>
        /// Ack-gated rotation. Truncates only when the journal is over the
        /// threshold AND the reader has acked every byte — so nothing is ever in
        /// flight at the moment of truncation. A missing, unparseable, or stale
        /// ack just delays rotation; it can never lose data, which is why the ack
        /// file needs no atomic-write dance.
        /// </summary>
        public void MaybeRotate()
        {
            if (_stream == null) return;
            long size = Length;
            if (size <= JournalLimits.RotateThresholdBytes) return;
            if (ReadAck() != size) return;
            Truncate();
        }

        private long ReadAck()
        {
            try
            {
                if (!File.Exists(_ackPath)) return -1;
                string text = File.ReadAllText(_ackPath).Trim();
                long v;
                if (!long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out v))
                    return -1;
                return v;
            }
            catch { return -1; }
        }

        public void Dispose()
        {
            try { if (_stream != null) _stream.Dispose(); } catch { }
            _stream = null;
        }
    }

    /// <summary>
    /// The polling side of one journal. Tracks a byte position and publishes an
    /// ack so the peer (the journal's writer) knows when rotation is safe.
    /// </summary>
    internal sealed class JournalReader : IDisposable
    {
        private readonly string _journalPath;
        private readonly string _ackPath;
        private readonly string _epochPath;
        private readonly LineBuffer _buf = new LineBuffer();
        private FileStream _stream;
        private long _readPos;
        private long _epoch = -1; // -1 = not yet observed
        private long _lastAckValue = -1;
        private long _lastAckWrittenMs = -1;

        public JournalReader(string journalPath, string ackPath)
        {
            _journalPath = journalPath;
            _ackPath = ackPath;
            _epochPath = JournalLimits.EpochPathFor(journalPath);
        }

        /// <summary>The writer's truncation epoch as last observed. Persist alongside <see cref="AckOffset"/>.</summary>
        public long Epoch { get { return _epoch < 0 ? 0 : _epoch; } }

        /// <summary>Set on the poll where the universal reset rule fired.</summary>
        public bool DidReset { get; private set; }

        public long Length
        {
            get { try { return _stream != null ? _stream.Length : 0L; } catch { return 0L; } }
        }

        /// <summary>
        /// Bytes fully consumed AND dispatched — never includes a buffered partial
        /// line. This is what gets published to the ack file and persisted across
        /// domain reloads.
        /// </summary>
        public long AckOffset { get { return _readPos - _buf.PendingBytes; } }

        /// <summary>
        /// Open the peer's file. False (retry later) when it does not exist yet —
        /// a reader never creates the peer's file.
        /// </summary>
        public bool TryOpen()
        {
            if (_stream != null) return true;
            try
            {
                if (!File.Exists(_journalPath)) return false;

                // bufferSize 1 disables FileStream's internal read buffer. That is
                // REQUIRED, not a tuning choice: with buffering on, seeking back to
                // 0 after the writer truncates is served from the cached OLD bytes,
                // so a reset silently replays stale content. We do our own
                // buffering in LineBuffer and read in large chunks anyway, so the
                // FileStream buffer bought nothing and cost correctness.
                _stream = new FileStream(_journalPath, FileMode.Open, FileAccess.Read,
                                         FileShare.ReadWrite, 1, FileOptions.None);
                return true;
            }
            catch
            {
                _stream = null;
                return false;
            }
        }

        /// <summary>
        /// Skip everything already in the file — used on a cold start so messages
        /// addressed to a previous session are not replayed.
        /// </summary>
        public void SeekToEnd()
        {
            _readPos = Length;
            _buf.Clear();
            _epoch = JournalLimits.ReadEpoch(_epochPath);
        }

        /// <summary>
        /// Restore a persisted position after a domain reload. The epoch must be
        /// persisted with the offset: if the writer rotated while our AppDomain was
        /// being torn down, the saved offset belongs to a journal that no longer
        /// exists, and only the epoch reveals that. A mismatch restarts at 0.
        /// </summary>
        public void RestorePosition(long offset, long epoch)
        {
            _buf.Clear();
            long current = JournalLimits.ReadEpoch(_epochPath);
            if (current != epoch)
            {
                _readPos = 0;      // the journal was reset while we were away
                _epoch = current;
                return;
            }
            _readPos = offset < 0 ? 0 : offset;
            _epoch = current;
        }

        public List<string> Poll()
        {
            var lines = new List<string>();
            DidReset = false;
            if (_stream == null) return lines;

            long len;
            try { len = _stream.Length; } catch { return lines; }

            // Universal reset rule, part 1 — the AUTHORITATIVE check. The epoch
            // changes on every truncation regardless of what length the writer
            // rewrites to, which length comparison alone cannot detect.
            long epoch = JournalLimits.ReadEpoch(_epochPath);
            if (_epoch < 0)
            {
                _epoch = epoch;    // first poll: adopt, don't reset
            }
            else if (epoch != _epoch)
            {
                _epoch = epoch;
                _readPos = 0;
                _buf.Clear();
                DidReset = true;
            }

            // Part 2 — safety net for the window between the writer's SetLength(0)
            // and its epoch publish, where the file is simply short.
            if (len < _readPos)
            {
                _readPos = 0;
                _buf.Clear();
                DidReset = true;
            }
            if (len <= _readPos) return lines;

            long available = len - _readPos;
            int toRead = (int)Math.Min(available, JournalLimits.MaxReadPerPollBytes);
            var chunk = new byte[toRead];
            int got;
            try
            {
                _stream.Seek(_readPos, SeekOrigin.Begin);
                got = ReadFully(_stream, chunk, toRead);
            }
            catch { return lines; }
            if (got <= 0) return lines;

            _readPos += got;
            _buf.Append(chunk, got);
            _buf.DrainLines(lines);

            // Bound memory on a corrupt journal: a line that never terminates.
            if (_buf.PendingBytes > JournalLimits.MaxLineBytes)
            {
                _buf.Clear();
                _readPos = len;
            }
            return lines;
        }

        /// <summary>
        /// Publish the consumed offset — but ONLY while the journal exceeds the
        /// rotate threshold, so an ordinary session does zero ack I/O.
        /// </summary>
        public void PublishAckIfNeeded(long nowMs)
        {
            if (_stream == null) return;
            if (Length <= JournalLimits.RotateThresholdBytes) return;

            long ack = AckOffset;
            if (ack == _lastAckValue) return;
            if (_lastAckWrittenMs >= 0 && nowMs - _lastAckWrittenMs < JournalLimits.AckIntervalMs) return;

            try
            {
                File.WriteAllText(_ackPath, ack.ToString(CultureInfo.InvariantCulture));
                _lastAckValue = ack;
                _lastAckWrittenMs = nowMs;
            }
            catch { /* delayed rotation is the only consequence */ }
        }

        private static int ReadFully(Stream s, byte[] into, int count)
        {
            int total = 0;
            while (total < count)
            {
                int n = s.Read(into, total, count - total);
                if (n <= 0) break;
                total += n;
            }
            return total;
        }

        public void Dispose()
        {
            try { if (_stream != null) _stream.Dispose(); } catch { }
            _stream = null;
        }
    }
}
