// TestRunnerHandlers.cs — run Unity tests via TestRunnerApi and stream results
// to the IDE as `test_event` pushes (F-8).
//
// The Unity Test Framework (com.unity.test-framework) is a default package, but
// to keep the bridge compiling even if a project removed it, all TestRunnerApi
// usage is behind `#if ARCANE_HAS_TEST_FRAMEWORK` (set by the asmdef
// versionDefine). The `#else` stub keeps Register/Tick present so
// BridgeBootstrap can call them unconditionally; runTests then returns a clear
// "not installed" result.
//
// test_event payload phases (mirrored by the Rust headless path so the frontend
// has ONE code path): runStarted / testStarted / testFinished / runFinished.

#if ARCANE_HAS_TEST_FRAMEWORK
using System;
using UnityEditor.TestTools.TestRunner.Api;

namespace Arcane.Bridge
{
    internal static class TestRunnerHandlers
    {
        private const int MaxMsgLen = 4096;

        private static BridgeClient _client;
        private static TestRunnerApi _api;
        private static BridgeTestCallbacks _callbacks;

        public static void Register(BridgeClient client)
        {
            _client = client;
            RpcDispatcher.Register("runTests", RunTests);
        }

        public static void Tick() { /* TestRunnerApi fires callbacks on the main thread; nothing to pump. */ }

        public static void Shutdown()
        {
            try
            {
                if (_api != null && _callbacks != null) _api.UnregisterCallbacks(_callbacks);
            }
            catch { /* ignore */ }
            _api = null;
            _callbacks = null;
            _client = null;
        }

        private static JsonValue RunTests(JsonValue p)
        {
            string mode = p["mode"].AsStringOr("EditMode");
            string filter = p["filter"].AsString;

            if (_api == null)
            {
                _api = UnityEngine.ScriptableObject.CreateInstance<TestRunnerApi>();
                _callbacks = new BridgeTestCallbacks(_client);
                _api.RegisterCallbacks(_callbacks);
            }

            var f = new Filter
            {
                testMode = mode == "PlayMode" ? TestMode.PlayMode : TestMode.EditMode,
            };
            if (!string.IsNullOrEmpty(filter)) f.testNames = new[] { filter };

            _api.Execute(new ExecutionSettings(f));

            var r = JsonValue.NewObject();
            r["ok"] = true; // immediate ack; results stream as test_event
            return r;
        }

        // ── Streaming callbacks ──────────────────────────────────────────────

        private sealed class BridgeTestCallbacks : ICallbacks
        {
            private readonly BridgeClient _c;
            public BridgeTestCallbacks(BridgeClient c) { _c = c; }

            private void Push(JsonValue payload)
            {
                if (_c == null) return;
                try { _c.Send(Protocol.Envelope(MsgType.TestEvent, payload)); }
                catch { /* never throw on the main thread */ }
            }

            private static string Trunc(string s)
            {
                if (string.IsNullOrEmpty(s)) return "";
                return s.Length > MaxMsgLen ? s.Substring(0, MaxMsgLen) : s;
            }

            public void RunStarted(ITestAdaptor testsToRun)
            {
                var o = JsonValue.NewObject();
                o["phase"] = "runStarted";
                o["total"] = CountTests(testsToRun);
                Push(o);
            }

            public void TestStarted(ITestAdaptor test)
            {
                if (test.IsSuite) return;
                var o = JsonValue.NewObject();
                o["phase"] = "testStarted";
                o["fullName"] = test.FullName ?? "";
                Push(o);
            }

            public void TestFinished(ITestResultAdaptor result)
            {
                if (result.Test.IsSuite) return;
                var o = JsonValue.NewObject();
                o["phase"] = "testFinished";
                o["fullName"] = result.Test.FullName ?? "";
                o["status"] = result.TestStatus.ToString(); // Passed|Failed|Skipped|Inconclusive
                o["durationMs"] = (long)(result.Duration * 1000.0);
                o["message"] = Trunc(result.Message);
                o["stackTrace"] = Trunc(result.StackTrace);
                Push(o);
            }

            public void RunFinished(ITestResultAdaptor result)
            {
                var o = JsonValue.NewObject();
                o["phase"] = "runFinished";
                o["passed"] = result.PassCount;
                o["failed"] = result.FailCount;
                o["skipped"] = result.SkipCount;
                o["durationMs"] = (long)(result.Duration * 1000.0);
                Push(o);
            }

            private static int CountTests(ITestAdaptor t)
            {
                if (t == null) return 0;
                if (!t.IsSuite) return 1;
                int n = 0;
                if (t.Children != null)
                    foreach (var c in t.Children) n += CountTests(c);
                return n;
            }
        }
    }
}
#else
namespace Arcane.Bridge
{
    // Test Framework package absent — keep the shape so BridgeBootstrap compiles.
    internal static class TestRunnerHandlers
    {
        public static void Register(BridgeClient client)
        {
            RpcDispatcher.Register("runTests", _ =>
            {
                var r = JsonValue.NewObject();
                r["ok"] = false;
                r["error"] = "Unity Test Framework (com.unity.test-framework) is not installed.";
                return r;
            });
        }

        public static void Tick() { }
        public static void Shutdown() { }
    }
}
#endif
