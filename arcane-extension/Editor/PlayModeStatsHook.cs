// PlayModeStatsHook.cs — lightweight play-mode telemetry (F-4.5).
//
// While the Editor is playing (and not paused), samples FPS / frame time /
// memory / GC / draw calls at ≤4 Hz and emits `playmode_stats`. Outbound-only
// (no inbound control protocol), so it stays off the core message switch. The
// throttle keeps Editor cost negligible; the IDE only DISPLAYS this when the
// user opts in (`unity.telemetry.enabled`), so it's effectively opt-in there.
//
// All sampling runs on the main thread via the BridgeBootstrap pump (Tick()).

using UnityEditor;
using UnityEngine;
using UnityEngine.Profiling;

namespace UnityIDE.Bridge
{
    internal static class PlayModeStatsHook
    {
        private const double IntervalSeconds = 0.25; // ≤ 4 Hz

        private static BridgeClient _client;
        private static bool _installed;
        private static double _lastSent;
        private static int _lastGcCount;

        public static void Install(BridgeClient client)
        {
            if (_installed) return;
            _installed = true;
            _client = client;
            _lastGcCount = System.GC.CollectionCount(0);
        }

        public static void Uninstall()
        {
            if (!_installed) return;
            _installed = false;
            _client = null;
        }

        public static void Tick()
        {
            if (!_installed || _client == null) return;
            if (!EditorApplication.isPlaying || EditorApplication.isPaused) return;

            double now = Protocol.NowUnixSeconds();
            if (now - _lastSent < IntervalSeconds) return;
            _lastSent = now;

            float dt = Time.unscaledDeltaTime;
            float fps = dt > 0f ? 1f / dt : 0f;

            int gcTotal = System.GC.CollectionCount(0);
            int gcDelta = Mathf.Max(0, gcTotal - _lastGcCount);
            _lastGcCount = gcTotal;

            var p = JsonValue.NewObject();
            p["fps"] = (double)fps;
            p["frameTimeMs"] = (double)(dt * 1000f);
            p["totalMemoryMb"] = Profiler.GetTotalAllocatedMemoryLong() / (1024.0 * 1024.0);
            p["reservedMemoryMb"] = Profiler.GetTotalReservedMemoryLong() / (1024.0 * 1024.0);
            p["gcCollections"] = gcDelta;
            p["frameCount"] = Time.frameCount;
            try { p["drawCalls"] = UnityStats.drawCalls; } catch { /* not always available */ }

            _client.Send(Protocol.Envelope(MsgType.PlayModeStats, p));
        }
    }
}
