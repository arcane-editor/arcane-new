# Unity Bridge Journal Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Unity bridge's Unix-domain-socket / named-pipe transport with a pair of append-only newline-delimited JSON journal files, so the bridge works at any Unity API Compatibility Level with zero project configuration.

**Architecture:** Two journal files under `<projectRoot>/Library/ArcaneIDE/` — `to-ide.jsonl` (Unity appends, IDE reads) and `to-unity.jsonl` (IDE appends, Unity reads). Every file has exactly one writer, so no cross-process locking exists anywhere. Readers poll file size with `fstat` and track a byte offset. Rotation is gated on a `.ack` file the reader publishes only once its journal exceeds 4 MiB.

**Tech Stack:** C# targeting .NET Standard 2.0 (`System.IO` only) in `arcane-extension/`; Rust + tokio in `editor/src-tauri/`. No new dependencies on either side.

**Spec:** `docs/superpowers/specs/2026-08-09-unity-bridge-journal-transport-design.md`

## Global Constraints

- **C# must compile at BOTH Unity API Compatibility Levels.** Use only .NET Standard 2.0 APIs. No `Span<T>`, no `System.Text.Json`, no `UnixDomainSocketEndPoint`, no C# 8+ language features (Unity 2021.3 supports C# 9 but the existing package writes C# 7-era code — match it).
- **Every `FileStream` in C# must pass `FileShare.ReadWrite` explicitly.** The default (`FileShare.Read` on a writer) makes the peer process's concurrent reads fail with a sharing violation on Windows. This is the single most likely source of a Windows-only bug in this change.
- **Never open a writer with `FileMode.Append`.** Append mode forbids seeking, which breaks `SetLength(0)` rotation. Use `FileMode.OpenOrCreate` + `Seek(0, SeekOrigin.End)`.
- **Split lines at the BYTE level on `0x0A`, never after decoding to a string.** Byte offsets and char offsets diverge under multi-byte UTF-8. Byte-level splitting is safe because UTF-8 continuation bytes are always `>= 0x80`, so `0x0A` can only ever be a real newline.
- **Writer flushes with `Flush()`, never `Flush(true)`.** `Flush()` makes bytes visible to other processes, which is all a transport needs; `Flush(true)` fsyncs and is pointlessly slow.
- Constants (identical on both sides): `POLL_ACTIVE_MS=25`, `POLL_IDLE_MS=250`, `IDLE_AFTER_MS=3000`, `HEARTBEAT_MS=2000`, `PEER_DEAD_MS=8000`, `ROTATE_THRESHOLD=4 MiB`, `MAX_LINE_BYTES=16 MiB`, `MAX_READ_PER_POLL=4 MiB`, `ACK_INTERVAL_MS=500`, `DISCOVERY_POLL_MS=1000`.
- **Protocol version 1 → 2** in both `Discovery.ProtocolVersion` (C#) and `PROTOCOL_VERSION` (Rust).
- Never throw out of `InitializeOnLoad`, the `EditorApplication.update` pump, or a tokio task.
- Commit to `heads/v0.3.0`. Never commit directly on `dev`.

---

## File Structure

| File | Responsibility |
|---|---|
| `arcane-extension/Editor/Journal.cs` | **New.** `LineBuffer`, `JournalWriter`, `JournalReader`. Pure `System.IO`, no Unity API → unit-testable. |
| `arcane-extension/Editor/Discovery.cs` | **Rewrite.** Parse `bridge.json`; own the `Library/ArcaneIDE/` path layout. |
| `arcane-extension/Editor/BridgeClient.cs` | **Rewrite transport.** Journal poll loop replaces the socket connect/read loop. |
| `arcane-extension/Editor/Protocol.cs` | Add `Disconnect` message type. |
| `arcane-extension/Editor/BridgeBootstrap.cs` | Session-id minting + `SessionState` offset persistence. |
| `arcane-extension/Editor/Framing.cs` | **Delete** (+ `.meta`). |
| `arcane-extension/Tests/Editor/` | **New.** EditMode test assembly, excluded from the shipped `.tgz`. |
| `editor/src-tauri/src/unity_journal.rs` | **New.** Rust mirror of `Journal.cs`. |
| `editor/src-tauri/src/unity_ipc.rs` | **Rewrite transport.** Delete both socket paths; add the journal session task. |
| `editor/src/stores/unity.ts` | Consume the new `unity-package-stale` event. |

---

## Task 1: C# journal primitives + test assembly

**Files:**
- Create: `arcane-extension/Editor/Journal.cs`
- Create: `arcane-extension/Tests/Editor/Arcane.Editor.Tests.asmdef`
- Create: `arcane-extension/Tests/Editor/JournalTests.cs`
- Modify: `editor/scripts/sync-unity-bridge.mjs:35-43` (`DENY_NAMES`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `JournalLimits.MaxLineBytes` (int), `.RotateThresholdBytes` (long), `.MaxReadPerPollBytes` (int), `.AckIntervalMs` (int)
  - `LineBuffer`: `int PendingBytes`, `void Clear()`, `void Append(byte[] data, int count)`, `int DrainLines(List<string> into)`
  - `JournalWriter(string journalPath, string ackPath)`: `bool Open()`, `long Length`, `void Truncate()`, `bool Append(string json)`, `void Flush()`, `void MaybeRotate()`, `void Dispose()`
  - `JournalReader(string journalPath, string ackPath)`: `bool TryOpen()`, `long Length`, `long AckOffset`, `bool DidReset`, `void SeekToEnd()`, `void RestorePosition(long offset)`, `List<string> Poll()`, `void PublishAckIfNeeded(long nowMs)`, `void Dispose()`

- [ ] **Step 1: Create the test assembly definition**

Create `arcane-extension/Tests/Editor/Arcane.Editor.Tests.asmdef`:

```json
{
    "name": "Arcane.Editor.Tests",
    "rootNamespace": "Arcane.Tests",
    "references": ["Arcane.Editor", "UnityEditor.TestRunner", "UnityEngine.TestRunner"],
    "includePlatforms": ["Editor"],
    "excludePlatforms": [],
    "allowUnsafeCode": false,
    "overrideReferences": true,
    "precompiledReferences": ["nunit.framework.dll"],
    "autoReferenced": false,
    "defineConstraints": ["UNITY_INCLUDE_TESTS"],
    "versionDefines": [],
    "noEngineReferences": false
}
```

`defineConstraints: ["UNITY_INCLUDE_TESTS"]` keeps this assembly out of normal compilation for consumers; `autoReferenced: false` keeps it off everyone else's reference graph.

- [ ] **Step 2: Exclude tests from the shipped package**

In `editor/scripts/sync-unity-bridge.mjs`, add `'Tests'` to `DENY_NAMES`:

```js
const DENY_NAMES = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '.wrangler',
  'Documentation~',
  'Tests',
  'deploy-prod.sh',
  'install-dev.sh',
]);
```

- [ ] **Step 3: Write the failing tests**

Create `arcane-extension/Tests/Editor/JournalTests.cs`:

```csharp
using System.Collections.Generic;
using System.IO;
using System.Text;
using Arcane.Bridge;
using NUnit.Framework;

namespace Arcane.Tests
{
    public class JournalTests
    {
        private string _dir;
        private string _journal;
        private string _ack;

        [SetUp]
        public void SetUp()
        {
            _dir = Path.Combine(Path.GetTempPath(), "arcane-journal-" + Path.GetRandomFileName());
            Directory.CreateDirectory(_dir);
            _journal = Path.Combine(_dir, "to-ide.jsonl");
            _ack = Path.Combine(_dir, "to-ide.ack");
        }

        [TearDown]
        public void TearDown()
        {
            try { Directory.Delete(_dir, true); } catch { }
        }

        [Test]
        public void RoundTripsLinesInOrder()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"a\":1}");
                w.Append("{\"a\":2}");
                w.Flush();

                Assert.IsTrue(r.TryOpen());
                List<string> lines = r.Poll();
                Assert.AreEqual(new[] { "{\"a\":1}", "{\"a\":2}" }, lines.ToArray());
            }
        }

        [Test]
        public void DoesNotDispatchAPartialLineUntilItsNewlineArrives()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                Assert.IsTrue(r.TryOpen());

                // Raw half-line, no newline yet.
                byte[] half = Encoding.UTF8.GetBytes("{\"a\":");
                using (var raw = new FileStream(_journal, FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
                {
                    raw.Seek(0, SeekOrigin.End);
                    raw.Write(half, 0, half.Length);
                }
                Assert.AreEqual(0, r.Poll().Count, "a partial line must not be dispatched");

                using (var raw = new FileStream(_journal, FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
                {
                    raw.Seek(0, SeekOrigin.End);
                    byte[] rest = Encoding.UTF8.GetBytes("1}\n");
                    raw.Write(rest, 0, rest.Length);
                }
                List<string> lines = r.Poll();
                Assert.AreEqual(1, lines.Count);
                Assert.AreEqual("{\"a\":1}", lines[0]);
            }
        }

        [Test]
        public void AdvancesOffsetByBytesNotCharsForMultiByteUtf8()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"m\":\"日本語\"}");
                w.Append("{\"m\":\"ok\"}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());

                List<string> lines = r.Poll();
                Assert.AreEqual(2, lines.Count);
                Assert.AreEqual("{\"m\":\"ok\"}", lines[1]);
                Assert.AreEqual(w.Length, r.AckOffset, "offset must track bytes, not chars");
            }
        }

        [Test]
        public void ResetsToZeroWhenTheFileShrinks()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"a\":1}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());
                Assert.AreEqual(1, r.Poll().Count);

                w.Truncate();
                w.Append("{\"b\":2}");
                w.Flush();

                List<string> lines = r.Poll();
                Assert.IsTrue(r.DidReset, "shrink must trigger the universal reset rule");
                Assert.AreEqual(1, lines.Count);
                Assert.AreEqual("{\"b\":2}", lines[0]);
            }
        }

        [Test]
        public void RefusesALineOverTheCap()
        {
            using (var w = new JournalWriter(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                Assert.IsFalse(w.Append(new string('x', JournalLimits.MaxLineBytes + 1)));
                Assert.AreEqual(0, w.Length, "an oversized line must not be partially written");
            }
        }

        [Test]
        public void SkipsRotationWhenTheAckFileIsMissingUnparseableOrStale()
        {
            using (var w = new JournalWriter(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                string line = new string('x', 64 * 1024);
                while (w.Length <= JournalLimits.RotateThresholdBytes) w.Append(line);
                w.Flush();
                long grown = w.Length;

                w.MaybeRotate();                       // ack missing
                Assert.AreEqual(grown, w.Length);

                File.WriteAllText(_ack, "not-a-number");
                w.MaybeRotate();                       // ack unparseable
                Assert.AreEqual(grown, w.Length);

                File.WriteAllText(_ack, (grown + 999).ToString());
                w.MaybeRotate();                       // ack stale (> size)
                Assert.AreEqual(grown, w.Length);

                File.WriteAllText(_ack, grown.ToString());
                w.MaybeRotate();                       // ack caught up
                Assert.AreEqual(0, w.Length);
            }
        }

        [Test]
        public void PublishesNoAckBelowTheRotateThreshold()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"a\":1}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());
                r.Poll();
                r.PublishAckIfNeeded(1000);
                Assert.IsFalse(File.Exists(_ack), "a small journal must do zero ack I/O");
            }
        }

        [Test]
        public void SeekToEndSkipsStaleMessages()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"stale\":1}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());
                r.SeekToEnd();
                Assert.AreEqual(0, r.Poll().Count);

                w.Append("{\"fresh\":1}");
                w.Flush();
                List<string> lines = r.Poll();
                Assert.AreEqual(1, lines.Count);
                Assert.AreEqual("{\"fresh\":1}", lines[0]);
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Open the project in Unity → `Window → General → Test Runner → EditMode → Run All`, or headless:

```bash
/Applications/Unity/Hub/Editor/2021.3.*/Unity.app/Contents/MacOS/Unity \
  -batchmode -runTests -testPlatform EditMode -projectPath <a Unity project with the package> \
  -testResults /tmp/results.xml -logFile -
```

Expected: compile error — `JournalWriter`/`JournalReader`/`JournalLimits` do not exist.

- [ ] **Step 5: Implement `Journal.cs`**

Create `arcane-extension/Editor/Journal.cs`:

```csharp
// Journal.cs — append-only newline-delimited JSON transport primitives.
//
// One message per line, UTF-8, '\n'-terminated. Json.cs escapes \n, \r and every
// control char below 0x20, so a serialized envelope can never contain a raw
// newline — one message is always exactly one line.
//
// SINGLE WRITER PER FILE is the invariant the whole design rests on: no
// cross-process locking exists anywhere. Unity owns to-ide.jsonl + to-unity.ack;
// the IDE owns to-unity.jsonl + to-ide.ack.
//
// Only System.IO is used, so this compiles at BOTH Unity API Compatibility
// Levels — which is the entire point of the journal transport.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Arcane.Bridge
{
    internal static class JournalLimits
    {
        public const int MaxLineBytes = 16 * 1024 * 1024;
        public const long RotateThresholdBytes = 4L * 1024 * 1024;
        public const int MaxReadPerPollBytes = 4 * 1024 * 1024;
        public const int AckIntervalMs = 500;
    }

    /// <summary>
    /// Byte accumulator that yields complete '\n'-terminated lines. Splitting
    /// happens at the BYTE level: UTF-8 continuation bytes are always >= 0x80, so
    /// 0x0A can only ever be a real newline, and byte offsets stay aligned with
    /// the file positions the reader tracks.
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
        private FileStream _stream;

        public JournalWriter(string journalPath, string ackPath)
        {
            _journalPath = journalPath;
            _ackPath = ackPath;
        }

        public long Length
        {
            get { try { return _stream != null ? _stream.Length : 0L; } catch { return 0L; } }
        }

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
                return true;
            }
            catch (Exception)
            {
                _stream = null;
                return false;
            }
        }

        public void Truncate()
        {
            if (_stream == null) return;
            try
            {
                _stream.SetLength(0);
                _stream.Seek(0, SeekOrigin.Begin);
                _stream.Flush();
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

        /// <summary>Make bytes visible to the peer. Never Flush(true) — fsync is pointless here.</summary>
        public void Flush() { try { if (_stream != null) _stream.Flush(); } catch { } }

        /// <summary>
        /// Ack-gated rotation. Truncates only when the journal is over the
        /// threshold AND the reader has acked every byte — so nothing is ever in
        /// flight at the moment of truncation. A missing, unparseable, or stale
        /// ack just delays rotation; it can never lose data.
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
        private readonly LineBuffer _buf = new LineBuffer();
        private FileStream _stream;
        private long _readPos;
        private long _lastAckValue = -1;
        private long _lastAckWrittenMs = -1;

        public JournalReader(string journalPath, string ackPath)
        {
            _journalPath = journalPath;
            _ackPath = ackPath;
        }

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

        /// <summary>Open the peer's file. False (retry later) when it doesn't exist yet — a reader never creates it.</summary>
        public bool TryOpen()
        {
            if (_stream != null) return true;
            try
            {
                if (!File.Exists(_journalPath)) return false;
                _stream = new FileStream(_journalPath, FileMode.Open, FileAccess.Read,
                                         FileShare.ReadWrite, 4096, FileOptions.None);
                return true;
            }
            catch
            {
                _stream = null;
                return false;
            }
        }

        /// <summary>Skip everything already in the file — used on a cold start so messages addressed to a previous session aren't replayed.</summary>
        public void SeekToEnd()
        {
            _readPos = Length;
            _buf.Clear();
        }

        /// <summary>Restore a persisted <see cref="AckOffset"/> after a domain reload.</summary>
        public void RestorePosition(long offset)
        {
            _readPos = offset < 0 ? 0 : offset;
            _buf.Clear();
        }

        public List<string> Poll()
        {
            var lines = new List<string>();
            DidReset = false;
            if (_stream == null) return lines;

            long len;
            try { len = _stream.Length; } catch { return lines; }

            // Universal reset rule: a shrink means the peer truncated (rotation or
            // a session reset). Neither reason needs distinguishing.
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Re-run the EditMode suite. Expected: all 8 `JournalTests` pass.

- [ ] **Step 7: Commit**

```bash
git add arcane-extension/Editor/Journal.cs arcane-extension/Tests editor/scripts/sync-unity-bridge.mjs
git commit -m "feat(bridge): add append-only journal primitives and a C# test assembly"
```

---

## Task 2: C# discovery rewrite

**Files:**
- Modify: `arcane-extension/Editor/Discovery.cs` (full rewrite)
- Create: `arcane-extension/Tests/Editor/DiscoveryTests.cs`

**Interfaces:**
- Consumes: `JsonValue.TryParse` (existing, `Json.cs`).
- Produces:
  - `Discovery.ProtocolVersion` = `2`
  - `Discovery.ProjectRoot(string applicationDataPath)` → `string` (unchanged behaviour)
  - `Discovery.BridgeDir(string projectRoot)`, `.BridgeJsonPath()`, `.ToIdeJournalPath()`, `.ToIdeAckPath()`, `.ToUnityJournalPath()`, `.ToUnityAckPath()` — all `(string projectRoot) → string`
  - `struct BridgeDiscovery { string IdeSessionId; int ProtocolVersion; string IdeVersion; int IdePid; }`
  - `bool Discovery.TryResolve(string projectRoot, out BridgeDiscovery result)` — **no fallback**; false when `bridge.json` is absent or malformed.

- [ ] **Step 1: Write the failing tests**

Create `arcane-extension/Tests/Editor/DiscoveryTests.cs`:

```csharp
using System.IO;
using Arcane.Bridge;
using NUnit.Framework;

namespace Arcane.Tests
{
    public class DiscoveryTests
    {
        private string _root;

        [SetUp]
        public void SetUp()
        {
            _root = Path.Combine(Path.GetTempPath(), "arcane-disc-" + Path.GetRandomFileName());
            Directory.CreateDirectory(Path.Combine(_root, "Library", "ArcaneIDE"));
        }

        [TearDown]
        public void TearDown()
        {
            try { Directory.Delete(_root, true); } catch { }
        }

        private void WriteBridgeJson(string contents)
        {
            File.WriteAllText(Discovery.BridgeJsonPath(_root), contents);
        }

        [Test]
        public void ResolvesAWellFormedBridgeJson()
        {
            WriteBridgeJson("{\"transport\":\"journal\",\"protocolVersion\":2," +
                            "\"ideSessionId\":\"abc123\",\"ideVersion\":\"0.3.0\",\"idePid\":4242}");

            BridgeDiscovery d;
            Assert.IsTrue(Discovery.TryResolve(_root, out d));
            Assert.AreEqual("abc123", d.IdeSessionId);
            Assert.AreEqual(2, d.ProtocolVersion);
            Assert.AreEqual("0.3.0", d.IdeVersion);
            Assert.AreEqual(4242, d.IdePid);
        }

        [Test]
        public void FailsWhenBridgeJsonIsAbsent()
        {
            BridgeDiscovery d;
            Assert.IsFalse(Discovery.TryResolve(_root, out d),
                "no bridge.json means no IDE — there is no computed fallback any more");
        }

        [Test]
        public void FailsOnMalformedOrSessionlessJson()
        {
            WriteBridgeJson("{ not json");
            BridgeDiscovery d;
            Assert.IsFalse(Discovery.TryResolve(_root, out d));

            WriteBridgeJson("{\"transport\":\"journal\",\"protocolVersion\":2}");
            Assert.IsFalse(Discovery.TryResolve(_root, out d),
                "a bridge.json with no ideSessionId cannot be handshaked against");
        }

        [Test]
        public void JournalPathsLiveUnderLibraryArcaneIde()
        {
            string dir = Path.Combine(_root, "Library", "ArcaneIDE");
            Assert.AreEqual(Path.Combine(dir, "to-ide.jsonl"), Discovery.ToIdeJournalPath(_root));
            Assert.AreEqual(Path.Combine(dir, "to-ide.ack"), Discovery.ToIdeAckPath(_root));
            Assert.AreEqual(Path.Combine(dir, "to-unity.jsonl"), Discovery.ToUnityJournalPath(_root));
            Assert.AreEqual(Path.Combine(dir, "to-unity.ack"), Discovery.ToUnityAckPath(_root));
        }

        [Test]
        public void ProjectRootIsTheParentOfAssets()
        {
            string dataPath = Path.Combine(_root, "Assets");
            Assert.AreEqual(_root, Discovery.ProjectRoot(dataPath));
        }
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Expected: compile errors — `BridgeDiscovery.IdeSessionId`, `Discovery.BridgeDir`, `Discovery.ToIdeJournalPath` etc. don't exist.

- [ ] **Step 3: Rewrite `Discovery.cs`**

Replace the entire contents of `arcane-extension/Editor/Discovery.cs`:

```csharp
// Discovery.cs — locate the IDE's journal directory and read its session identity.
//
// <projectRoot>/Library/ArcaneIDE/bridge.json is written by the IDE when it opens
// the project:
//   { "transport":"journal", "protocolVersion":2, "ideSessionId":"…",
//     "ideVersion":"x.y.z", "idePid":12345 }
//
// There is NO computed fallback. The socket transport needed one because it had a
// path to guess; a journal has nothing to derive — the files live at a fixed
// location relative to the project. That also retires the sha1(projectRoot)
// fallback whose symlink mismatch (Rust canonicalize resolves symlinks, .NET
// Path.GetFullPath does not) was a real source of silent non-connection.
//
// projectRoot is the folder ABOVE Assets/. Unity's Application.dataPath is
// "<projectRoot>/Assets", so projectRoot = Directory.GetParent(dataPath).

using System.IO;

namespace Arcane.Bridge
{
    internal struct BridgeDiscovery
    {
        /// <summary>Fresh per IDE workspace-open. A change means "new IDE session — re-handshake".</summary>
        public string IdeSessionId;
        public int ProtocolVersion;
        public string IdeVersion;
        public int IdePid;
    }

    internal static class Discovery
    {
        /// <summary>Bridge wire-protocol major version. 2 = journal transport.</summary>
        public const int ProtocolVersion = 2;

        /// <summary>projectRoot = parent of Application.dataPath ("…/Assets").</summary>
        public static string ProjectRoot(string applicationDataPath)
        {
            var parent = Directory.GetParent(applicationDataPath.TrimEnd('/', '\\'));
            return parent != null ? parent.FullName : applicationDataPath;
        }

        public static string BridgeDir(string projectRoot)
        {
            return Path.Combine(Path.Combine(projectRoot, "Library"), "ArcaneIDE");
        }

        public static string BridgeJsonPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "bridge.json");
        }

        // Unity writes to-ide.jsonl and reads to-unity.jsonl. Unity owns the
        // to-unity.ack (it is that journal's reader); the IDE owns to-ide.ack.
        public static string ToIdeJournalPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "to-ide.jsonl");
        }

        public static string ToIdeAckPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "to-ide.ack");
        }

        public static string ToUnityJournalPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "to-unity.jsonl");
        }

        public static string ToUnityAckPath(string projectRoot)
        {
            return Path.Combine(BridgeDir(projectRoot), "to-unity.ack");
        }

        /// <summary>
        /// Read bridge.json. False when it is absent (no IDE has the project open),
        /// unreadable, or carries no ideSessionId (nothing to handshake against).
        /// Never throws.
        /// </summary>
        public static bool TryResolve(string projectRoot, out BridgeDiscovery result)
        {
            result = default(BridgeDiscovery);
            try
            {
                string file = BridgeJsonPath(projectRoot);
                if (!File.Exists(file)) return false;

                JsonValue json = JsonValue.TryParse(File.ReadAllText(file));
                if (json == null || !json.IsObject) return false;

                string sessionId = json["ideSessionId"].AsString;
                if (string.IsNullOrEmpty(sessionId)) return false;

                result = new BridgeDiscovery
                {
                    IdeSessionId = sessionId,
                    ProtocolVersion = json["protocolVersion"].IsNumber
                        ? json["protocolVersion"].AsInt : ProtocolVersion,
                    IdeVersion = json["ideVersion"].AsStringOr(""),
                    IdePid = json["idePid"].AsInt,
                };
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
```

- [ ] **Step 4: Run to verify they pass**

Expected: all 5 `DiscoveryTests` pass, all 8 `JournalTests` still pass.

- [ ] **Step 5: Commit**

```bash
git add arcane-extension/Editor/Discovery.cs arcane-extension/Tests/Editor/DiscoveryTests.cs
git commit -m "feat(bridge): point discovery at the journal directory, drop the sha1 fallback"
```

---

## Task 3: C# BridgeClient transport swap

**Files:**
- Modify: `arcane-extension/Editor/BridgeClient.cs` (rewrite the transport half)
- Modify: `arcane-extension/Editor/Protocol.cs:19` (add `Disconnect`)
- Modify: `arcane-extension/Editor/BridgeBootstrap.cs:120-134,175-188`
- Delete: `arcane-extension/Editor/Framing.cs`, `arcane-extension/Editor/Framing.cs.meta`

**Interfaces:**
- Consumes: everything Produced by Tasks 1 and 2.
- Produces:
  - `MsgType.Disconnect` = `"disconnect"`
  - `BridgeClient(string projectRoot, Func<JsonValue> connectionInitPayloadFactory)` — **constructor signature unchanged**, so no hook or handler call site changes.
  - `BridgeClient.Send(JsonValue)`, `.Start()`, `.Stop()`, `.IsConnected`, `.ConnectionStateChanged` — **all unchanged**, so `ConsoleHook`, `PlayStateHook`, `CompilationHook`, `PlayModeStatsHook`, and all four handler groups compile untouched.

- [ ] **Step 1: Add the `Disconnect` message type**

In `arcane-extension/Editor/Protocol.cs`, after line 19 (`Heartbeat`):

```csharp
        public const string Disconnect = "disconnect";
```

- [ ] **Step 2: Replace the transport in `BridgeClient.cs`**

Keep the class name, the public surface, `_outbox`/`_sendLock`/`_sendSignal`, `HandleInbound`, `SetConnected`, and `SleepInterruptible` exactly as they are. Replace the header comment, the constants, and every socket-touching member.

Replace the header comment block (lines 1-18) with:

```csharp
// BridgeClient.cs — the journal transport. Owns the background worker thread that
// waits for bridge.json, handshakes, then runs a single poll loop: drain the
// outbox into to-ide.jsonl, read new lines out of to-unity.jsonl, heartbeat.
//
// THREADING MODEL
//   * One background "worker" thread per BridgeClient lifetime. It does all file
//     I/O. Public Send(JsonValue) is thread-safe; callers are usually Unity hooks
//     on the main thread. Messages enqueue and the worker flushes them.
//   * Inbound lines are decoded on the worker thread, then dispatched: control
//     messages (playmode, step) and RPCs marshal Unity work via the
//     MainThreadDispatcher. We never touch Unity APIs on the worker thread.
//
// TRANSPORT
//   Two append-only newline-delimited JSON files under Library/ArcaneIDE/. Only
//   System.IO is involved, so this works at EVERY Unity API Compatibility Level —
//   unlike UnixDomainSocketEndPoint, which does not exist on the .NET Framework
//   profile and cannot be shimmed.
//
// SESSION MODEL
//   There is no socket, so "connected" is defined by session ids. bridge.json
//   carries the IDE's; connection_init echoes it back alongside Unity's own. A
//   domain reload restores both ids plus the read offset from SessionState and
//   resumes mid-stream — no reconnect, no disconnect flicker.
```

Replace the constants block (lines 29-34) with:

```csharp
        private const int PollActiveMs = 25;
        private const int PollIdleMs = 250;
        private const int IdleAfterMs = 3000;
        private const int HeartbeatMs = 2000;
        private const int DiscoveryPollMs = 1000;
```

Replace the fields `_socket` and `_warnedUnsupported` with:

```csharp
        private JournalWriter _writer;   // to-ide.jsonl (we are its only writer)
        private JournalReader _reader;   // to-unity.jsonl
        private string _unitySessionId;
        private string _ideSessionId;    // the session we handshook against
        private long _restoreOffset = -1;
        private bool _handshakeSent;
        private bool _warnedUnwritable;
```

Add session-restore plumbing (called by `BridgeBootstrap` before `Start()`):

```csharp
        /// <summary>
        /// Restore identity + read position captured before a domain reload. When
        /// <paramref name="unitySessionId"/> is null this is a cold start and a
        /// fresh id is minted, which is what triggers a full re-handshake.
        /// </summary>
        public void RestoreSession(string unitySessionId, string ideSessionId, long readOffset)
        {
            _unitySessionId = unitySessionId;
            _ideSessionId = ideSessionId;
            _restoreOffset = readOffset;
        }

        /// <summary>Identity + read position to persist in SessionState across a domain reload.</summary>
        public string UnitySessionId { get { return _unitySessionId; } }
        public string HandshakenIdeSessionId { get { return _ideSessionId; } }
        public long ReadOffset { get { return _reader != null ? _reader.AckOffset : _restoreOffset; } }
```

Replace `WorkerLoop`, `ResolveSocketPathBlocking`, `UnixSocketsSupported`, `WarnUnsupportedOnce`, `TryCreateSocket`, `ConnectBlocking`, `RunConnection`, `WriterLoop`, and `FlushOutbox` with:

```csharp
        private void WorkerLoop()
        {
            while (_running)
            {
                try
                {
                    BridgeDiscovery disc;
                    if (!Discovery.TryResolve(_projectRoot, out disc))
                    {
                        // No IDE has this project open. Not an error — wait.
                        SetConnected(false);
                        CloseJournals();
                        if (!SleepInterruptible(DiscoveryPollMs)) return;
                        continue;
                    }

                    if (disc.ProtocolVersion > Discovery.ProtocolVersion)
                    {
                        WarnOnce(ref _warnedUnwritable,
                            "[ArcaneBridge] The Arcane IDE speaks bridge protocol v" +
                            disc.ProtocolVersion + " but this package speaks v" +
                            Discovery.ProtocolVersion + ". Update the com.arcane.editor package.");
                        if (!SleepInterruptible(DiscoveryPollMs)) return;
                        continue;
                    }

                    if (!EnsureSession(disc)) { if (!SleepInterruptible(DiscoveryPollMs)) return; continue; }

                    RunSession();
                }
                catch (ThreadInterruptedException) { /* shutting down */ }
                catch (Exception e)
                {
                    if (_running) Debug.LogWarning("[ArcaneBridge] journal error: " + e.Message);
                    CloseJournals();
                    SetConnected(false);
                    if (!SleepInterruptible(DiscoveryPollMs)) return;
                }
            }
            CloseJournals();
        }

        /// <summary>
        /// Open the journals and, when this is a cold start or the IDE session
        /// changed, perform the reset + handshake. Returns false to retry later.
        /// </summary>
        private bool EnsureSession(BridgeDiscovery disc)
        {
            bool freshHandshake = _unitySessionId == null || _ideSessionId != disc.IdeSessionId;

            if (_writer == null)
            {
                _writer = new JournalWriter(Discovery.ToIdeJournalPath(_projectRoot),
                                            Discovery.ToIdeAckPath(_projectRoot));
                if (!_writer.Open())
                {
                    WarnOnce(ref _warnedUnwritable,
                        "[ArcaneBridge] cannot write " + Discovery.BridgeDir(_projectRoot) +
                        " — the bridge is idle until that path is writable.");
                    CloseJournals();
                    return false;
                }
            }

            if (_reader == null)
            {
                _reader = new JournalReader(Discovery.ToUnityJournalPath(_projectRoot),
                                            Discovery.ToUnityAckPath(_projectRoot));
                if (!_reader.TryOpen()) return false; // IDE has not created it yet
                if (freshHandshake) _reader.SeekToEnd();       // skip a previous session's messages
                else if (_restoreOffset >= 0) _reader.RestorePosition(_restoreOffset);
            }

            if (freshHandshake)
            {
                _unitySessionId = Guid.NewGuid().ToString("N");
                _ideSessionId = disc.IdeSessionId;
                _writer.Truncate();          // safe: nothing of ours is live in it
                DrainOutbox();
                _handshakeSent = false;
            }

            if (!_handshakeSent)
            {
                SendConnectionInit();
                _handshakeSent = true;
            }

            SetConnected(true);
            return true;
        }

        /// <summary>Single poll loop for one live session. Returns when the IDE session changes or we stop.</summary>
        private void RunSession()
        {
            long lastHeartbeat = Environment.TickCount;
            long lastTraffic = Environment.TickCount;
            long lastDiscoveryCheck = Environment.TickCount;

            while (_running)
            {
                long now = Environment.TickCount;

                // Outbound.
                bool wrote = FlushOutbox();
                if (now - lastHeartbeat >= HeartbeatMs)
                {
                    lastHeartbeat = now;
                    EnqueueHeartbeat();
                    FlushOutbox();
                }
                _writer.MaybeRotate();

                // Inbound.
                List<string> lines = _reader.Poll();
                for (int i = 0; i < lines.Count; i++) HandleInbound(lines[i]);
                _reader.PublishAckIfNeeded(now);

                // Heartbeats deliberately do NOT reset the backoff, or a 2s
                // heartbeat would pin polling at 25ms forever and idle CPU
                // would never drop.
                if (wrote || lines.Count > 0) lastTraffic = now;
                int interval = (now - lastTraffic) >= IdleAfterMs ? PollIdleMs : PollActiveMs;

                // Re-check bridge.json about once a second: an IDE restart mints a
                // new session id and a closed IDE deletes the file entirely.
                if (now - lastDiscoveryCheck >= DiscoveryPollMs)
                {
                    lastDiscoveryCheck = now;
                    BridgeDiscovery disc;
                    if (!Discovery.TryResolve(_projectRoot, out disc) || disc.IdeSessionId != _ideSessionId)
                    {
                        SetConnected(false);
                        CloseJournals();
                        return; // WorkerLoop re-resolves and re-handshakes
                    }
                }

                if (!SleepInterruptible(interval)) return;
            }
        }

        /// <returns>true when at least one frame was written.</returns>
        private bool FlushOutbox()
        {
            bool wrote = false;
            while (true)
            {
                string line;
                lock (_sendLock)
                {
                    if (_outbox.Count == 0) break;
                    line = _outbox.Dequeue();
                }
                if (!_writer.Append(line))
                    Debug.LogWarning("[ArcaneBridge] outbound message exceeds the 16 MB cap — dropped.");
                else
                    wrote = true;
            }
            if (wrote) _writer.Flush();
            return wrote;
        }

        private void CloseJournals()
        {
            if (_reader != null) { _restoreOffset = _reader.AckOffset; _reader.Dispose(); _reader = null; }
            if (_writer != null) { _writer.Dispose(); _writer = null; }
            _handshakeSent = false;
        }

        private static void WarnOnce(ref bool flag, string message)
        {
            if (flag) return;
            flag = true;
            Debug.LogWarning(message);
        }
```

Change `_outbox` from `Queue<byte[]>` to `Queue<string>` and simplify `Send`:

```csharp
        private readonly System.Collections.Generic.Queue<string> _outbox =
            new System.Collections.Generic.Queue<string>();

        public void Send(JsonValue envelope)
        {
            if (!_running || envelope == null) return;
            lock (_sendLock) { _outbox.Enqueue(envelope.Serialize()); }
            _sendSignal.Set();
        }
```

Extend `SendConnectionInit` to carry the handshake fields:

```csharp
        private void SendConnectionInit()
        {
            JsonValue payload;
            try
            {
                payload = MainThreadDispatcher.EnqueueAndWait(_connectionInitPayloadFactory, 6000);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[ArcaneBridge] failed to build connection_init payload: " + e.Message);
                payload = JsonValue.NewObject();
            }
            payload["unitySessionId"] = _unitySessionId ?? "";
            payload["ideSessionId"] = _ideSessionId ?? "";
            Send(Protocol.Envelope(MsgType.ConnectionInit, payload));
        }
```

Update `Stop()` to write a clean `disconnect` and close the journals instead of the socket:

```csharp
        public void Stop()
        {
            _running = false;
            _sendSignal.Set();

            var w = _worker;
            _worker = null;
            if (w != null && w.IsAlive)
            {
                try { w.Join(1500); } catch { }
            }

            // Best-effort clean close so the IDE sees a disconnect instead of an
            // 8s heartbeat timeout. Safe on this thread: the worker has joined.
            try
            {
                if (_writer != null)
                {
                    _writer.Append(Protocol.Envelope(MsgType.Disconnect, JsonValue.NewObject()).Serialize());
                    _writer.Flush();
                }
            }
            catch { }

            CloseJournals();
            SetConnected(false);
        }
```

Add `using System.Collections.Generic;` and drop `using System.Net.Sockets;`.

**Keep `_sendSignal`.** With the writer thread gone it is no longer a write-wakeup — it survives only so `Stop()` can break the worker out of `SleepInterruptible`. Leave the `Set()` calls in `Send()` and `Stop()` as they are; do not "clean up" the field. The cost is that a message enqueued just after a poll waits up to one interval (25 ms while active), which is well inside the RPC timeout.

- [ ] **Step 3: Delete `Framing.cs`**

```bash
git rm arcane-extension/Editor/Framing.cs arcane-extension/Editor/Framing.cs.meta
```

- [ ] **Step 4: Persist the session across domain reloads in `BridgeBootstrap.cs`**

Add the `SessionState` keys next to `SessionConnectedKey` (line 35):

```csharp
        private const string SessionUnityIdKey = "Arcane.Bridge.UnitySessionId";
        private const string SessionIdeIdKey = "Arcane.Bridge.IdeSessionId";
        private const string SessionOffsetKey = "Arcane.Bridge.ReadOffset";
```

In `Start()`, restore before `_client.Start()` (replacing line 90):

```csharp
            // Restore identity + read position so a domain reload resumes the
            // stream mid-session instead of re-handshaking. Empty ids mean a cold
            // start, which is exactly what triggers a fresh handshake.
            string unityId = SessionState.GetString(SessionUnityIdKey, "");
            string ideId = SessionState.GetString(SessionIdeIdKey, "");
            long offset;
            long.TryParse(SessionState.GetString(SessionOffsetKey, "-1"), out offset);
            _client.RestoreSession(
                string.IsNullOrEmpty(unityId) ? null : unityId,
                string.IsNullOrEmpty(ideId) ? null : ideId,
                offset);

            _client.Start();
```

In `Shutdown()`, capture state before `_client.Stop()` (inside the `if (_client != null)` block at line 208):

```csharp
                if (_client != null)
                {
                    SessionState.SetString(SessionUnityIdKey, _client.UnitySessionId ?? "");
                    SessionState.SetString(SessionIdeIdKey, _client.HandshakenIdeSessionId ?? "");
                    SessionState.SetString(SessionOffsetKey,
                        _client.ReadOffset.ToString(System.Globalization.CultureInfo.InvariantCulture));

                    _client.ConnectionStateChanged -= OnConnectionStateChanged;
                    _client.Stop();
                    _client = null;
                }
```

In `OnQuitting()`, clear them so the next editor launch cold-starts (after line 187):

```csharp
            SessionState.EraseString(SessionUnityIdKey);
            SessionState.EraseString(SessionIdeIdKey);
            SessionState.EraseString(SessionOffsetKey);
```

Bump the reported protocol version in `BuildConnectionInitPayload` — line 131 already reads `Discovery.ProtocolVersion`, which Task 2 changed to `2`. Add the package version next to it:

```csharp
            p["packageVersion"] = "0.1.0";
```

- [ ] **Step 5: Verify the package compiles and the suite passes**

Open a Unity project with the package. Expected: zero compile errors, all 13 tests pass, and **no** `[ArcaneBridge]` warning about .NET Standard 2.1 — set the project to API Compatibility Level `.NET Framework` and confirm it still compiles clean.

- [ ] **Step 6: Commit**

```bash
git add -A arcane-extension
git commit -m "feat(bridge): swap the C# transport to the journal, delete Framing.cs"
```

---

## Task 4: Rust journal primitives

**Files:**
- Create: `editor/src-tauri/src/unity_journal.rs`
- Modify: `editor/src-tauri/src/lib.rs:14` (add `mod unity_journal;`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub const MAX_LINE_BYTES: u64`, `ROTATE_THRESHOLD: u64`, `MAX_READ_PER_POLL: u64`, `ACK_INTERVAL_MS: u64`
  - `pub struct JournalWriter` — `open(journal: &Path, ack: &Path) -> io::Result<Self>`, `len(&mut self) -> u64`, `truncate(&mut self) -> io::Result<()>`, `append(&mut self, line: &str) -> io::Result<bool>`, `flush(&mut self) -> io::Result<()>`, `maybe_rotate(&mut self)`
  - `pub struct JournalReader` — `open(journal: &Path, ack: &Path) -> io::Result<Self>`, `len(&mut self) -> u64`, `ack_offset(&self) -> u64`, `did_reset(&self) -> bool`, `seek_to_end(&mut self)`, `poll(&mut self) -> Vec<String>`, `publish_ack_if_needed(&mut self, now_ms: u64)`

- [ ] **Step 1: Register the module**

In `editor/src-tauri/src/lib.rs`, after line 14 (`mod unity_ipc;`):

```rust
mod unity_journal;
```

- [ ] **Step 2: Write the failing tests**

Create `editor/src-tauri/src/unity_journal.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("arcane-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trips_lines_in_order() {
        let d = tmp();
        let (j, a) = (d.join("j.jsonl"), d.join("j.ack"));
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"a\":1}").unwrap();
        w.append("{\"a\":2}").unwrap();
        w.flush().unwrap();

        let mut r = JournalReader::open(&j, &a).unwrap();
        assert_eq!(r.poll(), vec!["{\"a\":1}".to_string(), "{\"a\":2}".to_string()]);
    }

    #[test]
    fn does_not_dispatch_a_partial_line() {
        let d = tmp();
        let (j, a) = (d.join("p.jsonl"), d.join("p.ack"));
        let mut w = JournalWriter::open(&j, &a).unwrap();
        let mut r = JournalReader::open(&j, &a).unwrap();

        use std::io::Write;
        write!(w.file_for_test(), "{{\"a\":").unwrap();
        w.flush().unwrap();
        assert!(r.poll().is_empty(), "a partial line must not be dispatched");

        write!(w.file_for_test(), "1}}\n").unwrap();
        w.flush().unwrap();
        assert_eq!(r.poll(), vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn advances_offset_by_bytes_for_multibyte_utf8() {
        let d = tmp();
        let (j, a) = (d.join("u.jsonl"), d.join("u.ack"));
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"m\":\"日本語\"}").unwrap();
        w.append("{\"m\":\"ok\"}").unwrap();
        w.flush().unwrap();

        let mut r = JournalReader::open(&j, &a).unwrap();
        let lines = r.poll();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], "{\"m\":\"ok\"}");
        assert_eq!(r.ack_offset(), w.len(), "offset must track bytes, not chars");
    }

    #[test]
    fn resets_to_zero_when_the_file_shrinks() {
        let d = tmp();
        let (j, a) = (d.join("t.jsonl"), d.join("t.ack"));
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"a\":1}").unwrap();
        w.flush().unwrap();
        let mut r = JournalReader::open(&j, &a).unwrap();
        assert_eq!(r.poll().len(), 1);

        w.truncate().unwrap();
        w.append("{\"b\":2}").unwrap();
        w.flush().unwrap();

        let lines = r.poll();
        assert!(r.did_reset(), "shrink must trigger the universal reset rule");
        assert_eq!(lines, vec!["{\"b\":2}".to_string()]);
    }

    #[test]
    fn refuses_a_line_over_the_cap() {
        let d = tmp();
        let (j, a) = (d.join("c.jsonl"), d.join("c.ack"));
        let mut w = JournalWriter::open(&j, &a).unwrap();
        let huge = "x".repeat(MAX_LINE_BYTES as usize + 1);
        assert_eq!(w.append(&huge).unwrap(), false);
        assert_eq!(w.len(), 0, "an oversized line must not be partially written");
    }

    #[test]
    fn skips_rotation_when_ack_is_missing_unparseable_or_stale() {
        let d = tmp();
        let (j, a) = (d.join("r.jsonl"), d.join("r.ack"));
        let mut w = JournalWriter::open(&j, &a).unwrap();
        let chunk = "x".repeat(64 * 1024);
        while w.len() <= ROTATE_THRESHOLD {
            w.append(&chunk).unwrap();
        }
        w.flush().unwrap();
        let grown = w.len();

        w.maybe_rotate();
        assert_eq!(w.len(), grown, "missing ack must not rotate");

        std::fs::write(&a, "not-a-number").unwrap();
        w.maybe_rotate();
        assert_eq!(w.len(), grown, "unparseable ack must not rotate");

        std::fs::write(&a, (grown + 999).to_string()).unwrap();
        w.maybe_rotate();
        assert_eq!(w.len(), grown, "stale ack must not rotate");

        std::fs::write(&a, grown.to_string()).unwrap();
        w.maybe_rotate();
        assert_eq!(w.len(), 0, "a caught-up ack rotates");
    }

    #[test]
    fn publishes_no_ack_below_the_rotate_threshold() {
        let d = tmp();
        let (j, a) = (d.join("s.jsonl"), d.join("s.ack"));
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"a\":1}").unwrap();
        w.flush().unwrap();
        let mut r = JournalReader::open(&j, &a).unwrap();
        r.poll();
        r.publish_ack_if_needed(1000);
        assert!(!a.exists(), "a small journal must do zero ack I/O");
    }
}
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd editor/src-tauri && cargo test unity_journal
```

Expected: FAIL — `JournalWriter`, `JournalReader`, `MAX_LINE_BYTES`, `ROTATE_THRESHOLD` not found.

- [ ] **Step 4: Implement `unity_journal.rs`**

Prepend the implementation above the test module:

```rust
//! Append-only newline-delimited JSON journals — the Unity bridge transport.
//!
//! Mirrors `arcane-extension/Editor/Journal.cs` byte for byte. The two sides must
//! agree on line splitting, the rotation handshake, and every constant below.
//!
//! SINGLE WRITER PER FILE is the invariant: the IDE owns `to-unity.jsonl` and
//! `to-ide.ack`; Unity owns `to-ide.jsonl` and `to-unity.ack`. Nothing locks.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;
pub const ROTATE_THRESHOLD: u64 = 4 * 1024 * 1024;
pub const MAX_READ_PER_POLL: u64 = 4 * 1024 * 1024;
pub const ACK_INTERVAL_MS: u64 = 500;

pub struct JournalWriter {
    file: File,
    ack_path: PathBuf,
}

impl JournalWriter {
    pub fn open(journal: &Path, ack: &Path) -> std::io::Result<Self> {
        if let Some(dir) = journal.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = OpenOptions::new().read(true).write(true).create(true).open(journal)?;
        file.seek(SeekFrom::End(0))?;
        Ok(Self { file, ack_path: ack.to_path_buf() })
    }

    #[cfg(test)]
    pub fn file_for_test(&mut self) -> &mut File {
        &mut self.file
    }

    pub fn len(&mut self) -> u64 {
        self.file.metadata().map(|m| m.len()).unwrap_or(0)
    }

    pub fn truncate(&mut self) -> std::io::Result<()> {
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.flush()
    }

    /// Returns `Ok(false)` when the line exceeds the cap — caller warns and drops.
    pub fn append(&mut self, line: &str) -> std::io::Result<bool> {
        let bytes = line.as_bytes();
        if bytes.len() as u64 + 1 > MAX_LINE_BYTES {
            return Ok(false);
        }
        self.file.write_all(bytes)?;
        self.file.write_all(b"\n")?;
        Ok(true)
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }

    /// Ack-gated rotation: truncate only when the reader has consumed every byte,
    /// so nothing is ever in flight. Missing / unparseable / stale ack → skip.
    pub fn maybe_rotate(&mut self) {
        let size = self.len();
        if size <= ROTATE_THRESHOLD {
            return;
        }
        let ack = std::fs::read_to_string(&self.ack_path)
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok());
        if ack != Some(size) {
            return;
        }
        let _ = self.truncate();
    }
}

pub struct JournalReader {
    file: File,
    ack_path: PathBuf,
    buf: Vec<u8>,
    read_pos: u64,
    did_reset: bool,
    last_ack_value: Option<u64>,
    last_ack_written_ms: Option<u64>,
}

impl JournalReader {
    pub fn open(journal: &Path, ack: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new().read(true).open(journal)?;
        Ok(Self {
            file,
            ack_path: ack.to_path_buf(),
            buf: Vec::new(),
            read_pos: 0,
            did_reset: false,
            last_ack_value: None,
            last_ack_written_ms: None,
        })
    }

    pub fn len(&mut self) -> u64 {
        self.file.metadata().map(|m| m.len()).unwrap_or(0)
    }

    /// Bytes consumed AND dispatched — never includes a buffered partial line.
    pub fn ack_offset(&self) -> u64 {
        self.read_pos.saturating_sub(self.buf.len() as u64)
    }

    pub fn did_reset(&self) -> bool {
        self.did_reset
    }

    /// Skip everything already present — used on a cold start so a previous
    /// session's messages are not replayed.
    pub fn seek_to_end(&mut self) {
        self.read_pos = self.len();
        self.buf.clear();
    }

    pub fn poll(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        self.did_reset = false;
        let len = self.len();

        // Universal reset rule: a shrink means the peer truncated. Rotation and a
        // session reset are indistinguishable here, and neither needs its own case.
        if len < self.read_pos {
            self.read_pos = 0;
            self.buf.clear();
            self.did_reset = true;
        }
        if len <= self.read_pos {
            return lines;
        }

        let to_read = std::cmp::min(len - self.read_pos, MAX_READ_PER_POLL) as usize;
        let mut chunk = vec![0u8; to_read];
        if self.file.seek(SeekFrom::Start(self.read_pos)).is_err() {
            return lines;
        }
        let got = match self.file.read(&mut chunk) {
            Ok(n) => n,
            Err(_) => return lines,
        };
        if got == 0 {
            return lines;
        }

        self.read_pos += got as u64;
        self.buf.extend_from_slice(&chunk[..got]);

        // Split on the 0x0A byte. Safe pre-decode: UTF-8 continuation bytes are
        // always >= 0x80, so 0x0A can only ever be a real newline.
        let mut start = 0usize;
        while let Some(rel) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let nl = start + rel;
            let mut end = nl;
            if end > start && self.buf[end - 1] == b'\r' {
                end -= 1;
            }
            if end > start {
                lines.push(String::from_utf8_lossy(&self.buf[start..end]).into_owned());
            }
            start = nl + 1;
        }
        self.buf.drain(..start);

        // Bound memory on a corrupt journal: a line that never terminates.
        if self.buf.len() as u64 > MAX_LINE_BYTES {
            self.buf.clear();
            self.read_pos = len;
        }
        lines
    }

    /// Publish the consumed offset — only while the journal exceeds the rotate
    /// threshold, so an ordinary session does zero ack I/O.
    pub fn publish_ack_if_needed(&mut self, now_ms: u64) {
        if self.len() <= ROTATE_THRESHOLD {
            return;
        }
        let ack = self.ack_offset();
        if self.last_ack_value == Some(ack) {
            return;
        }
        if let Some(prev) = self.last_ack_written_ms {
            if now_ms.saturating_sub(prev) < ACK_INTERVAL_MS {
                return;
            }
        }
        if std::fs::write(&self.ack_path, ack.to_string()).is_ok() {
            self.last_ack_value = Some(ack);
            self.last_ack_written_ms = Some(now_ms);
        }
    }
}
```

- [ ] **Step 5: Run to verify they pass**

```bash
cd editor/src-tauri && cargo test unity_journal
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add editor/src-tauri/src/unity_journal.rs editor/src-tauri/src/lib.rs
git commit -m "feat(unity-ipc): add Rust journal reader/writer mirroring Journal.cs"
```

---

## Task 5: Rust `unity_ipc` transport rewrite

**Files:**
- Modify: `editor/src-tauri/src/unity_ipc.rs` (delete both socket paths, add the journal session task)
- Modify: `editor/src-tauri/src/lib.rs:206-214` (stale doc comment referencing `unity_ipc::hash_workspace`)

**Interfaces:**
- Consumes: `unity_journal::{JournalWriter, JournalReader}` from Task 4.
- Produces: `unity_ipc_start`, `unity_ipc_stop`, `unity_ipc_send`, `unity_ipc_request`, `unity_write_bridge_discovery` — **all five Tauri command signatures unchanged**, so `editor/src/stores/unity.ts` keeps working. `UnityIpcState`, `UnityIpcInner`, and `route_message` are untouched.

- [ ] **Step 1: Delete the socket transport**

Remove from `unity_ipc.rs`: `IPC_PIPE_PREFIX` (line 15), `MAX_FRAME_SIZE` (16), `HEADER_SIZE` (17), `hash_workspace` (150), both `compute_pipe_path` (161-170), `cleanup_stale_socket` (172-199), `encode_frame`/`decode_frame`, the `use sha1::{Digest, Sha1};` and `use tokio::io::{AsyncReadExt, AsyncWriteExt};` imports, and the `pipe_path_is_deterministic` test (697-705). The size cap now comes from `unity_journal::MAX_LINE_BYTES`.

Widen the path import — the original file has only `use std::path::Path;` and the new code needs both:

```rust
use std::path::{Path, PathBuf};
```

- [ ] **Step 2: Add the constants and journal path helpers**

```rust
use crate::unity_journal::{JournalReader, JournalWriter};

const PROTOCOL_VERSION: u32 = 2;
const POLL_ACTIVE_MS: u64 = 25;
const POLL_IDLE_MS: u64 = 250;
const IDLE_AFTER_MS: u64 = 3000;
const HEARTBEAT_MS: u64 = 2000;
const PEER_DEAD_MS: u64 = 8000;
const DEFAULT_RPC_TIMEOUT_MS: u64 = 10_000;

fn bridge_dir(workspace_path: &str) -> PathBuf {
    Path::new(workspace_path).join("Library").join("ArcaneIDE")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
```

- [ ] **Step 3: Rewrite `write_bridge_discovery` with an atomic write**

```rust
/// Write the discovery file the Unity package reads to find this IDE session.
/// Lives under `Library/ArcaneIDE/bridge.json` (Library/ is VCS-ignored). Only
/// written for actual Unity projects (presence of `ProjectSettings/`).
///
/// Written via tmp + rename so Unity can never observe a half-written file —
/// `std::fs::write` alone is NOT atomic.
pub fn write_bridge_discovery(
    workspace_path: &str,
    ide_session_id: &str,
) -> Result<Option<String>, String> {
    let root = Path::new(workspace_path);
    if !root.join("ProjectSettings").is_dir() {
        return Ok(None); // not a Unity project — no discovery file
    }
    let dir = bridge_dir(workspace_path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    let content = serde_json::json!({
        "transport": "journal",
        "protocolVersion": PROTOCOL_VERSION,
        "ideSessionId": ide_session_id,
        "ideVersion": env!("CARGO_PKG_VERSION"),
        "idePid": std::process::id(),
        "minPackageVersion": "0.1.0",
        "_note": "Arcane IDE bridge. If Unity is not connecting, update the com.arcane.editor package.",
    });
    let serialized = serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?;

    let file = dir.join("bridge.json");
    let tmp = dir.join("bridge.json.tmp");
    std::fs::write(&tmp, serialized).map_err(|e| format!("Failed to write bridge.json: {}", e))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("Failed to publish bridge.json: {}", e))?;
    Ok(Some(file.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn unity_write_bridge_discovery(workspace_path: String) -> Result<Option<String>, String> {
    write_bridge_discovery(&workspace_path, &uuid_hex())
}

/// 32 hex chars of session identity. No uuid crate needed — this only has to be
/// unique across IDE launches on one machine, not globally.
fn uuid_hex() -> String {
    let a = now_ms();
    let b = std::process::id() as u64;
    let c = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    format!("{:016x}{:08x}{:08x}", a, b as u32, c as u32)
}
```

- [ ] **Step 4: Replace the listener + accept loops with the journal session task**

Replace everything in `unity_ipc_start` from `let socket_path = compute_pipe_path(...)` (line 261) through the **closing `Ok(())` and brace of `unity_ipc_start`** (lines 361-362) with the block below. The replacement includes its own `Ok(())` and closing brace, so do not leave the originals in place or the function will end twice.

```rust
    let ide_session_id = uuid_hex();
    let dir = bridge_dir(&workspace_path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    // We own to-unity.jsonl (writer) and to-ide.ack (reader-side ack).
    let mut writer = JournalWriter::open(&dir.join("to-unity.jsonl"), &dir.join("to-unity.ack"))
        .map_err(|e| format!("Failed to open to-unity.jsonl: {}", e))?;
    // Sequence A: our own start truncates the journal we write. Safe because we
    // write nothing until connection_init echoes this ide_session_id back.
    writer.truncate().map_err(|e| format!("Failed to reset to-unity.jsonl: {}", e))?;

    if let Err(e) = write_bridge_discovery(&workspace_path, &ide_session_id) {
        eprintln!("[UnityIPC] Failed to write bridge discovery: {}", e);
    }

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    *inner.shutdown_tx.lock().await = Some(shutdown_tx);

    let app_handle = app.clone();
    let ipc_state = inner.clone();
    let label_for_task = label.clone();
    let ws = workspace_path.clone();

    tokio::spawn(async move {
        tokio::select! {
            _ = shutdown_rx.recv() => {}
            _ = run_journal_session(ws, ide_session_id, dir, writer, app_handle, ipc_state, label_for_task) => {}
        }
    });

    Ok(())
}

/// One journal session: poll `to-ide.jsonl`, gate on the handshake, pump the
/// outbound channel into `to-unity.jsonl`. Replaces `handle_client`.
#[allow(clippy::too_many_arguments)]
async fn run_journal_session(
    workspace_path: String,
    ide_session_id: String,
    dir: PathBuf,
    mut writer: JournalWriter,
    app: AppHandle,
    state: Arc<UnityIpcInner>,
    label: String,
) {
    let (client_tx, mut client_rx) = mpsc::channel::<String>(64);
    *state.client_tx.lock().await = Some(client_tx);

    let mut reader: Option<JournalReader> = None;
    let mut connected = false;
    let mut unity_session_id: Option<String> = None;
    let mut last_heartbeat = now_ms();
    let mut last_traffic = now_ms();
    let mut last_peer_bytes = now_ms();
    let mut stale_warned = false;
    let started = now_ms();

    loop {
        let now = now_ms();

        // Lazily open the peer's journal — a reader never creates it.
        if reader.is_none() {
            reader = JournalReader::open(&dir.join("to-ide.jsonl"), &dir.join("to-ide.ack")).ok();
        }

        let mut saw_bytes = false;
        if let Some(r) = reader.as_mut() {
            let lines = r.poll();
            if !lines.is_empty() {
                saw_bytes = true;
                last_peer_bytes = now;
            }
            for line in lines {
                let msg: UnityMessage = match serde_json::from_str(&line) {
                    Ok(m) => m,
                    Err(_) => continue, // one bad line never kills the session
                };

                // Handshake gate: we write NOTHING until connection_init echoes
                // our current ide_session_id. That is what closes the startup race.
                if msg.msg_type == "connection_init" {
                    let echoed = msg.payload.get("ideSessionId").and_then(|v| v.as_str()).unwrap_or("");
                    if echoed != ide_session_id {
                        continue; // stale handshake from a previous IDE session
                    }
                    let incoming = msg.payload.get("unitySessionId").and_then(|v| v.as_str()).unwrap_or("");
                    if unity_session_id.as_deref() != Some(incoming) {
                        // Sequence B: a new Unity session. Truncate the journal we
                        // write BEFORE emitting anything into it.
                        let _ = writer.truncate();
                        unity_session_id = Some(incoming.to_string());
                    }
                    connected = true;
                    stale_warned = true; // handshake landed; never warn about a stale package
                } else if msg.msg_type == "disconnect" {
                    connected = false;
                    unity_session_id = None;
                    let _ = app.emit_to(
                        label.as_str(),
                        "unity-connection-changed",
                        ConnectionChangedPayload { connected: false, info: None },
                    );
                    continue;
                }

                route_message(&app, &state, &label, msg).await;
            }
            r.publish_ack_if_needed(now);
        }

        // Outbound — only after the handshake.
        let mut wrote = false;
        if connected {
            while let Ok(msg) = client_rx.try_recv() {
                match writer.append(&msg) {
                    Ok(true) => wrote = true,
                    Ok(false) => eprintln!("[UnityIPC] outbound message exceeds the 16 MB cap — dropped"),
                    Err(e) => eprintln!("[UnityIPC] journal write failed: {}", e),
                }
            }
            if now.saturating_sub(last_heartbeat) >= HEARTBEAT_MS {
                last_heartbeat = now;
                let hb = serde_json::json!({ "type": "heartbeat", "payload": {}, "timestamp": now as f64 / 1000.0 });
                let _ = writer.append(&hb.to_string());
                wrote = true;
            }
            if wrote {
                let _ = writer.flush();
            }
            writer.maybe_rotate();
        }

        // Liveness: the journal IS the heartbeat.
        if connected && now.saturating_sub(last_peer_bytes) > PEER_DEAD_MS {
            connected = false;
            unity_session_id = None;
            *state.client_tx.lock().await = None;
            state.pending.lock().await.clear();
            let _ = app.emit_to(
                label.as_str(),
                "unity-connection-changed",
                ConnectionChangedPayload { connected: false, info: None },
            );
        }

        // Stale-package detection (Task 6 consumes this).
        if !stale_warned && now.saturating_sub(started) > 15_000 {
            stale_warned = true;
            if unity_editor_is_running(&workspace_path) {
                let _ = app.emit_to(label.as_str(), "unity-package-stale", ());
            }
        }

        // Heartbeats deliberately do not reset the backoff.
        if wrote || saw_bytes {
            last_traffic = now;
        }
        let interval = if now.saturating_sub(last_traffic) >= IDLE_AFTER_MS {
            POLL_IDLE_MS
        } else {
            POLL_ACTIVE_MS
        };
        tokio::time::sleep(Duration::from_millis(interval)).await;
    }
}
```

- [ ] **Step 5: Emit `connected: true` where the handshake lands**

Inside the `connection_init` branch, right after `connected = true;`, add:

```rust
                    let _ = app.emit_to(
                        label.as_str(),
                        "unity-connection-changed",
                        ConnectionChangedPayload { connected: true, info: Some(msg.payload.clone()) },
                    );
```

- [ ] **Step 6: Fix the stale doc comment in `lib.rs`**

`lib.rs:206-214` explains why `canonicalize_project_path` matters by referencing `unity_ipc::hash_workspace`, which no longer exists. The *conclusion* still holds — two windows on the same project would fight over the same journal files — so rewrite the reasoning:

```rust
/// Canonicalize a project path before `openProjectInNewWindow`
/// (`src/features/project/services/multi-window.ts`) hashes it into a
/// per-window label. The Unity bridge's journal files live at a fixed
/// location relative to the project (`Library/ArcaneIDE/`), so the same
/// project opened via two different spellings (a symlink, a trailing
/// slash, `..` segments) would get two different window labels while
/// both windows' bridges write the SAME journal files — two writers on
/// one file, which is exactly the invariant the transport depends on not
/// being violated. Calling this first and using its result everywhere
/// downstream (label, window dedup, `?path=` query param, recents) keeps
/// all of that on one canonical form.
```

- [ ] **Step 7: Build and test**

```bash
cd editor/src-tauri && cargo build 2>&1 | tail -20 && cargo test unity 2>&1 | tail -20
```

Expected: clean build (no `sha1` / `UnixListener` / `named_pipe` references remain in `unity_ipc.rs`), all `unity_journal` and `UnityIpcState` tests pass.

- [ ] **Step 8: Commit**

```bash
git add editor/src-tauri/src/unity_ipc.rs editor/src-tauri/src/lib.rs
git commit -m "feat(unity-ipc): replace socket/pipe transport with the journal session"
```

---

## Task 6: Stale-package detection

**Files:**
- Modify: `editor/src-tauri/src/unity_ipc.rs` (add `unity_editor_is_running`)
- Modify: `editor/src/stores/unity.ts:131` (listen for `unity-package-stale`)

**Interfaces:**
- Consumes: the `unity-package-stale` emit added in Task 5 Step 4.
- Produces: `fn unity_editor_is_running(workspace_path: &str) -> bool`.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `unity_ipc.rs`:

```rust
    #[test]
    fn detects_a_running_unity_editor_from_editor_instance_json() {
        let d = std::env::temp_dir().join(format!("arcane-ei-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("Library")).unwrap();

        // No EditorInstance.json at all.
        assert!(!unity_editor_is_running(d.to_str().unwrap()));

        // Our own pid is definitionally alive.
        std::fs::write(
            d.join("Library").join("EditorInstance.json"),
            format!("{{\"process_id\":{},\"version\":\"2021.3.0f1\"}}", std::process::id()),
        )
        .unwrap();
        assert!(unity_editor_is_running(d.to_str().unwrap()));

        // Malformed content must not panic or report a live editor.
        std::fs::write(d.join("Library").join("EditorInstance.json"), "{ not json").unwrap();
        assert!(!unity_editor_is_running(d.to_str().unwrap()));
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd editor/src-tauri && cargo test detects_a_running_unity_editor
```

Expected: FAIL — `unity_editor_is_running` not found.

- [ ] **Step 3: Implement it**

```rust
/// True when Unity has this project open. Unity writes
/// `Library/EditorInstance.json` (containing `process_id`) whenever the editor
/// holds a project — the same signal Rider and the VS Code extension use.
///
/// Combined with "no to-ide.jsonl has appeared", this distinguishes *the user
/// hasn't opened Unity* from *the com.arcane.editor package is missing or
/// pre-v2*, which turns an indefinite "waiting for Unity" into an actionable
/// prompt.
fn unity_editor_is_running(workspace_path: &str) -> bool {
    let path = Path::new(workspace_path).join("Library").join("EditorInstance.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let pid = match serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("process_id").and_then(|p| p.as_u64()))
    {
        Some(p) => p,
        None => return false,
    };
    process_is_alive(pid as u32)
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    // Signal 0 performs error checking without delivering a signal.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use std::process::Command;
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}
```

If `libc` is not already in `editor/src-tauri/Cargo.toml`, add it under `[target.'cfg(unix)'.dependencies]`:

```toml
[target.'cfg(unix)'.dependencies]
libc = "0.2"
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd editor/src-tauri && cargo test detects_a_running_unity_editor
```

Expected: PASS.

- [ ] **Step 5: Surface it in the frontend**

In `editor/src/stores/unity.ts`, next to the existing `unity-connection-changed` listener at line 131:

```ts
    const u3 = await listenScoped<void>('unity-package-stale', () => {
      // Unity has the project open but no bridge journal ever appeared — the
      // com.arcane.editor package is missing or predates the journal transport.
      set({ packageStale: true });
    });
```

Add `packageStale: boolean` (default `false`) to the store's state and reset it to `false` in the `unity-connection-changed` handler when `connected` is true. Include `u3` in the store's existing unlisten teardown alongside `u1`.

- [ ] **Step 6: Typecheck and commit**

```bash
cd editor && npx tsc --noEmit 2>&1 | tail -5
git add editor/src-tauri editor/src/stores/unity.ts
git commit -m "feat(unity-ipc): detect a missing or outdated Unity package via EditorInstance.json"
```

---

## Task 7: Cross-language contract fixtures, version bumps, manual acceptance

**Files:**
- Create: `editor/src-tauri/fixtures/unity-journal/sample.jsonl`
- Modify: `editor/src-tauri/src/unity_journal.rs` (fixture test)
- Create: `arcane-extension/Tests/Editor/ContractTests.cs`
- Modify: `arcane-extension/package.json:3` (`version` → `0.1.0`)

**Interfaces:**
- Consumes: `JournalReader` (both languages).
- Produces: the golden fixture both sides parse, pinning the format so it cannot drift between languages.

- [ ] **Step 1: Create the golden fixture**

Create `editor/src-tauri/fixtures/unity-journal/sample.jsonl` — exactly these four lines, each `\n`-terminated, no trailing blank line:

```
{"type":"connection_init","payload":{"unitySessionId":"u1","ideSessionId":"i1","projectName":"Demo"},"timestamp":1.5}
{"type":"log","payload":{"message":"line one\nline two","stackTrace":"at Foo()\n  at Bar()"},"timestamp":2.5}
{"type":"log","payload":{"message":"日本語 → emoji 🎮"},"timestamp":3.5}
{"type":"heartbeat","payload":{},"timestamp":4.5}
```

Line 2 is the important one: escaped `\n` inside JSON strings must **not** split a record. Line 3 pins multi-byte offset handling.

- [ ] **Step 2: Add the Rust fixture test**

In `unity_journal.rs`'s test module:

```rust
    #[test]
    fn parses_the_golden_fixture_shared_with_the_csharp_side() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/unity-journal/sample.jsonl");
        let d = tmp();
        let (j, a) = (d.join("g.jsonl"), d.join("g.ack"));
        std::fs::copy(&fixture, &j).unwrap();

        let mut r = JournalReader::open(&j, &a).unwrap();
        let lines = r.poll();
        assert_eq!(lines.len(), 4, "escaped \\n inside a JSON string must not split a record");

        let log: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(log["payload"]["message"], "line one\nline two");

        let uni: serde_json::Value = serde_json::from_str(&lines[2]).unwrap();
        assert_eq!(uni["payload"]["message"], "日本語 → emoji 🎮");

        assert_eq!(r.ack_offset(), std::fs::metadata(&j).unwrap().len());
    }
```

- [ ] **Step 3: Add the matching C# fixture test**

Create `arcane-extension/Tests/Editor/ContractTests.cs`. It reproduces the fixture inline rather than reading the Rust repo path, since the shipped package has no access to `editor/`:

```csharp
using System.Collections.Generic;
using System.IO;
using System.Text;
using Arcane.Bridge;
using NUnit.Framework;

namespace Arcane.Tests
{
    public class ContractTests
    {
        // Byte-identical to editor/src-tauri/fixtures/unity-journal/sample.jsonl.
        // If you change one, change both — this pins the wire format across languages.
        private const string Fixture =
            "{\"type\":\"connection_init\",\"payload\":{\"unitySessionId\":\"u1\",\"ideSessionId\":\"i1\",\"projectName\":\"Demo\"},\"timestamp\":1.5}\n" +
            "{\"type\":\"log\",\"payload\":{\"message\":\"line one\\nline two\",\"stackTrace\":\"at Foo()\\n  at Bar()\"},\"timestamp\":2.5}\n" +
            "{\"type\":\"log\",\"payload\":{\"message\":\"日本語 → emoji 🎮\"},\"timestamp\":3.5}\n" +
            "{\"type\":\"heartbeat\",\"payload\":{},\"timestamp\":4.5}\n";

        [Test]
        public void ParsesTheGoldenFixture()
        {
            string dir = Path.Combine(Path.GetTempPath(), "arcane-contract-" + Path.GetRandomFileName());
            Directory.CreateDirectory(dir);
            string journal = Path.Combine(dir, "g.jsonl");
            File.WriteAllBytes(journal, Encoding.UTF8.GetBytes(Fixture));

            try
            {
                using (var r = new JournalReader(journal, Path.Combine(dir, "g.ack")))
                {
                    Assert.IsTrue(r.TryOpen());
                    List<string> lines = r.Poll();
                    Assert.AreEqual(4, lines.Count,
                        "escaped \\n inside a JSON string must not split a record");

                    JsonValue log = JsonValue.TryParse(lines[1]);
                    Assert.AreEqual("line one\nline two", log["payload"]["message"].AsString);

                    JsonValue uni = JsonValue.TryParse(lines[2]);
                    Assert.AreEqual("日本語 → emoji 🎮", uni["payload"]["message"].AsString);

                    Assert.AreEqual(new FileInfo(journal).Length, r.AckOffset);
                }
            }
            finally
            {
                try { Directory.Delete(dir, true); } catch { }
            }
        }

        [Test]
        public void SerializeNeverEmitsARawNewline()
        {
            // The precondition the whole line-delimited format rests on.
            var v = JsonValue.NewObject();
            v["message"] = "line one\nline two\r\nand a tab\there";
            string s = v.Serialize();
            Assert.IsFalse(s.Contains("\n"), "Serialize must escape newlines, not emit them");
            Assert.IsFalse(s.Contains("\r"));
            Assert.IsFalse(s.Contains("\t"));
        }
    }
}
```

- [ ] **Step 4: Run both suites**

```bash
cd editor/src-tauri && cargo test unity_journal
```
Expected: 8 passed. Then run the Unity EditMode suite: 16 tests pass.

- [ ] **Step 5: Bump the package version**

In `arcane-extension/package.json`, change `"version": "0.0.1"` to `"version": "0.1.0"`.

- [ ] **Step 6: Manual acceptance — the test that actually matters**

On a real Unity project, with **API Compatibility Level = `.NET Framework`** (Project Settings → Player → Other Settings → Configuration):

1. Import the `.tgz`. Confirm **no** `[ArcaneBridge]` warning about .NET Standard 2.1.
2. Open the same project in Arcane. Confirm the bridge connects within ~2s.
3. `Debug.Log` from a script — confirm it streams to the IDE console.
4. Trigger an RPC (hierarchy fetch) — confirm a response.
5. Enter and exit play mode from the IDE.
6. **Edit a script to force a recompile — confirm the IDE shows NO disconnect.** This is the behaviour the journal buys over the socket transport; if it flickers, `SessionState` restore is broken.
7. Quit Unity — confirm the IDE shows disconnected promptly (via the `disconnect` message, not the 8 s timeout).
8. Confirm `Library/ArcaneIDE/` contains exactly `bridge.json`, `to-ide.jsonl`, `to-unity.jsonl` — and **no** `.ack` files for a short session.
9. Repeat steps 1-7 on Windows.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(bridge): pin the journal wire format with a cross-language golden fixture"
```

---

## As-Built Deviations

Recorded after execution. The spec was updated to match; this plan's task bodies
were not rewritten, so read these first if you are following them.

1. **Epoch sidecars were added** (`to-ide.epoch`, `to-unity.epoch`). The plan's
   `len < offset` rule cannot detect a truncation that rewrites to the same
   byte length — exactly what a session reset does. Caught by
   `DetectsTruncationEvenWhenRewrittenToTheSameLength`. Each journal's single
   writer bumps a counter on every truncate; the reader treats a change as
   authoritative and keeps `len < offset` as a safety net.
2. **C# readers must open with `bufferSize: 1`.** `FileStream`'s read buffer
   served stale bytes after a truncation, replaying old content. Rust's
   `std::fs::File` is unbuffered, so only C# needed this.
3. **`RestorePosition` takes `(offset, epoch)`**, not `(offset)`. A saved offset
   is meaningless if the writer rotated during the domain reload.
   `BridgeBootstrap` persists `Arcane.Bridge.ReadEpoch` alongside the offset.
4. **`unity_write_bridge_discovery` was deleted, not ported.** It was registered
   but never called, and would have published a session id owned by no running
   journal loop.
5. **The IDE `seek_to_end()`s on first open** of `to-ide.jsonl`, instead of
   reading from 0 and replaying a previous session's backlog through
   `route_message`.
6. **`keep()` in `sync-unity-bridge.mjs` strips `.meta` before matching**, or
   excluding `Tests` still ships an orphaned `Tests.meta`.

## Self-Review Notes

**Spec coverage:** File layout → Task 2. Wire format → Tasks 1, 4, 7. Read/write mechanics incl. Windows sharing flags → Tasks 1, 4 (+ Global Constraints). Truncation protocol → Tasks 1, 4. Session protocol Sequences A/B/C → Task 3 (`EnsureSession`), Task 5 (handshake gate). Liveness → Tasks 3, 5. Stale-package detection → Task 6. Limits table → Tasks 1, 4. C# code changes → Tasks 1-3. Rust code changes → Tasks 4-6. Testing → all tasks + Task 7. Rollout → Task 7 Step 5.

**Deliberate deviation from the spec:** the spec's `unity_journal.rs` "mirrors the C# semantics" — the Rust `JournalReader` omits `restore_position`, which only the C# side needs (the IDE has no domain reload to survive).
