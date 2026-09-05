// ConsoleHook.cs — stream Unity console output to the IDE as log batches, AND
// keep a bounded, persisted "hook ring" of the same entries for
// `getConsoleSnapshot` to fall back to when `ConsoleReflection` can't read
// Unity's real console (an unsupported Editor version).
//
// Application.logMessageReceivedThreaded fires on ARBITRARY threads (jobs,
// background loaders). We therefore ONLY buffer in the callback (lock-guarded
// list) and read Unity state (Time.frameCount, isPlaying) on the MAIN THREAD
// during the flush tick. The flush coalesces up to 50 entries every ~100ms into
// a single `log_batch` message.
//
// ── log_batch PAYLOAD SHAPE (IMPORTANT) ──────────────────────────────────────
// The task spec suggested { "entries": [...] }, but the LIVE IDE frontend
// (src/stores/unity.ts) registers `listen<UnityLogEntry[]>('unity-log-batch')`
// and calls `event.payload.map(...)` — i.e. it expects the payload to BE the
// bare array. The Rust router forwards `payload` verbatim, so the array must sit
// at payload root for logs to render. We therefore send the payload AS A BARE
// ARRAY of UnityLogEntry. The single switch below makes this trivial to flip if
// the frontend ever changes to the wrapped { entries } form.
// (See the report / README "Wire shape note".)
//
// ── THE HOOK RING ────────────────────────────────────────────────────────────
// A second, bounded (2000-entry) copy of every flushed log, keyed by a
// monotonic `Seq` (long, starts at 1). It exists for the Editor versions where
// `ConsoleReflection` can't resolve Unity's own LogEntries API — the ring is
// this package's own memory of what streamed, going back to whenever this
// AppDomain (or an earlier one this session) started listening. It survives a
// domain reload by persisting the last 500 entries (capped smaller than the
// live ring, since it round-trips through SessionState as JSON text) plus the
// running `Seq` and `ClearEpoch` counters — restored on the next `Install`, so
// a script recompile doesn't reset an agent's paging baseline to zero.

using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace UnityIDE.Bridge
{
    internal static class ConsoleHook
    {
        // Set true to emit { "entries": [...] }; false emits a bare [...] array.
        // The current IDE frontend requires the bare array (false).
        //
        // static readonly, not const: as a const the compiler folds the value away
        // and reports the wrap branch as unreachable (CS0162). readonly keeps both
        // branches compiled, so the alternative wire format stays type-checked
        // rather than quietly rotting until someone flips the flag.
        private static readonly bool WrapInEntriesObject = false;

        private const int MaxBatch = 50;
        private const double FlushIntervalSeconds = 0.1; // ~100ms

        // ── Hook ring ────────────────────────────────────────────────────────
        private const int RingCapacity = 2000;
        private const int PersistRingCount = 500;
        private const int PersistMessageBytes = 1024; // 1 KB
        private const int PersistStackBytes = 2048;    // 2 KB
        internal const string RingSessionKey = "UnityIDE.Bridge.ConsoleRing";

        private struct RingEntry
        {
            public long Seq;
            public string Message;
            public string StackTrace;
            public string LogType;
            public string Mode;
            public double Timestamp;
        }

        // Appended only from Tick() (main thread) — no lock needed, unlike Buffer.
        private static readonly List<RingEntry> Ring = new List<RingEntry>();
        private static long _seq;
        private static int _clearEpoch;

        /// <summary>Last assigned ring sequence number (0 = none yet this AppDomain/session).</summary>
        public static long CurrentSeq => _seq;
        /// <summary>Bumped every time either console (Unity's or the ring) is cleared.</summary>
        public static int ClearEpoch => _clearEpoch;

        private struct PendingLog
        {
            public string Message;
            public string StackTrace;
            public LogType Type;
            public double Timestamp;
        }

        private static readonly List<PendingLog> Buffer = new List<PendingLog>(128);
        private static readonly object BufferLock = new object();

        private static BridgeClient _client;
        private static double _lastFlush;
        private static bool _installed;

        public static void Install(BridgeClient client)
        {
            if (_installed) return;
            _installed = true;
            _client = client;
            RestoreRing();
            Application.logMessageReceivedThreaded += OnLogThreaded;
        }

        public static void Uninstall()
        {
            if (!_installed) return;
            _installed = false;
            Application.logMessageReceivedThreaded -= OnLogThreaded;
            PersistRing();
            lock (BufferLock) { Buffer.Clear(); }
            _client = null;
        }

        /// <summary>Clear the hook ring and bump the clear epoch. Always succeeds —
        /// this is the bridge's own memory, not a reflected Unity API.</summary>
        public static void ClearRing()
        {
            Ring.Clear();
            _clearEpoch++;
        }

        /// <summary>
        /// Full state reset — ring, sequence counter, epoch, pending buffer,
        /// install flag. Test-only: isolates `ConsoleHookRingTests` cases from
        /// each other in the same AppDomain (unlike `Uninstall`, which persists
        /// first — this is a hard wipe).
        /// </summary>
        internal static void ResetForTests()
        {
            lock (BufferLock) { Buffer.Clear(); }
            Ring.Clear();
            _seq = 0;
            _clearEpoch = 0;
            _lastFlush = 0;
            _installed = false;
            _client = null;
        }

        /// <summary>
        /// Append one entry directly to the ring, bypassing
        /// `Application.logMessageReceivedThreaded` and the outbound batch —
        /// a deterministic test seam for ring behaviour (cap, monotonic Seq)
        /// that does not depend on Unity's real log-event timing.
        /// </summary>
        internal static long IngestForTests(string message, string logType, string mode = "EditMode")
        {
            long seq = ++_seq;
            AppendRing(seq, message, "", logType, mode, Protocol.NowUnixSeconds());
            return seq;
        }

        private static void RestoreRing()
        {
            try
            {
                string raw = SessionState.GetString(RingSessionKey, "");
                if (string.IsNullOrEmpty(raw)) return;
                JsonValue json = JsonValue.TryParse(raw);
                if (json == null || !json.IsObject) return;

                _seq = json["seq"].IsNumber ? json["seq"].AsLong : 0;
                _clearEpoch = json["epoch"].IsNumber ? json["epoch"].AsInt : 0;

                Ring.Clear();
                JsonValue arr = json["entries"];
                if (arr != null && arr.IsArray)
                {
                    foreach (JsonValue e in arr.Array)
                    {
                        Ring.Add(new RingEntry
                        {
                            Seq = e["seq"].AsLong,
                            Message = e["message"].AsStringOr(""),
                            StackTrace = e["stackTrace"].AsStringOr(""),
                            LogType = e["logType"].AsStringOr("Log"),
                            Mode = e["mode"].AsStringOr("Unknown"),
                            Timestamp = e["timestamp"].AsNumber,
                        });
                    }
                }
            }
            catch
            {
                // A corrupt/missing blob just starts the ring empty — never block Install.
            }
        }

        private static void PersistRing()
        {
            try
            {
                var obj = JsonValue.NewObject();
                obj["seq"] = _seq;
                obj["epoch"] = _clearEpoch;

                var arr = JsonValue.NewArray();
                int start = Math.Max(0, Ring.Count - PersistRingCount);
                for (int i = start; i < Ring.Count; i++)
                {
                    RingEntry r = Ring[i];
                    var e = JsonValue.NewObject();
                    e["seq"] = r.Seq;
                    e["message"] = ConsoleReflection.CapUtf8(r.Message, PersistMessageBytes);
                    e["stackTrace"] = ConsoleReflection.CapUtf8(r.StackTrace, PersistStackBytes);
                    e["logType"] = r.LogType;
                    e["mode"] = r.Mode;
                    e["timestamp"] = r.Timestamp;
                    arr.Add(e);
                }
                obj["entries"] = arr;
                SessionState.SetString(RingSessionKey, obj.Serialize());
            }
            catch
            {
                // Persistence is best-effort — losing ring history across a reload
                // degrades the fallback path, but must never block shutdown.
            }
        }

        private static void AppendRing(long seq, string message, string stackTrace, string logType, string mode, double timestamp)
        {
            Ring.Add(new RingEntry
            {
                Seq = seq,
                Message = message,
                StackTrace = stackTrace,
                LogType = logType,
                Mode = mode,
                Timestamp = timestamp,
            });
            if (Ring.Count > RingCapacity)
            {
                Ring.RemoveRange(0, Ring.Count - RingCapacity);
            }
        }

        /// <summary>Total errors/warnings/logs currently held in the ring (all of
        /// it, not just a page) — the hook-ring counterpart to
        /// <see cref="ConsoleReflection.TryCounts"/>.</summary>
        public static void CountsInRing(out int errors, out int warnings, out int logs)
        {
            errors = warnings = logs = 0;
            foreach (RingEntry r in Ring)
            {
                if (r.LogType == "Error" || r.LogType == "Assert" || r.LogType == "Exception") errors++;
                else if (r.LogType == "Warning") warnings++;
                else logs++;
            }
        }

        /// <summary>
        /// Read a page of the hook ring, filtered by wire type name (null = no
        /// filter), ordered newest-first unless `order` is "oldest". Always
        /// succeeds — this is the bridge's own bounded memory, never a reflected
        /// Unity API that can fail.
        /// </summary>
        public static void Snapshot(
            int offset, int limit, HashSet<string> types, bool includeStack, string order,
            out List<JsonValue> entries, out int total)
        {
            var matched = new List<RingEntry>();
            foreach (RingEntry r in Ring)
            {
                if (types != null && !types.Contains(r.LogType)) continue;
                matched.Add(r);
            }

            total = matched.Count;
            if (!string.Equals(order, "oldest", StringComparison.OrdinalIgnoreCase))
                matched.Reverse();

            entries = new List<JsonValue>();
            int start = Math.Max(0, offset);
            int end = Math.Min(matched.Count, start + Math.Max(0, limit));
            for (int i = start; i < end; i++)
            {
                RingEntry r = matched[i];
                var e = JsonValue.NewObject();
                e["seq"] = r.Seq;
                e["logType"] = r.LogType;
                e["message"] = r.Message;
                e["stackTrace"] = includeStack ? r.StackTrace : "";
                e["file"] = "";
                e["line"] = 0;
                e["mode"] = r.Mode;
                e["count"] = 1;
                entries.Add(e);
            }
        }

        // Threaded callback: buffer only. No Unity API calls here.
        private static void OnLogThreaded(string condition, string stackTrace, LogType type)
        {
            var entry = new PendingLog
            {
                Message = condition ?? "",
                StackTrace = stackTrace ?? "",
                Type = type,
                Timestamp = Protocol.NowUnixSeconds(),
            };
            lock (BufferLock)
            {
                Buffer.Add(entry);
            }
        }

        /// <summary>
        /// Called from the main-thread pump every tick. Flushes at most every
        /// ~100ms, reading Time.frameCount / play state on the main thread.
        /// </summary>
        public static void Tick()
        {
            if (!_installed || _client == null) return;

            double now = Protocol.NowUnixSeconds();
            if (now - _lastFlush < FlushIntervalSeconds) return;
            _lastFlush = now;

            // Read Unity state once per flush on the main thread.
            int frame = Time.frameCount;
            string mode = UnityEditor.EditorApplication.isPlaying ? "PlayMode" : "EditMode";

            while (true)
            {
                List<PendingLog> slice = null;
                lock (BufferLock)
                {
                    if (Buffer.Count == 0) break;
                    int take = Math.Min(MaxBatch, Buffer.Count);
                    slice = Buffer.GetRange(0, take);
                    Buffer.RemoveRange(0, take);
                }
                if (slice == null || slice.Count == 0) break;

                var arr = JsonValue.NewArray();
                foreach (var p in slice)
                {
                    string wireType = MapLogType(p.Type);
                    long seq = ++_seq;
                    AppendRing(seq, p.Message, p.StackTrace, wireType, mode, p.Timestamp);

                    var e = JsonValue.NewObject();
                    e["message"] = p.Message;
                    e["stackTrace"] = p.StackTrace;
                    e["logType"] = wireType;
                    e["timestamp"] = p.Timestamp;
                    e["frameCount"] = frame;
                    e["mode"] = mode;
                    // Additive: an IDE built before protocol 4 ignores unknown fields.
                    e["seq"] = seq;
                    arr.Add(e);
                }

                JsonValue payload;
                if (WrapInEntriesObject)
                {
                    payload = JsonValue.NewObject();
                    payload["entries"] = arr;
                }
                else
                {
                    payload = arr; // bare array — matches the live frontend listener
                }

                _client.Send(Protocol.Envelope(MsgType.LogBatch, payload));

                // If we drained a full MaxBatch, loop to flush the rest this tick.
                if (slice.Count < MaxBatch) break;
            }
        }

        // Map Unity's LogType enum to the wire strings.
        private static string MapLogType(LogType type)
        {
            switch (type)
            {
                case LogType.Warning: return "Warning";
                case LogType.Error: return "Error";
                case LogType.Assert: return "Assert";
                case LogType.Exception: return "Exception";
                case LogType.Log:
                default: return "Log";
            }
        }
    }
}
