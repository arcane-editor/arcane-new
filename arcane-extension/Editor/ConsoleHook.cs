// ConsoleHook.cs — stream Unity console output to the IDE as log batches.
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

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Arcane.Bridge
{
    internal static class ConsoleHook
    {
        // Set true to emit { "entries": [...] }; false emits a bare [...] array.
        // The current IDE frontend requires the bare array (false).
        private const bool WrapInEntriesObject = false;

        private const int MaxBatch = 50;
        private const double FlushIntervalSeconds = 0.1; // ~100ms

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
            Application.logMessageReceivedThreaded += OnLogThreaded;
        }

        public static void Uninstall()
        {
            if (!_installed) return;
            _installed = false;
            Application.logMessageReceivedThreaded -= OnLogThreaded;
            lock (BufferLock) { Buffer.Clear(); }
            _client = null;
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
                    var e = JsonValue.NewObject();
                    e["message"] = p.Message;
                    e["stackTrace"] = p.StackTrace;
                    e["logType"] = MapLogType(p.Type);
                    e["timestamp"] = p.Timestamp;
                    e["frameCount"] = frame;
                    e["mode"] = mode;
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
